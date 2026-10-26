import type { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
export async function personnelScope(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
  write = false,
) {
  if (!['PM', 'EXPERT'].includes(principal.role))
    throw new AuthError(403, 'FORBIDDEN', '请切换至PM或EXPERT角色');
  const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
  if (!project) throw new AuthError(404, 'NOT_FOUND', '项目不存在');
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
  throw new AuthError(403, 'FORBIDDEN', '无当前项目人员管理权限');
}
export const memberInclude = {
  user: true,
  organization: true,
  organizationMembership: true,
  expertAssignment: {
    include: {
      owners: { include: { user: true }, orderBy: { id: 'asc' as const } },
      legacyOwner: true,
      memberResponses: true,
    },
  },
  admissionAttempt: { include: { exam: { select: { projectId: true } } } },
} satisfies Prisma.ProjectMemberInclude;
export type PersonnelMember = Prisma.ProjectMemberGetPayload<{ include: typeof memberInclude }>;
export function qualifiedForEntry(member: PersonnelMember, needWrittenExam: boolean) {
  const a = member.expertAssignment;
  if (
    !a ||
    a.status !== 'ACCEPTED' ||
    a.projectId !== member.projectId ||
    member.user.status !== 'ACTIVE' ||
    !member.admittedAt
  )
    return false;
  if (member.organizationId) {
    const rel = member.organizationMembership;
    if (
      a.subjectType !== 'ORGANIZATION' ||
      a.organizationId !== member.organizationId ||
      member.organization?.deleted ||
      !rel ||
      rel.orgId !== member.organizationId ||
      rel.userId !== member.userId ||
      !participatingStatuses.includes(rel.joinStatus)
    )
      return false;
    const response = a.memberResponses.find(
      (r) => r.userId === member.userId && r.userOrgRelId === rel.id,
    );
    const owner = a.owners.length
      ? a.owners.some((o) => o.userId === member.userId && o.status === 'ACTIVE')
      : a.projectOwnerUserId === member.userId;
    if (!owner && (!response || !['ACCEPTED', 'SELECTED'].includes(response.status))) return false;
  } else if (
    a.subjectType !== 'INDIVIDUAL' ||
    a.expertUserId !== member.userId ||
    member.userOrgRelId
  )
    return false;
  const attempt = member.admissionAttempt;
  return (
    !needWrittenExam ||
    !!(
      attempt &&
      attempt.candidateUserId === member.userId &&
      attempt.organizationId === member.organizationId &&
      attempt.finalResult === 'ADMITTED' &&
      attempt.exam.projectId === member.projectId &&
      attempt.userOrgRelId === member.userOrgRelId &&
      attempt.sourceBizId === a.id &&
      !attempt.cancelledAt
    )
  );
}
