import { Prisma, type ApprovalNode, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { personnelScope } from './personnel-access.js';
import { applyMovement } from './personnel-movement-apply.service.js';
import { movementConflict, movementInvalid } from './personnel-movement.domain.js';
import { changeWithProgress } from './personnel-transfer-progress.service.js';
import {
  currentApprovers,
  isManualTransferStep,
  requireTransferPassed,
  requireTransferStage,
} from './personnel-transfer.access.js';
import { lockTransfer } from './personnel-transfer.repository.js';
import {
  type MovementProcessInput,
  type MovementWithdrawInput,
  type Transfer,
} from './personnel-transfer.types.js';
import { todayText } from './personnel.domain.js';

// Keep immutable historical decisions; refresh only the next unprocessed candidate group.
async function activateNext(tx: Prisma.TransactionClient, m: Transfer, seq: number, uid: string) {
  const template = m.flow!.nodes.find((n) => n.nodeSeq === seq);
  if (!template) throw movementConflict('转项流程节点快照异常');
  const users = await currentApprovers(tx, m, template.nodeCode);
  if (!users.length) throw movementConflict('下一节点没有有效审批人');
  await tx.approvalNode.updateMany({
    where: { flowId: m.flowId!, nodeSeq: seq, nodeStatus: { in: ['WAITING', 'PENDING'] } },
    data: { nodeStatus: 'CANCELED', versionNo: { increment: 1 }, updatedBy: uid },
  });
  for (const user of users) {
    const existing = m.flow!.nodes.find((n) => n.nodeSeq === seq && n.approverId === user.id);
    if (existing)
      await tx.approvalNode.update({
        where: { id: existing.id },
        data: { nodeStatus: 'PENDING', versionNo: { increment: 1 }, updatedBy: uid },
      });
    else
      await tx.approvalNode.create({
        data: {
          flowId: m.flowId!,
          flowNo: m.flow!.flowNo,
          nodeSeq: seq,
          nodeCode: template.nodeCode,
          nodeName: template.nodeName,
          approverId: user.id,
          approverUid: user.uid,
          approverName: (user.displayName || user.realName || user.uid).slice(0, 200),
          approverType: 'USER',
          approverSource: template.approverSource ?? Prisma.JsonNull,
          nodeStatus: 'PENDING',
          createdBy: uid,
          updatedBy: uid,
        },
      });
  }
  await tx.approvalFlow.update({
    where: { id: m.flowId! },
    data: {
      currentNode: seq,
      currentNodeCode: template.nodeCode,
      versionNo: { increment: 1 },
      updatedBy: uid,
    },
  });
}

async function terminate(
  tx: Prisma.TransactionClient,
  m: Transfer,
  status: 'REJECTED' | 'WITHDRAWN',
  now: Date,
  uid: string,
) {
  await tx.projectMemberMovement.update({
    where: { id: m.id },
    data: {
      status,
      [status === 'REJECTED' ? 'rejectedAt' : 'withdrawnAt']: now,
      versionNo: { increment: 1 },
      updatedBy: uid,
    },
  });
  if (m.flowId) {
    await tx.approvalFlow.update({
      where: { id: m.flowId },
      data: {
        status,
        finishedAt: now,
        versionNo: { increment: 1 },
        updatedBy: uid,
      },
    });
    await tx.approvalNode.updateMany({
      where: { flowId: m.flowId, nodeStatus: { in: ['WAITING', 'PENDING'] } },
      data: { nodeStatus: 'CANCELED', versionNo: { increment: 1 }, updatedBy: uid },
    });
  }
  // Never revive a member removed by another domain.
  await tx.projectMember.updateMany({
    where: {
      id: m.memberId,
      status: m.movementType === 'TRANSFER' ? 'PENDING_TRANSFER' : 'PENDING_EXIT',
    },
    data: { status: 'ACTIVE', plannedLeaveDate: null, updatedBy: uid },
  });
}

async function decideNode(
  tx: Prisma.TransactionClient,
  m: Transfer,
  node: ApprovalNode,
  accepted: boolean,
  comment: string | null,
  now: Date,
  actor?: AuthPrincipal,
) {
  const uid = actor?.uid ?? 'SYSTEM';
  const changed = await tx.approvalNode.updateMany({
    where: { id: node.id, versionNo: node.versionNo, nodeStatus: 'PENDING' },
    data: {
      nodeStatus: accepted ? 'APPROVED' : 'REJECTED',
      approvedAt: now,
      approveComment: comment,
      versionNo: { increment: 1 },
      updatedBy: uid,
    },
  });
  if (changed.count !== 1) throw movementConflict('审批节点已变化，请刷新');
  await tx.approvalActionLog.create({
    data: {
      flowId: m.flowId!,
      nodeId: node.id,
      actionType: actor
        ? accepted
          ? 'APPROVE'
          : 'REJECT'
        : accepted
          ? 'AUTO_PASS'
          : 'AUTO_REJECT',
      operatorId: actor?.userId,
      operatorName: uid,
      fromStatus: 'PENDING',
      toStatus: accepted ? 'APPROVED' : 'REJECTED',
      actionComment: comment,
    },
  });
  if (!accepted) return terminate(tx, m, 'REJECTED', now, uid);
  await tx.approvalNode.updateMany({
    where: {
      flowId: m.flowId!,
      nodeSeq: node.nodeSeq,
      nodeStatus: 'PENDING',
      id: { not: node.id },
    },
    data: { nodeStatus: 'CANCELED', versionNo: { increment: 1 }, updatedBy: uid },
  });
  if (node.nodeSeq === m.flow!.totalNodes) {
    requireTransferPassed(m);
    await tx.approvalFlow.update({
      where: { id: m.flowId! },
      data: {
        status: 'APPROVED',
        finishedAt: now,
        versionNo: { increment: 1 },
        updatedBy: uid,
      },
    });
    await tx.projectMemberMovement.update({
      where: { id: m.id },
      data: {
        status: 'WAITING_EFFECTIVE',
        versionNo: { increment: 1 },
        updatedBy: uid,
      },
    });
    await applyMovement(
      tx,
      { ...m, status: 'WAITING_EFFECTIVE', flow: { ...m.flow!, status: 'APPROVED' } },
      now,
    );
  } else await activateNext(tx, m, node.nodeSeq + 1, uid);
}

export async function respondTransfer(
  db: PrismaClient,
  input: { movementId: number; decision: 'ACCEPT' | 'REJECT'; rejectReason?: string | null },
  p: AuthPrincipal,
) {
  return db.$transaction(
    async (tx) => {
      return respondTransferInTransaction(tx, input, p);
    },
    { timeout: 30_000 },
  );
}

export async function processMovement(
  db: PrismaClient,
  input: MovementProcessInput,
  p: AuthPrincipal,
) {
  if (
    !['APPROVE', 'REJECT'].includes(input.action) ||
    (input.actionComment != null &&
      (typeof input.actionComment !== 'string' || input.actionComment.length > 500)) ||
    (input.action === 'REJECT' && !input.actionComment?.trim())
  )
    throw movementInvalid('审批动作或意见无效，驳回原因必填且最多500字');
  return db.$transaction(
    async (tx) => {
      const m = await lockTransfer(tx, input.movementId, p.userId);
      if (![m.sourceProjectId, m.targetProjectId].includes(input.projectId))
        throw new AppError(404, 'NOT_FOUND', '当前项目不存在此变动');
      const flow = m.flow;
      if (!flow || flow.flowNo !== input.flowNo.trim() || flow.versionNo !== input.flowVersionNo)
        throw movementConflict('审批流程已变化，请刷新');
      await requireTransferStage(tx, m, flow.currentNodeCode!);
      if (!isManualTransferStep(flow.currentNodeCode!))
        throw movementInvalid('本人接单和考试节点只能由业务结果推进');
      const role = flow.currentNodeCode === 'TARGET_MANAGER' ? 'PM' : 'EXPERT';
      const approvers = await currentApprovers(tx, m, flow.currentNodeCode!);
      if (p.role !== role || !approvers.some((u) => u.id === p.userId))
        throw new AppError(403, 'FORBIDDEN', '当前用户不再具有此节点审批资格');
      const node = flow.nodes.find(
        (n) =>
          n.id === input.nodeId &&
          n.nodeSeq === flow.currentNode &&
          n.approverId === p.userId &&
          n.nodeStatus === 'PENDING',
      );
      if (!node || node.versionNo !== input.nodeVersionNo)
        throw movementConflict('审批节点已变化，请刷新');
      if (flow.currentNodeCode !== 'SOURCE_ORG_OWNER') requireTransferPassed(m);
      await changeWithProgress(tx, m, new Date(), 'PROCESS_MOVEMENT', p.userId, () =>
        decideNode(
          tx,
          m,
          node,
          input.action === 'APPROVE',
          input.actionComment?.trim() || null,
          new Date(),
          p,
        ),
      );
      return null;
    },
    { timeout: 30_000 },
  );
}

export async function withdrawMovement(
  db: PrismaClient,
  input: MovementWithdrawInput,
  p: AuthPrincipal,
  now = new Date(),
) {
  return db.$transaction(
    async (tx) => {
      const m = await lockTransfer(tx, input.movementId, p.userId);
      if (m.sourceProjectId !== input.projectId)
        throw new AppError(404, 'NOT_FOUND', '原项目不存在此变动');
      const scope = await personnelScope(tx, input.projectId, p, true);
      if (
        m.initiatedBy !== p.userId ||
        (scope.organizationIds && !scope.organizationIds.includes(m.member.organizationId!))
      )
        throw new AppError(403, 'FORBIDDEN', '只有仍有该成员管理权限的发起人可以撤回');
      if (
        m.movementType === 'TRANSFER'
          ? m.status !== 'PROCESSING'
          : m.status !== 'WAITING_EFFECTIVE' ||
            m.plannedEffectiveDate.toISOString().slice(0, 10) <= todayText(now)
      )
        throw movementConflict('人员变动已不可撤回');
      await changeWithProgress(tx, m, now, 'WITHDRAW_MOVEMENT', p.userId, async () => {
        await terminate(tx, m, 'WITHDRAWN', now, p.uid);
        if (m.flowId)
          await tx.approvalActionLog.create({
            data: {
              flowId: m.flowId,
              actionType: 'WITHDRAW',
              operatorId: p.userId,
              operatorName: p.uid,
              fromStatus: 'PENDING',
              toStatus: 'WITHDRAWN',
            },
          });
      });
      return null;
    },
    { timeout: 30_000 },
  );
}

// Runs after grading commits. Repeated delivery is harmless; persisted final facts allow retries.
export async function consumeTransferExam(db: PrismaClient, movementId: number, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      const m = await lockTransfer(tx, movementId);
      if (
        m.status !== 'PROCESSING' ||
        m.flow?.status !== 'PENDING' ||
        m.flow.currentNodeCode !== 'TARGET_ENTRANCE_EXAM'
      )
        return false;
      const a = m.targetExamAttempt;
      if (
        !a ||
        a.sourceBizType !== 'PROJECT_MEMBER_TRANSFER' ||
        a.sourceBizId !== m.id ||
        a.exam.projectId !== m.targetProjectId ||
        a.candidateUserId !== m.userId ||
        a.organizationId !== m.member.organizationId ||
        a.userOrgRelId !== m.member.userOrgRelId
      )
        throw movementConflict('转项考试来源不一致');
      const rejected = !!a.cancelledAt || (a.finalResult === 'ELIMINATED' && !!a.finalDecidedAt);
      if (!rejected) {
        if (a.finalResult !== 'ADMITTED' || !a.finalDecidedAt || !a.submittedAt) return false;
        await requireTransferStage(tx, m, 'TARGET_ENTRANCE_EXAM');
        requireTransferPassed(m);
      }
      const node = m.flow.nodes.find(
        (n) => n.nodeSeq === m.flow!.currentNode && n.nodeStatus === 'PENDING',
      );
      if (!node) throw movementConflict('考试等待节点异常');
      await changeWithProgress(tx, m, now, 'CONSUME_TRANSFER_EXAM', undefined, () =>
        decideNode(
          tx,
          m,
          node,
          !rejected,
          rejected ? '目标考试未通过或已取消' : '目标考试通过',
          now,
        ),
      );
      return true;
    },
    { timeout: 30_000 },
  );
}

export async function respondTransferInTransaction(
  tx: Prisma.TransactionClient,
  input: { movementId: number; decision: 'ACCEPT' | 'REJECT'; rejectReason?: string | null },
  p: AuthPrincipal,
) {
  const m = await lockTransfer(tx, input.movementId, p.userId);
  if (p.role !== 'EXPERT' || m.userId !== p.userId)
    throw new AppError(403, 'FORBIDDEN', '只有被调人本人可以接单');
  await requireTransferStage(tx, m, 'MEMBER_CONFIRM');
  const node = m.flow!.nodes.find(
    (n) =>
      n.nodeSeq === m.flow!.currentNode && n.nodeStatus === 'PENDING' && n.approverId === p.userId,
  );
  if (!node) throw movementConflict('本人接单节点异常');
  const now = new Date(),
    accepted = input.decision === 'ACCEPT';
  await changeWithProgress(tx, m, now, 'TRANSFER_RESPONSE', p.userId, () =>
    decideNode(tx, m, node, accepted, accepted ? null : input.rejectReason!.trim(), now, p),
  );
  return {
    assignmentId: null,
    movementId: m.id,
    status: accepted ? 'ACCEPTED' : 'REJECTED',
    memberStatus: null,
    nextAction: accepted ? 'TAKE_ENTRANCE_EXAM' : 'VIEW_RESULT',
    notifiedMemberCount: 0,
  };
}
