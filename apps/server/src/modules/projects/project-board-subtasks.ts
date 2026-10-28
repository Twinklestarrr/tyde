import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { boardStatisticsScope } from './project-workbench-statistics.js';
import { projectTime } from './project-time.js';

const Decimal = Prisma.Decimal.clone({ precision: 64 });
const statusNames: Record<string, string> = {
  IN_PROGRESS: '进行中',
  PENDING_ACCEPTANCE: '待验收',
  REWORK_REQUIRED: '驳回返修',
  ACCEPTED: '已验收',
};
const dayNumber = (day: string) => Date.parse(day) / 86_400_000;

export async function resolveBoardAccess(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
) {
  if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
    throw new AuthError(400, 'VALIDATION_ERROR', 'projectId必须为32位正整数');
  const scope = boardStatisticsScope(principal);
  const project = await tx.project.findFirst({
    where: { id: projectId, deleted: false, status: 'PUBLISHED', AND: [scope] },
    select: { id: true, projectName: true, deadline: true, currentNodeCode: true },
  });
  if (!project) throw new AuthError(403, 'FORBIDDEN', '当前用户无权查看该项目看板');
  const assignments =
    principal.role === 'EXPERT'
      ? await tx.projectExpertAssignment.findMany({
          where: { ...scope.expertAssignments!.some!, projectId },
          select: { organizationId: true },
        })
      : null;
  const organizationIds = assignments?.flatMap((a) => (a.organizationId ? [a.organizationId] : []));
  if (organizationIds && !organizationIds.length)
    throw new AuthError(403, 'FORBIDDEN', '当前执行专家不再管理该项目组织');
  return { project, organizationIds };
}

export async function boardSubtasks(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
  now: Date,
) {
  const access = await resolveBoardAccess(tx, projectId, principal);
  return loadBoardSubtasks(tx, projectId, access.organizationIds, now);
}

export async function loadBoardSubtasks(
  tx: Prisma.TransactionClient,
  projectId: number,
  organizationIds: string[] | undefined,
  now: Date,
) {
  const member = organizationIds ? { organizationId: { in: organizationIds } } : undefined;
  const subtasks = await tx.projectSubtask.findMany({
    where: {
      projectId,
      ...(member
        ? { OR: [{ assignees: { some: { member } } }, { outputReports: { some: { member } } }] }
        : {}),
    },
    orderBy: [{ expectedDeliveryDate: 'asc' }, { id: 'asc' }],
  });
  if (!subtasks.length) return [];
  const ids = subtasks.map((s) => s.id);
  const reports = await tx.projectOutputReport.groupBy({
    by: ['subtaskId'],
    where: { projectId, subtaskId: { in: ids }, ...(member ? { member } : {}) },
    _sum: { quantity: true },
  });
  const allCounts = member
    ? await tx.projectSubtaskAssignee.groupBy({
        by: ['subtaskId'],
        where: { projectId, subtaskId: { in: ids } },
        _count: { memberId: true },
      })
    : [];
  const scopedCounts = member
    ? await tx.projectSubtaskAssignee.groupBy({
        by: ['subtaskId'],
        where: { projectId, subtaskId: { in: ids }, member },
        _count: { memberId: true },
      })
    : [];
  const quantities = new Map(reports.map((r) => [r.subtaskId, r._sum.quantity]));
  const total = new Map(allCounts.map((r) => [r.subtaskId, r._count.memberId]));
  const scoped = new Map(scopedCounts.map((r) => [r.subtaskId, r._count.memberId]));
  const today = projectTime(now).slice(0, 10);
  return subtasks.map((s) => {
    let reported = new Decimal(quantities.get(s.id) ?? 0);
    let target = new Decimal(s.expectedQuantity ?? 0);
    if (member && s.distributionMode === 'DESIGNATED') {
      const ownCount = scoped.get(s.id) ?? 0;
      const totalCount = total.get(s.id) ?? 0;
      reported = ownCount ? reported.div(ownCount) : new Decimal(0);
      target = totalCount ? target.div(totalCount) : new Decimal(0);
    }
    const start = projectTime(s.createdAt).slice(0, 10);
    const end = s.expectedDeliveryDate.toISOString().slice(0, 10);
    const delivered = ['PENDING_ACCEPTANCE', 'ACCEPTED'].includes(s.status);
    const duration = dayNumber(end) - dayNumber(start) + 1;
    const elapsed = Math.max(0, Math.min(duration, dayNumber(today) - dayNumber(start) + 1));
    const planned = target.mul(elapsed);
    const validPlan = duration > 0 && target.gt(0);
    return {
      subtaskId: s.id,
      subtaskNo: s.subtaskNo,
      subtaskName: s.subtaskName,
      status: s.status,
      statusName: statusNames[s.status] ?? null,
      distributionMode: s.distributionMode,
      plannedStartDate: start,
      expectedQuantityToDate: validPlan
        ? planned.div(duration).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toNumber()
        : null,
      progressLowRisk: validPlan && !delivered && reported.mul(duration).lt(planned),
      expectedDeliveryDate: end,
      reportedQuantity: reported.toNumber(),
      targetQuantity: target.toNumber(),
      progressPercent: target.gt(0)
        ? reported.mul(100).div(target).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
        : 0,
      quantityUnit: s.quantityUnit,
      overdueRisk: today >= end && !delivered,
    };
  });
}
