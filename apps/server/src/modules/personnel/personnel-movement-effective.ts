import type { Prisma, PrismaClient } from '@prisma/client';
import { todayText } from './personnel-domain.js';
import { movementConflict } from './personnel-movement.domain.js';
import {
  lockTransfer,
  requireTransferSource,
  requireTransferPassed,
  requireTransferEligibility,
  changeWithProgress,
  type Transfer,
} from './personnel-transfer.js';
import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import {
  collectManagementTasks,
  managementTaskTypes,
  reconcileTaskRounds,
} from '../projects/project-task-rounds.js';

// Caller holds source/target project, member, movement and flow locks.
export async function applyMovement(tx: Prisma.TransactionClient, m: Transfer, now: Date) {
  if (
    m.status !== 'WAITING_EFFECTIVE' ||
    m.plannedEffectiveDate.toISOString().slice(0, 10) > todayText(now)
  )
    return false;
  const transfer = m.movementType === 'TRANSFER';
  if (m.member.status !== (transfer ? 'PENDING_TRANSFER' : 'PENDING_EXIT'))
    throw movementConflict('原项目成员状态与待生效变动不一致');
  const source = await tx.project.findFirst({ where: { id: m.sourceProjectId, deleted: false } });
  if (!source || source.currentNodeCode === 'COMPLETED') throw movementConflict('原项目已失效');
  let assignmentId: number | null = null;
  if (transfer) {
    if (m.flow?.status !== 'APPROVED') throw movementConflict('转项审批尚未完成');
    requireTransferSource(m);
    requireTransferPassed(m);
    await requireTransferEligibility(tx, m);
    const rel = m.member.organizationMembership;
    if (
      rel?.joinStatus === 'PENDING_LEAVE' &&
      rel.plannedLeaveDate &&
      rel.plannedLeaveDate.toISOString().slice(0, 10) <= todayText(now)
    )
      throw movementConflict('来源组织离职日期已到期');
    if (m.member.organizationId) {
      const assignment = await tx.projectExpertAssignment.findFirst({
        where: {
          projectId: m.targetProjectId!,
          organizationId: m.member.organizationId,
          subjectType: 'ORGANIZATION',
          status: 'ACCEPTED',
        },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      });
      if (!assignment) throw movementConflict('目标组织接单已失效');
      assignmentId = assignment.id;
    } else {
      const manager = await tx.projectManagerRecruitment.findFirst({
        where: {
          projectId: m.targetProjectId!,
          status: 'ASSIGNED',
          candidate: { status: 'ACTIVE' },
        },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      });
      if (!manager) throw movementConflict('目标项目主策略官已失效');
    }
  }
  const effectiveAt = new Date(
    m.plannedEffectiveDate.toISOString().slice(0, 10) + 'T00:00:00+08:00',
  );
  await tx.projectMember.update({
    where: { id: m.memberId },
    data: {
      status: transfer ? 'LEFT' : 'REMOVED',
      leftAt: effectiveAt,
      updatedBy: 'SYSTEM',
    },
  });
  if (transfer) {
    const target = m.targetProject!;
    const before = await collectManagementTasks(tx, target);
    await tx.projectMember.create({
      data: {
        projectId: target.id,
        userId: m.userId,
        organizationId: m.member.organizationId,
        userOrgRelId: m.member.userOrgRelId,
        expertAssignmentId: assignmentId,
        admissionAttemptId: m.targetExamAttemptId,
        admittedAt: now,
        entryDecision: 'YES',
        plannedEntryDate: m.plannedEffectiveDate,
        projectRole: m.member.projectRole,
        status: 'ACTIVE',
        joinedAt: effectiveAt,
        createdBy: 'SYSTEM',
        updatedBy: 'SYSTEM',
      },
    });
    const updated =
      target.currentNodeCode === 'PRODUCTION_TASK'
        ? target
        : await tx.project.update({
            where: { id: target.id },
            data: { currentNodeCode: 'PRODUCTION_TASK', updatedBy: 'SYSTEM' },
          });
    await reconcileTaskRounds(
      tx,
      target.id,
      before,
      await collectManagementTasks(tx, updated),
      null,
      [],
      [],
      managementTaskTypes,
      now,
    );
  }
  await tx.projectMemberMovement.update({
    where: { id: m.id },
    data: {
      status: 'EFFECTIVE',
      effectiveAt,
      versionNo: { increment: 1 },
      updatedBy: 'SYSTEM',
    },
  });
  for (const id of [m.sourceProjectId, ...(transfer ? [m.targetProjectId!] : [])])
    await refreshOwnerProgress(tx, id, [m.userId], now);
  return true;
}

export async function processDueMovements(db: PrismaClient, now = new Date()) {
  let effective = 0,
    skipped = 0,
    failed = 0,
    cursor = 0;
  while (true) {
    const rows = await db.projectMemberMovement.findMany({
      where: {
        id: { gt: cursor },
        status: 'WAITING_EFFECTIVE',
        plannedEffectiveDate: { lte: new Date(todayText(now)) },
      },
      orderBy: { id: 'asc' },
      take: 200,
      select: { id: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      try {
        const changed = await db.$transaction(
          async (tx) => {
            const m = await lockTransfer(tx, row.id);
            if (
              m.status !== 'WAITING_EFFECTIVE' ||
              m.plannedEffectiveDate.toISOString().slice(0, 10) > todayText(now)
            )
              return false;
            return changeWithProgress(tx, m, now, 'PROCESS_DUE_MOVEMENT', undefined, () =>
              applyMovement(tx, m, now),
            );
          },
          { timeout: 30_000 },
        );
        if (changed) effective++;
        else skipped++;
      } catch {
        failed++;
      }
    }
    if (rows.length < 200) break;
  }
  return { effective, skipped, failed };
}
