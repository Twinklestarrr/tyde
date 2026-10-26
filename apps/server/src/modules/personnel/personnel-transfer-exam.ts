import type { Prisma, PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import {
  transferInclude,
  requireTransferStage,
  lockTransfer,
  consumeTransferExam,
} from './personnel-transfer.js';

export async function transferCandidate(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
  readOnly = false,
) {
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      userId,
      targetProjectId: projectId,
      movementType: 'TRANSFER',
      status: readOnly ? { in: ['PROCESSING', 'WAITING_EFFECTIVE', 'EFFECTIVE'] } : 'PROCESSING',
    },
    include: transferInclude,
    orderBy: { id: 'asc' },
  });
  if (!rows.length) return null;
  const active = rows.filter((m) => m.status !== 'EFFECTIVE');
  if (active.length > 1)
    throw new AuthError(409, 'DUPLICATE', '存在多条待转入记录，请联系项目管理员');
  const movement = active[0] ?? rows[rows.length - 1]!;
  if (!readOnly) await requireTransferStage(tx, movement, 'TARGET_ENTRANCE_EXAM');
  else if (
    movement.member.user.status !== 'ACTIVE' ||
    movement.targetProject?.deleted ||
    (movement.member.organizationId &&
      (movement.member.organization?.deleted ||
        !movement.member.organizationMembership ||
        movement.member.organizationMembership.orgId !== movement.member.organizationId ||
        movement.member.organizationMembership.userId !== movement.userId ||
        !participatingStatuses.includes(movement.member.organizationMembership.joinStatus)))
  )
    throw new AuthError(403, 'FORBIDDEN', '转项考试绑定身份已失效');
  const relation = movement.member.organizationMembership;
  return {
    movement,
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    sourceBizId: movement.id,
    organizationId: movement.member.organizationId,
    user: movement.member.user,
    project: movement.targetProject!,
    relation:
      relation && movement.member.organization
        ? { ...relation, organization: movement.member.organization }
        : undefined,
  };
}
export async function lockTransferCandidate(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
) {
  const m = await tx.projectMemberMovement.findFirst({
    where: {
      targetProjectId: projectId,
      userId,
      movementType: 'TRANSFER',
      status: 'PROCESSING',
    },
    orderBy: { id: 'asc' },
  });
  if (!m) return false;
  await lockTransfer(tx, m.id, userId);
  return true;
}
// Grading/cancellation is already committed. A failed consumer leaves authoritative final facts
// available to the explicit compensation command; never lock a second project under an exam lock.
export async function tryConsumeTransferResult(db: PrismaClient, attemptId: number) {
  try {
    const a = await db.entranceExamAttempt.findUnique({ where: { id: attemptId } });
    if (a?.sourceBizType !== 'PROJECT_MEMBER_TRANSFER' || !a.sourceBizId) return;
    await consumeTransferExam(db, a.sourceBizId);
  } catch {
    console.warn('考试结果消费待补偿', { attemptId });
  }
}

export async function compensateTransferResults(db: PrismaClient) {
  const pending = await db.projectMemberMovement.findMany({
    where: {
      status: 'PROCESSING',
      flow: { status: 'PENDING', currentNodeCode: 'TARGET_ENTRANCE_EXAM' },
      targetExamAttempt: {
        OR: [{ cancelledAt: { not: null } }, { finalDecidedAt: { not: null } }],
      },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  let completed = 0,
    skipped = 0,
    failed = 0;
  for (const m of pending) {
    try {
      if (await consumeTransferExam(db, m.id)) completed++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  return { completed, skipped, failed };
}
