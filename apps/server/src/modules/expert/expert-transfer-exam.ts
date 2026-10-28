import type { Prisma } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import { requireTransferEligibility, type Transfer } from '../personnel/personnel-transfer.js';

// 转项考试没有普通接单关系；读取与快照必须沿同一真实流程、来源及答题窗口判断。
export async function hasTransferExamTask(
  tx: Prisma.TransactionClient,
  movement: Transfer,
  now: Date,
) {
  const flow = movement.flow;
  if (
    movement.movementType !== 'TRANSFER' ||
    !movement.targetProject ||
    movement.targetProject.deleted ||
    movement.targetProject.status !== 'PUBLISHED' ||
    movement.targetProject.currentNodeCode === 'COMPLETED' ||
    movement.status !== 'PROCESSING' ||
    flow?.status !== 'PENDING' ||
    flow.currentNodeCode !== 'TARGET_ENTRANCE_EXAM' ||
    !flow.nodes.some(
      (n) =>
        n.nodeSeq === flow.currentNode &&
        n.nodeCode === 'TARGET_ENTRANCE_EXAM' &&
        n.nodeStatus === 'PENDING' &&
        n.approverId === movement.userId,
    )
  )
    return false;
  try {
    await requireTransferEligibility(tx, movement);
  } catch (error) {
    if (error instanceof AuthError && [403, 409].includes(error.status)) return false;
    throw error;
  }
  const attempt = movement.targetExamAttempt;
  if (attempt) {
    if (
      attempt.id !== movement.targetExamAttemptId ||
      attempt.sourceBizType !== 'PROJECT_MEMBER_TRANSFER' ||
      attempt.sourceBizId !== movement.id ||
      attempt.candidateUserId !== movement.userId ||
      attempt.organizationId !== movement.member.organizationId ||
      attempt.userOrgRelId !== movement.member.userOrgRelId ||
      attempt.exam.projectId !== movement.targetProjectId ||
      attempt.exam.deleted ||
      attempt.submittedAt ||
      attempt.cancelledAt ||
      attempt.finalResult !== 'PENDING' ||
      (attempt.answerDeadlineAt && attempt.answerDeadlineAt <= now)
    )
      return false;
    // 已入场绑定历史版本，关闭发布或报名截止不撤销尚在答题窗口中的任务。
    if (attempt.enteredAt) return true;
  }
  const used = await tx.entranceExamAttempt.findMany({
    where: { candidateUserId: movement.userId },
    select: { examId: true },
  });
  const exam = await tx.projectEntranceExam.findFirst({
    where: {
      projectId: movement.targetProjectId!,
      deleted: false,
      status: 'ACTIVE',
      currentVersion: { registrationDeadline: { gt: now } },
      ...(attempt ? { id: attempt.examId } : { id: { notIn: used.map((a) => a.examId) } }),
    },
    include: { currentVersion: true },
  });
  return !!exam?.currentVersion && exam.currentVersion.examId === exam.id;
}
