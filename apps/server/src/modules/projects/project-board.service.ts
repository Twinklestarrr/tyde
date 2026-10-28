import { boardTrends, type BoardTrendsQuery } from './project-board-trends.js';
import { boardRisks } from './project-board-risks.js';
import { boardSubtasks } from './project-board-subtasks.js';
import { boardProjects, type BoardProjectsQuery } from './project-board-projects.js';
import { workbenchStatistics, type WorkbenchMode } from './project-workbench-statistics.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { displayName } from './project-detail.js';
import { projectTime } from './project-time.js';

// 基础详情与统计/列表的范围不同：候选策略官待接受时也可读取，且不限制发布状态。
export function boardBasicScope(p: AuthPrincipal): Prisma.ProjectWhereInput {
  if (p.role === 'NAVIGATOR') return { createdBy: p.uid };
  if (p.role === 'PM')
    return {
      managerRecruitments: {
        some: {
          OR: [
            { candidateUserId: p.userId, status: { in: ['PENDING_ACCEPTANCE', 'ASSIGNED'] } },
            { expertRecruitmentHandlerUserId: p.userId, status: 'ASSIGNED' },
          ],
        },
      },
    };
  if (p.role !== 'EXPERT') throw new AuthError(403, 'FORBIDDEN', '当前角色无权查看项目基础详情');
  const member = { userId: p.userId, joinStatus: { in: participatingStatuses } };
  return {
    expertAssignments: {
      some: {
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
        organization: {
          deleted: false,
          memberships: { some: member },
        },
        OR: [
          { organization: { memberships: { some: { ...member, position: 'OWNER' } } } },
          { owners: { some: { userId: p.userId, status: 'ACTIVE' } } },
          { projectOwnerUserId: p.userId, owners: { none: {} } },
        ],
      },
    },
  };
}

export class ProjectBoardService {
  constructor(readonly db: PrismaClient) {}
  async trends(query: BoardTrendsQuery, principal: AuthPrincipal) {
    return this.db.$transaction((tx) => boardTrends(tx, query, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async risks(projectId: number, principal: AuthPrincipal, now = new Date()) {
    return this.db.$transaction((tx) => boardRisks(tx, projectId, principal, now), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async subtasks(projectId: number, principal: AuthPrincipal, now = new Date()) {
    return this.db.$transaction((tx) => boardSubtasks(tx, projectId, principal, now), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async projects(query: BoardProjectsQuery, principal: AuthPrincipal) {
    return this.db.$transaction((tx) => boardProjects(tx, query, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async statistics(mode: WorkbenchMode, principal: AuthPrincipal, now = new Date()) {
    if (!['TASK', 'BOARD'].includes(mode))
      throw new AuthError(400, 'VALIDATION_ERROR', 'mode必须为TASK或BOARD');
    return this.db.$transaction((tx) => workbenchStatistics(tx, mode, principal, now), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async basicDetail(projectId: number, principal: AuthPrincipal) {
    if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
      throw new AuthError(400, 'VALIDATION_ERROR', 'projectId必须为32位正整数');
    const scope = boardBasicScope(principal);
    return this.db.$transaction(
      async (tx) => {
        const p = await tx.project.findFirst({
          where: { id: projectId, deleted: false, AND: [scope] },
          include: {
            categories: { orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }] },
            requester: { select: { displayName: true, realName: true } },
          },
        });
        if (!p) throw new AuthError(403, 'FORBIDDEN', '项目不存在或当前用户无权查看项目基础详情');
        const first = p.categories.find((c) => c.categoryLevel === 1);
        const second = p.categories.find((c) => c.categoryLevel === 2);
        const third = p.categories.filter((c) => c.categoryLevel === 3);
        return {
          projectId: p.id,
          projectNo: p.projectNo,
          projectName: p.projectName,
          projectDescription: p.projectDescription,
          requesterType: p.requesterType,
          requesterId: p.requesterId,
          requesterName:
            p.requesterType === 'INDIVIDUAL'
              ? displayName(p.requester.displayName, p.requester.realName, p.requesterName)
              : p.requesterName,
          categoryLevel1Id: first?.categoryId ?? null,
          categoryLevel1Name: first?.categoryNameSnapshot ?? null,
          categoryLevel2Id: second?.categoryId ?? null,
          categoryLevel2Name: second?.categoryNameSnapshot ?? null,
          categoryLevel3Ids: third.map((c) => c.categoryId),
          categoryLevel3Names: third.map((c) => c.categoryNameSnapshot),
          difficultyLevel: p.difficultyLevel,
          projectQuantity: p.projectQuantity?.toNumber() ?? null,
          quantityUnit: p.quantityUnit,
          deadline: p.deadline ? projectTime(p.deadline) : null,
          requiredHeadcount: p.requiredHeadcount,
          educationRequirement: p.educationRequirement,
          employmentType: p.employmentType,
          experienceRequirement: p.experienceRequirement,
          workSummary: p.workSummary,
          specialRequirement: p.specialRequirement,
          mandatoryRequirement: p.mandatoryRequirement,
          standardContent: p.standardContent,
          standardLink: p.standardLink,
          status: p.status,
          currentNodeCode: p.currentNodeCode,
          publishedAt: p.publishedAt ? projectTime(p.publishedAt) : null,
          closedAt: p.closedAt ? projectTime(p.closedAt) : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
