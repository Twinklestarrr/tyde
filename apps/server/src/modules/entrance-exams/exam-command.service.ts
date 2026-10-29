import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import { nodeAfterPlan } from '../projects/project-production-plan.service.js';
import {
  collectManagementTasks,
  reconcileTaskRounds,
  managementTaskTypes,
} from '../projects/project-task-rounds.js';
import { requireExamManager } from './exam-access.js';
import { requireProjectExam, type ExamLocator } from './exam-access.js';
import { prepareExamConfig } from './exam-config.js';
import type { ExamConfigInput, ExamEditInput, ExamFileInput } from './exam-config.types.js';
const bad = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const conflict = (message: string) => new AuthError(409, 'DUPLICATE', message);
export class ExamCommandService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}
  async close(input: ExamLocator & { closeReason?: string | null }, principal: AuthPrincipal) {
    if (input.closeReason != null && input.closeReason.length > 500)
      throw bad('关闭原因长度不能超过500');
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
        const project = await requireExamManager(tx, input.projectId, principal);
        await tx.$queryRaw`SELECT "id" FROM "ProjectEntranceExam" WHERE "id" = ${input.examId} AND "projectId" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
        const exam = await requireProjectExam(tx, input);
        if (exam.status === 'CLOSED') throw conflict('考试已关闭');
        const before = await collectManagementTasks(tx, project),
          now = new Date();
        const updated = await tx.projectEntranceExam.updateMany({
          where: { id: exam.id, projectId: input.projectId, deleted: false, status: 'ACTIVE' },
          data: {
            status: 'CLOSED',
            closedBy: principal.uid,
            closedAt: now,
            closeReason: input.closeReason?.trim() || null,
            updatedBy: principal.uid,
          },
        });
        if (updated.count !== 1) throw conflict('考试状态已发生变化，请刷新后重试');
        await reconcileTaskRounds(
          tx,
          project.id,
          before,
          await collectManagementTasks(tx, project),
          { userId: principal.userId, role: 'PM' },
          [],
          [],
          managementTaskTypes,
          now,
        );
        await refreshOwnerProgress(tx, project.id, null, now);
        await refreshManagementCardSnapshots(tx, project.id, now);
        return {
          examId: exam.id,
          status: 'CLOSED',
          closedBy: principal.uid,
          closedAt: projectTime(now),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
        throw conflict('考试状态已发生变化，请刷新后重试');
      throw error;
    }
  }
  async save(input: ExamConfigInput | ExamEditInput, principal: AuthPrincipal, edit = false) {
    const now = new Date(),
      config = prepareExamConfig(input, now);
    const editing = edit ? (input as ExamEditInput) : null;
    if (editing && (!editing.examId || !editing.expectedCurrentVersionId))
      throw bad('考试ID和预期版本必填');
    try {
      return await this.db.$transaction(
        async (tx) => {
          // 同项目发布、编辑共用项目锁，防同名/数量并发穿透；保持项目→考试→文件的锁顺序。
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
          const project = await requireExamManager(tx, input.projectId, principal);
          const before = await collectManagementTasks(tx, project);
          let exam;
          let versionNo = 1;
          if (editing) {
            await tx.$queryRaw`SELECT "id" FROM "ProjectEntranceExam" WHERE "id" = ${editing.examId} AND "projectId" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
            exam = await tx.projectEntranceExam.findFirst({
              where: { id: editing.examId, projectId: input.projectId, deleted: false },
            });
            if (!exam) throw new AuthError(404, 'NOT_FOUND', '考试不存在或不属于当前项目');
            if (exam.status !== 'ACTIVE') throw bad('已关闭考试不允许编辑');
            if (exam.currentVersionId !== editing.expectedCurrentVersionId)
              throw conflict('考试内容已被其他人修改，请刷新后重试');
            const current = await tx.entranceExamVersion.findUnique({
              where: { id: exam.currentVersionId },
            });
            if (!current || current.examId !== exam.id)
              throw new AuthError(500, 'INTERNAL_ERROR', '考试当前配置版本异常');
            versionNo = current.versionNo + 1;
          } else {
            await tx.$queryRaw`SELECT "id" FROM "ProjectProductionPlan" WHERE "projectId" = ${input.projectId} FOR UPDATE`;
            const plan = await tx.projectProductionPlan.findUnique({
              where: { projectId: input.projectId },
            });
            if (!plan) throw bad('请先确认生产计划');
            if (!plan.needWrittenExam) throw bad('生产计划未配置准入考试');
            const count = await tx.projectEntranceExam.count({
              where: { projectId: input.projectId, status: 'ACTIVE', deleted: false },
            });
            if (count >= (plan.maxActiveExamCount ?? 1))
              throw bad('进行中考试数量已达项目配置上限');
          }
          if (
            await tx.projectEntranceExam.findFirst({
              where: {
                projectId: input.projectId,
                deleted: false,
                examName: config.examName,
                ...(exam ? { id: { not: exam.id } } : {}),
              },
              select: { id: true },
            })
          )
            throw conflict('项目内已有同名考试，请确认或修改名称');
          if (!exam)
            exam = await tx.projectEntranceExam.create({
              data: {
                examNo: `EX${projectTime(now).replace(/[- :]/g, '')}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
                projectId: project.id,
                examName: config.examName,
                status: 'ACTIVE',
                createdBy: principal.uid,
                updatedBy: principal.uid,
              },
            });
          const reviewerIds = [
            ...new Set(
              config.rounds
                .filter((r) => r.gradingMode === 'MANUAL')
                .flatMap((r) => r.reviewerUserIds!),
            ),
          ];
          const reviewers = await tx.user.findMany({
            where: {
              id: { in: reviewerIds },
              status: 'ACTIVE',
            },
            select: { id: true, uid: true, displayName: true, realName: true },
          });
          if (reviewers.length !== reviewerIds.length)
            throw bad('阅卷人必须为状态有效的三角色账号');
          const version = await tx.entranceExamVersion.create({
            data: {
              examId: exam.id,
              versionNo,
              examNameSnapshot: config.examName,
              durationMinutes: config.durationMinutes,
              registrationDeadline: config.registrationDeadline,
              fullScore: config.fullScore,
              passScore: config.passScore,
              decisionRule: config.decisionRule,
              tieBreakRule: config.tieBreakRule,
              publishedBy: principal.uid,
              publishedAt: now,
              createdBy: principal.uid,
            },
          });
          const keys = new Set<string>();
          const claimFiles = async (requests?: ExamFileInput[] | null) => {
            const snapshots: Prisma.InputJsonObject[] = [];
            for (const request of requests ?? []) {
              const key = request.objectKey?.trim();
              if (!key || Boolean(request.uploadedFileId) === Boolean(request.uploadToken?.trim()))
                throw bad('考试附件必须提供上传凭证或已认领文件ID且不能同时提供');
              if (keys.has(key)) throw bad('同一配置版本不能重复引用同一附件');
              keys.add(key);
              const file = request.uploadedFileId
                ? await this.files.reuseEntranceExamFile(
                    tx,
                    request.uploadedFileId,
                    key,
                    String(exam.id),
                  )
                : await this.files.claimForEntranceExam(
                    tx,
                    key,
                    request.uploadToken!,
                    principal.uid,
                    String(exam.id),
                  );
              snapshots.push({
                uploadedFileId: file.id,
                objectKey: file.objectKey,
                fileName: file.fileName,
                extension: file.extension,
                contentType: file.contentType,
                fileSize: file.fileSize,
                fileHash: file.fileHash,
              });
            }
            return snapshots.length ? snapshots : null;
          };
          for (const prepared of config.papers) {
            const paper = await tx.entranceExamPaper.create({
              data: {
                examVersionId: version.id,
                sequenceNo: prepared.sequenceNo,
                paperName: prepared.paperName,
                totalScore: config.fullScore,
                createdBy: principal.uid,
              },
            });
            for (const question of prepared.questions) {
              const request = question.request;
              const questionFiles = await claimFiles(request.questionFiles),
                referenceFiles = await claimFiles(request.referenceFiles);
              await tx.entranceExamQuestion.create({
                data: {
                  paperId: paper.id,
                  sequenceNo: question.sequenceNo,
                  questionContent: request.questionContent?.trim() || null,
                  questionFilesJson: questionFiles ?? Prisma.DbNull,
                  requiredFlag: request.requiredFlag ?? true,
                  score: question.score,
                  scoreSource: question.scoreSource,
                  referenceAnswer: request.referenceAnswer?.trim() || null,
                  referenceFilesJson: referenceFiles ?? Prisma.DbNull,
                  createdBy: principal.uid,
                },
              });
            }
          }
          for (const [index, round] of config.rounds.entries()) {
            let toolConfig: Prisma.InputJsonObject | null = null;
            let reviewerSnapshots: Prisma.InputJsonObject[] | null = null;
            if (round.gradingMode === 'AUTO') {
              toolConfig =
                round.toolConfig != null
                  ? typeof round.toolConfig === 'object' && !Array.isArray(round.toolConfig)
                    ? ({ ...round.toolConfig } as Prisma.InputJsonObject)
                    : { config: round.toolConfig as Prisma.InputJsonValue }
                  : {};
              const attachments = await claimFiles(round.toolFiles);
              if (attachments) toolConfig = { ...toolConfig, files: attachments };
              if (!Object.keys(toolConfig).length) toolConfig = null;
            } else
              reviewerSnapshots = round.reviewerUserIds!.map((id) => {
                const u = reviewers.find((u) => u.id === id)!;
                return {
                  userId: u.id,
                  uid: u.uid,
                  name: displayName(u.displayName, u.realName, u.uid),
                };
              });
            await tx.entranceExamGradingRound.create({
              data: {
                examVersionId: version.id,
                roundNo: index + 1,
                gradingMode: round.gradingMode,
                toolCode: round.gradingMode === 'AUTO' ? round.toolCode!.trim() : null,
                toolName: round.gradingMode === 'AUTO' ? round.toolName!.trim() : null,
                toolConfigJson: toolConfig ?? Prisma.DbNull,
                reviewersJson: reviewerSnapshots ?? Prisma.DbNull,
                createdBy: principal.uid,
              },
            });
          }
          const updated = await tx.projectEntranceExam.updateMany({
            where: {
              id: exam.id,
              status: 'ACTIVE',
              deleted: false,
              currentVersionId: exam.currentVersionId,
            },
            data: {
              examName: config.examName,
              currentVersionId: version.id,
              updatedBy: principal.uid,
            },
          });
          if (updated.count !== 1) throw conflict('考试配置已变化，请刷新后重试');
          let afterProject = project;
          if (!editing) {
            const nextNode = nodeAfterPlan(project.currentNodeCode, false);
            if (nextNode !== project.currentNodeCode)
              afterProject = await tx.project.update({
                where: { id: project.id },
                data: { currentNodeCode: nextNode, updatedBy: principal.uid },
              });
          }
          await reconcileTaskRounds(
            tx,
            project.id,
            before,
            await collectManagementTasks(tx, afterProject),
            { userId: principal.userId, role: 'PM' },
            editing ? [] : ['MAIN_ENTRANCE_EXAM'],
            editing ? [] : ['MAIN_ENTRANCE_EXAM'],
            managementTaskTypes,
            now,
          );
          await refreshOwnerProgress(tx, project.id, null, now);
          await refreshManagementCardSnapshots(tx, project.id, now);
          return {
            examId: exam.id,
            examNo: exam.examNo,
            projectId: project.id,
            examName: config.examName,
            status: 'ACTIVE',
            currentVersionId: version.id,
            versionNo,
            publishedAt: projectTime(now),
          };
        },
        { timeout: 30000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      )
        throw conflict('考试名称、版本或附件状态发生冲突，请刷新后重试');
      throw error;
    }
  }
}
