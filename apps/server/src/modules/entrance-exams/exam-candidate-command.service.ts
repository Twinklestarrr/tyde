import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import type { ExamFileInput } from './exam-config.types.js';
import {
  lockCandidate,
  requireCandidate,
  validateCandidateProject,
} from './exam-candidate.service.js';
import { collectGradingTasks, reviewerIds } from './exam-grading-tasks.js';
import { syncGradingTasks } from './exam-grading-command.service.js';
import { projectTime } from '../projects/project-time.js';

export interface CandidateAttemptInput {
  projectId: number;
  attemptId: number;
}
export interface CandidateSubmitInput extends CandidateAttemptInput {
  integritySigned: boolean;
  answers: {
    questionId: number;
    answerContent?: string | null;
    answerFiles?: ExamFileInput[] | null;
  }[];
}
const bad = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
export class ExamCandidateCommandService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}
  private async owned(
    tx: Prisma.TransactionClient,
    input: CandidateAttemptInput,
    p: AuthPrincipal,
  ) {
    await lockCandidate(tx, input.projectId, p.userId);
    const { assignment, relation, project } = await requireCandidate(tx, input.projectId, p.userId);
    await tx.$queryRaw`SELECT "id" FROM "EntranceExamAttempt" WHERE "id"=${input.attemptId} FOR UPDATE`;
    const attempt = await tx.entranceExamAttempt.findFirst({
      where: {
        id: input.attemptId,
        candidateUserId: p.userId,
        exam: { projectId: input.projectId, deleted: false },
      },
    });
    if (!attempt) throw new AuthError(404, 'NOT_FOUND', '应试记录不存在');
    if (attempt.sourceBizType !== 'EXPERT_ORDER')
      throw new AuthError(503, 'NOT_IMPLEMENTED', '转项应试来源由12任务接入');
    if (
      attempt.sourceBizId !== assignment.id ||
      attempt.organizationId !== assignment.organizationId ||
      attempt.userOrgRelId !== (relation?.id ?? null)
    )
      throw new AuthError(403, 'FORBIDDEN', '应试记录绑定的接单身份已失效');
    if (project.currentNodeCode === 'COMPLETED') throw bad('项目已结项');
    if (attempt.cancelledAt) throw bad('已取消并离场，不可再次操作');
    if (attempt.submittedAt) throw new AuthError(409, 'CONFLICT', '答卷已提交，不可重复操作');
    if (attempt.finalResult !== 'PENDING') throw bad('应试记录已终结，不可重考');
    if (!attempt.enteredAt || !attempt.paperId || !attempt.examVersionId) throw bad('请先进入考试');
    return attempt as typeof attempt & { paperId: number; examVersionId: number };
  }
  private validate(input: CandidateAttemptInput, p: AuthPrincipal) {
    validateCandidateProject(input.projectId, p);
    if (!Number.isInteger(input.attemptId) || input.attemptId < 1 || input.attemptId > 2147483647)
      throw bad('应试ID必须为32位正整数');
  }
  async submit(input: CandidateSubmitInput, p: AuthPrincipal) {
    this.validate(input, p);
    if (input.integritySigned !== true) throw bad('请先签署诚信考试承诺');
    if (!Array.isArray(input.answers) || input.answers.length > 500)
      throw bad('答卷必须为最多500题的数组');
    return this.db.$transaction(
      async (tx) => {
        const attempt = await this.owned(tx, input, p),
          now = new Date();
        if (attempt.answerDeadlineAt && attempt.answerDeadlineAt <= now)
          throw bad('答题时间已结束');
        const paper = await tx.entranceExamPaper.findFirst({
          where: { id: attempt.paperId, examVersionId: attempt.examVersionId },
          include: { questions: { orderBy: { sequenceNo: 'asc' } } },
        });
        const rounds = await tx.entranceExamGradingRound.findMany({
          where: { examVersionId: attempt.examVersionId },
          orderBy: { roundNo: 'asc' },
        });
        if (!paper?.questions.length || !rounds.length)
          throw new AuthError(500, 'INTERNAL_ERROR', '绑定试卷或判卷轮次异常');
        const allowed = new Set(paper.questions.map((q) => q.id)),
          submitted = new Map<number, CandidateSubmitInput['answers'][number]>();
        for (const item of input.answers) {
          if (!item || !allowed.has(item.questionId)) throw bad('答卷包含不属于当前试卷的题目');
          if (submitted.has(item.questionId)) throw bad('答卷存在重复题目');
          if (
            item.answerContent != null &&
            (typeof item.answerContent !== 'string' || item.answerContent.length > 100000)
          )
            throw bad('单题答案内容过长或格式错误');
          if (
            item.answerFiles != null &&
            (!Array.isArray(item.answerFiles) || item.answerFiles.length > 10)
          )
            throw bad('单题附件最多10个');
          submitted.set(item.questionId, item);
        }
        const before = await collectGradingTasks(tx, input.projectId),
          keys = new Set<string>();
        const answers = [];
        for (const q of paper.questions) {
          const item = submitted.get(q.id),
            content = item?.answerContent?.trim() || null;
          if (q.requiredFlag && !content && !item?.answerFiles?.length)
            throw bad(`必答题未作答：第${q.sequenceNo}题`);
          const snapshots: Prisma.InputJsonObject[] = [];
          for (const file of item?.answerFiles ?? []) {
            const key = file?.objectKey?.trim();
            if (!key || !file.uploadToken?.trim() || file.uploadedFileId != null)
              throw bad('答案附件须提供新上传凭证，不允许复用已认领附件');
            if (keys.has(key)) throw bad('答卷附件存在重复文件');
            keys.add(key);
            const stored = await this.files.claimForEntranceExam(
              tx,
              key,
              file.uploadToken,
              p.uid,
              String(attempt.examId),
            );
            snapshots.push({
              uploadedFileId: stored.id,
              objectKey: stored.objectKey,
              fileName: stored.fileName,
              extension: stored.extension,
              contentType: stored.contentType,
              fileSize: stored.fileSize,
              fileHash: stored.fileHash,
            });
          }
          answers.push(
            await tx.entranceExamAnswer.create({
              data: {
                attemptId: attempt.id,
                paperId: attempt.paperId,
                questionId: q.id,
                answerContent: content,
                answerFilesJson: snapshots.length ? snapshots : Prisma.DbNull,
                answeredFlag: !!content || snapshots.length > 0,
                createdBy: p.uid,
              },
            }),
          );
        }
        let firstRecordId = 0;
        for (const [index, round] of rounds.entries()) {
          const record = await tx.entranceExamGradingRecord.create({
            data: {
              attemptId: attempt.id,
              examVersionId: attempt.examVersionId,
              gradingRoundId: round.id,
              status: index === 0 ? 'PENDING' : 'WAITING',
              createdBy: 'SYSTEM',
            },
          });
          // 复合关系中的attemptId由嵌套写入隐式管理；独立写入逐题项，显式保留全部来源键。
          await tx.entranceExamGradingItem.createMany({
            data: answers.map((a) => ({
              gradingRecordId: record.id,
              attemptId: attempt.id,
              questionId: a.questionId,
              answerId: a.id,
              correctness: 'PENDING',
              createdBy: 'SYSTEM',
            })),
          });
          if (index === 0) firstRecordId = record.id;
        }
        await tx.entranceExamAttempt.update({
          where: { id: attempt.id },
          data: {
            integritySignedAt: now,
            submittedAt: now,
            gradingStatus: 'PENDING',
            updatedBy: p.uid,
          },
        });
        const first = rounds[0]!;
        await tx.projectEventOutbox.create({
          data: {
            projectId: input.projectId,
            operation: 'entrance-exam.candidate.submit',
            actorUserId: p.userId,
            eventType:
              first.gradingMode === 'AUTO'
                ? 'EXAM_AUTO_DISPATCH_REQUESTED'
                : 'EXAM_REVIEW_QUEUE_CHANGED',
            payload:
              first.gradingMode === 'AUTO'
                ? {
                    gradingRecordId: firstRecordId,
                    provider: 'mock',
                    executionStatus: 'NOT_EXECUTED',
                  }
                : {
                    attemptId: attempt.id,
                    nextRoundId: first.id,
                    reviewerUserIds: reviewerIds(first.reviewersJson),
                    deliveryStatus: 'NOT_DELIVERED',
                  },
          },
        });
        await syncGradingTasks(tx, input.projectId, before, now);
        await finishCandidateTask(tx, input.projectId, p.userId, now, true);
        return {
          attemptId: attempt.id,
          answerCount: answers.length,
          gradingRoundCount: rounds.length,
          gradingStatus: 'PENDING',
          submittedAt: projectTime(now),
        };
      },
      { timeout: 30000 },
    );
  }
  async cancel(input: CandidateAttemptInput, p: AuthPrincipal) {
    this.validate(input, p);
    return this.db.$transaction(
      async (tx) => {
        const attempt = await this.owned(tx, input, p),
          now = new Date();
        await tx.entranceExamAttempt.update({
          where: { id: attempt.id },
          data: { cancelledAt: now, updatedBy: p.uid },
        });
        await tx.projectEventOutbox.create({
          data: {
            projectId: input.projectId,
            operation: 'entrance-exam.candidate.cancel',
            actorUserId: p.userId,
            eventType: 'EXAM_RESULT_DECIDED',
            payload: {
              attemptId: attempt.id,
              sourceBizType: attempt.sourceBizType,
              sourceBizId: attempt.sourceBizId,
              admitted: false,
              cancelled: true,
            },
          },
        });
        await finishCandidateTask(tx, input.projectId, p.userId, now, false);
        return { attemptId: attempt.id, cancelledAt: projectTime(now) };
      },
      { timeout: 30000 },
    );
  }
}
async function finishCandidateTask(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
  now: Date,
  submitted: boolean,
) {
  await tx.projectTaskRound.updateMany({
    where: { projectId, userId, role: 'EXPERT', taskType: 'ENTRANCE_EXAM', status: 'OPEN' },
    data: {
      status: submitted ? 'COMPLETED' : 'CANCELLED',
      participated: submitted,
      finishedAt: now,
    },
  });
  await tx.projectRoleNodeSnapshot.deleteMany({
    where: {
      projectId,
      userId,
      perspective: { in: ['EXPERT_INDIVIDUAL', 'EXPERT_MEMBER', 'EXPERT_PROJECT_OWNER'] },
      branchNodeCode: 'ENTRANCE_EXAM',
      sourceBizType: 'EXPERT_ASSIGNMENT',
    },
  });
}
