import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { dateText } from '../attendance/attendance.domain.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { refreshOwnerProgress } from '../expert/expert-progress.service.js';
import { personnelScope } from '../personnel/personnel-access.js';
import { todayText } from '../personnel/personnel.domain.js';
import { lockPersonnel } from '../personnel/personnel.repository.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import { reconcileTaskRounds } from '../projects/project-task-rounds.js';
import { type TaskSnapshot } from '../projects/project-task.types.js';
import {
  acceptanceDecision,
  acceptanceReady,
  acceptanceTypes,
  validateAcceptance,
} from './acceptance.domain.js';
import { acceptanceTasks, acceptanceTotals } from './acceptance.repository.js';
import {
  type AcceptanceKey,
  type AcceptanceReview,
  type AcceptanceSubmit,
} from './acceptance.types.js';
import { reportConflict, reportProject } from './output-report-access.js';
import { invalidTask } from './production.domain.js';

async function task(tx: Prisma.TransactionClient, q: AcceptanceKey) {
  const r = await tx.projectSubtask.findFirst({
    where: { id: q.subtaskId, projectId: q.projectId },
  });
  if (!r) throw new AppError(404, 'NOT_FOUND', '子任务不存在');
  return r;
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
  await refreshOwnerProgress(tx, q.projectId, null, now);
  const cardChanges = await refreshManagementCardSnapshots(tx, q.projectId, now);
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
        ...cardChanges,
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
          throw new AppError(403, 'FORBIDDEN', '仅策略官或招募协作可查询验收上下文');
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
    if (p.role !== 'PM') throw new AppError(403, 'FORBIDDEN', '仅主策略官可提交验收');
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
      throw new AppError(403, 'FORBIDDEN', '仅项目创建人领航员可审核验收');
    const decision = acceptanceDecision(q);
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, q.projectId, [], p.userId);
        const project = await reportProject(tx, q.projectId);
        if (project.createdBy !== p.uid)
          throw new AppError(403, 'FORBIDDEN', '仅项目创建人领航员可审核验收');
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
