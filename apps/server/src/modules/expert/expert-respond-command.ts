import { Prisma, type PrismaClient } from '@prisma/client';
import {
  respondTransfer,
  respondTransferInTransaction,
  lockTransfer,
} from '../personnel/personnel-transfer.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import {
  ownerTargets,
  refreshOwnerProgress,
  type OwnerChangeInput,
} from './expert-owner-command.js';
import {
  collectRecruitmentTasks,
  syncRecruitmentRetrySnapshot,
} from '../projects/project-recruitment-snapshot.js';
import { reconcileTaskRounds, taskEventFacts } from '../projects/project-task-rounds.js';

export interface RespondInput extends Omit<OwnerChangeInput, 'assignmentId'> {
  assignmentId?: number | null;
  movementId?: number | null;
  decision: 'ACCEPT' | 'REJECT';
  rejectReason?: string | null;
}
const bad = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const conflict = () => new AuthError(409, 'CONFLICT', '该任务已经处理，请刷新后重试');
export function validateResponse(input: RespondInput) {
  const positive = (id: number) => Number.isInteger(id) && id > 0 && id <= 2147483647;
  if (
    (input.assignmentId == null) === (input.movementId == null) ||
    (input.assignmentId != null && !positive(input.assignmentId)) ||
    (input.movementId != null && !positive(input.movementId)) ||
    !['ACCEPT', 'REJECT'].includes(input.decision)
  )
    throw bad('请指定唯一有效接单来源及接单决定');
  if (
    input.rejectReason != null &&
    (typeof input.rejectReason !== 'string' || input.rejectReason.length > 500)
  )
    throw bad('拒绝原因最多500字符');
  if (input.decision === 'REJECT' && !input.rejectReason?.trim())
    throw bad('拒绝时必须填写拒绝原因');
  if (input.projectOwnerUserId != null || (input.projectOwnerUserIds?.length ?? 0) > 0)
    ownerTargets({ ...input, assignmentId: input.assignmentId ?? input.movementId! });
}

export async function respondToAssignment(db: PrismaClient, input: RespondInput, p: AuthPrincipal) {
  if (p.role !== 'EXPERT') throw new AuthError(403, 'FORBIDDEN', '仅执行专家可访问');
  validateResponse(input);
  if (input.movementId != null) {
    if (input.projectOwnerUserId != null || (input.projectOwnerUserIds?.length ?? 0) > 0)
      throw bad('转项接单不能指定项目负责人');
    return respondTransfer(db, { ...input, movementId: input.movementId }, p);
  }
  const assignmentId = input.assignmentId!;
  const requested =
    input.projectOwnerUserId != null || (input.projectOwnerUserIds?.length ?? 0) > 0
      ? ownerTargets({ ...input, assignmentId })
      : [];
  return db.$transaction(
    async (tx) => {
      // Discover both projects before taking locks; transfer commands always lock in the same order.
      const source = await tx.projectExpertAssignment.findFirst({
        where: { id: assignmentId, project: { deleted: false } },
      });
      const pending =
        source && (source.subjectType === 'INDIVIDUAL' || source.status === 'ACCEPTED')
          ? await tx.projectMemberMovement.findMany({
              where: {
                userId: p.userId,
                targetProjectId: source.projectId,
                movementType: 'TRANSFER',
                status: 'PROCESSING',
                flow: { status: 'PENDING', currentNodeCode: 'MEMBER_CONFIRM' },
                member: { organizationId: source.organizationId },
              },
              select: { id: true },
            })
          : [];
      if (pending.length > 1) throw conflict();
      const movementId = pending[0]?.id;
      if (movementId) await lockTransfer(tx, movementId, p.userId);
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=ANY(ARRAY[${Prisma.join([...new Set([p.userId, ...requested])].sort())}]::uuid[]) ORDER BY "id" FOR SHARE`;
      const initial = await tx.projectExpertAssignment.findFirst({
        where: { id: assignmentId, project: { deleted: false } },
      });
      if (!initial) throw new AuthError(404, 'NOT_FOUND', '执行专家任务不存在');
      if (initial.organizationId) {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id"=${initial.organizationId}::uuid AND "deleted"=false FOR SHARE`;
        await tx.$queryRaw`SELECT "id" FROM "UserOrgRel" WHERE "orgId"=${initial.organizationId}::uuid ORDER BY "id" FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${initial.projectId} AND "deleted"=false FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ProjectExpertAssignment" WHERE "id"=${assignmentId} FOR UPDATE`;
      const a = await tx.projectExpertAssignment.findFirst({
        where: { id: assignmentId, project: { deleted: false } },
        include: { owners: true, project: true },
      });
      if (!a) throw new AuthError(404, 'NOT_FOUND', '执行专家任务不存在');
      const members = a.organizationId
        ? await tx.userOrgRel.findMany({
            where: {
              orgId: a.organizationId,
              joinStatus: { in: participatingStatuses },
              organization: { deleted: false },
              user: { status: 'ACTIVE' },
            },
          })
        : [];
      const relation = members.find((r) => r.userId === p.userId);
      if (
        a.subjectType === 'INDIVIDUAL'
          ? a.expertUserId !== p.userId
          : a.subjectType !== 'ORGANIZATION' || !relation
      )
        throw new AuthError(403, 'FORBIDDEN', '无权响应此执行专家任务');
      const memberResponse = a.subjectType === 'ORGANIZATION' && a.status === 'ACCEPTED';
      const owner = a.owners.length
        ? a.owners.some((o) => o.status === 'ACTIVE' && o.userId === p.userId)
        : a.projectOwnerUserId === p.userId;
      if (
        memberResponse
          ? relation?.position === 'OWNER' && !owner
          : a.subjectType === 'ORGANIZATION' && relation?.position !== 'OWNER'
      )
        throw new AuthError(403, 'FORBIDDEN', '组织主管不能作为普通成员接单，主体响应须有效主管');
      if (a.project.currentNodeCode === 'COMPLETED') throw conflict();
      if ((memberResponse || a.subjectType === 'INDIVIDUAL') && requested.length)
        throw bad('个人或组织成员响应不能指定项目负责人');
      const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      const plan = await tx.projectProductionPlan.findUnique({ where: { projectId: a.projectId } });
      let nextAction =
        input.decision === 'REJECT'
          ? memberResponse
            ? 'VIEW_RESULT'
            : 'NONE'
          : plan?.needWrittenExam
            ? 'TAKE_ENTRANCE_EXAM'
            : 'WAIT_ENTRY_CONFIRMATION';
      if (memberResponse && owner && input.decision === 'ACCEPT')
        nextAction = 'MANAGE_PROJECT_MEMBERS';
      const result = (memberStatus: string | null, notifiedMemberCount = 0) => ({
        assignmentId,
        movementId: movementId ?? null,
        status: memberResponse ? a.status : status,
        memberStatus,
        nextAction,
        notifiedMemberCount,
      });
      const now = new Date();
      if (memberResponse) {
        const existing = await tx.projectExpertAssignmentMember.findUnique({
          where: { assignmentId_userId: { assignmentId, userId: p.userId } },
        });
        if (existing) {
          if (existing.status !== status) throw conflict();
          if (!movementId) return result(existing.status);
        }
      } else if (a.status !== 'PENDING_ACCEPTANCE') throw conflict();
      if (
        !memberResponse &&
        a.subjectType === 'ORGANIZATION' &&
        input.decision === 'ACCEPT' &&
        (!requested.length || requested.some((id) => !members.some((m) => m.userId === id)))
      )
        throw bad('组织接单须指定1至20名该组织有效成员为项目负责人');
      const before = await collectRecruitmentTasks(tx, a.project);
      const reason = input.decision === 'REJECT' ? input.rejectReason!.trim() : null;
      if (memberResponse) {
        if (
          !(await tx.projectExpertAssignmentMember.findUnique({
            where: { assignmentId_userId: { assignmentId, userId: p.userId } },
          }))
        )
          await tx.projectExpertAssignmentMember.create({
            data: {
              assignmentId,
              userId: p.userId,
              userOrgRelId: relation!.id,
              status,
              rejectReason: reason,
              respondedAt: now,
              createdBy: p.uid,
              updatedBy: p.uid,
            },
          });
      } else {
        await tx.projectExpertAssignment.update({
          where: { id: assignmentId },
          data: {
            status,
            acceptedAt: status === 'ACCEPTED' ? now : null,
            rejectedAt: status === 'REJECTED' ? now : null,
            rejectReason: reason,
            ...(a.subjectType === 'ORGANIZATION' && status === 'ACCEPTED'
              ? { projectOwnerUserId: requested.length === 1 ? requested[0] : null }
              : {}),
            updatedBy: p.uid,
          },
        });
      }
      if (movementId) {
        await respondTransferInTransaction(tx, { ...input, movementId }, p);
        nextAction = input.decision === 'ACCEPT' ? 'TAKE_ENTRANCE_EXAM' : 'VIEW_RESULT';
      }
      const participants =
        input.decision !== 'ACCEPT'
          ? []
          : !memberResponse && a.subjectType === 'ORGANIZATION'
            ? requested
            : [p.userId];
      if (!memberResponse && a.subjectType === 'ORGANIZATION' && status === 'ACCEPTED') {
        nextAction = 'MANAGE_PROJECT_MEMBERS';
        for (const userId of requested) {
          await tx.projectExpertAssignmentOwner.upsert({
            where: { assignmentId_userId: { assignmentId, userId } },
            create: { assignmentId, userId, createdBy: p.uid, appointedAt: now },
            update: { status: 'ACTIVE', appointedAt: now, removedAt: null, updatedBy: p.uid },
          });
          await tx.projectExpertAssignmentMember.upsert({
            where: { assignmentId_userId: { assignmentId, userId } },
            create: {
              assignmentId,
              userId,
              userOrgRelId: members.find((m) => m.userId === userId)!.id,
              status: 'SELECTED',
              respondedAt: now,
              createdBy: p.uid,
            },
            update: { status: 'SELECTED', rejectReason: null, respondedAt: now, updatedBy: p.uid },
          });
        }
      }
      for (const userId of participants) {
        if (
          !movementId &&
          !plan?.needWrittenExam &&
          !(await tx.projectMember.findFirst({
            where: { expertAssignmentId: assignmentId, userId },
          }))
        )
          await tx.projectMember.create({
            data: {
              projectId: a.projectId,
              userId,
              expertAssignmentId: assignmentId,
              organizationId: a.organizationId,
              userOrgRelId: members.find((m) => m.userId === userId)?.id ?? null,
              status: 'PENDING_CONFIRM',
              projectRole: 'MEMBER',
              admittedAt: now,
              createdBy: p.uid,
            },
          });
      }
      // 组织首次接单会改变全体有效成员的身份优先级，须撤销被组织待响应身份覆盖的个人旧轮次。
      const affected =
        !memberResponse && a.subjectType === 'ORGANIZATION' && status === 'ACCEPTED'
          ? members.map((m) => m.userId)
          : [p.userId, ...participants];
      await refreshOwnerProgress(tx, a.projectId, [...new Set(affected)], now);
      const after = await collectRecruitmentTasks(tx, a.project);
      await reconcileTaskRounds(
        tx,
        a.projectId,
        before,
        after,
        null,
        [],
        [],
        ['EXPERT_RECRUITMENT_RETRY'],
        now,
      );
      await syncRecruitmentRetrySnapshot(tx, a.projectId, after);
      await tx.projectEventOutbox.create({
        data: {
          projectId: a.projectId,
          eventType: 'EXPERT_ASSIGNMENT_RESPONDED',
          operation: 'expert.respond',
          actorUserId: p.userId,
          payload: {
            schemaVersion: 1,
            assignmentId,
            decision: input.decision,
            memberResponse,
            organizationId: a.organizationId,
            participantUserIds: participants,
            ...taskEventFacts(before, after),
          },
        },
      });
      return result(
        memberResponse ? status : null,
        !memberResponse && a.subjectType === 'ORGANIZATION' && status === 'ACCEPTED'
          ? members.length
          : 0,
      );
    },
    { timeout: 30_000 },
  );
}
