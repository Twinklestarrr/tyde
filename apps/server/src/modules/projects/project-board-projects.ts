import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { boardStatisticsScope } from './project-workbench-statistics.js';
import { displayName } from './project-detail.js';
import { projectTime } from './project-time.js';

export interface BoardProjectsQuery {
  keyword?: string | null;
  current?: number;
  size?: number;
}
const ExactDecimal = Prisma.Decimal.clone({ precision: 64 });
export const boardNodeNames: Record<string, string> = {
  RECRUIT_PROJECT_MANAGER: '招募策略官',
  PRODUCTION_PLAN: '生产计划',
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  RECRUIT_EXECUTION_EXPERT: '招募执行专家',
  PERSONNEL_MANAGEMENT: '人员管理',
  PRODUCTION_TASK: '生产任务',
  COMPLETED: '结项',
};
// 与当前项目列表相同的真实管理关系；不读取会话登录时缓存的身份展示字段。
async function requireExpertManager(tx: Prisma.TransactionClient, p: AuthPrincipal) {
  const owner = {
    OR: [
      { owners: { some: { userId: p.userId, status: 'ACTIVE' } } },
      { projectOwnerUserId: p.userId, owners: { none: {} } },
    ],
  };
  const relation = await tx.userOrgRel.findFirst({
    where: {
      userId: p.userId,
      joinStatus: { in: participatingStatuses },
      organization: {
        deleted: false,
        OR: [
          {
            memberships: {
              some: {
                userId: p.userId,
                position: 'OWNER',
                joinStatus: { in: participatingStatuses },
              },
            },
          },
          {
            expertAssignments: {
              some: {
                subjectType: 'ORGANIZATION',
                status: 'ACCEPTED',
                project: { deleted: false },
                ...owner,
              },
            },
          },
        ],
      },
    },
    select: { id: true },
  });
  if (!relation) throw new AuthError(403, 'FORBIDDEN', '仅组织主管或项目负责人可查看工作台看板');
}
export async function boardProjects(
  tx: Prisma.TransactionClient,
  query: BoardProjectsQuery,
  p: AuthPrincipal,
) {
  const current = query.current ?? 1;
  const size = query.size ?? 20;
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    current > 2147483647 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100 ||
    (query.keyword != null && (typeof query.keyword !== 'string' || query.keyword.length > 128))
  )
    throw new AuthError(400, 'VALIDATION_ERROR', '分页参数无效或keyword超过128字符');
  const scope = boardStatisticsScope(p);
  const keyword = query.keyword?.trim();
  // 旧SQL按名称快照搜索，展示个人需求方的实时名称；保留该区别。
  const where: Prisma.ProjectWhereInput = {
    deleted: false,
    status: 'PUBLISHED',
    AND: [
      scope,
      ...(keyword
        ? [
            {
              OR: [
                { projectName: { contains: keyword } },
                { requesterName: { contains: keyword } },
              ],
            },
          ]
        : []),
    ],
  };
  const total = await tx.project.count({ where });
  const projects =
    (current - 1) * size >= total
      ? []
      : await tx.project.findMany({
          where,
          orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          skip: (current - 1) * size,
          take: size,
          include: {
            requester: { select: { displayName: true, realName: true } },
            productionPlan: { select: { needWrittenExam: true } },
            managerRecruitments: {
              where: { status: 'ASSIGNED' },
              select: { candidateUserId: true, expertRecruitmentHandlerUserId: true },
            },
          },
        });
  if (!projects.length && p.role === 'EXPERT') await requireExpertManager(tx, p);
  const ids = projects.map((project) => project.id);
  const progress = ids.length
    ? await tx.projectSubtask.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids } },
        _sum: { actualQuantity: true },
      })
    : [];
  const assignments =
    ids.length && p.role === 'EXPERT'
      ? await tx.projectExpertAssignment.groupBy({
          by: ['projectId'],
          where: { ...scope.expertAssignments!.some!, projectId: { in: ids } },
          _max: { id: true },
        })
      : [];
  const quantities = new Map(progress.map((row) => [row.projectId, row._sum.actualQuantity]));
  const assignmentIds = new Map(assignments.map((row) => [row.projectId, row._max.id]));
  const records = projects.map((project) => {
    const progressQuantity = new ExactDecimal(quantities.get(project.id) ?? 0);
    const targetQuantity = new ExactDecimal(project.projectQuantity ?? 0);
    const currentNodeCode =
      project.currentNodeCode ??
      (project.managerRecruitments.length ? 'PRODUCTION_PLAN' : 'RECRUIT_PROJECT_MANAGER');
    return {
      projectId: project.id,
      assignmentId: assignmentIds.get(project.id) ?? null,
      deadline: project.deadline ? projectTime(project.deadline) : null,
      projectNo: project.projectNo,
      projectName: project.projectName,
      requesterName:
        project.requesterType === 'INDIVIDUAL'
          ? displayName(
              project.requester.displayName,
              project.requester.realName,
              project.requesterName,
            )
          : project.requesterName,
      needWrittenExam: project.productionPlan?.needWrittenExam ?? false,
      ...(p.role === 'PM'
        ? {
            primaryProjectManager: project.managerRecruitments.some(
              (r) => r.candidateUserId === p.userId,
            ),
            expertRecruitmentHandler: project.managerRecruitments.some(
              (r) => r.expertRecruitmentHandlerUserId === p.userId,
            ),
          }
        : {}),
      currentNodeCode,
      currentNodeName: boardNodeNames[currentNodeCode] ?? null,
      progressQuantity: progressQuantity.toNumber(),
      targetQuantity: targetQuantity.toNumber(),
      progressPercent: targetQuantity.gt(0)
        ? progressQuantity
            .mul(100)
            .div(targetQuantity)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
            .toNumber()
        : 0,
      quantityUnit: project.quantityUnit,
    };
  });
  return { total, pages: Math.ceil(total / size), current, size, records };
}
