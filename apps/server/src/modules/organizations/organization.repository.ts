import type { Prisma } from '@prisma/client';

// 后续成员写操作亦须先锁组织，再检查关系，统一组织内角色/人数/权限变更的锁顺序。
export async function lockOrganization(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`;
}
