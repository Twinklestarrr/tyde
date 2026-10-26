import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { lockPersonnel } from '../personnel/personnel.service.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import { reconcileTaskRounds } from '../projects/project-task-rounds.js';
import { parseDate } from '../attendance/attendance-domain.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import {
  outputScope,
  reportMembers,
  reportProject,
  isReportOwner,
  writableReport,
  reportConflict,
  forbiddenReport,
  reportActions,
} from './output-report-access.js';
import { outputTasks, syncOutputSnapshots } from './output-report-progress.js';
import {
  reportQuantity,
  reportDay,
  reportTypes,
  type ReportSave,
  type ReportCorrect,
  type ReportReview,
  type ReportQuery,
} from './output-report.domain.js';
import { invalidTask, type TaskQuery } from './production-domain.js';
const name = (u: { displayName: string | null; realName: string | null; uid: string }) =>
  displayName(u.displayName ?? '', u.realName, u.uid);
export class OutputReportService {
  constructor(readonly db: PrismaClient) {}
  async reportable(query: { projectId: number }, p: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        await reportProject(tx, query.projectId);
        if (p.role !== 'EXPERT') throw forbiddenReport();
        const ids = (await reportMembers(tx, query.projectId, now)).active
          .filter((m) => m.userId === p.userId)
          .map((m) => m.id);
        if (!ids.length) return [];
        const project = await reportProject(tx, query.projectId);
        if (project.currentNodeCode === 'COMPLETED') return [];
        const rows = await tx.projectSubtask.findMany({
          where: {
            projectId: query.projectId,
            status: 'IN_PROGRESS',
            OR: [
              { distributionMode: 'POOL' },
              { distributionMode: 'DESIGNATED', assignees: { some: { memberId: { in: ids } } } },
            ],
          },
          orderBy: { id: 'desc' },
        });
        return rows.map((r) => ({
          subtaskId: r.id,
          subtaskNo: r.subtaskNo,
          subtaskName: r.subtaskName,
          quantityUnit: r.quantityUnit,
          distributionMode: r.distributionMode,
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async assignees(query: TaskQuery & { subtaskId: number }, p: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        const project = await reportProject(tx, query.projectId);
        const task = await tx.projectSubtask.findFirst({
          where: { projectId: query.projectId, id: query.subtaskId },
        });
        if (!task) throw new AuthError(404, 'NOT_FOUND', '子任务不存在');
        if (!(p.role === 'NAVIGATOR' && p.uid === project.createdBy)) {
          const scope = await outputScope(tx, query.projectId, p, now);
          if (p.role === 'EXPERT') {
            const visible = await tx.projectSubtaskAssignee.count({
              where: {
                subtaskId: task.id,
                member: {
                  status: 'ACTIVE',
                  OR: [
                    { userId: p.userId, id: { in: scope.active.map((m) => m.id) } },
                    { organizationId: { in: scope.organizationIds ?? [] } },
                  ],
                },
              },
            });
            if (!visible && !(scope.reviewer && task.distributionMode === 'POOL'))
              throw forbiddenReport();
          }
        }
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const where: Prisma.ProjectSubtaskAssigneeWhereInput = {
          projectId: query.projectId,
          subtaskId: task.id,
          ...(query.keyword?.trim()
            ? {
                member: {
                  user: {
                    OR: ['displayName', 'realName', 'uid'].map((k) => ({
                      [k]: { contains: query.keyword!.trim() },
                    })),
                  },
                },
              }
            : {}),
        };
        const total = await tx.projectSubtaskAssignee.count({ where });
        const rows = await tx.projectSubtaskAssignee.findMany({
          where,
          orderBy: { id: 'asc' },
          skip: (current - 1) * size,
          take: size,
          include: {
            member: { include: { user: true, organization: true, expertAssignment: true } },
          },
        });
        return {
          current,
          size,
          total,
          pages: Math.ceil(total / size),
          records: rows.map((a) => ({
            memberId: a.memberId,
            userId: a.userId,
            uid: a.member.user.uid,
            displayName: name(a.member.user),
            subjectType: a.member.expertAssignment!.subjectType,
            organizationId: a.member.organizationId,
            organizationName: a.member.organization?.name ?? null,
            assignmentType: a.assignmentType,
            assignedAt: projectTime(a.assignedAt),
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async reports(query: ReportQuery, p: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        const scope = await outputScope(tx, query.projectId, p, now);
        if (
          query.reportDateStart &&
          query.reportDateEnd &&
          query.reportDateStart > query.reportDateEnd
        )
          throw invalidTask('报量开始日期不能晚于结束日期');
        for (const day of [query.reportDateStart, query.reportDateEnd])
          if (day) {
            parseDate(day);
          }
        if (
          query.subtaskId &&
          !(await tx.projectSubtask.findFirst({
            where: { id: query.subtaskId, projectId: query.projectId },
          }))
        )
          throw new AuthError(404, 'NOT_FOUND', '子任务不存在');
        const where: Prisma.ProjectOutputReportWhereInput = {
          projectId: query.projectId,
          subtaskId: query.subtaskId ?? null,
          ...(scope.memberIds ? { memberId: { in: scope.memberIds } } : {}),
          ...(query.reviewStatuses?.length ? { reviewStatus: { in: query.reviewStatuses } } : {}),
          ...(query.keyword?.trim()
            ? {
                member: {
                  user: {
                    OR: ['displayName', 'realName', 'uid'].map((k) => ({
                      [k]: { contains: query.keyword!.trim() },
                    })),
                  },
                },
              }
            : {}),
          ...(query.reportDateStart || query.reportDateEnd
            ? {
                reportDate: {
                  ...(query.reportDateStart ? { gte: new Date(query.reportDateStart) } : {}),
                  ...(query.reportDateEnd ? { lte: new Date(query.reportDateEnd) } : {}),
                },
              }
            : {}),
        };
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const grouped = await tx.projectOutputReport.groupBy({
          by: ['reviewStatus'],
          where,
          _count: { _all: true },
          _sum: { quantity: true },
        });
        const total = grouped.reduce((a, g) => a + g._count._all, 0);
        const rows = await tx.projectOutputReport.findMany({
          where,
          orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * size,
          take: size,
          include: { member: { include: { user: true } }, subtask: true },
        });
        return {
          totalReportCount: total,
          totalQuantity: Number(
            grouped.reduce((a, g) => a.plus(g._sum.quantity ?? 0), new Prisma.Decimal(0)),
          ),
          pendingCount: grouped.find((g) => g.reviewStatus === 'PENDING')?._count._all ?? 0,
          returnedCount: grouped.find((g) => g.reviewStatus === 'RETURNED')?._count._all ?? 0,
          page: {
            current,
            size,
            total,
            pages: Math.ceil(total / size),
            records: rows.map((r) => ({
              reportId: r.id,
              subtaskId: r.subtaskId,
              memberId: r.memberId,
              userId: r.userId,
              uid: r.member.user.uid,
              displayName: name(r.member.user),
              reportDate: r.reportDate.toISOString().slice(0, 10),
              quantity: Number(r.quantity),
              quantityUnit: r.quantityUnit,
              remark: r.remark,
              reviewStatus: r.reviewStatus,
              returnReason: r.returnReason,
              updatedAt: projectTime(r.updatedAt),
              allowedActions: reportActions(
                scope,
                r.memberId,
                r.reviewStatus,
                scope.project.currentNodeCode !== 'COMPLETED' &&
                  (r.subtask
                    ? r.subtask.status === 'IN_PROGRESS'
                    : scope.project.currentNodeCode === 'PRODUCTION_TASK'),
              ),
            })),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  private async command(
    projectId: number,
    ids: number[],
    p: AuthPrincipal,
    now: Date,
    operation: string,
    fn: (tx: Prisma.TransactionClient) => Promise<string[]>,
  ) {
    try {
      return await this.db.$transaction(
        async (tx) => {
          await lockPersonnel(tx, projectId, ids, p.userId);
          await reportProject(tx, projectId);
          const before = await outputTasks(tx, projectId, now);
          const recipients = await fn(tx);
          const after = await outputTasks(tx, projectId, now);
          await reconcileTaskRounds(
            tx,
            projectId,
            before,
            after,
            { userId: p.userId, role: p.role },
            reportTypes,
            [],
            reportTypes,
            now,
          );
          await syncOutputSnapshots(tx, projectId, before, after, now);
          // 核准只静默重算轮次/快照；保存、退回及代修正产生PENDING事实，14负责实际投递。
          if (recipients.length)
            await tx.projectEventOutbox.create({
              data: {
                projectId,
                eventType: 'OUTPUT_REPORT_STATE_CHANGED',
                operation,
                actorUserId: p.userId,
                payload: {
                  schemaVersion: 1,
                  projectId,
                  reporterUserIds: [...new Set(recipients)],
                  actorUserId: p.userId,
                },
              },
            });
          return null;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw reportConflict();
      throw error;
    }
  }
  async save(input: ReportSave, p: AuthPrincipal, now = new Date()) {
    if (p.role !== 'EXPERT') throw forbiddenReport();
    if (!input.reports?.length || input.reports.length > 100)
      throw invalidTask('reports须包含1至100条');
    const normalized = input.reports.map((r) => ({
      ...r,
      quantity: reportQuantity(r.quantity),
      date: reportDay(r.reportDate, now),
    }));
    // 不传memberId时锁定本人所有来源，避免多身份切换和并发离组。
    const own = await this.db.projectMember.findMany({
      where: { projectId: input.projectId, userId: p.userId },
      select: { id: true },
    });
    return this.command(
      input.projectId,
      [...own.map((m) => m.id), ...normalized.flatMap((r) => (r.memberId ? [r.memberId] : []))],
      p,
      now,
      'PENDING_REVIEW',
      async (tx) => {
        const scope = await outputScope(tx, input.projectId, p, now);
        const rels = await tx.userOrgRel.findMany({
          where: {
            userId: p.userId,
            joinStatus: { in: participatingStatuses },
            organization: { deleted: false },
          },
        });
        const keys = new Set<string>(),
          recipients: string[] = [];
        for (const [index, r] of normalized.entries()) {
          const candidates = scope.active.filter((m) =>
            r.memberId ? m.id === r.memberId : m.userId === p.userId,
          );
          if (candidates.length !== 1)
            throw invalidTask(`reports[${index}]: 可报量成员不存在或身份不唯一，请明确memberId`);
          const member = candidates[0]!;
          if (
            member.userId !== p.userId &&
            !(
              rels.some((rel) => rel.orgId === member.organizationId) &&
              isReportOwner(member, p.userId)
            )
          )
            throw forbiddenReport();
          const subtaskId = r.subtaskId ?? null;
          const key = JSON.stringify([subtaskId, member.id, r.reportDate]);
          if (keys.has(key))
            throw invalidTask(`reports[${index}]: 同一成员、层级和日期不能重复报量`);
          keys.add(key);
          const { task, quantityUnit } = await writableReport(tx, input.projectId, subtaskId);
          if (!quantityUnit?.trim()) throw invalidTask('量级单位未配置');
          if (task) {
            const assigned = await tx.projectSubtaskAssignee.findUnique({
              where: { subtaskId_memberId: { subtaskId: task.id, memberId: member.id } },
            });
            if (!assigned) {
              if (task.distributionMode !== 'POOL') throw forbiddenReport();
              await tx.projectSubtaskAssignee.create({
                data: {
                  projectId: input.projectId,
                  subtaskId: task.id,
                  memberId: member.id,
                  userId: member.userId,
                  assignmentType: 'CLAIMED',
                  assignedBy: p.uid,
                  assignedAt: now,
                },
              });
            }
          }
          const old = await tx.projectOutputReport.findFirst({
            where: {
              projectId: input.projectId,
              subtaskId,
              memberId: member.id,
              reportDate: r.date,
            },
          });
          const data = { quantity: r.quantity, remark: r.remark?.trim() || null, updatedBy: p.uid };
          if (old) {
            if (old.reviewStatus !== 'RETURNED') throw reportConflict();
            if (!scope.correctionIds.includes(member.id)) throw forbiddenReport();
            await tx.projectOutputReport.update({
              where: { id: old.id },
              data: {
                ...data,
                reviewStatus: 'PENDING',
                returnReason: null,
                returnedBy: null,
                returnedAt: null,
                lockedAt: null,
              },
            });
          } else
            await tx.projectOutputReport.create({
              data: {
                ...data,
                projectId: input.projectId,
                subtaskId,
                memberId: member.id,
                userId: member.userId,
                reportDate: r.date,
                quantityUnit,
                createdBy: p.uid,
              },
            });
          recipients.push(member.userId);
        }
        return recipients;
      },
    );
  }
  async correct(input: ReportCorrect, p: AuthPrincipal, now = new Date()) {
    if (p.role !== 'EXPERT') throw forbiddenReport();
    const quantity = reportQuantity(input.quantity);
    const initial = await this.db.projectOutputReport.findFirst({
      where: { projectId: input.projectId, id: input.reportId },
    });
    return this.command(
      input.projectId,
      initial ? [initial.memberId] : [],
      p,
      now,
      'PENDING_REVIEW',
      async (tx) => {
        const scope = await outputScope(tx, input.projectId, p, now);
        const report = await tx.projectOutputReport.findFirst({
          where: { projectId: input.projectId, id: input.reportId },
        });
        if (!report) throw new AuthError(404, 'NOT_FOUND', '待修正报量不存在');
        if (!scope.correctionIds.includes(report.memberId)) throw forbiddenReport();
        await writableReport(tx, input.projectId, report.subtaskId);
        if (report.reviewStatus !== 'RETURNED') throw reportConflict();
        await tx.projectOutputReport.update({
          where: { id: report.id },
          data: {
            quantity,
            remark: input.remark?.trim() || null,
            reviewStatus: 'PENDING',
            returnReason: null,
            returnedBy: null,
            returnedAt: null,
            lockedAt: null,
            updatedBy: p.uid,
          },
        });
        return report.userId === p.userId ? [] : [report.userId];
      },
    );
  }
  async review(input: ReportReview, p: AuthPrincipal, now = new Date()) {
    const ids = [...new Set(input.reportIds ?? [])];
    if (input.action !== 'VERIFY' && input.action !== 'RETURN') throw invalidTask('核查动作无效');
    if (input.action === 'RETURN' && (ids.length !== 1 || !input.reason?.trim()))
      throw invalidTask('退回必须恰好选择1条并填写原因');
    return this.command(
      input.projectId,
      [],
      p,
      now,
      input.action === 'RETURN' ? 'RETURNED_FOR_CORRECTION' : 'VERIFIED',
      async (tx) => {
        const scope = await outputScope(tx, input.projectId, p, now);
        if (!scope.reviewer || scope.readOnly) throw forbiddenReport();
        await writableReport(tx, input.projectId, input.subtaskId ?? null);
        const memberIds =
          scope.organizationIds === null
            ? null
            : scope.all
                .filter((m) => scope.organizationIds!.includes(m.organizationId ?? ''))
                .map((m) => m.id);
        const base = {
          projectId: input.projectId,
          subtaskId: input.subtaskId ?? null,
          ...(memberIds ? { memberId: { in: memberIds } } : {}),
        };
        if (
          ids.length &&
          (await tx.projectOutputReport.count({ where: { ...base, id: { in: ids } } })) !==
            ids.length
        )
          throw forbiddenReport();
        const where = {
          ...base,
          reviewStatus: 'PENDING',
          ...(ids.length ? { id: { in: ids } } : {}),
        };
        const targets = await tx.projectOutputReport.findMany({ where });
        if (ids.length && targets.length !== ids.length) throw reportConflict();
        const data =
          input.action === 'VERIFY'
            ? {
                reviewStatus: 'VERIFIED',
                verifiedBy: p.uid,
                verifiedAt: now,
                lockedAt: now,
                returnReason: null,
                returnedBy: null,
                returnedAt: null,
                updatedBy: p.uid,
              }
            : {
                reviewStatus: 'RETURNED',
                returnReason: input.reason!.trim(),
                returnedBy: p.uid,
                returnedAt: now,
                lockedAt: null,
                updatedBy: p.uid,
              };
        const changed = await tx.projectOutputReport.updateMany({ where, data });
        if (changed.count !== targets.length) throw reportConflict();
        return input.action === 'RETURN' ? targets.map((r) => r.userId) : [];
      },
    );
  }
}
