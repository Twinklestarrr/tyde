import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { requireTransferStage } from './personnel-transfer.access.js';
import { transferInclude } from './personnel-transfer.types.js';

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
    throw new AppError(409, 'DUPLICATE', '存在多条待转入记录，请联系项目管理员');
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
    throw new AppError(403, 'FORBIDDEN', '转项考试绑定身份已失效');
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
