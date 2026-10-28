import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import {
  syncRecruitmentRetrySnapshot,
  collectRecruitmentTasks,
} from './project-recruitment-snapshot.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { displayName } from './project-detail.js';
import { managementTaskTypes, reconcileTaskRounds, taskEventFacts } from './project-task-rounds.js';
import {
  candidateSql,
  candidateAssignmentSql,
  type RecruitmentCandidate,
  type RecruitmentQuery,
  type SubjectType,
} from './project-recruitment-candidates.js';

export interface RecruitmentItem {
  subjectType: SubjectType;
  subjectId: string;
  productionRequirement: number;
  operatorHeadcount: number;
  inspectorHeadcount?: number | null;
  sourceRejectedAssignmentId?: number | null;
}
export interface RecruitmentInput {
  projectId: number;
  assignments: RecruitmentItem[];
}
const bad = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const tracked = [...managementTaskTypes, 'EXPERT_RECRUITMENT_RETRY'];
export class ProjectRecruitmentService {
  constructor(readonly db: PrismaClient) {}
  private async context(tx: Prisma.TransactionClient, id: number, p: AuthPrincipal) {
    if (p.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '当前会话必须为策略官');
    const project = await tx.project.findFirst({ where: { id, deleted: false } });
    if (!project) throw new AuthError(404, 'NOT_FOUND', '项目不存在');
    const relation = await tx.projectManagerRecruitment.findFirst({
      where: { projectId: id, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    if (
      !relation ||
      (relation.candidateUserId !== p.userId &&
        relation.expertRecruitmentHandlerUserId !== p.userId)
    )
      throw new AuthError(403, 'FORBIDDEN', '仅当前主策略官或招募环节负责人可操作');
    const creator = await tx.user.findUnique({
      where: { uid: project.createdBy },
      select: { id: true },
    });
    const excluded = [
      creator?.id,
      relation.candidateUserId,
      relation.expertRecruitmentHandlerUserId,
    ].filter((v): v is string => Boolean(v));
    return { project, relation, excluded };
  }
  async detail(id: number, p: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const { project, relation } = await this.context(tx, id, p);
        const assignments = await tx.projectExpertAssignment.findMany({ where: { projectId: id } });
        const count = (status: string) => assignments.filter((a) => a.status === status).length;
        const pending = count('PENDING_ACCEPTANCE'),
          accepted = count('ACCEPTED');
        const assigned = assignments
          .filter((a) => ['PENDING_ACCEPTANCE', 'ACCEPTED'].includes(a.status))
          .reduce((sum, a) => sum.add(a.productionRequirement ?? 0), new Prisma.Decimal(0));
        const brief = async (userId: string | null) => {
          if (!userId) return null;
          const user = await tx.user.findUnique({ where: { id: userId } });
          return user
            ? {
                userId,
                uid: user.uid,
                name: displayName(user.displayName, user.realName, user.uid),
                avatarUrl: user.avatarUrl,
              }
            : null;
        };
        const primary = relation.candidateUserId === p.userId;
        return {
          projectId: id,
          projectName: project.projectName,
          projectQuantity: project.projectQuantity?.toNumber() ?? null,
          quantityUnit: project.quantityUnit,
          currentNodeCode: project.currentNodeCode,
          primaryManager: await brief(relation.candidateUserId),
          handler: await brief(relation.expertRecruitmentHandlerUserId),
          currentOperatorRole: primary ? 'PRIMARY_MANAGER' : 'EXPERT_RECRUITMENT_HANDLER',
          canChangeHandler: primary,
          summary: {
            activeAssignmentCount: pending + accepted,
            pendingAcceptanceCount: pending,
            acceptedCount: accepted,
            rejectedCount: count('REJECTED'),
            assignedProductionRequirement: assigned.toNumber(),
            remainingProductionRequirement: project.projectQuantity
              ? Prisma.Decimal.max(project.projectQuantity.sub(assigned), 0).toNumber()
              : 0,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async candidates(query: RecruitmentQuery, p: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const { excluded } = await this.context(tx, query.projectId, p);
        const cte = candidateSql(excluded, query);
        const totals = await tx.$queryRaw<{ total: number }[]>(
          Prisma.sql`${cte} SELECT COUNT(*)::integer AS total FROM candidates`,
        );
        const total = totals[0]!.total;
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const rows = await tx.$queryRaw<RecruitmentCandidate[]>(Prisma.sql`${cte}
        SELECT c.*, CASE WHEN a."id" IS NULL THEN NULL ELSE jsonb_build_object(
          'assignmentId', a."id", 'status', a."status", 'productionRequirement', a."productionRequirement",
          'operatorHeadcount', a."operatorHeadcount", 'inspectorHeadcount', a."inspectorHeadcount") END AS assignment
        FROM candidates c ${candidateAssignmentSql(query.projectId)}
        ORDER BY (a."id" IS NULL), (c."subjectType"='INDIVIDUAL'), c."subjectId" LIMIT ${size} OFFSET ${(current - 1) * size}`);
        return {
          records: rows.map((r) => ({
            ...r,
            availableAction: !r.assignment
              ? 'RECRUIT'
              : r.assignment.status === 'REJECTED'
                ? 'RECRUIT_AGAIN'
                : 'NONE',
          })),
          total,
          current,
          size,
          pages: Math.ceil(total / size),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  private async tasks(
    tx: Prisma.TransactionClient,
    ctx: Awaited<ReturnType<ProjectRecruitmentService['context']>>,
  ) {
    return collectRecruitmentTasks(tx, ctx.project);
  }

  async submit(input: RecruitmentInput, p: AuthPrincipal) {
    if (p.role !== 'PM') throw new AuthError(403, 'FORBIDDEN', '当前会话必须为策略官');
    if (!input.assignments.length || input.assignments.length > 100) throw bad('单次须下发1—100项');
    const subjects = new Set<string>(),
      sources = new Set<number>();
    for (const a of input.assignments) {
      if (!['INDIVIDUAL', 'ORGANIZATION'].includes(a.subjectType)) throw bad('主体类型无效');
      const key = `${a.subjectType}:${a.subjectId}`;
      if (subjects.has(key)) throw bad('本次下发存在重复执行专家');
      subjects.add(key);
      const amount = new Prisma.Decimal(a.productionRequirement);
      if (
        !amount.isFinite() ||
        amount.lt('0.0001') ||
        amount.gte('10000000000000000') ||
        amount.decimalPlaces() > 4
      )
        throw bad('生产量级须为0.0001以上、最多16位整数及4位小数');
      for (const n of [a.operatorHeadcount, a.inspectorHeadcount])
        if (n != null && (!Number.isInteger(n) || n < 1 || n > 2147483647))
          throw bad('人数须为32位正整数');
      if (a.sourceRejectedAssignmentId != null) {
        if (sources.has(a.sourceRejectedAssignmentId))
          throw bad('同一拒单记录不能重复发起再次招募');
        sources.add(a.sourceRejectedAssignmentId);
      }
    }
    return this.db.$transaction(async (tx) => {
      const users = input.assignments
        .filter((a) => a.subjectType === 'INDIVIDUAL')
        .map((a) => a.subjectId);
      const orgs = input.assignments
        .filter((a) => a.subjectType === 'ORGANIZATION')
        .map((a) => a.subjectId);
      // 用户→组织/关系→项目，锁定真实接单主体及当前主管资格后再锁项目；同项目提交串行。
      await tx.$queryRaw(Prisma.sql`SELECT u."id" FROM "User" u WHERE u."id"::text IN (${Prisma.join(users.length ? users : [''])}) OR EXISTS (
        SELECT 1 FROM "UserOrgRel" r WHERE r."userId"=u."id" AND r."orgId"::text IN (${Prisma.join(orgs.length ? orgs : [''])}) AND r."position"='OWNER') ORDER BY u."id" FOR SHARE`);
      if (orgs.length)
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Organization" WHERE "id"::text IN (${Prisma.join(orgs)}) ORDER BY "id" FOR SHARE`,
        );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "UserOrgRel" WHERE "userId"::text IN (${Prisma.join(users.length ? users : [''])}) OR "orgId"::text IN (${Prisma.join(orgs.length ? orgs : [''])}) ORDER BY "id" FOR SHARE`,
      );
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.projectId} AND "deleted"=false FOR UPDATE`;
      const ctx = await this.context(tx, input.projectId, p);
      const before = await this.tasks(tx, ctx);
      for (const a of input.assignments) {
        const eligible = await tx.$queryRaw<{ subjectId: string }[]>(
          Prisma.sql`${candidateSql(ctx.excluded, { projectId: input.projectId, subjectType: a.subjectType }, a.subjectId)} SELECT "subjectId" FROM candidates`,
        );
        if (!eligible.length) throw bad('所选个人或组织不是有效执行专家，或与项目管理人员冲突');
        if (a.sourceRejectedAssignmentId != null) {
          const source = await tx.projectExpertAssignment.findFirst({
            where: {
              id: a.sourceRejectedAssignmentId,
              projectId: input.projectId,
              status: 'REJECTED',
              replacements: { none: {} },
            },
          });
          if (!source) throw bad('来源分配记录不是本项目未处理的拒单记录');
        }
        const active = await tx.projectExpertAssignment.findFirst({
          where: {
            projectId: input.projectId,
            subjectType: a.subjectType,
            ...(a.subjectType === 'INDIVIDUAL'
              ? { expertUserId: a.subjectId }
              : { organizationId: a.subjectId }),
            status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED'] },
          },
        });
        if (active) throw new AuthError(409, 'DUPLICATE', '该执行专家已有待接单或已接单记录');
      }
      const ids: number[] = [];
      for (const a of input.assignments) {
        const created = await tx.projectExpertAssignment.create({
          data: {
            projectId: input.projectId,
            assignmentNo: `PEA${randomUUID().replaceAll('-', '').toUpperCase()}`,
            subjectType: a.subjectType,
            expertUserId: a.subjectType === 'INDIVIDUAL' ? a.subjectId : null,
            organizationId: a.subjectType === 'ORGANIZATION' ? a.subjectId : null,
            productionRequirement: new Prisma.Decimal(a.productionRequirement),
            operatorHeadcount: a.operatorHeadcount,
            inspectorHeadcount: a.inspectorHeadcount ?? null,
            previousAssignmentId: a.sourceRejectedAssignmentId ?? null,
            status: 'PENDING_ACCEPTANCE',
            createdBy: p.uid,
            updatedBy: p.uid,
          },
        });
        ids.push(created.id);
      }
      const priorNodes = [
        'RECRUIT_PROJECT_MANAGER',
        'PRODUCTION_PLAN',
        'ENTRANCE_EXAM',
        'STANDARD_TRAINING',
        'RECRUIT_EXECUTION_EXPERT',
      ];
      if (!ctx.project.currentNodeCode || priorNodes.includes(ctx.project.currentNodeCode)) {
        ctx.project = await tx.project.update({
          where: { id: input.projectId },
          data: { currentNodeCode: 'PERSONNEL_MANAGEMENT', updatedBy: p.uid },
        });
      }
      const after = await this.tasks(tx, ctx);
      await reconcileTaskRounds(
        tx,
        input.projectId,
        before,
        after,
        { userId: p.userId, role: 'PM' },
        ['MAIN_RECRUIT_EXECUTION_EXPERT', 'EXPERT_RECRUITMENT_RETRY'],
        ['MAIN_RECRUIT_EXECUTION_EXPERT'],
        tracked,
      );
      await refreshOwnerProgress(tx, input.projectId, null, new Date());
      const cardChanges = await syncRecruitmentRetrySnapshot(tx, input.projectId, after);
      await tx.projectEventOutbox.create({
        data: {
          projectId: input.projectId,
          eventType: 'EXPERT_ASSIGNMENTS_CREATED',
          operation: 'project.expert-recruitments.submit',
          actorUserId: p.userId,
          payload: {
            schemaVersion: 1,
            projectId: input.projectId,
            assignmentIds: ids,
            ...taskEventFacts(before, after),
            ...cardChanges,
          },
        },
      });
      return null;
    });
  }
}
