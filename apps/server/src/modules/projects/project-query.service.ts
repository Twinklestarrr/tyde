import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { hasManagementRole } from '../management/management.service.js';
import { displayName, projectDetailData, projectDetailInclude } from './project-detail.js';
import { productionStageData } from './project-production-plan.service.js';

export class ProjectQueryService {
  constructor(readonly db: PrismaClient) {}
  async detail(projectId: number, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const project = await tx.project.findFirst({
          where: { id: projectId, deleted: false, status: 'PUBLISHED' },
          include: projectDetailInclude,
        });
        if (!project) throw new AppError(404, 'NOT_FOUND', '已发布项目不存在');
        // 当前会话角色与实际项目关系共同决定访问范围。
        const creator =
          project.createdBy === principal.uid &&
          (await hasManagementRole(tx, principal, 'NAVIGATOR'));
        const manager =
          !creator &&
          (await hasManagementRole(tx, principal, 'PM')) &&
          Boolean(
            await tx.projectManagerRecruitment.findFirst({
              where: {
                projectId,
                status: 'ASSIGNED',
                OR: [
                  { candidateUserId: principal.userId },
                  { expertRecruitmentHandlerUserId: principal.userId },
                ],
              },
              select: { id: true },
            }),
          );
        const expert =
          !creator &&
          !manager &&
          principal.role === 'EXPERT' &&
          Boolean(
            await tx.projectMember.findFirst({
              where: {
                projectId,
                userId: principal.userId,
                projectRole: 'MEMBER',
                status: 'ACTIVE',
              },
              select: { id: true },
            }),
          );
        if (!creator && !manager && !expert)
          throw new AppError(403, 'FORBIDDEN', '当前用户无权查看该项目');
        const data = await projectDetailData(tx, project);
        const user = await tx.user.findUnique({
          where: { uid: project.createdBy },
          select: { displayName: true, realName: true },
        });
        const fallback = project.requesterName.trim() || project.createdBy;
        const detail = {
          ...data,
          creatorName: user ? displayName(user.displayName, user.realName, fallback) : fallback,
        };
        // 管理范围优先；仅实际ACTIVE MEMBER返回量级要求，绝不查询或泄露确认人/扩展JSON。
        if (!expert) return detail;
        const plan = await tx.projectProductionPlan.findUnique({
          where: { projectId },
          include: { stages: { orderBy: { sequenceNo: 'asc' } } },
        });
        return {
          ...detail,
          productionRequirements: {
            hasPlan: Boolean(plan),
            planId: plan?.id ?? null,
            operatorHeadcount: plan?.operatorHeadcount ?? null,
            operatorCpd: plan?.operatorCpd.toNumber() ?? null,
            inspectorHeadcount: plan?.inspectorHeadcount ?? null,
            inspectorCpd: plan?.inspectorCpd?.toNumber() ?? null,
            totalExpectedOutput: plan?.totalExpectedOutput.toNumber() ?? null,
            // 旧ProjectQueryService不是接单服务：从未加载人群，DTO该字段实际为null。
            crowds: null,
            stages: plan?.stages.map(productionStageData) ?? [],
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
