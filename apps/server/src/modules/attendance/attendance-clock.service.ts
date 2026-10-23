import { createHash } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type AttendanceClockEvent,
  type OrgAttendanceDaily,
} from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { lockOrganization } from '../organizations/organization.service.js';
import { AttendanceService } from './attendance.service.js';
import { dateText, parseDate, wallTime, invalid, conflict } from './attendance-domain.js';
import {
  calculateClockDaily,
  clockDecision,
  clockTimezone,
  clockWallTime,
  eventBounds,
  type ClockInput,
} from './attendance-clock.domain.js';

export class AttendanceClockService {
  private readonly attendance: AttendanceService;
  constructor(
    readonly db: PrismaClient,
    private readonly now = () => new Date(),
  ) {
    this.attendance = new AttendanceService(db);
  }
  private async scope(
    tx: Prisma.TransactionClient,
    orgId: string | null,
    principal: AuthPrincipal,
    lock: boolean,
  ) {
    if (orgId && lock) await lockOrganization(tx, orgId);
    if (lock)
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId}::uuid FOR UPDATE`;
    const member = orgId ? await this.attendance.membership(tx, orgId, principal.userId) : null;
    if (!orgId) await this.attendance.independent(tx, principal);
    return {
      scopeKey: orgId ?? 'PERSONAL',
      orgId,
      userId: principal.userId,
      userOrgRelId: member?.id ?? null,
    };
  }
  async context(input: ClockInput, principal: AuthPrincipal) {
    const timezone = clockTimezone(input.timezone),
      orgId = input.orgId?.toLowerCase() || null;
    return this.db.$transaction(
      async (tx) => {
        const scope = await this.scope(tx, orgId, principal, false);
        const now = clockWallTime(this.now(), timezone),
          attendanceDate = parseDate(dateText(now));
        const schedule = await tx.orgMemberSchedule.findFirst({
          where: { ...scope, scheduleDate: attendanceDate, status: 'ACTIVE' },
        });
        const events = await tx.attendanceClockEvent.findMany({
          where: { scopeKey: scope.scopeKey, userId: scope.userId, attendanceDate },
        });
        const decision = clockDecision(schedule, events, now),
          bounds = eventBounds(events);
        return {
          orgId,
          attendanceDate: dateText(now),
          serverTime: wallTime(now),
          scheduleId: schedule?.id ?? null,
          dayType: schedule?.dayType ?? null,
          shiftStartAt: wallTime(schedule?.shiftStartAt),
          shiftEndAt: wallTime(schedule?.shiftEndAt),
          firstClockInAt: wallTime(bounds.firstClockInAt),
          lastClockOutAt: wallTime(bounds.lastClockOutAt),
          ...decision,
          buttonText:
            decision.nextClockType === 'CLOCK_IN'
              ? '上班打卡'
              : decision.nextClockType === 'CLOCK_OUT'
                ? '下班打卡'
                : '暂不可打卡',
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async clock(key: string, input: ClockInput, principal: AuthPrincipal, clientIp: string) {
    if (!key?.trim() || key.length > 128) throw invalid('Idempotency-Key须为1至128字符');
    const timezone = clockTimezone(input.timezone),
      orgId = input.orgId?.toLowerCase() || null;
    return this.db.$transaction(async (tx) => {
      const scope = await this.scope(tx, orgId, principal, true);
      const eventNo =
        'CLK' +
        createHash('sha256')
          .update(`${scope.scopeKey}:${principal.userId}:${key.trim()}`)
          .digest('hex')
          .slice(0, 40)
          .toUpperCase();
      const existing = await tx.attendanceClockEvent.findUnique({ where: { eventNo } });
      if (existing) {
        if (input.clockType && input.clockType !== existing.clockType)
          throw new AuthError(409, 'DUPLICATE', 'Idempotency-Key已用于其他打卡请求');
        const daily = await tx.orgAttendanceDaily.findUniqueOrThrow({
          where: {
            scopeKey_userId_attendanceDate: {
              scopeKey: existing.scopeKey,
              userId: existing.userId,
              attendanceDate: existing.attendanceDate,
            },
          },
        });
        return clockResponse(existing, daily);
      }
      const instant = this.now(),
        now = clockWallTime(instant, timezone),
        attendanceDate = parseDate(dateText(now));
      const schedule = await tx.orgMemberSchedule.findFirst({
        where: { ...scope, scheduleDate: attendanceDate, status: 'ACTIVE' },
      });
      const events = await tx.attendanceClockEvent.findMany({
        where: { scopeKey: scope.scopeKey, userId: scope.userId, attendanceDate },
      });
      const decision = clockDecision(schedule, events, now);
      if (!decision.canClock) throw invalid(decision.warning!);
      if (input.clockType && input.clockType !== decision.nextClockType)
        throw new AuthError(409, 'DUPLICATE', '打卡状态已变化，请刷新后重试');
      const event = await tx.attendanceClockEvent.create({
        data: {
          ...scope,
          eventNo,
          attendanceDate,
          clockType: decision.nextClockType!,
          clockAt: now,
          occurredAt: instant,
          timezone,
          sourceRef: input.sourceRef?.trim() || null,
          clientIp,
          extJson: input.extJson == null ? Prisma.DbNull : (input.extJson as Prisma.InputJsonValue),
          createdBy: principal.uid,
        },
      });
      const where = {
        scopeKey_userId_attendanceDate: {
          scopeKey: scope.scopeKey,
          userId: scope.userId,
          attendanceDate,
        },
      };
      const daily = await tx.orgAttendanceDaily.upsert({
        where,
        update: {},
        create: { ...scope, attendanceDate, createdBy: 'SYSTEM', updatedBy: 'SYSTEM' },
      });
      const data = calculateClockDaily(schedule, daily, dateText(now), [...events, event]);
      const updated = await tx.orgAttendanceDaily.updateMany({
        where: { id: daily.id, versionNo: daily.versionNo },
        data: {
          ...data,
          calculatedAt: instant,
          updatedBy: 'SYSTEM',
          versionNo: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw conflict();
      const result = { ...daily, ...data, versionNo: daily.versionNo + 1 };
      await tx.attendanceEventOutbox.create({
        data: {
          orgId,
          eventType: 'ATTENDANCE_CLOCK',
          payload: {
            eventId: event.id,
            eventNo,
            userId: scope.userId,
            attendanceDate: dateText(attendanceDate),
            delivery: 'NOT_EXECUTED',
          },
        },
      });
      return clockResponse(event, result);
    });
  }
}
export function clockResponse(event: AttendanceClockEvent, daily: OrgAttendanceDaily) {
  return {
    eventId: event.id,
    eventNo: event.eventNo,
    orgId: event.orgId,
    memberId: event.userOrgRelId,
    userId: event.userId,
    clockType: event.clockType,
    clockAt: wallTime(event.clockAt, true),
    timezone: event.timezone,
    sourceType: event.sourceType,
    dailyAttendance: {
      id: daily.id,
      attendanceDate: dateText(daily.attendanceDate),
      scheduleId: daily.scheduleId,
      expectedStartAt: wallTime(daily.expectedStartAt),
      expectedEndAt: wallTime(daily.expectedEndAt),
      firstClockInAt: wallTime(daily.firstClockInAt, true),
      lastClockOutAt: wallTime(daily.lastClockOutAt, true),
      autoStatus: daily.autoStatus,
      finalStatus: daily.finalStatus,
      lateMinutes: daily.lateMinutes,
      earlyLeaveMinutes: daily.earlyLeaveMinutes,
      workedMinutes: daily.workedMinutes,
      reviewRequired: daily.reviewRequired,
      reviewReason: daily.reviewReason,
      versionNo: daily.versionNo,
    },
  };
}
