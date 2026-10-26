import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { personnelScope } from '../personnel/personnel-access.js';
import { lockPersonnel } from '../personnel/personnel.service.js';
import { todayText } from '../personnel/personnel-domain.js';
import { parseDate, dateText } from '../attendance/attendance-domain.js';
import { reconcileTaskRounds, type TaskSnapshot } from '../projects/project-task-rounds.js';
import { reportProject, reportConflict } from './output-report-access.js';
import { reportQuantity } from './output-report.domain.js';
import { invalidTask } from './production-domain.js';
export interface AcceptanceKey {
  projectId: number;
  subtaskId: number;
}
export interface AcceptanceSubmit extends AcceptanceKey {
  actualQuantity: string | number;
  actualDeliveryDate: string;
  quantityAdjustmentRemark?: string | null;
}
export interface AcceptanceReview extends AcceptanceKey {
  decision: 'ACCEPT' | 'REJECT';
  rejectReason?: string | null;
}
export const acceptanceTypes = [
  'SUBTASK_ACCEPTANCE',
  'SUBTASK_REWORK_REVIEW',
  'SUBTASK_REWORK_SUBMIT',
];
export function acceptanceReady(counts: { verified: number; pending: number; returned: number }) {
  return counts.verified > 0 && counts.pending === 0 && counts.returned === 0;
}
export async function acceptanceTotals(
  tx: Prisma.TransactionClient,
  projectId: number,
  subtaskId: number,
) {
  const groups = await tx.projectOutputReport.groupBy({
    by: ['reviewStatus'],
    where: { projectId, subtaskId },
    _count: { _all: true },
    _sum: { quantity: true },
  });
  const count = (s: string) => groups.find((g) => g.reviewStatus === s)?._count._all ?? 0;
  return {
    verified: count('VERIFIED'),
    pending: count('PENDING'),
    returned: count('RETURNED'),
    quantity:
      groups.find((g) => g.reviewStatus === 'VERIFIED')?._sum.quantity ?? new Prisma.Decimal(0),
  };
}
async function task(tx: Prisma.TransactionClient, q: AcceptanceKey) {
  const r = await tx.projectSubtask.findFirst({
    where: { id: q.subtaskId, projectId: q.projectId },
  });
  if (!r) throw new AuthError(404, 'NOT_FOUND', '子任务不存在');
  return r;
}
export function validateAcceptance(q: AcceptanceSubmit, reported: Prisma.Decimal, now: Date) {
  const actualQuantity = reportQuantity(q.actualQuantity);
  if (!actualQuantity.gt(0)) throw invalidTask('实际交付量须大于0');
  const actualDeliveryDate = parseDate(q.actualDeliveryDate);
  if (q.actualDeliveryDate < todayText(now)) throw invalidTask('实际交付日期不能早于上海当天');
  let quantityAdjustmentRemark = q.quantityAdjustmentRemark?.trim() || null;
  if ((q.quantityAdjustmentRemark?.length ?? 0) > 1000) throw invalidTask('调整备注不能超过1000字');
  if (!actualQuantity.eq(reported) && !quantityAdjustmentRemark)
    throw invalidTask('调整实际交付量时必须填写备注');
  if (actualQuantity.eq(reported)) quantityAdjustmentRemark = null;
  return { actualQuantity, actualDeliveryDate, quantityAdjustmentRemark };
}
export function acceptanceDecision(q: AcceptanceReview) {
  const rejectReason = q.rejectReason?.trim() || null;
  if (
    !['ACCEPT', 'REJECT'].includes(q.decision) ||
    (q.rejectReason?.length ?? 0) > 500 ||
    (q.decision === 'REJECT' ? !rejectReason : !!rejectReason)
  )
    throw invalidTask('驳回须填写原因，通过不能填写原因；原因最多500字');
  return { status: q.decision === 'ACCEPT' ? 'ACCEPTED' : 'REWORK_REQUIRED', rejectReason };
}
export async function acceptanceTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.deleted || project.currentNodeCode === 'COMPLETED') return snapshot;
  const creator = await tx.user.findUnique({ where: { uid: project.createdBy } });
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    include: { candidate: true },
  });
  const tasks = await tx.projectSubtask.findMany({
    where: { projectId, status: { in: ['PENDING_ACCEPTANCE', 'REWORK_REQUIRED'] } },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
  });
  for (const identity of [
    creator?.status === 'ACTIVE'
      ? { userId: creator.id, role: 'NAVIGATOR' as const, perspective: 'NAVIGATOR' }
      : null,
    manager?.candidate.status === 'ACTIVE'
      ? { userId: manager.candidateUserId, role: 'PM' as const, perspective: 'PROJECT_MANAGER' }
      : null,
  ]) {
    if (!identity) continue;
    snapshot.scopes.push({
      ...identity,
      currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_TASK',
      mainEligible: false,
      boardVisible: true,
    });
    for (const taskType of acceptanceTypes) {
      const sources = tasks
        .filter((t) =>
          identity.role === 'PM'
            ? taskType === 'SUBTASK_REWORK_SUBMIT' && t.status === 'REWORK_REQUIRED'
            : t.status === 'PENDING_ACCEPTANCE' &&
              taskType === (t.acceptanceRound > 1 ? 'SUBTASK_REWORK_REVIEW' : 'SUBTASK_ACCEPTANCE'),
        )
        .map((t) => `SUBTASK:${t.id}`);
      if (sources.length) snapshot.sources.push({ ...identity, taskType, sources });
    }
  }
  return snapshot;
}
async function syncAcceptance(
  tx: Prisma.TransactionClient,
  projectId: number,
  before: TaskSnapshot,
  after: TaskSnapshot,
  now: Date,
) {
  const priority = (type: string) =>
    type === 'SUBTASK_REWORK_REVIEW' ? 90 : type === 'SUBTASK_REWORK_SUBMIT' ? 85 : 80;
  for (const scope of [...before.scopes, ...after.scopes]) {
    const where = {
      projectId_userId_perspective: {
        projectId,
        userId: scope.userId,
        perspective: scope.perspective,
      },
    };
    const old = await tx.projectRoleNodeSnapshot.findUnique({ where });
    const owned = old?.sourceBizType === 'SUBTASK' && acceptanceTypes.includes(old.branchNodeCode);
    const source = after.sources
      .filter((s) => s.userId === scope.userId && s.role === scope.role)
      .sort((a, b) => priority(b.taskType) - priority(a.taskType))[0];
    if (!source) {
      if (owned) await tx.projectRoleNodeSnapshot.delete({ where });
      continue;
    }
    if (old && !owned && old.branchPriority >= priority(source.taskType)) continue;
    const id = Number(source.sources[0]!.split(':')[1]);
    const t = await tx.projectSubtask.findUniqueOrThrow({ where: { id } });
    const data = {
      branchNodeCode: source.taskType,
      branchPriority: priority(source.taskType),
      sourceBizType: 'SUBTASK',
      sourceBizId: id,
      sourceEventAt: t.reviewedAt ?? t.submittedAt ?? now,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where,
      create: { projectId, userId: scope.userId, perspective: scope.perspective, ...data },
      update: data,
    });
  }
}
async function publish(
  tx: Prisma.TransactionClient,
  q: AcceptanceKey,
  p: AuthPrincipal,
  before: TaskSnapshot,
  operation: string,
  completed: string[],
  now: Date,
) {
  const after = await acceptanceTasks(tx, q.projectId);
  await reconcileTaskRounds(
    tx,
    q.projectId,
    before,
    after,
    { userId: p.userId, role: p.role as 'PM' | 'NAVIGATOR' },
    completed,
    [],
    acceptanceTypes,
    now,
  );
  await syncAcceptance(tx, q.projectId, before, after, now);
  await tx.projectEventOutbox.create({
    data: {
      projectId: q.projectId,
      eventType: 'PROJECT_SUBTASK_CHANGED',
      operation,
      actorUserId: p.userId,
      payload: {
        schemaVersion: 1,
        projectId: q.projectId,
        subtaskId: q.subtaskId,
        actorUserId: p.userId,
      },
    },
  });
}
export class AcceptanceService {
  constructor(readonly db: PrismaClient) {}
  async context(q: AcceptanceKey, p: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        await reportProject(tx, q.projectId);
        if (p.role !== 'PM')
          throw new AuthError(403, 'FORBIDDEN', '仅策略官或招募协作可查询验收上下文');
        const scope = await personnelScope(tx, q.projectId, p);
        const t = await task(tx, q),
          totals = await acceptanceTotals(tx, q.projectId, q.subtaskId);
        return {
          subtaskId: t.id,
          subtaskName: t.subtaskName,
          expectedDeliveryDate: dateText(t.expectedDeliveryDate),
          expectedQuantity: Number(t.expectedQuantity),
          quantityUnit: t.quantityUnit,
          reportedQuantity: Number(totals.quantity),
          pendingCount: totals.pending,
          returnedCount: totals.returned,
          defaultActualQuantity: Number(totals.quantity),
          defaultActualDeliveryDate: todayText(now),
          canSubmit:
            !scope.readOnly &&
            scope.project.currentNodeCode !== 'COMPLETED' &&
            ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(t.status) &&
            acceptanceReady(totals),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async submit(q: AcceptanceSubmit, p: AuthPrincipal, now = new Date()) {
    if (p.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '仅主策略官可提交验收');
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, q.projectId, [], p.userId);
        const project = await reportProject(tx, q.projectId);
        await personnelScope(tx, q.projectId, p, true);
        const t = await task(tx, q);
        if (
          project.currentNodeCode === 'COMPLETED' ||
          !['IN_PROGRESS', 'REWORK_REQUIRED'].includes(t.status)
        )
          throw reportConflict();
        const totals = await acceptanceTotals(tx, q.projectId, q.subtaskId);
        if (!acceptanceReady(totals))
          throw invalidTask('至少一条已核准报量且无待核查或退回数据才能提交验收');
        const data = validateAcceptance(q, totals.quantity, now),
          before = await acceptanceTasks(tx, q.projectId);
        await tx.projectSubtask.update({
          where: { id: t.id },
          data: {
            ...data,
            status: 'PENDING_ACCEPTANCE',
            reportedQuantity: totals.quantity,
            acceptanceRound: t.acceptanceRound + Number(t.status === 'REWORK_REQUIRED'),
            submittedBy: p.uid,
            submittedAt: now,
            reviewedBy: null,
            reviewedAt: null,
            rejectReason: null,
          },
        });
        await publish(tx, q, p, before, 'ACCEPTANCE_SUBMITTED', ['SUBTASK_REWORK_SUBMIT'], now);
        return null;
      },
      { timeout: 30000 },
    );
  }
  async review(q: AcceptanceReview, p: AuthPrincipal, now = new Date()) {
    if (p.role !== 'NAVIGATOR')
      throw new AuthError(403, 'FORBIDDEN', '仅项目创建人领航员可审核验收');
    const decision = acceptanceDecision(q);
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, q.projectId, [], p.userId);
        const project = await reportProject(tx, q.projectId);
        if (project.createdBy !== p.uid)
          throw new AuthError(403, 'FORBIDDEN', '仅项目创建人领航员可审核验收');
        const t = await task(tx, q);
        if (project.currentNodeCode === 'COMPLETED' || t.status !== 'PENDING_ACCEPTANCE')
          throw reportConflict();
        const before = await acceptanceTasks(tx, q.projectId);
        await tx.projectSubtask.update({
          where: { id: t.id },
          data: { ...decision, reviewedBy: p.uid, reviewedAt: now },
        });
        await publish(
          tx,
          q,
          p,
          before,
          q.decision === 'ACCEPT' ? 'ACCEPTANCE_ACCEPTED' : 'ACCEPTANCE_REJECTED',
          ['SUBTASK_ACCEPTANCE', 'SUBTASK_REWORK_REVIEW'],
          now,
        );
        return null;
      },
      { timeout: 30000 },
    );
  }
}
