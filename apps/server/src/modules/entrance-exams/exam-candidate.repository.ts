import { Prisma } from '@prisma/client';
import { lockTransferCandidate } from '../personnel/personnel-transfer.repository.js';

export async function lockCandidate(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
) {
  if (await lockTransferCandidate(tx, projectId, userId)) return;
  // 用户→组织→关系→项目，与离组/成员响应保持同序；项目锁串行化首次建档及考试编辑/关闭。
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId}::uuid FOR SHARE`;
  const rels = await tx.userOrgRel.findMany({
    where: { userId: userId },
    orderBy: { orgId: 'asc' },
  });
  const orgIds = [...new Set(rels.map((r) => r.orgId))].sort();
  if (orgIds.length)
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id"=ANY(ARRAY[${Prisma.join(orgIds)}]::uuid[]) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "UserOrgRel" WHERE "userId"=${userId}::uuid ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${projectId} AND "deleted"=false FOR UPDATE`;
}
