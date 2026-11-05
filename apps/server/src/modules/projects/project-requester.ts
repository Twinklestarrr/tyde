import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { participatingStatuses } from '../organizations/organization.domain.js';

export async function resolveCurrentRequester(
  db: PrismaClient | Prisma.TransactionClient,
  principal: AuthPrincipal,
  input: { requesterId?: string | null; requesterType?: 'INDIVIDUAL' | 'ORGANIZATION' | null },
) {
  if (input.requesterId != null && input.requesterId !== principal.userId)
    throw new AppError(403, 'FORBIDDEN', '只能使用当前登录账号作为需求方');
  const user = await db.user.findUnique({
    where: { id: principal.userId },
    include: {
      memberships: {
        where: { joinStatus: { in: participatingStatuses }, organization: { deleted: false } },
        include: { organization: true },
      },
    },
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', '需求方用户不存在');
  if (input.requesterType != null && input.requesterType !== 'INDIVIDUAL')
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '统一账号使用本人作为需求方，组织需求方选择尚未开放',
    );
  const nickname = user.displayName.trim();
  const realName = user.realName?.trim();
  const name = nickname && realName ? `${nickname}(${realName})` : nickname || realName;
  if (!name) throw new AppError(400, 'VALIDATION_ERROR', '当前账号未填写姓名');
  return {
    user,
    requester: {
      requesterType: 'INDIVIDUAL' as const,
      requesterId: user.id,
      requesterName: name,
      orgId: null,
      orgVerifyStatus: null,
    },
  };
}
