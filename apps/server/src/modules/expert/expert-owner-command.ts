import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import { refreshMovementApprovers } from '../personnel/personnel-movement-approvers.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { collectExpertCardCandidates } from '../projects/project-expert-card-candidates.js';

export interface OwnerChangeInput {
  assignmentId: number;
  projectOwnerUserId?: string | null;
  projectOwnerUserIds?: string[] | null;
}
const invalid = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
export function ownerTargets(input: OwnerChangeInput) {
  const ids = input.projectOwnerUserIds;
  const multiple = Array.isArray(ids) && ids.length > 0;
  const legacy = input.projectOwnerUserId != null;
  if (
    !Number.isInteger(input.assignmentId) ||
    input.assignmentId < 1 ||
    input.assignmentId > 2147483647
  )
    throw invalid('assignmentId必须为32位正整数');
  if (legacy === multiple || (ids != null && !Array.isArray(ids)))
    throw invalid('必须填写且只能填写一种项目负责人参数');
  const requested = multiple ? ids : [input.projectOwnerUserId!];
  if (
    requested.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  )
    throw invalid('项目负责人须为有效用户ID');
  const target = [...new Set(requested.map((id) => id.toLowerCase()))];
  if (target.length > 20) throw invalid('项目负责人须为有效用户ID，去重后最多20人');
  return target;
}

// 只同步本域考试/培训轮次，不把交接计为完成；调用方在全部更新后统一仲裁卡片。
export async function refreshOwnerProgress(
  tx: Prisma.TransactionClient,
  projectId: number,
  ids: string[] | null,
  now: Date,
) {
  if (ids?.length === 0) return;
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const types = ['ENTRANCE_EXAM', 'STANDARD_TRAINING'];
  // 收集全部真实来源，不能因报量核查/入项等卡片胜者遮挡而取消独立轮次。
  const candidates =
    !project.deleted && project.status === 'PUBLISHED' && project.currentNodeCode !== 'COMPLETED'
      ? await collectExpertCardCandidates(tx, projectId, now)
      : [];
  // 配置变更影响全项目：兼顾新增来源和仅剩旧 OPEN 轮次的失效用户。
  if (ids === null) {
    const open = await tx.projectTaskRound.findMany({
      where: { projectId, role: 'EXPERT', status: 'OPEN', taskType: { in: types } },
      select: { userId: true },
    });
    ids = [
      ...new Set([
        ...candidates.filter((c) => types.includes(c.branchNodeCode)).map((c) => c.userId),
        ...open.map((r) => r.userId),
      ]),
    ];
  }
  if (!ids.length) return;
  const active = new Set(
    (
      await tx.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } })
    ).map((u) => u.id),
  );
  for (const userId of new Set(ids)) {
    const sources = new Set<string>(
      candidates.flatMap((c) =>
        active.has(userId) && c.userId === userId && types.includes(c.branchNodeCode)
          ? [c.branchNodeCode]
          : [],
      ),
    );
    const open = await tx.projectTaskRound.findMany({
      where: { projectId, userId, role: 'EXPERT', status: 'OPEN', taskType: { in: types } },
    });
    for (const round of open)
      if (!sources.has(round.taskType))
        await tx.projectTaskRound.update({
          where: { id: round.id },
          data: { status: 'CANCELLED', finishedAt: now },
        });
    for (const taskType of sources)
      if (!open.some((r) => r.taskType === taskType))
        await tx.projectTaskRound.create({
          data: { projectId, userId, role: 'EXPERT', taskType, openedAt: now },
        });
  }
}

export async function replaceProjectOwners(
  db: PrismaClient,
  input: OwnerChangeInput,
  principal: AuthPrincipal,
  operation: string,
) {
  if (principal.role !== 'EXPERT') throw new AuthError(403, 'FORBIDDEN', '仅执行专家可访问');
  const target = ownerTargets(input);
  return db.$transaction(
    async (tx) => {
      // 与组织成员变更保持用户→组织→成员关系→项目顺序；同项目下发/阅卷也使用项目锁。
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(ARRAY[${Prisma.join([...new Set([principal.userId, ...target])].sort())}]::uuid[]) ORDER BY "id" FOR SHARE`;
      const initial = await tx.projectExpertAssignment.findFirst({
        where: { id: input.assignmentId, subjectType: 'ORGANIZATION', project: { deleted: false } },
      });
      if (!initial?.organizationId) throw new AuthError(404, 'NOT_FOUND', '组织执行专家任务不存在');
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id"=${initial.organizationId}::uuid AND "deleted"=false FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "UserOrgRel" WHERE "orgId"=${initial.organizationId}::uuid ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${initial.projectId} AND "deleted"=false FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ProjectExpertAssignment" WHERE "id"=${input.assignmentId} FOR UPDATE`;
      const assignment = await tx.projectExpertAssignment.findFirst({
        where: {
          id: input.assignmentId,
          subjectType: 'ORGANIZATION',
          organizationId: initial.organizationId,
          project: { deleted: false },
        },
        include: { owners: true },
      });
      if (!assignment) throw new AuthError(404, 'NOT_FOUND', '组织执行专家任务不存在');
      const members = await tx.userOrgRel.findMany({
        where: {
          orgId: initial.organizationId,
          joinStatus: { in: participatingStatuses },
          organization: { deleted: false },
          user: { status: 'ACTIVE' },
        },
      });
      if (!members.some((r) => r.userId === principal.userId && r.position === 'OWNER'))
        throw new AuthError(403, 'FORBIDDEN', '只有该组织有效主管可以执行此操作');
      if (assignment.status !== 'ACCEPTED') throw invalid('只有已接单组织可以修改项目负责人');
      if (target.some((id) => !members.some((r) => r.userId === id)))
        throw invalid('所选项目负责人必须为该组织有效成员且账号正常');
      const now = new Date();
      let rows = assignment.owners;
      if (!rows.length && assignment.projectOwnerUserId) {
        rows = [
          await tx.projectExpertAssignmentOwner.create({
            data: {
              assignmentId: assignment.id,
              userId: assignment.projectOwnerUserId,
              appointedAt: assignment.acceptedAt ?? assignment.createdAt,
              createdBy: principal.uid,
              updatedBy: principal.uid,
            },
          }),
        ];
      }
      const before = rows.filter((r) => r.status === 'ACTIVE').map((r) => r.userId);
      if (before.length === target.length && target.every((id) => before.includes(id))) return null;
      await tx.projectExpertAssignmentOwner.updateMany({
        where: { assignmentId: assignment.id, status: 'ACTIVE', userId: { notIn: target } },
        data: { status: 'REMOVED', removedAt: now, updatedBy: principal.uid },
      });
      const added = target.filter((id) => !before.includes(id));
      const plan = await tx.projectProductionPlan.findUnique({
        where: { projectId: assignment.projectId },
      });
      for (const userId of added) {
        await tx.projectExpertAssignmentOwner.upsert({
          where: { assignmentId_userId: { assignmentId: assignment.id, userId } },
          create: {
            assignmentId: assignment.id,
            userId,
            appointedAt: now,
            createdBy: principal.uid,
            updatedBy: principal.uid,
          },
          update: { status: 'ACTIVE', appointedAt: now, removedAt: null, updatedBy: principal.uid },
        });
        const membership = members.find((r) => r.userId === userId)!;
        const response = await tx.projectExpertAssignmentMember.findUnique({
          where: { assignmentId_userId: { assignmentId: assignment.id, userId } },
        });
        if (!response || !['SELECTED', 'ACCEPTED'].includes(response.status))
          await tx.projectExpertAssignmentMember.upsert({
            where: { assignmentId_userId: { assignmentId: assignment.id, userId } },
            create: {
              assignmentId: assignment.id,
              userId,
              userOrgRelId: membership.id,
              status: 'SELECTED',
              respondedAt: now,
              createdBy: principal.uid,
              updatedBy: principal.uid,
            },
            update: {
              userOrgRelId: membership.id,
              status: 'SELECTED',
              rejectReason: null,
              respondedAt: now,
              updatedBy: principal.uid,
            },
          });
        if (
          !plan?.needWrittenExam &&
          !(await tx.projectMember.findFirst({
            where: { expertAssignmentId: assignment.id, userId },
          }))
        )
          await tx.projectMember.create({
            data: {
              projectId: assignment.projectId,
              userId,
              userOrgRelId: membership.id,
              organizationId: assignment.organizationId,
              expertAssignmentId: assignment.id,
              admittedAt: now,
              projectRole: 'MEMBER',
              status: 'PENDING_CONFIRM',
              createdBy: principal.uid,
              updatedBy: principal.uid,
            },
          });
      }
      await tx.projectExpertAssignment.update({
        where: { id: assignment.id },
        data: {
          projectOwnerUserId: target.length === 1 ? target[0] : null,
          updatedBy: principal.uid,
        },
      });
      await refreshMovementApprovers(tx, assignment.projectId, now, false);
      await refreshOwnerProgress(
        tx,
        assignment.projectId,
        [...added, ...before.filter((id) => !target.includes(id))],
        now,
      );
      const cards = await refreshManagementCardSnapshots(tx, assignment.projectId, now);
      await tx.projectEventOutbox.create({
        data: {
          projectId: assignment.projectId,
          eventType: 'PROJECT_ASSIGNMENT_OWNERS_CHANGED',
          operation,
          actorUserId: principal.userId,
          payload: {
            schemaVersion: 1,
            projectId: assignment.projectId,
            assignmentId: assignment.id,
            organizationId: assignment.organizationId,
            ownerUserIds: target,
            previousOwnerUserIds: before,
            ...cards,
            actorUserId: principal.userId,
          },
        },
      });
      return null;
    },
    { timeout: 30_000 },
  );
}
