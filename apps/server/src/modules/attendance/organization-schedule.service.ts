import { calculateClockDaily } from './attendance-clock.domain.js';
import { replayClockDaily } from './attendance-replay.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type OrgMemberSchedule,
  type OrgAttendanceDaily,
} from '@prisma/client';
import { AttendanceService } from './attendance.service.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { lockOrganization, participatingStatuses } from '../organizations/organization.service.js';
import { shanghaiDay } from '../organizations/departure.service.js';
import {
  calendarDay,
  summarize,
  monthDates,
  parseDate,
  dateText,
  invalid,
  conflict,
} from './attendance-domain.js';
import { HolidayCalendarService } from './holiday-calendar.service.js';
import {
  normalizeDetails,
  expandBatch,
  type OrganizationScheduleQuery,
  type OrganizationScheduleBatch,
  type OrganizationScheduleDetails,
} from './organization-schedule.domain.js';
type Assignment = ReturnType<typeof normalizeDetails>[number];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recalculateScheduledDaily(
  schedule: OrgMemberSchedule,
  daily: OrgAttendanceDaily,
  today: string,
) {
  return calculateClockDaily(schedule, daily, today);
}
export class OrganizationScheduleService {
  private readonly attendance: AttendanceService;
  constructor(
    readonly db: PrismaClient,
    readonly holiday = new HolidayCalendarService(),
  ) {
    this.attendance = new AttendanceService(db);
  }
  private async manager(tx: Prisma.TransactionClient, orgId: string, principal: AuthPrincipal) {
    if (principal.role !== 'EXPERT')
      throw new AuthError(403, 'FORBIDDEN', '请切换执行专家身份管理组织排班');
    const rel = await this.attendance.membership(tx, orgId, principal.userId);
    if (!['OWNER', 'ADMIN'].includes(rel.position))
      throw new AuthError(403, 'FORBIDDEN', '仅目标组织主管或管理员可管理排班');
  }
  async list(input: OrganizationScheduleQuery, principal: AuthPrincipal) {
    const range = monthDates(input.month),
      current = input.current ?? 1,
      size = input.size ?? 20;
    if (
      !Number.isInteger(current) ||
      current < 1 ||
      current > 2147483647 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 100
    )
      throw invalid('分页参数不合法');
    return this.db.$transaction(
      async (tx) => {
        await this.manager(tx, input.orgId, principal);
        const keyword = input.keyword?.trim();
        // 入组时间在上海时区展示；支持日期/时间前缀而不把所有成员拉到内存过滤。
        let joinedIds: string[] = [];
        if (keyword) {
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "UserOrgRel" WHERE "orgId" = ${input.orgId}::uuid AND ("id"::text LIKE ${`%${keyword}%`} OR "userId"::text LIKE ${`%${keyword}%`} OR to_char("joinedAt" AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') LIKE ${`%${keyword}%`})`;
          joinedIds = rows.map((r) => r.id);
        }
        const where: Prisma.UserOrgRelWhereInput = {
          orgId: input.orgId,
          joinStatus: input.joinStatus || { in: ['PENDING_ACTIVATION', ...participatingStatuses] },
          ...(input.employmentType ? { employmentType: input.employmentType } : {}),
          ...(input.position ? { position: input.position } : {}),
          ...(input.projectId
            ? { projectMembers: { some: { projectId: input.projectId, status: 'ACTIVE' } } }
            : {}),
          ...(keyword
            ? {
                OR: [
                  {
                    user: {
                      OR: [
                        { realName: { contains: keyword } },
                        { displayName: { contains: keyword } },
                        { uid: { contains: keyword } },
                        { phoneE164: keyword.startsWith('+') ? keyword : `+86${keyword}` },
                      ],
                    },
                  },

                  ...(joinedIds.length ? [{ id: { in: joinedIds } }] : []),
                ],
              }
            : {}),
        };
        const total = await tx.userOrgRel.count({ where });
        const offset = (current - 1) * size;
        const rows =
          offset >= total
            ? []
            : await tx.userOrgRel.findMany({
                where,
                include: { user: true },
                orderBy: { id: 'asc' },
                skip: offset,
                take: size,
              });
        const memberIds = rows.map((r) => r.id);
        const schedules = rows.length
          ? await tx.orgMemberSchedule.findMany({
              where: {
                orgId: input.orgId,
                userOrgRelId: { in: memberIds },
                scheduleDate: { gte: range.start, lt: range.end },
              },
            })
          : [];
        const dailies = rows.length
          ? await tx.orgAttendanceDaily.findMany({
              where: {
                orgId: input.orgId,
                userOrgRelId: { in: memberIds },
                attendanceDate: { gte: range.start, lt: range.end },
              },
            })
          : [];
        const key = (member: string | null, date: Date) => `${member}/${dateText(date)}`;
        const sm = new Map(schedules.map((s) => [key(s.userOrgRelId, s.scheduleDate), s]));
        const dm = new Map(dailies.map((d) => [key(d.userOrgRelId, d.attendanceDate), d]));
        const today = shanghaiDay(new Date());
        return {
          month: input.month,
          total,
          pages: Math.ceil(total / size),
          current,
          size,
          members: rows.map((rel) => {
            const days = range.dates.map((date) =>
              calendarDay(date, today, sm.get(`${rel.id}/${date}`), dm.get(`${rel.id}/${date}`)),
            );
            return {
              memberId: rel.id,
              userId: rel.userId,
              realName: rel.user.realName,
              nickname: rel.user.displayName,
              joinStatus: rel.joinStatus,
              canSchedule: participatingStatuses.includes(rel.joinStatus),
              summary: summarize(days),
              days,
            };
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async batch(key: string, input: OrganizationScheduleBatch, principal: AuthPrincipal) {
    const members = [...new Set(input.memberIds)].sort();
    const sample = normalizeDetails({
      orgId: input.orgId,
      overwrite: input.overwrite,
      timezone: input.timezone,
      schedules: members.map((memberId) => ({ ...input, memberId, scheduleDate: input.startDate })),
    });
    parseDate(input.endDate);
    const fingerprint = {
      startDate: input.startDate,
      endDate: input.endDate,
      weekdays: [...new Set(input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5])].sort(),
      sample,
      overwrite: input.overwrite,
    };
    return this.write(
      key,
      input.orgId,
      'BATCH',
      hash(fingerprint),
      input.overwrite,
      principal,
      () => expandBatch(input, this.holiday),
    );
  }
  async details(key: string, input: OrganizationScheduleDetails, principal: AuthPrincipal) {
    const schedules = normalizeDetails(input);
    return this.write(
      key,
      input.orgId,
      'DETAIL',
      hash({ schedules, overwrite: input.overwrite }),
      input.overwrite,
      principal,
      async () => schedules,
    );
  }
  private async write(
    key: string,
    orgId: string,
    kind: string,
    requestHash: string,
    overwrite: boolean,
    principal: AuthPrincipal,
    assignments: () => Promise<Assignment[]>,
  ) {
    if (!key?.trim() || key.length > 128) throw invalid('Idempotency-Key须为1至128字符');
    orgId = orgId.toLowerCase();
    return this.db.$transaction(
      async (tx) => {
        await lockOrganization(tx, orgId);
        await this.manager(tx, orgId, principal);
        const receiptWhere = { orgId, userId: principal.userId, kind, key: key.trim() };
        const receipt = await tx.organizationScheduleReceipt.findUnique({
          where: { orgId_userId_kind_key: receiptWhere },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            throw new AuthError(409, 'DUPLICATE', '幂等键已用于不同排班请求');
          return receipt.response;
        }
        const schedules = await assignments();
        const memberIds = [...new Set(schedules.map((s) => s.memberId))];
        const members = await tx.userOrgRel.findMany({
          where: { orgId, id: { in: memberIds }, joinStatus: { in: participatingStatuses } },
        });
        if (members.length !== memberIds.length)
          throw invalid('存在不属于目标组织或不可排班的成员');
        const memberMap = new Map(members.map((m) => [m.id, m]));
        const dates = [...new Set(schedules.map((s) => s.scheduleDate))];
        const existing = await tx.orgMemberSchedule.findMany({
          where: {
            orgId,
            userOrgRelId: { in: memberIds },
            scheduleDate: { in: dates.map(parseDate) },
          },
        });
        const byKey = new Map(
          existing.map((s) => [`${s.userOrgRelId}/${dateText(s.scheduleDate)}`, s]),
        );
        const batchNo = `SCH-${randomUUID().replaceAll('-', '').toUpperCase()}`;
        const conflicts: {
          memberId: string;
          scheduleDate: string;
          scheduleId: number;
          versionNo: number;
        }[] = [];
        const changed: OrgMemberSchedule[] = [];
        const inserts: Prisma.OrgMemberScheduleCreateManyInput[] = [];
        let updatedCount = 0;
        for (const item of schedules) {
          const row = byKey.get(`${item.memberId}/${item.scheduleDate}`);
          if (row && !overwrite) {
            conflicts.push({
              memberId: item.memberId,
              scheduleDate: item.scheduleDate,
              scheduleId: row.id,
              versionNo: row.versionNo,
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
            sourceType: 'MANUAL',
            batchNo,
            status: 'ACTIVE',
            updatedBy: principal.uid,
          };
          if (row) {
            const result = await tx.orgMemberSchedule.updateMany({
              where: { id: row.id, versionNo: row.versionNo },
              data: { ...data, versionNo: { increment: 1 } },
            });
            if (result.count !== 1) throw conflict();
            changed.push({ ...row, ...data, versionNo: row.versionNo + 1 });
            updatedCount++;
          } else
            inserts.push({
              ...data,
              scopeKey: orgId,
              orgId,
              userOrgRelId: item.memberId,
              userId: memberMap.get(item.memberId)!.userId,
              scheduleDate: parseDate(item.scheduleDate),
              createdBy: principal.uid,
            });
        }
        if (inserts.length) {
          await tx.orgMemberSchedule.createMany({ data: inserts });
          changed.push(...(await tx.orgMemberSchedule.findMany({ where: { orgId, batchNo } })));
        }
        // 仅重算已有日考勤，优先重放不可变原始事件；保护人工结果。
        if (changed.length) {
          const changedMap = new Map(
            changed.map((s) => [`${s.userId}/${dateText(s.scheduleDate)}`, s]),
          );
          const dailies = await tx.orgAttendanceDaily.findMany({
            where: {
              orgId,
              userOrgRelId: { in: memberIds },
              attendanceDate: { in: dates.map(parseDate) },
            },
          });
          for (const daily of dailies) {
            const schedule = changedMap.get(`${daily.userId}/${dateText(daily.attendanceDate)}`);
            if (!schedule) continue;
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
                calculatedAt: new Date(),
                updatedBy: 'SYSTEM',
                versionNo: { increment: 1 },
              },
            });
            if (result.count !== 1) throw conflict();
          }
          await tx.attendanceEventOutbox.create({
            data: {
              orgId,
              eventType: 'ORGANIZATION_SCHEDULE',
              payload: {
                batchNo,
                operatorId: principal.userId,
                userIds: [...new Set(changed.map((s) => s.userId))],
                delivery: 'NOT_EXECUTED',
              },
            },
          });
        }
        const response = {
          batchNo,
          createdCount: inserts.length,
          updatedCount,
          skippedCount: conflicts.length,
          conflicts,
        };
        await tx.organizationScheduleReceipt.create({
          data: { ...receiptWhere, requestHash, response },
        });
        return response;
      },
      { timeout: 45000 },
    );
  }
}
