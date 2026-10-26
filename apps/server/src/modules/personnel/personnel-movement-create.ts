import { todayText } from './personnel-domain.js';
import { applyMovement } from './personnel-movement-effective.js';
import { transferInclude } from './personnel-transfer.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { displayName } from '../projects/project-detail.js';
import { lockPersonnel } from './personnel.service.js';
import { personnelScope, memberInclude } from './personnel-access.js';
import {
  movementConflict,
  movementInvalid,
  transferSteps,
  validateMovement,
  type MovementInput,
} from './personnel-movement.domain.js';
import { reconcileTaskRounds, type TaskSnapshot } from '../projects/project-task-rounds.js';

const names: Record<string, string> = {
  SOURCE_ORG_OWNER: '原项目组织负责人审批',
  MEMBER_CONFIRM: '本人接单',
  TARGET_ENTRANCE_EXAM: '目标项目准入考试',
  TARGET_MANAGER: '目标项目主策略官审批',
  TARGET_ORG_OWNER: '目标项目组织负责人审批',
};
const personName = (u: User) => displayName(u.displayName, u.realName, u.uid);
export async function projectOwners(
  tx: Prisma.TransactionClient,
  projectId: number,
  organizationId: string,
) {
  const assignment = await tx.projectExpertAssignment.findFirst({
    where: { projectId, organizationId, subjectType: 'ORGANIZATION', status: 'ACCEPTED' },
    include: { owners: true },
    orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
  });
  const ids = assignment?.owners.length
    ? assignment.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.userId)
    : assignment?.projectOwnerUserId
      ? [assignment.projectOwnerUserId]
      : [];
  const users = await tx.user.findMany({
    where: {
      id: { in: ids },
      status: 'ACTIVE',
      memberships: {
        some: {
          orgId: organizationId,
          joinStatus: { in: participatingStatuses },
          organization: { deleted: false },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  if (!users.length) throw movementConflict('项目组织未配置有效项目负责人');
  return users;
}
// 只采集转项人工审批，不把接单/考试等待节点当成人工审批待办。
export async function movementTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      OR: [{ sourceProjectId: projectId }, { targetProjectId: projectId }],
      status: 'PROCESSING',
      flow: { status: 'PENDING' },
    },
    include: { flow: { include: { nodes: { where: { nodeStatus: 'PENDING' } } } } },
    orderBy: { id: 'asc' },
  });
  for (const row of rows)
    for (const node of row.flow?.nodes ?? []) {
      if (!['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER', 'TARGET_MANAGER'].includes(node.nodeCode))
        continue;
      if (
        (node.nodeCode === 'SOURCE_ORG_OWNER' ? row.sourceProjectId : row.targetProjectId) !==
        projectId
      )
        continue;
      const role = node.nodeCode === 'TARGET_MANAGER' ? ('PM' as const) : ('EXPERT' as const);
      let source = snapshot.sources.find((s) => s.userId === node.approverId && s.role === role);
      if (!source) {
        snapshot.scopes.push({
          userId: node.approverId,
          role,
          perspective: role === 'PM' ? 'PROJECT_MANAGER' : 'EXPERT_PROJECT_OWNER',
          currentNodeCode: 'PRODUCTION_TASK',
          mainEligible: false,
          boardVisible: true,
        });
        source = {
          userId: node.approverId,
          role,
          taskType: 'MEMBER_MOVEMENT_APPROVAL',
          sources: [],
        };
        snapshot.sources.push(source);
      }
      source.sources.push(`PROJECT_MEMBER_MOVEMENT:${row.id}`);
    }
  return snapshot;
}
export async function syncSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  snapshot: TaskSnapshot,
  now: Date,
) {
  for (const scope of snapshot.scopes) {
    const where = {
      projectId_userId_perspective: {
        projectId,
        userId: scope.userId,
        perspective: scope.perspective,
      },
    };
    const old = await tx.projectRoleNodeSnapshot.findUnique({ where });
    if (old && old.branchPriority > 100) continue;
    const id = Number(
      snapshot.sources
        .find((s) => s.userId === scope.userId && s.role === scope.role)!
        .sources[0]!.split(':')[1],
    );
    const movement = await tx.projectMemberMovement.findUniqueOrThrow({ where: { id } });
    const data = {
      branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
      branchPriority: 100,
      sourceBizType: 'PROJECT_MEMBER_MOVEMENT',
      sourceBizId: id,
      sourceEventAt: movement.createdAt,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where,
      create: { projectId, userId: scope.userId, perspective: scope.perspective, ...data },
      update: data,
    });
  }
}
export async function createMovement(
  db: PrismaClient,
  input: MovementInput,
  principal: AuthPrincipal,
  now = new Date(),
) {
  const ids = validateMovement(input, now);
  return db.$transaction(
    async (tx) => {
      await lockPersonnel(
        tx,
        input.projectId,
        ids,
        principal.userId,
        input.targetProjectId ? [input.targetProjectId] : [],
      );
      const scope = await personnelScope(tx, input.projectId, principal, true);
      if (scope.project.currentNodeCode === 'COMPLETED') throw movementConflict('项目已结项');
      if (input.movementType === 'TRANSFER' && principal.role !== 'PM')
        throw new AuthError(403, 'FORBIDDEN', '人员转项只能由原项目主策略官发起');
      const target = input.targetProjectId
        ? await tx.project.findFirst({ where: { id: input.targetProjectId, deleted: false } })
        : null;
      if (input.movementType === 'TRANSFER' && !target)
        throw new AuthError(404, 'NOT_FOUND', '目标项目不存在');
      if (target && (target.status !== 'PUBLISHED' || target.currentNodeCode === 'COMPLETED'))
        throw movementInvalid('目标项目尚未发布或已结项');
      await tx.$queryRaw`SELECT "id" FROM "ProjectMember" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
      const members = await tx.projectMember.findMany({
        where: { projectId: input.projectId, id: { in: ids } },
        include: memberInclude,
        orderBy: { id: 'asc' },
      });
      if (members.length !== ids.length) throw new AuthError(404, 'NOT_FOUND', '项目成员不存在');
      const applicant = await tx.user.findUniqueOrThrow({ where: { id: principal.userId } });
      const before = await movementTasks(tx, input.projectId);
      const movementIds: number[] = [];
      for (const m of members) {
        if (
          scope.organizationIds &&
          (!m.organizationId || !scope.organizationIds.includes(m.organizationId))
        )
          throw new AuthError(403, 'FORBIDDEN', '只能管理职责组织内成员');
        if (m.status !== 'ACTIVE') throw movementConflict('只有已入项人员可以发起变动');
        if (
          await tx.projectMemberMovement.findFirst({
            where: { memberId: m.id, status: { in: ['PROCESSING', 'WAITING_EFFECTIVE'] } },
          })
        )
          throw movementConflict('成员已有进行中的变动');
        const a = m.expertAssignment;
        if (
          m.user.status !== 'ACTIVE' ||
          !a ||
          a.status !== 'ACCEPTED' ||
          a.projectId !== m.projectId ||
          (m.organizationId
            ? a.subjectType !== 'ORGANIZATION' ||
              a.organizationId !== m.organizationId ||
              m.organization?.deleted ||
              !m.organizationMembership ||
              m.organizationMembership.orgId !== m.organizationId ||
              m.organizationMembership.userId !== m.userId ||
              !participatingStatuses.includes(m.organizationMembership.joinStatus)
            : a.subjectType !== 'INDIVIDUAL' || a.expertUserId !== m.userId || !!m.userOrgRelId)
        )
          throw movementConflict('成员接单或来源组织关系已失效');
        let resolved: { code: string; users: User[] }[] = [];
        if (target) {
          const isOwner = a.owners.length
            ? a.owners.some((o) => o.status === 'ACTIVE' && o.userId === m.userId)
            : a.projectOwnerUserId === m.userId;
          if (isOwner) throw movementInvalid('项目负责人不能转项，请先更换项目负责人');
          if (
            await tx.projectMember.findFirst({
              where: {
                projectId: target.id,
                userId: m.userId,
                status: {
                  in: [
                    'PENDING_CONFIRM',
                    'PENDING_ENTRY',
                    'ACTIVE',
                    'PENDING_EXIT',
                    'PENDING_TRANSFER',
                  ],
                },
              },
            })
          )
            throw movementConflict('成员已在目标项目中');
          const manager = await tx.projectManagerRecruitment.findFirst({
            where: { projectId: target.id, status: 'ASSIGNED' },
            orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
            include: { candidate: true },
          });
          if (!manager || manager.candidate.status !== 'ACTIVE')
            throw movementConflict('目标项目未配置有效主策略官');
          const sourceOwners = m.organizationId
            ? await projectOwners(tx, m.projectId, m.organizationId)
            : [];
          const targetOwners = m.organizationId
            ? await projectOwners(tx, target.id, m.organizationId)
            : [];
          resolved = transferSteps(!!m.organizationId).map((code) => ({
            code,
            users:
              code === 'SOURCE_ORG_OWNER'
                ? sourceOwners
                : code === 'TARGET_ORG_OWNER'
                  ? targetOwners
                  : code === 'TARGET_MANAGER'
                    ? [manager.candidate]
                    : [m.user],
          }));
        }
        const movement = await tx.projectMemberMovement.create({
          data: {
            movementNo: `MV${randomUUID().replaceAll('-', '').toUpperCase()}`,
            memberId: m.id,
            userId: m.userId,
            sourceProjectId: m.projectId,
            targetProjectId: target?.id ?? null,
            movementType: input.movementType,
            reason: input.reason.trim(),
            plannedEffectiveDate: new Date(input.plannedEffectiveDate),
            status: target ? 'PROCESSING' : 'WAITING_EFFECTIVE',
            initiatedBy: principal.userId,
            createdBy: principal.uid,
            updatedBy: principal.uid,
          },
        });
        movementIds.push(movement.id);
        if (target) {
          const flowNo = `TF${randomUUID().replaceAll('-', '').toUpperCase()}`;
          const flow = await tx.approvalFlow.create({
            data: {
              flowNo,
              processCode: m.organizationId
                ? 'PROJECT_ORG_MEMBER_TRANSFER'
                : 'PROJECT_PERSONAL_MEMBER_TRANSFER',
              businessType: 'PROJECT_MEMBER_TRANSFER',
              businessId: String(movement.id),
              businessNo: movement.movementNo,
              title:
                `人员转项：${scope.project.projectName ?? scope.project.projectNo} → ${target.projectName ?? target.projectNo}`.slice(
                  0,
                  200,
                ),
              applicantId: principal.userId,
              applicantName: personName(applicant).slice(0, 200),
              applicantOrgId: m.organizationId,
              applicantOrgName: m.organization?.name,
              applyReason: input.reason.trim(),
              currentNode: 1,
              currentNodeCode: resolved[0]!.code,
              totalNodes: resolved.length,
              formData: {
                movementId: movement.id,
                memberId: m.id,
                targetUserId: m.userId,
                sourceProjectId: m.projectId,
                targetProjectId: target.id,
                organizationId: m.organizationId,
                userOrgRelId: m.userOrgRelId,
                plannedEffectiveDate: input.plannedEffectiveDate,
                // 内置不可编辑v1流程；快照固定顺序与ANY模式，不依赖组织退出配置。
                steps: resolved.map((r) => ({
                  nodeCode: r.code,
                  approveMode: 'ANY',
                  approverIds: r.users.map((u) => u.id),
                })),
              },
              createdBy: principal.uid,
              updatedBy: principal.uid,
              nodes: {
                create: resolved.flatMap((r, index) =>
                  r.users.map((u) => ({
                    flowNo,
                    nodeSeq: index + 1,
                    nodeCode: r.code,
                    nodeName: names[r.code]!,
                    approverId: u.id,
                    approverUid: u.uid,
                    approverName: personName(u).slice(0, 200),
                    approverType: 'USER',
                    approverSource: {
                      nodeCode: r.code,
                      sourceProjectId: m.projectId,
                      targetProjectId: target.id,
                      organizationId: m.organizationId,
                    },
                    nodeStatus: index === 0 ? 'PENDING' : 'WAITING',
                    createdBy: principal.uid,
                    updatedBy: principal.uid,
                  })),
                ),
              },
              actions: {
                create: {
                  actionType: 'SUBMIT',
                  operatorId: principal.userId,
                  operatorName: personName(applicant).slice(0, 200),
                  toStatus: 'PENDING',
                  actionComment: input.reason.trim(),
                },
              },
            },
          });
          await tx.projectMemberMovement.update({
            where: { id: movement.id },
            data: { flowId: flow.id },
          });
        }
        await tx.projectMember.update({
          where: { id: m.id },
          data: {
            status: target ? 'PENDING_TRANSFER' : 'PENDING_EXIT',
            plannedLeaveDate: target ? null : new Date(input.plannedEffectiveDate),
            updatedBy: principal.uid,
          },
        });
      }
      if (!target && input.plannedEffectiveDate <= todayText(now))
        for (const id of movementIds) {
          const row = await tx.projectMemberMovement.findUniqueOrThrow({
            where: { id },
            include: transferInclude,
          });
          await applyMovement(tx, row, now);
        }
      const after = await movementTasks(tx, input.projectId);
      await reconcileTaskRounds(
        tx,
        input.projectId,
        before,
        after,
        { userId: principal.userId, role: principal.role as 'PM' | 'EXPERT' },
        [],
        [],
        ['MEMBER_MOVEMENT_APPROVAL'],
        now,
      );
      await syncSnapshots(tx, input.projectId, after, now);
      for (const projectId of [input.projectId, ...(target ? [target.id] : [])])
        await tx.projectEventOutbox.create({
          data: {
            projectId,
            eventType: 'PROJECT_MEMBER_MOVEMENTS_INITIATED',
            operation: 'CREATE_MOVEMENT',
            actorUserId: principal.userId,
            payload: {
              schemaVersion: 1,
              movementIds,
              memberIds: ids,
              sourceProjectId: input.projectId,
              targetProjectId: target?.id ?? null,
              movementType: input.movementType,
              affectedUserIds: members.map((m) => m.userId),
              pendingApproverUserIds: after.scopes.map((s) => s.userId),
            },
          },
        });
      return null;
    },
    { timeout: 30_000 },
  );
}
