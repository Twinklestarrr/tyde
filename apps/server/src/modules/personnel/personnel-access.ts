import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { participatingStatuses } from '../organizations/organization.domain.js';

export async function personnelScope(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
  write = false,
) {
  if (!['PM', 'EXPERT'].includes(principal.role))
    throw new AppError(403, 'FORBIDDEN', '请切换至PM或EXPERT角色');
  const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
  if (!project) throw new AppError(404, 'NOT_FOUND', '项目不存在');
  if (principal.role === 'PM') {
    const manager = await tx.projectManagerRecruitment.findFirst({
      where: { projectId, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    const primary = manager?.candidateUserId === principal.userId;
    if (primary || (!write && manager?.expertRecruitmentHandlerUserId === principal.userId))
      return { project, organizationIds: null, readOnly: !primary };
  } else {
    const rels = await tx.userOrgRel.findMany({
      where: {
        userId: principal.userId,
        joinStatus: { in: participatingStatuses },
        organization: { deleted: false },
        user: { status: 'ACTIVE' },
      },
    });
    const assignments = await tx.projectExpertAssignment.findMany({
      where: {
        projectId,
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
        organizationId: { in: rels.map((r) => r.orgId) },
      },
      include: { owners: true },
    });
    const organizationIds = [
      ...new Set(
        assignments
          .filter(
            (a) =>
              rels.some((r) => r.orgId === a.organizationId && r.position === 'OWNER') ||
              (a.owners.length
                ? a.owners.some((o) => o.userId === principal.userId && o.status === 'ACTIVE')
                : a.projectOwnerUserId === principal.userId),
          )
          .map((a) => a.organizationId!),
      ),
    ];
    if (organizationIds.length) return { project, organizationIds, readOnly: false };
  }
  throw new AppError(403, 'FORBIDDEN', '无当前项目人员管理权限');
}
