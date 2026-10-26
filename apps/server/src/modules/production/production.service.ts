import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { personnelScope, memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { lockPersonnel } from '../personnel/personnel.service.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import {
  reconcileTaskRounds,
  collectManagementTasks,
  managementTaskTypes,
  type TaskSnapshot,
} from '../projects/project-task-rounds.js';
import { validateTask, invalidTask, type TaskQuery, type TaskInput } from './production-domain.js';
import { acceptanceReady } from './acceptance.service.js';
import { outputScope } from './output-report-access.js';
const nameOf = (u: { displayName: string | null; realName: string | null; uid: string }) =>
  displayName(u.displayName ?? '', u.realName, u.uid);
const published = async (tx: Prisma.TransactionClient, projectId: number) => {
  const project = await tx.project.findFirst({
    where: { id: projectId, deleted: false, status: 'PUBLISHED' },
  });
  if (!project) throw new AuthError(404, 'NOT_FOUND', '已发布项目不存在');
  return project;
};
async function managerScope(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
  write = false,
) {
  await published(tx, projectId);
  if (principal.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '请切换至PM角色');
  return personnelScope(tx, projectId, principal, write);
}
async function eligible(tx: Prisma.TransactionClient, projectId: number, now: Date) {
  const plan = await tx.projectProductionPlan.findUnique({ where: { projectId } });
  const members = await tx.projectMember.findMany({
    where: { projectId, status: 'ACTIVE', joinedAt: { lte: now }, leftAt: null },
    include: memberInclude,
  });
  return members.filter((m) => qualifiedForEntry(m, plan?.needWrittenExam ?? false));
}
// 本批只采集首次创建支线；验收和报量来源随后接入，不取消其他领域轮次。
async function creationTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const project = await published(tx, projectId);
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  if (!manager || project.currentNodeCode === 'COMPLETED') return { scopes: [], sources: [] };
  const scope = {
    userId: manager.candidateUserId,
    role: 'PM' as const,
    perspective: 'PROJECT_MANAGER',
    currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_TASK',
    mainEligible: false,
    boardVisible: true,
  };
  const count = await tx.projectSubtask.count({ where: { projectId } });
  return {
    scopes: [scope],
    sources:
      count || project.currentNodeCode !== 'PRODUCTION_TASK'
        ? []
        : [{ ...scope, taskType: 'SUBTASK_CREATE', sources: [`PROJECT:${projectId}`] }],
  };
}
export class ProductionService {
  constructor(readonly db: PrismaClient) {}
  async members(query: TaskQuery, principal: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        await managerScope(tx, query.projectId, principal);
        const key = query.keyword?.trim();
        const rows = (await eligible(tx, query.projectId, now))
          .filter(
            (m) =>
              !key ||
              [m.user.uid, m.user.displayName, m.user.realName].some((v) => v?.includes(key)),
          )
          .sort((a, b) => nameOf(a.user).localeCompare(nameOf(b.user), 'zh-CN') || a.id - b.id);
        const current = query.current ?? 1,
          size = query.size ?? 20;
        return {
          current,
          size,
          total: rows.length,
          pages: Math.ceil(rows.length / size),
          records: rows.slice((current - 1) * size, current * size).map((m) => ({
            memberId: m.id,
            userId: m.userId,
            uid: m.user.uid,
            displayName: nameOf(m.user),
            subjectType: m.expertAssignment!.subjectType,
            organizationId: m.organizationId,
            organizationName: m.organization?.name ?? null,
            assignmentType: null,
            assignedAt: null,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async create(input: TaskInput, principal: AuthPrincipal, now = new Date()) {
    const { name, quantity, ids } = validateTask(input, now);
    try {
      return await this.db.$transaction(
        async (tx) => {
          await lockPersonnel(tx, input.projectId, ids, principal.userId);
          const scope = await managerScope(tx, input.projectId, principal, true);
          if (scope.project.currentNodeCode === 'COMPLETED')
            throw new AuthError(409, 'DUPLICATE', '项目已结项');
          if (!scope.project.quantityUnit?.trim()) throw invalidTask('项目量级单位未配置');
          if (
            await tx.projectSubtask.findUnique({
              where: { projectId_subtaskName: { projectId: input.projectId, subtaskName: name } },
            })
          )
            throw new AuthError(409, 'DUPLICATE', '项目内子任务名称已存在');
          const members = ids.length
            ? (await eligible(tx, input.projectId, now)).filter((m) => ids.includes(m.id))
            : [];
          if (members.length !== ids.length)
            throw invalidTask('指定人员已不满足接单、实际入项或原准入条件');
          const firstCreation = !(await tx.projectSubtask.count({
            where: { projectId: input.projectId },
          }));
          const before = await creationTasks(tx, input.projectId);
          const managementBefore = await collectManagementTasks(tx, scope.project);
          const task = await tx.projectSubtask.create({
            data: {
              projectId: input.projectId,
              subtaskNo: `ST${projectTime(now).replace(/[- :]/g, '')}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
              subtaskName: name,
              expectedDeliveryDate: new Date(input.expectedDeliveryDate),
              expectedQuantity: new Prisma.Decimal(quantity),
              quantityUnit: scope.project.quantityUnit,
              distributionMode: input.distributionMode,
              createdBy: principal.uid,
            },
          });
          if (ids.length)
            await tx.projectSubtaskAssignee.createMany({
              data: members.map((m) => ({
                projectId: input.projectId,
                subtaskId: task.id,
                memberId: m.id,
                userId: m.userId,
                assignmentType: 'DESIGNATED',
                assignedBy: principal.uid,
                assignedAt: now,
              })),
            });
          const project =
            scope.project.currentNodeCode === 'PRODUCTION_TASK'
              ? scope.project
              : await tx.project.update({
                  where: { id: input.projectId },
                  data: { currentNodeCode: 'PRODUCTION_TASK', updatedBy: principal.uid },
                });
          const actor = { userId: principal.userId, role: 'PM' as const };
          await reconcileTaskRounds(
            tx,
            input.projectId,
            managementBefore,
            await collectManagementTasks(tx, project),
            actor,
            [],
            [],
            managementTaskTypes,
            now,
          );
          await reconcileTaskRounds(
            tx,
            input.projectId,
            before,
            await creationTasks(tx, input.projectId),
            actor,
            ['SUBTASK_CREATE'],
            firstCreation ? ['SUBTASK_CREATE'] : [],
            ['SUBTASK_CREATE'],
            now,
          );
          // 只撤销本领域已消解的快照，保留其他优先级支线。
          await tx.projectRoleNodeSnapshot.deleteMany({
            where: {
              projectId: input.projectId,
              perspective: 'PROJECT_MANAGER',
              branchNodeCode: 'SUBTASK_CREATE',
            },
          });
          await tx.projectEventOutbox.create({
            data: {
              projectId: input.projectId,
              eventType: 'PROJECT_SUBTASK_CHANGED',
              operation: 'CREATED',
              actorUserId: principal.userId,
              payload: {
                schemaVersion: 1,
                projectId: input.projectId,
                subtaskId: task.id,
                actorUserId: principal.userId,
              },
            },
          });
          return null;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(409, 'DUPLICATE', '子任务名称或编号已存在');
      throw error;
    }
  }
  async list(query: TaskQuery, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const project = await published(tx, query.projectId);
        const scope =
          principal.role === 'NAVIGATOR' && principal.uid === project.createdBy
            ? null
            : await outputScope(tx, query.projectId, principal);
        const organizationIds = scope?.organizationIds ?? null;
        const memberOnly = principal.role === 'EXPERT' && !scope?.reviewer;
        const corrections = scope?.correctionIds ?? [];
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const where: Prisma.ProjectSubtaskWhereInput = {
          projectId: query.projectId,
          ...(query.statuses?.length ? { status: { in: query.statuses } } : {}),
          ...(query.keyword?.trim()
            ? {
                OR: [
                  { subtaskName: { contains: query.keyword.trim() } },
                  { subtaskNo: { contains: query.keyword.trim() } },
                ],
              }
            : {}),
          // 本人已报量及离项后转交修正来源，不把指定当作报量。
          ...(memberOnly
            ? { outputReports: { some: { userId: principal.userId } } }
            : organizationIds
              ? {
                  AND: [
                    {
                      OR: [
                        { distributionMode: 'POOL' },
                        {
                          outputReports: {
                            some: { reviewStatus: 'RETURNED', memberId: { in: corrections } },
                          },
                        },
                        {
                          assignees: {
                            some: {
                              member: { status: 'ACTIVE', organizationId: { in: organizationIds } },
                            },
                          },
                        },
                      ],
                    },
                  ],
                }
              : {}),
        };
        const total = await tx.projectSubtask.count({ where });
        const rows = await tx.projectSubtask.findMany({
          where,
          orderBy: { id: 'desc' },
          skip: (current - 1) * size,
          take: size,
          include: {
            _count: { select: { assignees: true } },
            outputReports: {
              select: { id: true, reviewStatus: true, memberId: true },
            },
            assignees: {
              orderBy: { id: 'asc' },
              take: 3,
              include: { member: { include: { user: true } } },
            },
          },
        });
        const operators = await tx.user.findMany({
          where: {
            uid: {
              in: rows.flatMap((r) =>
                [r.submittedBy, r.reviewedBy].filter((v): v is string => !!v),
              ),
            },
          },
        });
        const operatorName = (uid: string | null) =>
          uid
            ? operators.find((u) => u.uid === uid)
              ? nameOf(operators.find((u) => u.uid === uid)!)
              : uid
            : null;
        return {
          current,
          size,
          total,
          pages: Math.ceil(total / size),
          records: rows.map((r) => ({
            subtaskId: r.id,
            subtaskNo: r.subtaskNo,
            subtaskName: r.subtaskName,
            status: r.status,
            distributionMode: r.distributionMode,
            assigneeCount: r._count.assignees,
            assigneeNames: r.assignees.map((a) => nameOf(a.member.user)),
            pendingReportCount: r.outputReports.filter(
              (x) => x.reviewStatus === 'RETURNED' && corrections.includes(x.memberId),
            ).length,
            expectedDeliveryDate: r.expectedDeliveryDate.toISOString().slice(0, 10),
            expectedQuantity: Number(r.expectedQuantity),
            quantityUnit: r.quantityUnit,
            actualDeliveryDate: r.actualDeliveryDate?.toISOString().slice(0, 10) ?? null,
            actualQuantity: r.actualQuantity === null ? null : Number(r.actualQuantity),
            reportedQuantity: r.reportedQuantity === null ? null : Number(r.reportedQuantity),
            quantityAdjustmentRemark: r.quantityAdjustmentRemark,
            submittedByName: operatorName(r.submittedBy),
            submittedAt: r.submittedAt ? projectTime(r.submittedAt) : null,
            reviewedByName: operatorName(r.reviewedBy),
            reviewedAt: r.reviewedAt ? projectTime(r.reviewedAt) : null,
            rejectReason: r.rejectReason,
            operationHint:
              principal.role === 'NAVIGATOR' &&
              ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(r.status)
                ? '待策略官提交验收'
                : null,
            allowedActions:
              project.currentNodeCode === 'COMPLETED'
                ? []
                : principal.role === 'EXPERT' &&
                    r.status === 'IN_PROGRESS' &&
                    r.outputReports.some(
                      (x) => x.reviewStatus === 'RETURNED' && corrections.includes(x.memberId),
                    )
                  ? ['CORRECT_REPORT']
                  : principal.role === 'PM' &&
                      !scope?.readOnly &&
                      ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(r.status)
                    ? acceptanceReady({
                        verified: r.outputReports.filter((x) => x.reviewStatus === 'VERIFIED')
                          .length,
                        pending: r.outputReports.filter((x) => x.reviewStatus === 'PENDING').length,
                        returned: r.outputReports.filter((x) => x.reviewStatus === 'RETURNED')
                          .length,
                      })
                      ? ['SUBMIT_ACCEPTANCE']
                      : ['CHECK_DATA']
                    : principal.role === 'NAVIGATOR' && r.status === 'PENDING_ACCEPTANCE'
                      ? ['ACCEPT', 'REJECT']
                      : [],
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
