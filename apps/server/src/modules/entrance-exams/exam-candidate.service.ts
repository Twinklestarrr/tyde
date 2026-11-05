import { Prisma, type PrismaClient } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { admissionStatus } from '../expert/expert-assignment.domain.js';
import { refreshOwnerProgress } from '../expert/expert-progress.service.js';
import { displayName } from '../projects/project-detail.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import { projectTime } from '../projects/project-time.js';
import { candidateContext } from './exam-candidate.access.js';
import { lockCandidate } from './exam-candidate.repository.js';

const bad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);

export function validateCandidateProject(projectId: number, p: AuthPrincipal) {
  if (p.role !== 'EXPERT') throw new AppError(403, 'FORBIDDEN', '仅执行专家可访问');
  if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
    throw bad('项目ID必须为32位正整数');
}

export class ExamCandidateService {
  constructor(readonly db: PrismaClient) {}
  async current(projectId: number, p: AuthPrincipal) {
    validateCandidateProject(projectId, p);
    return this.db.$transaction(
      async (tx) => {
        const context = await candidateContext(tx, projectId, p.userId, true);
        const attempts = await tx.entranceExamAttempt.findMany({
          where: {
            candidateUserId: p.userId,
            sourceBizType: context.sourceBizType,
            sourceBizId: context.sourceBizId,
            ...(context.movement ? { id: context.movement.targetExamAttemptId ?? -1 } : {}),
            organizationId: context.organizationId,
            userOrgRelId: context.relation?.id ?? null,
            exam: { projectId, deleted: false },
          },
        });
        return { projectId, status: admissionStatus(attempts) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async enter(projectId: number, p: AuthPrincipal) {
    validateCandidateProject(projectId, p);
    return this.db.$transaction(
      async (tx) => {
        await lockCandidate(tx, projectId, p.userId);
        const context = await candidateContext(tx, projectId, p.userId);
        const { user, project, relation, movement } = context;
        if (project.currentNodeCode === 'COMPLETED') throw bad('项目已结项，不可进入考试');
        const plan = await tx.projectProductionPlan.findUnique({ where: { projectId } });
        if (!movement && !plan?.needWrittenExam) throw bad('当前项目无需笔试，不可进入考试');
        const exams = await tx.projectEntranceExam.findMany({
          where: { projectId, deleted: false },
          include: { currentVersion: true },
          orderBy: { id: 'asc' },
        });
        if (!exams.length) throw new AppError(404, 'NOT_FOUND', '当前项目暂无准入考试');
        let attempt = await tx.entranceExamAttempt.findFirst({
          where: {
            candidateUserId: p.userId,
            examId: { in: exams.map((e) => e.id) },
            sourceBizType: context.sourceBizType,
            ...(movement ? { sourceBizId: movement.id } : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const now = new Date();
        if (attempt) {
          if (
            attempt.sourceBizType !== context.sourceBizType ||
            (attempt.sourceBizId !== null && attempt.sourceBizId !== context.sourceBizId) ||
            attempt.organizationId !== context.organizationId ||
            attempt.userOrgRelId !== (relation?.id ?? null)
          )
            throw new AppError(403, 'FORBIDDEN', '应试记录绑定的接单身份已失效');
          if (attempt.cancelledAt) throw bad('已取消并离场，不可再次操作');
          if (attempt.submittedAt) throw new AppError(409, 'CONFLICT', '答卷已提交，不可重复操作');
          if (attempt.finalResult !== 'PENDING') throw bad('应试记录已终结，不可重考');
          if (attempt.answerDeadlineAt && attempt.answerDeadlineAt <= now)
            throw bad('答题时间已结束');
        }
        if (!attempt?.enteredAt) {
          const used = movement
            ? await tx.entranceExamAttempt.findMany({
                where: { candidateUserId: p.userId },
                select: { examId: true },
              })
            : [];
          const available = exams.filter(
            (e) =>
              e.status === 'ACTIVE' &&
              (!movement || attempt?.examId === e.id || !used.some((a) => a.examId === e.id)) &&
              e.currentVersion &&
              e.currentVersion.registrationDeadline > now,
          );
          const exam = attempt
            ? available.find((e) => e.id === attempt!.examId)
            : available.length
              ? available[randomInt(available.length)]
              : undefined;
          if (!exam?.currentVersion) throw bad('当前没有可参加的准入考试');
          const version = exam.currentVersion;
          const papers = await tx.entranceExamPaper.findMany({
            where: { examVersionId: version.id },
            orderBy: { sequenceNo: 'asc' },
          });
          if (!papers.length) throw new AppError(500, 'INTERNAL_ERROR', '考试未配置试卷');
          const binding = {
            examVersionId: version.id,
            paperId: papers[randomInt(papers.length)]!.id,
            enteredAt: now,
            answerDeadlineAt:
              version.durationMinutes === null
                ? null
                : new Date(now.getTime() + version.durationMinutes * 60_000),
            updatedBy: p.uid,
          };
          attempt = attempt
            ? await tx.entranceExamAttempt.update({ where: { id: attempt.id }, data: binding })
            : await tx.entranceExamAttempt.create({
                data: {
                  ...binding,
                  attemptNo: `EEA${randomUUID().replaceAll('-', '').toUpperCase()}`,
                  examId: exam.id,
                  candidateUserId: p.userId,
                  candidateUid: user.uid,
                  candidateName: displayName(user.displayName, user.realName, user.uid),
                  organizationId: context.organizationId,
                  organizationName: relation?.organization.name ?? null,
                  userOrgRelId: relation?.id ?? null,
                  sourceBizType: context.sourceBizType,
                  sourceBizId: context.sourceBizId,
                  createdBy: p.uid,
                },
              });
        }
        if (movement && movement.targetExamAttemptId !== attempt.id) {
          if (movement.targetExamAttemptId !== null) throw bad('转项已关联其他考试');
          await tx.projectMemberMovement.update({
            where: { id: movement.id },
            data: { targetExamAttemptId: attempt.id, updatedBy: p.uid },
          });
        }
        const version = await tx.entranceExamVersion.findFirst({
          where: { id: attempt.examVersionId!, examId: attempt.examId },
        });
        const paper = await tx.entranceExamPaper.findFirst({
          where: { id: attempt.paperId!, examVersionId: attempt.examVersionId! },
          include: { questions: { orderBy: { sequenceNo: 'asc' } } },
        });
        if (!version || !paper || !paper.questions.length)
          throw new AppError(500, 'INTERNAL_ERROR', '应试记录绑定的版本或试卷异常');
        await refreshOwnerProgress(tx, projectId, [p.userId], now);
        await refreshManagementCardSnapshots(tx, projectId, now);
        return {
          projectId,
          attemptId: attempt.id,
          examId: attempt.examId,
          examVersionId: version.id,
          paperId: paper.id,
          examName: version.examNameSnapshot,
          paperName: paper.paperName,
          durationMinutes: version.durationMinutes,
          fullScore: version.fullScore.toNumber(),
          enteredAt: projectTime(attempt.enteredAt!),
          answerDeadlineAt: attempt.answerDeadlineAt ? projectTime(attempt.answerDeadlineAt) : null,
          questions: paper.questions.map((q) => ({
            questionId: q.id,
            sequenceNo: q.sequenceNo,
            questionContent: q.questionContent,
            questionFiles: q.questionFilesJson,
            requiredFlag: q.requiredFlag,
            score: q.score.toNumber(),
          })),
        };
      },
      { timeout: 30_000 },
    );
  }
}
