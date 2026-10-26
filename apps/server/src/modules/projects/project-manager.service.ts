import { refreshMovementApprovers } from '../personnel/personnel-movement-approvers.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { ManagementService } from '../management/management.service.js';
import { projectTime } from './project-time.js';
import {
  collectManagementTasks,
  managementTaskTypes,
  reconcileTaskRounds,
  taskEventFacts,
} from './project-task-rounds.js';

export interface ManagerCandidate {
  status: 'CURRENT' | 'RECOMMENDED';
  userId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
  currentProjectCount: number;
}
export interface ManagerRecruitInput {
  projectId: number;
  candidateUserId: string;
}

export class ProjectManagerService {
  readonly management: ManagementService;
  constructor(readonly db: PrismaClient) {
    this.management = new ManagementService(db);
  }

  private async ownedPublished(
    tx: Prisma.TransactionClient,
    projectId: number,
    principal: AuthPrincipal,
  ) {
    const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
    if (!project) throw new AuthError(404, 'NOT_FOUND', '项目不存在');
    if (project.createdBy !== principal.uid)
      throw new AuthError(403, 'FORBIDDEN', '只能操作自己创建的项目');
    if (project.status !== 'PUBLISHED')
      throw new AuthError(400, 'VALIDATION_ERROR', '只有已发布项目可以招募策略官');
    return project;
  }
  private assigned(tx: Prisma.TransactionClient, projectId: number) {
    return tx.projectManagerRecruitment.findFirst({
      where: { projectId, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
  }
  private candidates(
    tx: Prisma.TransactionClient,
    current: string | null,
    keyword: string | null,
    onlyId?: string,
  ) {
    const keywordFilter = keyword
      ? Prisma.sql`AND (u."realName" LIKE ${`%${keyword}%`} OR u."displayName" LIKE ${`%${keyword}%`})`
      : Prisma.empty;
    const idFilter = onlyId ? Prisma.sql`AND u."id" = ${onlyId}::uuid` : Prisma.empty;
    return tx.$queryRaw<ManagerCandidate[]>(Prisma.sql`
      SELECT CASE WHEN u."id" = ${current}::uuid THEN 'CURRENT' ELSE 'RECOMMENDED' END AS "status",
        u."id" AS "userId", u."uid",
        CASE WHEN NULLIF(BTRIM(u."displayName"), '') IS NOT NULL AND NULLIF(BTRIM(u."realName"), '') IS NOT NULL
          THEN BTRIM(u."displayName") || '(' || BTRIM(u."realName") || ')'
          ELSE COALESCE(NULLIF(BTRIM(u."displayName"), ''), NULLIF(BTRIM(u."realName"), ''), u."uid") END AS "name",
        u."avatarUrl", COALESCE(load."count", 0)::integer AS "currentProjectCount"
      FROM "User" u LEFT JOIN (
        SELECT "candidateUserId", COUNT(*) AS "count" FROM "ProjectManagerRecruitment"
        WHERE "status" = 'ASSIGNED' GROUP BY "candidateUserId"
      ) load ON load."candidateUserId" = u."id"
      WHERE (u."id" = ${current}::uuid OR u."status" = 'ACTIVE' ) ${keywordFilter} ${idFilter}
      ORDER BY CASE WHEN u."id" = ${current}::uuid THEN 0 ELSE 1 END,
        COALESCE(load."count", 0), u."creditScore" DESC NULLS LAST, u."id" ASC`);
  }
  async listCandidates(projectId: number, keyword: string | undefined, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'NAVIGATOR');
    return this.db.$transaction(
      async (tx) => {
        await this.ownedPublished(tx, projectId, principal);
        const assigned = await this.assigned(tx, projectId);
        return this.candidates(tx, assigned?.candidateUserId ?? null, keyword?.trim() || null);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async recruit(input: ManagerRecruitInput, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'NAVIGATOR');
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
        const project = await this.ownedPublished(tx, input.projectId, principal);
        const previous = await this.assigned(tx, input.projectId);
        const candidate = (
          await this.candidates(tx, previous?.candidateUserId ?? null, null, input.candidateUserId)
        ).find((c) => c.status === 'RECOMMENDED');
        if (!candidate)
          throw new AuthError(
            400,
            'VALIDATION_ERROR',
            '所选用户不是当前可招募的策略官，请刷新候选列表',
          );
        const before = await collectManagementTasks(tx, project);
        const now = new Date();
        if (previous) {
          const replaced = await tx.projectManagerRecruitment.updateMany({
            where: { id: previous.id, status: 'ASSIGNED' },
            data: { status: 'REPLACED', replacedAt: now, updatedBy: principal.uid },
          });
          if (replaced.count !== 1)
            throw new AuthError(409, 'DUPLICATE', '项目策略官已发生变化，请刷新后重试');
        }
        const recruitmentType = previous ? 'REPLACEMENT' : 'INITIAL';
        const recruitment = await tx.projectManagerRecruitment.create({
          data: {
            recruitmentNo: `PMR${projectTime(now).replace(/[- :]/g, '')}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
            projectId: input.projectId,
            candidateUserId: candidate.userId,
            recruitmentType,
            assignmentMode: 'DIRECT',
            status: 'ASSIGNED',
            previousManagerUserId: previous?.candidateUserId ?? null,
            assignedAt: now,
            createdBy: principal.uid,
            updatedBy: principal.uid,
          },
        });
        let updatedProject = project;
        if (!previous) {
          const updated = await tx.project.updateMany({
            where: {
              id: project.id,
              deleted: false,
              status: 'PUBLISHED',
              OR: [{ currentNodeCode: 'RECRUIT_PROJECT_MANAGER' }, { currentNodeCode: null }],
            },
            data: { currentNodeCode: 'PRODUCTION_PLAN', updatedBy: principal.uid },
          });
          if (updated.count !== 1)
            throw new AuthError(409, 'DUPLICATE', '项目流程节点已发生变化，请刷新后重试');
          updatedProject = { ...project, currentNodeCode: 'PRODUCTION_PLAN' };
        }
        await refreshMovementApprovers(tx, project.id, now);
        const after = await collectManagementTasks(tx, updatedProject);
        await reconcileTaskRounds(
          tx,
          project.id,
          before,
          after,
          { userId: principal.userId, role: 'NAVIGATOR' },
          ['MAIN_RECRUIT_PROJECT_MANAGER'],
          ['MAIN_RECRUIT_PROJECT_MANAGER'],
          managementTaskTypes,
          now,
        );
        const facts = taskEventFacts(before, after);
        await tx.projectEventOutbox.create({
          data: {
            projectId: project.id,
            eventType: 'PROJECT_TASKS_RECONCILED',
            operation: 'project.manager.recruit',
            actorUserId: principal.userId,
            payload: {
              schemaVersion: 1,
              projectId: project.id,
              operation: 'project.manager.recruit',
              actorUserId: principal.userId,
              ...facts,
            },
          },
        });
        const manager = (await this.candidates(tx, candidate.userId, null, candidate.userId))[0];
        if (!manager)
          throw new AuthError(409, 'DUPLICATE', '生效策略官资料已发生变化，请刷新后重试');
        return {
          recruitmentId: recruitment.id,
          projectId: project.id,
          recruitmentType,
          assignmentMode: 'DIRECT',
          status: 'ASSIGNED',
          manager,
          currentNodeCode: updatedProject.currentNodeCode,
          nextStage: updatedProject.currentNodeCode,
          primaryAction: 'CHANGE_PROJECT_MANAGER',
          assignedAt: projectTime(now),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(409, 'DUPLICATE', '项目策略官已发生变化，请刷新后重试');
      throw error;
    }
  }
}
