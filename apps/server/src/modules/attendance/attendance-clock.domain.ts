import type { OrgMemberSchedule, OrgAttendanceDaily } from '@prisma/client';
import { dateText, invalid } from './attendance-domain.js';
export interface ClockInput {
  orgId?: string | null;
  clockType?: 'CLOCK_IN' | 'CLOCK_OUT' | null;
  timezone?: string | null;
  sourceRef?: string | null;
  extJson?: unknown;
}
export interface ClockEvent {
  clockType: string;
  clockAt: Date;
}
export function clockTimezone(value?: string | null) {
  const timezone = value?.trim() || 'Asia/Shanghai';
  if (timezone.length > 64) throw invalid('timezone长度不能超过64');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw invalid('timezone不是有效IANA时区');
  }
  return timezone;
}
// 与现有排班Timestamp契约一致：Date的UTC分量表示指定时区的墙上时间，不是UTC瞬时。
export function clockWallTime(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  return new Date(
    `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(instant.getUTCMilliseconds()).padStart(3, '0')}Z`,
  );
}
export function eventBounds(events: ClockEvent[]) {
  const ins = events.filter((e) => e.clockType === 'CLOCK_IN').map((e) => e.clockAt.getTime());
  const outs = events.filter((e) => e.clockType === 'CLOCK_OUT').map((e) => e.clockAt.getTime());
  return {
    firstClockInAt: ins.length ? new Date(Math.min(...ins)) : null,
    lastClockOutAt: outs.length ? new Date(Math.max(...outs)) : null,
  };
}
export function clockDecision(schedule: OrgMemberSchedule | null, events: ClockEvent[], now: Date) {
  const { firstClockInAt: first, lastClockOutAt: last } = eventBounds(events);
  const next = first || last ? 'CLOCK_OUT' : 'CLOCK_IN';
  if (!schedule || schedule.status !== 'ACTIVE')
    return {
      nextClockType: next,
      canClock: true,
      warning: '当日未配置排班，本次打卡将记录为未排班',
    };
  if (schedule.dayType === 'REST')
    return { nextClockType: next, canClock: true, warning: '当日为休息日，本次打卡仍会正常记录' };
  const start = schedule.shiftStartAt,
    end = schedule.shiftEndAt;
  if (!start || !end)
    return { nextClockType: null, canClock: false, warning: '当日排班时间不完整，不能打卡' };
  if (
    [schedule.scheduleDate, start, end].some((d) => dateText(d) !== dateText(now)) ||
    end <= start
  )
    return { nextClockType: null, canClock: false, warning: '跨天班次不支持打卡' };
  if (first || last)
    return {
      nextClockType: 'CLOCK_OUT',
      canClock: true,
      warning: first ? null : '未检测到上班卡，本次将记为下班卡',
    };
  return now.getTime() < (start.getTime() + end.getTime()) / 2
    ? { nextClockType: 'CLOCK_IN', canClock: true, warning: null }
    : {
        nextClockType: 'CLOCK_OUT',
        canClock: true,
        warning: '已进入下班阶段且缺少上班卡，本次将记为下班卡',
      };
}
export function calculateClockDaily(
  schedule: OrgMemberSchedule | null,
  daily: OrgAttendanceDaily,
  today: string,
  events?: ClockEvent[],
) {
  const { firstClockInAt: first, lastClockOutAt: last } = events ? eventBounds(events) : daily;
  const work = schedule?.status === 'ACTIVE' && schedule.dayType === 'WORK';
  const late = !!(work && first && schedule.shiftStartAt && first > schedule.shiftStartAt);
  const early = !!(work && last && schedule.shiftEndAt && last < schedule.shiftEndAt);
  const autoStatus =
    !schedule || schedule.status !== 'ACTIVE'
      ? 'UNSCHEDULED'
      : !work
        ? 'REST'
        : !first && !last
          ? dateText(daily.attendanceDate) < today
            ? 'ABSENT'
            : null
          : late && early
            ? 'LATE_EARLY'
            : late
              ? 'LATE'
              : early
                ? 'EARLY_LEAVE'
                : 'PRESENT';
  const minutes = (a: Date | null, b: Date | null) =>
    a && b ? Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60000)) : 0;
  return {
    scheduleId: schedule?.id ?? null,
    expectedStartAt: schedule?.shiftStartAt ?? null,
    expectedEndAt: schedule?.shiftEndAt ?? null,
    firstClockInAt: first,
    lastClockOutAt: last,
    autoStatus,
    finalStatus: daily.manualOverride ? daily.finalStatus : autoStatus,
    lateMinutes: work ? minutes(schedule.shiftStartAt, first) : 0,
    earlyLeaveMinutes: work ? minutes(last, schedule.shiftEndAt) : 0,
    workedMinutes: minutes(first, last),
    reviewRequired: false,
    reviewReason: null,
  };
}
