import type { Prisma, PrismaClient } from '@prisma/client';
import { currentApprovers, isManualTransferStep, transferInclude } from './personnel-transfer.js';
import { movementTasks, syncSnapshots } from './personnel-movement-create.js';
import { reconcileTaskRounds } from '../projects/project-task-rounds.js';

// Caller holds this project lock. Refresh only the active manual group belonging to this project.
// Completed decisions, future groups and member/exam waits remain immutable here.
export async function refreshMovementApprovers(
  tx: Prisma.TransactionClient,
  projectId: number,
  now = new Date(),
) {
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      status: 'PROCESSING',
      flow: { status: 'PENDING' },
      OR: [{ sourceProjectId: projectId }, { targetProjectId: projectId }],
    },
    include: transferInclude,
    orderBy: { id: 'asc' },
  });
  if (!rows.length) return 0;
  const before = await movementTasks(tx, projectId);
  const changed: number[] = [];
  for (const m of rows) {
    const flow = m.flow!;
    const code = flow.currentNodeCode!;
    if (
      !isManualTransferStep(code) ||
      (code === 'SOURCE_ORG_OWNER' ? m.sourceProjectId : m.targetProjectId) !== projectId
    )
      continue;
    const users = await currentApprovers(tx, m, code);
    const pending = flow.nodes.filter(
      (n) => n.nodeSeq === flow.currentNode && n.nodeStatus === 'PENDING',
    );
    if (
      pending.length === users.length &&
      pending.every((n) => users.some((u) => u.id === n.approverId))
    )
      continue;
    const template = flow.nodes.find((n) => n.nodeSeq === flow.currentNode)!;
    await tx.approvalNode.updateMany({
      where: {
        flowId: flow.id,
        nodeSeq: flow.currentNode!,
        nodeStatus: 'PENDING',
        approverId: { notIn: users.map((u) => u.id) },
      },
      data: { nodeStatus: 'CANCELED', versionNo: { increment: 1 }, updatedBy: 'SYSTEM' },
    });
    for (const user of users) {
      if (pending.some((n) => n.approverId === user.id)) continue;
      const old = flow.nodes.find(
        (n) => n.nodeSeq === flow.currentNode && n.approverId === user.id,
      );
      if (old)
        await tx.approvalNode.update({
          where: { id: old.id },
          data: {
            nodeStatus: 'PENDING',
            versionNo: { increment: 1 },
            updatedBy: 'SYSTEM',
          },
        });
      else
        await tx.approvalNode.create({
          data: {
            flowId: flow.id,
            flowNo: flow.flowNo,
            nodeSeq: flow.currentNode!,
            nodeCode: code,
            nodeName: template.nodeName,
            approverId: user.id,
            approverUid: user.uid,
            approverName: (user.displayName || user.realName || user.uid).slice(0, 200),
            approverType: 'USER',
            approverSource: template.approverSource ?? undefined,
            nodeStatus: 'PENDING',
            createdBy: 'SYSTEM',
            updatedBy: 'SYSTEM',
          },
        });
    }
    await tx.approvalFlow.update({
      where: { id: flow.id },
      data: { versionNo: { increment: 1 }, updatedBy: 'SYSTEM' },
    });
    await tx.approvalActionLog.create({
      data: {
        flowId: flow.id,
        actionType: 'TRANSFER',
        fromStatus: 'PENDING',
        toStatus: 'PENDING',
        actionComment: '按当前项目负责人或主策略官同步待办候选',
        operatorName: 'SYSTEM',
      },
    });
    changed.push(m.id);
  }
  if (changed.length) {
    const after = await movementTasks(tx, projectId);
    await reconcileTaskRounds(
      tx,
      projectId,
      before,
      after,
      null,
      [],
      [],
      ['MEMBER_MOVEMENT_APPROVAL'],
      now,
    );
    await tx.projectRoleNodeSnapshot.deleteMany({
      where: {
        projectId,
        sourceBizType: 'PROJECT_MEMBER_MOVEMENT',
        branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
      },
    });
    await syncSnapshots(tx, projectId, after, now);
    await tx.projectEventOutbox.create({
      data: {
        projectId,
        eventType: 'PROJECT_MEMBER_MOVEMENTS_CHANGED',
        operation: 'REFRESH_MOVEMENT_APPROVERS',
        payload: { schemaVersion: 1, movementIds: changed, deliveryStatus: 'NOT_DELIVERED' },
      },
    });
  }
  return changed.length;
}

export async function reconcileMovementApprovers(db: PrismaClient, now = new Date()) {
  const rows = await db.projectMemberMovement.findMany({
    where: { status: 'PROCESSING' },
    select: { sourceProjectId: true, targetProjectId: true },
  });
  const ids = [
    ...new Set(
      rows.flatMap((m) => [m.sourceProjectId, ...(m.targetProjectId ? [m.targetProjectId] : [])]),
    ),
  ].sort((a, b) => a - b);
  let refreshed = 0,
    failed = 0;
  for (const id of ids) {
    try {
      refreshed += await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${id} FOR UPDATE`;
          return refreshMovementApprovers(tx, id, now);
        },
        { timeout: 30_000 },
      );
    } catch {
      failed++;
    }
  }
  return { refreshed, failed };
}
