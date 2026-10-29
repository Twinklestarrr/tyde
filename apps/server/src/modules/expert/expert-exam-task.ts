import type { Prisma } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';

/** 普通考试读取与仲裁共用真实身份、来源和绑定试卷门禁；只读。 */
export async function ordinaryExamTask(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
  now: Date,
) {
  try {
    const { candidateContext } = await import('../entrance-exams/exam-candidate.service.js');
    const context = await candidateContext(tx, projectId, userId, true);
    // 转项由独立门禁按精确等待阶段采集，不能借普通接单/负责人视角复活。
    if (context.movement) return null;
    const submitted = await tx.entranceExamAttempt.count({
      where: {
        candidateUserId: userId,
        exam: { projectId, deleted: false },
        OR: [{ submittedAt: { not: null } }, { cancelledAt: { not: null } }],
      },
    });
    if (submitted) return null;
    const attempt = await tx.entranceExamAttempt.findFirst({
      where: {
        candidateUserId: userId,
        exam: { projectId, deleted: false },
        sourceBizType: context.sourceBizType,
      },
      include: {
        exam: true,
        version: true,
        paper: { include: { questions: { take: 1, select: { id: true } } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (attempt) {
      if (
        (attempt.sourceBizId !== null && attempt.sourceBizId !== context.sourceBizId) ||
        attempt.organizationId !== context.organizationId ||
        attempt.userOrgRelId !== (context.relation?.id ?? null) ||
        attempt.finalResult !== 'PENDING' ||
        (attempt.answerDeadlineAt && attempt.answerDeadlineAt <= now)
      )
        return null;
      // 已入场继续使用绑定旧卷；编辑报名截止或关闭发布不取消答题窗口。
      if (attempt.enteredAt) {
        if (
          !attempt.version ||
          attempt.version.id !== attempt.examVersionId ||
          attempt.version.examId !== attempt.examId ||
          !attempt.paper ||
          attempt.paper.id !== attempt.paperId ||
          attempt.paper.examVersionId !== attempt.examVersionId ||
          !attempt.paper.questions.length
        )
          return null;
        return {
          examId: attempt.examId,
          assignmentId: context.sourceBizId,
          sourceEventAt: attempt.exam.createdAt,
        };
      }
    }
    const exam = await tx.projectEntranceExam.findFirst({
      where: {
        projectId,
        deleted: false,
        status: 'ACTIVE',
        ...(attempt ? { id: attempt.examId } : {}),
        currentVersion: { registrationDeadline: { gt: now } },
      },
      include: { currentVersion: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!exam?.currentVersion || exam.currentVersion.examId !== exam.id) return null;
    return { examId: exam.id, assignmentId: context.sourceBizId, sourceEventAt: exam.createdAt };
  } catch (error) {
    if (!(error instanceof AuthError && [403, 404].includes(error.status))) throw error;
  }
  return null;
}
