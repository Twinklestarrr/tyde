import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { refreshManagementCardSnapshots } from './project-management-card-snapshot.js';
import { collectRecruitmentTasks } from './project-recruitment-snapshot.js';
import { managementTaskTypes, reconcileTaskRounds, taskEventFacts } from './project-task-rounds.js';

export interface HandlerChangeInput {
  projectId: number;
  handlerUserId: string;
}
interface HandlerCandidate {
  userId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
  currentProjectCount: number;
  currentHandler: boolean;
}
export class ProjectRecruitmentHandlerService {
  constructor(readonly db: PrismaClient) {}

  private async primary(tx: Prisma.TransactionClient, id: number, principal: AuthPrincipal) {
    if (principal.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '当前会话必须为策略官');
    const project = await tx.project.findFirst({ where: { id, deleted: false } });
    if (!project) throw new AuthError(404, 'NOT_FOUND', '项目不存在');
    const relation = await tx.projectManagerRecruitment.findFirst({
      where: { projectId: id, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    if (relation?.candidateUserId !== principal.userId)
      throw new AuthError(403, 'FORBIDDEN', '只有项目主策略官可以操作招募负责人');
    return { project, relation };
  }
  async candidates(id: number, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const { relation } = await this.primary(tx, id, principal);
        // 统一账号自带PM；候选资格依据ACTIVE，不能以User.role或单数组织筛选。
        return tx.$queryRaw<HandlerCandidate[]>`
        SELECT u."id" AS "userId", u."uid", u."avatarUrl",
          CASE WHEN NULLIF(BTRIM(u."displayName"),'') IS NOT NULL AND NULLIF(BTRIM(u."realName"),'') IS NOT NULL
            THEN BTRIM(u."displayName") || '(' || BTRIM(u."realName") || ')'
            ELSE COALESCE(NULLIF(BTRIM(u."displayName"),''),NULLIF(BTRIM(u."realName"),''),u."uid") END AS "name",
          COALESCE(load."count",0)::integer AS "currentProjectCount",
          COALESCE(u."id" = ${relation.expertRecruitmentHandlerUserId}::uuid,false) AS "currentHandler"
        FROM "User" u LEFT JOIN (
          SELECT "candidateUserId", COUNT(*) AS "count" FROM "ProjectManagerRecruitment"
          WHERE "status"='ASSIGNED' GROUP BY "candidateUserId"
        ) load ON load."candidateUserId"=u."id"
        WHERE u."status"='ACTIVE'
        ORDER BY COALESCE(load."count",0), u."creditScore" DESC NULLS LAST, u."id" ASC`;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async change(input: HandlerChangeInput, principal: AuthPrincipal) {
    if (principal.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '当前会话必须为策略官');
    return this.db.$transaction(async (tx) => {
      // 与材料写操作一致，先锁用户后锁项目，避免相反锁顺序。
      const [candidate] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "id"=${input.handlerUserId}::uuid AND "status"='ACTIVE' FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.projectId} AND "deleted"=false FOR UPDATE`;
      const { project, relation } = await this.primary(tx, input.projectId, principal);
      if (!candidate) throw new AuthError(400, 'VALIDATION_ERROR', '所选用户不是可用的策略官');
      const before = await collectRecruitmentTasks(tx, project);
      const changed = await tx.projectManagerRecruitment.updateMany({
        where: {
          id: relation.id,
          status: 'ASSIGNED',
          candidateUserId: principal.userId,
          expertRecruitmentHandlerUserId: relation.expertRecruitmentHandlerUserId,
        },
        data: { expertRecruitmentHandlerUserId: input.handlerUserId, updatedBy: principal.uid },
      });
      if (changed.count !== 1)
        throw new AuthError(409, 'DUPLICATE', '环节负责人已变化，请刷新后重试');
      const after = await collectRecruitmentTasks(tx, project);
      await reconcileTaskRounds(
        tx,
        project.id,
        before,
        after,
        null,
        [],
        [],
        [...managementTaskTypes, 'EXPERT_RECRUITMENT_RETRY'],
      );
      await refreshOwnerProgress(tx, project.id, null, new Date());
      const cardChanges = await refreshManagementCardSnapshots(tx, project.id);
      // 不把转交视为完成招募；本域管理真值及待投递事件同事务。
      await tx.projectEventOutbox.create({
        data: {
          projectId: project.id,
          eventType: 'PROJECT_TASKS_RECONCILED',
          operation: 'project.expert-recruitment-handler.change',
          actorUserId: principal.userId,
          payload: {
            schemaVersion: 1,
            projectId: project.id,
            operation: 'project.expert-recruitment-handler.change',
            actorUserId: principal.userId,
            ...taskEventFacts(before, after),
            ...cardChanges,
          },
        },
      });
      return null;
    });
  }
}
