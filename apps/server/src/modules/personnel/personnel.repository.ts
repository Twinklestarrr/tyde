import { Prisma } from '@prisma/client';

export async function lockPersonnel(
  tx: Prisma.TransactionClient,
  projectId: number,
  ids: number[],
  actorUserId: string,
  relatedProjectIds: number[] = [],
) {
  const projectIds = [...new Set([projectId, ...relatedProjectIds])].sort((a, b) => a - b);
  const initial = await tx.projectMember.findMany({
    where: { projectId: projectId, id: { in: ids } },
  });
  const users = [...new Set([actorUserId, ...initial.map((m) => m.userId)])].sort();
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(ARRAY[${Prisma.join(users)}]::uuid[]) ORDER BY "id" FOR SHARE`;
  // 组织成员变更采用用户→组织→成员关系→项目；项目内业务统一先锁项目再锁成员。
  const organizations = await tx.projectExpertAssignment.findMany({
    where: { projectId: { in: projectIds }, organizationId: { not: null } },
    select: { organizationId: true },
  });
  const orgIds = [
    ...new Set([
      ...organizations.map((a) => a.organizationId!),
      ...initial.flatMap((m) => (m.organizationId ? [m.organizationId] : [])),
    ]),
  ].sort();
  if (orgIds.length) {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ANY(ARRAY[${Prisma.join(orgIds)}]::uuid[]) ORDER BY "id" FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "UserOrgRel" WHERE "orgId" = ANY(ARRAY[${Prisma.join(orgIds)}]::uuid[]) ORDER BY "id" FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR UPDATE`;
}
