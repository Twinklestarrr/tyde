import type { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import {
  memberInclude,
  personnelScope,
  qualifiedForEntry,
  type PersonnelMember,
} from '../personnel/personnel-access.js';
import { participatingStatuses } from '../organizations/organization.service.js';
export const forbiddenReport = () => new AuthError(403, 'FORBIDDEN', '无当前项目报量操作权限');
export const reportConflict = () =>
  new AuthError(409, 'DUPLICATE', '数据状态已变化或当前节点不允许操作');
export async function reportProject(tx: Prisma.TransactionClient, projectId: number) {
  const project = await tx.project.findFirst({
    where: { id: projectId, deleted: false, status: 'PUBLISHED' },
  });
  if (!project) throw new AuthError(404, 'NOT_FOUND', '已发布项目不存在');
  return project;
}
export async function reportMembers(
  tx: Prisma.TransactionClient,
  projectId: number,
  now = new Date(),
) {
  const plan = await tx.projectProductionPlan.findUnique({ where: { projectId } });
  const all = await tx.projectMember.findMany({ where: { projectId }, include: memberInclude });
  const active = all.filter(
    (m) =>
      m.status === 'ACTIVE' &&
      !!m.joinedAt &&
      m.joinedAt <= now &&
      !m.leftAt &&
      qualifiedForEntry(m, plan?.needWrittenExam ?? false),
  );
  return { all, active };
}
// 代报/离项后代修正必须是该接单来源的有效项目负责人，组织主管仅取得核查权限。
export function isReportOwner(m: PersonnelMember, userId: string) {
  const a = m.expertAssignment;
  if (
    !a ||
    a.status !== 'ACCEPTED' ||
    a.projectId !== m.projectId ||
    !m.organizationId ||
    a.organizationId !== m.organizationId ||
    m.organization?.deleted
  )
    return false;
  return a.owners.length
    ? a.owners.some(
        (o) => o.userId === userId && o.status === 'ACTIVE' && o.user.status === 'ACTIVE',
      )
    : a.projectOwnerUserId === userId && a.legacyOwner?.status === 'ACTIVE';
}
export function departed(m: PersonnelMember) {
  return (
    ['LEFT', 'REMOVED'].includes(m.status) ||
    !!m.leftAt ||
    (!!m.userOrgRelId &&
      (!m.organizationMembership ||
        ['LEFT', 'REMOVED'].includes(m.organizationMembership.joinStatus)))
  );
}
export async function outputScope(
  tx: Prisma.TransactionClient,
  projectId: number,
  p: AuthPrincipal,
  now = new Date(),
) {
  const project = await reportProject(tx, projectId);
  const { all, active } = await reportMembers(tx, projectId, now);
  if (p.role === 'PM') {
    const scope = await personnelScope(tx, projectId, p);
    return {
      project,
      all,
      active,
      memberIds: null,
      correctionIds: [] as number[],
      reviewer: !scope.readOnly,
      readOnly: scope.readOnly,
      organizationIds: null,
    };
  }
  if (p.role !== 'EXPERT') throw forbiddenReport();
  let organizationIds: string[] = [];
  try {
    organizationIds = (await personnelScope(tx, projectId, p)).organizationIds ?? [];
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 403) throw error;
  }
  // 本人的有效组织关系也用于代修正，不能沿用离组后的负责人历史身份。
  const rels = await tx.userOrgRel.findMany({
    where: {
      userId: p.userId,
      joinStatus: { in: participatingStatuses },
      organization: { deleted: false },
    },
  });
  const owns = (m: PersonnelMember) =>
    rels.some((r) => r.orgId === m.organizationId) && isReportOwner(m, p.userId);
  const managed = all.filter((m) => organizationIds.includes(m.organizationId ?? ''));
  const own = active.filter((m) => m.userId === p.userId);
  const correctionIds = all
    .filter((m) => (departed(m) ? owns(m) : own.some((o) => o.id === m.id)))
    .map((m) => m.id);
  if (!managed.length && !own.length && !correctionIds.length && !organizationIds.length)
    throw forbiddenReport();
  return {
    project,
    all,
    active,
    memberIds: [...new Set([...managed, ...own].map((m) => m.id).concat(correctionIds))],
    correctionIds,
    reviewer: organizationIds.length > 0,
    readOnly: false,
    organizationIds,
  };
}
export type OutputScope = Awaited<ReturnType<typeof outputScope>>;
export function reportActions(
  scope: OutputScope,
  memberId: number,
  status: string,
  writable: boolean,
) {
  if (scope.readOnly || !writable) return [];
  if (
    scope.reviewer &&
    status === 'PENDING' &&
    (scope.memberIds === null ||
      scope.all.some(
        (m) => m.id === memberId && scope.organizationIds?.includes(m.organizationId ?? ''),
      ))
  )
    return ['VERIFY', 'RETURN'];
  return status === 'RETURNED' && scope.correctionIds.includes(memberId) ? ['SAVE_REPORT'] : [];
}
export async function writableReport(
  tx: Prisma.TransactionClient,
  projectId: number,
  subtaskId: number | null,
) {
  const project = await reportProject(tx, projectId);
  if (project.currentNodeCode === 'COMPLETED') throw reportConflict();
  if (subtaskId === null) {
    if (project.currentNodeCode !== 'PRODUCTION_TASK') throw reportConflict();
    return { quantityUnit: project.quantityUnit, task: null };
  }
  const task = await tx.projectSubtask.findFirst({ where: { id: subtaskId, projectId } });
  if (!task) throw new AuthError(404, 'NOT_FOUND', '子任务不存在');
  if (task.status !== 'IN_PROGRESS') throw reportConflict();
  return { quantityUnit: task.quantityUnit, task };
}
