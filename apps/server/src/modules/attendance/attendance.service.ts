import { replayClockDaily } from './attendance-replay.js';
import { attendanceBusinessId, attendanceBusinessTypes } from './attendance-application.domain.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses, lockOrganization } from '../organizations/organization.service.js';
import { shanghaiDay } from '../organizations/departure.service.js';
import { projectTime } from '../projects/project-time.js';
import {
  calendarDay,
  summarize,
  monthDates,
  normalizeSchedules,
  parseDate,
  dateText,
  invalid,
  conflict,
  manualStatuses,
  type ScheduleInput,
} from './attendance-domain.js';
export interface AttendanceUpdate {
  orgId: string;
  dailyId: number;
  finalStatus: string;
  manualRemark?: string | null;
  versionNo: number;
}
export class AttendanceService {
  constructor(readonly db: PrismaClient) {}
  async independent(tx: Prisma.TransactionClient, principal: AuthPrincipal) {
    if (principal.role !== 'EXPERT')
      throw new AuthError(403, 'FORBIDDEN', '仅执行专家可以使用个人排班');
    const count = await tx.userOrgRel.count({
      where: { userId: principal.userId, joinStatus: { in: participatingStatuses } },
    });
    if (count) throw new AuthError(403, 'FORBIDDEN', '当前用户已有组织，请使用组织排班并传orgId');
  }
  async membership(tx: Prisma.TransactionClient, orgId: string, userId: string) {
    const org = await tx.organization.findFirst({ where: { id: orgId, deleted: false } });
    if (!org) throw new AuthError(404, 'NOT_FOUND', '组织不存在');
    const rel = await tx.userOrgRel.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (!rel || !participatingStatuses.includes(rel.joinStatus))
      throw new AuthError(403, 'FORBIDDEN', '当前用户不是该组织有效成员');
    return rel;
  }
  async batch(key: string, input: ScheduleInput, principal: AuthPrincipal) {
    if (!key?.trim() || key.length > 128) throw invalid('Idempotency-Key不能为空且不能超过128字符');
    const schedules = normalizeSchedules(input);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ schedules, overwrite: input.overwrite }))
      .digest('hex');
    return this.db.$transaction(
      async (tx) => {
        // 用户行锁串行化本人的个人排班和receipt；不在外部缓存制造事务提交空窗。
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId}::uuid FOR UPDATE`;
        await this.independent(tx, principal);
        const receipt = await tx.personalScheduleReceipt.findUnique({
          where: { userId_key: { userId: principal.userId, key: key.trim() } },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            throw new AuthError(409, 'DUPLICATE', '幂等键已用于不同排班请求');
          return receipt.response;
        }
        const batchNo = `SELF-SCH-${randomUUID().replaceAll('-', '').toUpperCase()}`;
        const conflicts: { scheduleDate: string; scheduleId: number; versionNo: number }[] = [];
        let createdCount = 0,
          updatedCount = 0;
        const existingRows = await tx.orgMemberSchedule.findMany({
          where: {
            scopeKey: 'PERSONAL',
            userId: principal.userId,
            scheduleDate: { in: schedules.map((item) => parseDate(item.scheduleDate)) },
          },
        });
        const existingByDate = new Map(
          existingRows.map((row) => [dateText(row.scheduleDate), row]),
        );
        const inserts: Prisma.OrgMemberScheduleCreateManyInput[] = [];
        for (const item of schedules) {
          const scheduleDate = parseDate(item.scheduleDate);
          const existing = existingByDate.get(item.scheduleDate);
          if (existing && !input.overwrite) {
            conflicts.push({
              scheduleDate: item.scheduleDate,
              scheduleId: existing.id,
              versionNo: existing.versionNo,
            });
            continue;
          }
          const data = {
            dayType: item.dayType,
            shiftStartAt: item.startTime
              ? new Date(`${item.scheduleDate}T${item.startTime}Z`)
              : null,
            shiftEndAt: item.endTime ? new Date(`${item.scheduleDate}T${item.endTime}Z`) : null,
            timezone: item.timezone,
            batchNo,
            status: 'ACTIVE',
            sourceType: 'MANUAL',
            updatedBy: principal.uid,
          };
          if (existing) {
            const changed = await tx.orgMemberSchedule.updateMany({
              where: { id: existing.id, versionNo: existing.versionNo },
              data: { ...data, versionNo: { increment: 1 } },
            });
            if (changed.count !== 1) throw conflict();
            updatedCount++;
          } else {
            inserts.push({
              ...data,
              scopeKey: 'PERSONAL',
              userId: principal.userId,
              scheduleDate,
              createdBy: principal.uid,
            });
            createdCount++;
          }
        }
        if (inserts.length) await tx.orgMemberSchedule.createMany({ data: inserts });
        // 个人排班覆盖/补排也重放已有事件，不制造无打卡日考勤。
        const changedSchedules = await tx.orgMemberSchedule.findMany({
          where: { scopeKey: 'PERSONAL', userId: principal.userId, batchNo },
        });
        for (const schedule of changedSchedules) {
          const daily = await tx.orgAttendanceDaily.findUnique({
            where: {
              scopeKey_userId_attendanceDate: {
                scopeKey: 'PERSONAL',
                userId: principal.userId,
                attendanceDate: schedule.scheduleDate,
              },
            },
          });
          if (!daily) continue;
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: schedule.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date());
          const data = await replayClockDaily(tx, schedule, daily, today);
          const result = await tx.orgAttendanceDaily.updateMany({
            where: { id: daily.id, versionNo: daily.versionNo },
            data: {
              ...data,
              versionNo: { increment: 1 },
              calculatedAt: new Date(),
              updatedBy: 'SYSTEM',
            },
          });
          if (result.count !== 1) throw conflict();
        }
        const response = {
          batchNo,
          createdCount,
          updatedCount,
          skippedCount: conflicts.length,
          conflicts,
        };
        await tx.personalScheduleReceipt.create({
          data: { userId: principal.userId, key: key.trim(), requestHash, response },
        });
        return response;
      },
      { timeout: 30000 },
    );
  }
  async month(month: string, orgId: string | undefined, principal: AuthPrincipal) {
    const range = monthDates(month);
    return this.db.$transaction(
      async (tx) => {
        const rel = orgId ? await this.membership(tx, orgId, principal.userId) : null;
        if (!orgId) await this.independent(tx, principal);
        const user = await tx.user.findUniqueOrThrow({ where: { id: principal.userId } });
        const where = { scopeKey: orgId ?? 'PERSONAL', userId: principal.userId };
        const schedules = await tx.orgMemberSchedule.findMany({
          where: { ...where, scheduleDate: { gte: range.start, lt: range.end } },
        });
        const daily = await tx.orgAttendanceDaily.findMany({
          where: { ...where, attendanceDate: { gte: range.start, lt: range.end } },
        });
        const scheduleMap = new Map(schedules.map((s) => [dateText(s.scheduleDate), s]));
        const dailyMap = new Map(daily.map((d) => [dateText(d.attendanceDate), d]));
        const today = shanghaiDay(new Date());
        const flows = orgId
          ? await tx.approvalFlow.findMany({
              where: {
                applicantOrgId: orgId,
                applicantId: principal.userId,
                businessType: { in: attendanceBusinessTypes },
                businessId: {
                  in: range.dates.map((date) => attendanceBusinessId(principal.userId, date)),
                },
              },
              orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
            })
          : [];
        const latest = new Map<string, (typeof flows)[number]>();
        const pending = new Set<string>();
        for (const flow of flows) {
          if (!latest.has(flow.businessId)) latest.set(flow.businessId, flow);
          if (flow.status === 'PENDING') pending.add(flow.businessId);
        }
        const canApply = !!rel && ['MEMBER', 'ADMIN'].includes(rel.position);
        const canDirectUpdate = !!rel && ['OWNER', 'ADMIN'].includes(rel.position);
        const days = range.dates.map((date) => {
          const schedule = scheduleMap.get(date),
            daily = dailyMap.get(date);
          const businessId = attendanceBusinessId(principal.userId, date),
            flow = latest.get(businessId);
          const form = flow?.formData;
          const data = form && typeof form === 'object' && !Array.isArray(form) ? form : {};
          const hasPending = pending.has(businessId);
          const workSchedule = schedule?.status === 'ACTIVE' && schedule.dayType === 'WORK';
          return {
            ...calendarDay(date, today, schedule, daily),
            application: flow
              ? {
                  applicationId: flow.id,
                  flowNo: flow.flowNo,
                  flowVersionNo: flow.versionNo,
                  applicationType: data.applicationType,
                  status: flow.status,
                  finalStatus: data.finalStatus,
                  canWithdraw: flow.status === 'PENDING',
                }
              : null,
            permissions: {
              canApplyLeave:
                canApply && !!workSchedule && !hasPending && daily?.finalStatus !== 'LEAVE',
              canApplyCorrection:
                canApply && date <= today && (!!daily || !!workSchedule) && !hasPending,
              canWithdraw: hasPending,
              canDirectUpdate: canDirectUpdate && date <= today && !!daily,
            },
          };
        });
        return {
          organizationId: orgId ?? null,
          independentSchedule: !orgId,
          month,
          memberId: rel?.id ?? null,
          userId: principal.userId,
          realName: user.realName,
          nickname: user.displayName,
          summary: summarize(days),
          days,
          permissions: {
            canBatchSchedule: !orgId,
            canDirectUpdate,
            canApply,
            canWithdraw: pending.size > 0,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async update(input: AttendanceUpdate, principal: AuthPrincipal) {
    if (!manualStatuses.includes(input.finalStatus))
      throw invalid('finalStatus不支持人工设置为该状态');
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const rel = await this.membership(tx, input.orgId, principal.userId);
      if (!['OWNER', 'ADMIN'].includes(rel.position))
        throw new AuthError(403, 'FORBIDDEN', '仅组织主管和管理员可直接变更考勤');
      await tx.$queryRaw`SELECT "id" FROM "OrgAttendanceDaily" WHERE "id" = ${input.dailyId} AND "orgId" = ${input.orgId}::uuid FOR UPDATE`;
      const daily = await tx.orgAttendanceDaily.findFirst({
        where: { id: input.dailyId, orgId: input.orgId },
      });
      if (!daily) throw new AuthError(404, 'NOT_FOUND', '日考勤记录不存在');
      if (daily.versionNo !== input.versionNo) throw conflict();
      if (dateText(daily.attendanceDate) > shanghaiDay(new Date()))
        throw invalid('不能修正未来日期的考勤');
      const now = new Date(),
        remark = input.manualRemark?.trim() || null;
      const result = await tx.orgAttendanceDaily.updateMany({
        where: { id: daily.id, versionNo: input.versionNo },
        data: {
          finalStatus: input.finalStatus,
          manualOverride: true,
          manualRemark: remark,
          correctedBy: principal.uid,
          correctedAt: now,
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
        },
      });
      if (result.count !== 1) throw conflict();
      const operator = await tx.user.findUniqueOrThrow({ where: { id: principal.userId } });
      const nickname = operator.displayName?.trim(),
        name = operator.realName?.trim();
      const adjustment = await tx.orgAttendanceAdjustment.create({
        data: {
          attendanceDailyId: daily.id,
          beforeStatus: daily.finalStatus,
          afterStatus: input.finalStatus,
          beforeRemark: daily.manualRemark,
          afterRemark: remark,
          reason: remark ?? '',
          operatorUserId: principal.userId,
          operatorName:
            nickname && name ? `${nickname}(${name})` : nickname || name || principal.uid,
          createdBy: principal.uid,
          createdAt: now,
        },
      });
      return {
        id: daily.id,
        beforeStatus: daily.finalStatus,
        finalStatus: input.finalStatus,
        manualOverride: true,
        manualRemark: remark,
        correctedBy: principal.uid,
        correctedAt: projectTime(now),
        versionNo: input.versionNo + 1,
        adjustmentId: adjustment.id,
      };
    });
  }
}
