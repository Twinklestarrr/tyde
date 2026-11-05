import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { transferInclude } from './personnel-transfer.types.js';
import { lockPersonnel } from './personnel.repository.js';

// All commands take the same user/organization/project locks before member, movement and flow.
// The initial read only discovers the immutable source/target IDs; state is read again under locks.
export async function lockTransfer(tx: Prisma.TransactionClient, id: number, actor?: string) {
  const initial = await tx.projectMemberMovement.findUnique({ where: { id } });
  if (!initial) throw new AppError(404, 'NOT_FOUND', '人员变动不存在');
  await lockPersonnel(
    tx,
    initial.sourceProjectId,
    [initial.memberId],
    actor ?? initial.userId,
    initial.targetProjectId ? [initial.targetProjectId] : [],
  );
  await tx.$queryRaw`SELECT "id" FROM "ProjectMember" WHERE "id"=${initial.memberId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ProjectMemberMovement" WHERE "id"=${id} FOR UPDATE`;
  if (initial.flowId)
    await tx.$queryRaw`SELECT "id" FROM "ApprovalFlow" WHERE "id"=${initial.flowId}::uuid FOR UPDATE`;
  return tx.projectMemberMovement.findUniqueOrThrow({ where: { id }, include: transferInclude });
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
