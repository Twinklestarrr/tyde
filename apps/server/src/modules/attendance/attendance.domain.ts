import type { OrgAttendanceDaily, OrgMemberSchedule } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { businessDate } from '../organizations/member.domain.js';
export const manualStatuses = [
  'PRESENT',
  'LATE',
  'EARLY_LEAVE',
  'LATE_EARLY',
  'LEAVE',
  'ABSENT',
  'REST',
];
export const attendanceStatuses = [...manualStatuses, 'UNSCHEDULED', 'REVIEW_REQUIRED'];
export const invalid = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
export const conflict = () => new AppError(409, 'DUPLICATE', '考勤或排班版本已变化，请刷新后重试');
export const dateText = (date: Date) => date.toISOString().slice(0, 10);
export const wallTime = (date: Date | null | undefined, milliseconds = false) =>
  date
    ? date
        .toISOString()
        .slice(0, milliseconds ? 23 : 19)
        .replace('T', ' ')
    : null;
export function parseDate(value: string) {
  businessDate(value, true);
  return new Date(`${value}T00:00:00Z`);
}
export function monthDates(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900)
    throw invalid('month须为1900年起的YYYY-MM');
  const start = parseDate(`${month}-01`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const dates: string[] = [];
  for (let time = start.getTime(); time < end.getTime(); time += 86400000)
    dates.push(dateText(new Date(time)));
  return { start, end, dates };
}
export interface ScheduleInput {
  schedules: {
    scheduleDate: string;
    dayType: 'WORK' | 'REST';
    startTime?: string | null;
    endTime?: string | null;
  }[];
  overwrite: boolean;
  timezone?: string | null;
}
export function normalizeSchedules(input: ScheduleInput) {
  if (
    !input.schedules?.length ||
    input.schedules.length > 366 ||
    typeof input.overwrite !== 'boolean'
  )
    throw invalid('schedules须有1至366条且overwrite必填');
  const timezone = input.timezone?.trim() || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw invalid('timezone不是有效IANA时区');
  }
  const seen = new Set<string>();
  function time(value: string | null | undefined) {
    if (!value || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))
      throw invalid('WORK班次须提供有效HH:mm[:ss]时间');
    return value.length === 5 ? `${value}:00` : value;
  }
  return input.schedules
    .map((item) => {
      parseDate(item.scheduleDate);
      if (seen.has(item.scheduleDate)) throw invalid('schedules不能包含重复日期');
      seen.add(item.scheduleDate);
      if (!['WORK', 'REST'].includes(item.dayType)) throw invalid('dayType须为WORK或REST');
      if (item.dayType === 'REST' && (item.startTime != null || item.endTime != null))
        throw invalid('REST不能提供班次时间');
      const startTime = item.dayType === 'WORK' ? time(item.startTime) : null;
      const endTime = item.dayType === 'WORK' ? time(item.endTime) : null;
      if (startTime && endTime && endTime <= startTime)
        throw invalid('不支持跨日班次，结束时间须晚于开始时间');
      return {
        scheduleDate: item.scheduleDate,
        dayType: item.dayType,
        startTime,
        endTime,
        timezone,
      };
    })
    .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate));
}
export function calendarDay(
  date: string,
  today: string,
  schedule?: OrgMemberSchedule,
  daily?: OrgAttendanceDaily,
) {
  let autoStatus = daily?.autoStatus ?? null,
    finalStatus = daily?.finalStatus ?? null;
  let reviewRequired = daily?.reviewRequired ?? null,
    reviewReason = daily?.reviewReason ?? null;
  if (autoStatus === 'REVIEW_REQUIRED' || finalStatus === 'REVIEW_REQUIRED') {
    let inferred: string | null;
    if (!schedule || schedule.status !== 'ACTIVE') inferred = 'UNSCHEDULED';
    else if (schedule.dayType === 'REST') inferred = 'REST';
    else if (!daily?.firstClockInAt && !daily?.lastClockOutAt)
      inferred = date < today ? 'ABSENT' : null;
    else {
      const late =
        daily?.firstClockInAt &&
        schedule.shiftStartAt &&
        daily.firstClockInAt > schedule.shiftStartAt;
      const early =
        daily?.lastClockOutAt && schedule.shiftEndAt && daily.lastClockOutAt < schedule.shiftEndAt;
      inferred = late && early ? 'LATE_EARLY' : late ? 'LATE' : early ? 'EARLY_LEAVE' : 'PRESENT';
    }
    if (autoStatus === 'REVIEW_REQUIRED') autoStatus = inferred;
    if (finalStatus === 'REVIEW_REQUIRED') finalStatus = inferred;
    reviewRequired = false;
    reviewReason = null;
  }
  const calendarStatus =
    finalStatus ??
    (!schedule || schedule.status !== 'ACTIVE'
      ? 'UNSCHEDULED'
      : schedule.dayType === 'REST'
        ? 'REST'
        : date < today
          ? 'ABSENT'
          : 'PENDING_ATTENDANCE');
  return {
    scheduleId: schedule?.id ?? null,
    scheduleDate: date,
    calendarStatus,
    dayType: schedule?.dayType ?? null,
    shiftStartAt: wallTime(schedule?.shiftStartAt),
    shiftEndAt: wallTime(schedule?.shiftEndAt),
    timezone: schedule?.timezone ?? null,
    sourceType: schedule?.sourceType ?? null,
    batchNo: schedule?.batchNo ?? null,
    status: schedule?.status ?? null,
    versionNo: schedule?.versionNo ?? null,
    dailyId: daily?.id ?? null,
    autoStatus,
    finalStatus,
    firstClockInAt: wallTime(daily?.firstClockInAt, true),
    lastClockOutAt: wallTime(daily?.lastClockOutAt, true),
    reviewRequired,
    reviewReason,
    manualOverride: daily?.manualOverride ?? null,
    dailyVersionNo: daily?.versionNo ?? null,
  };
}
export function summarize(days: { calendarStatus: string }[]) {
  const summary = {
    presentCount: 0,
    lateCount: 0,
    earlyLeaveCount: 0,
    leaveCount: 0,
    absentCount: 0,
  };
  for (const { calendarStatus: status } of days) {
    if (status === 'PRESENT') summary.presentCount++;
    if (status === 'LATE' || status === 'LATE_EARLY') summary.lateCount++;
    if (status === 'EARLY_LEAVE' || status === 'LATE_EARLY') summary.earlyLeaveCount++;
    if (status === 'LEAVE') summary.leaveCount++;
    if (status === 'ABSENT') summary.absentCount++;
  }
  return summary;
}
