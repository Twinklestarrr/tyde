import {
  normalizeSchedules,
  parseDate,
  dateText,
  invalid,
  type ScheduleInput,
} from './attendance-domain.js';
import type { HolidayCalendarService } from './holiday-calendar.service.js';
export interface OrganizationScheduleQuery {
  orgId: string;
  month: string;
  keyword?: string | null;
  employmentType?: string | null;
  joinStatus?: string | null;
  position?: string | null;
  projectId?: number | null;
  current?: number;
  size?: number;
}
type Shift = ScheduleInput['schedules'][number];
export interface OrganizationScheduleBatch extends Omit<Shift, 'scheduleDate'> {
  orgId: string;
  memberIds: string[];
  startDate: string;
  endDate: string;
  weekdays?: number[] | null;
  timezone?: string | null;
  overwrite: boolean;
}
export interface OrganizationScheduleDetails {
  orgId: string;
  schedules: (Shift & { memberId: string; timezone?: string | null })[];
  timezone?: string | null;
  overwrite: boolean;
}
export function normalizeDetails(input: OrganizationScheduleDetails) {
  if (
    !input.schedules?.length ||
    input.schedules.length > 5000 ||
    typeof input.overwrite !== 'boolean'
  )
    throw invalid('schedules须有1至5000条且overwrite必填');
  const seen = new Set<string>(),
    members = new Set<string>();
  const schedules = input.schedules.map((item) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.memberId))
      throw invalid('memberId须为成员关系UUID');
    const key = `${item.memberId.toLowerCase()}/${item.scheduleDate}`;
    if (seen.has(key)) throw invalid('schedules不能包含重复成员和日期');
    seen.add(key);
    members.add(item.memberId.toLowerCase());
    const [shift] = normalizeSchedules({
      schedules: [item],
      timezone: item.timezone?.trim() || input.timezone,
      overwrite: input.overwrite,
    });
    return { memberId: item.memberId.toLowerCase(), ...shift! };
  });
  if (members.size > 500) throw invalid('最多500个不同成员');
  return schedules.sort(
    (a, b) => a.memberId.localeCompare(b.memberId) || a.scheduleDate.localeCompare(b.scheduleDate),
  );
}
export async function expandBatch(
  input: OrganizationScheduleBatch,
  holiday: HolidayCalendarService,
) {
  const start = parseDate(input.startDate),
    end = parseDate(input.endDate);
  // 限制展开成本；明细接口仍支持跨年度的稀疏排班。
  if (start > end || end.getTime() - start.getTime() > 365 * 86400000)
    throw invalid('日期范围须正序且最多366天');
  if (!input.memberIds?.length || input.memberIds.length > 500)
    throw invalid('memberIds须有1至500项');
  const members = [...new Set(input.memberIds.map((id) => id.toLowerCase()))].sort();
  const weekdays = input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5];
  if (weekdays.length > 7 || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw invalid('weekdays须为1至7');
  // 即使范围没有匹配日期，也先校验班次及时区。
  normalizeDetails({
    orgId: input.orgId,
    overwrite: input.overwrite,
    timezone: input.timezone,
    schedules: members.map((memberId) => ({ ...input, memberId, scheduleDate: input.startDate })),
  });
  const holidays = new Set<string>();
  const months = new Set<string>();
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000)
    months.add(dateText(new Date(t)).slice(0, 7));
  for (const month of months) {
    const calendar = await holiday.month(month);
    for (const day of calendar.days)
      if (day.calendarDayType === 'PUBLIC_HOLIDAY') holidays.add(day.date);
  }
  const dates: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const date = new Date(t),
      text = dateText(date);
    if (weekdays.includes(date.getUTCDay() || 7) && !holidays.has(text)) dates.push(text);
  }
  if (!dates.length) throw invalid('日期范围内没有可排班日期');
  if (dates.length * members.length > 5000) throw invalid('展开后最多5000条排班，请分批提交');
  return normalizeDetails({
    orgId: input.orgId,
    overwrite: input.overwrite,
    timezone: input.timezone,
    schedules: members.flatMap((memberId) =>
      dates.map((scheduleDate) => ({ ...input, memberId, scheduleDate })),
    ),
  });
}
