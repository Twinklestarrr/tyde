import { Prisma, type PrismaClient, type UploadedFile } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import {
  monthDates,
  parseDate,
  dateText,
  wallTime,
  invalid,
} from '../attendance/attendance-domain.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import { personnelScope } from './personnel-access.js';
import { lockPersonnel } from './personnel.service.js';
import { todayText } from './personnel-domain.js';

export interface ProjectAttendanceQuery {
  projectId: number;
  month: string;
  keyword?: string | null;
  organizationIds?: string[] | null;
  attendanceStatuses?: string[] | null;
  current?: number;
  size?: number;
}
export interface PerformanceQuery {
  projectId: number;
  memberId: number;
  recordDateStart?: string | null;
  recordDateEnd?: string | null;
  current?: number;
  size?: number;
}
export interface PerformanceInput {
  projectId: number;
  memberId: number;
  recordDate: string;
  content: string;
  attachmentIds?: string[] | null;
  attachmentUploadTokens?: Record<string, string> | null;
}
export function performanceDates(
  query: Pick<PerformanceQuery, 'recordDateStart' | 'recordDateEnd'>,
) {
  const start = query.recordDateStart ? parseDate(query.recordDateStart) : undefined;
  const end = query.recordDateEnd ? parseDate(query.recordDateEnd) : undefined;
  if (start && end && start > end) throw invalid('recordDateStart不能晚于recordDateEnd');
  return { gte: start, lte: end };
}
async function memberAccess(
  tx: Prisma.TransactionClient,
  projectId: number,
  memberId: number,
  principal: AuthPrincipal,
  write = false,
) {
  const scope = await personnelScope(tx, projectId, principal, write);
  const member = await tx.projectMember.findFirst({ where: { id: memberId, projectId } });
  if (!member) throw new AuthError(404, 'NOT_FOUND', '项目成员不存在');
  if (
    scope.organizationIds &&
    (!member.organizationId || !scope.organizationIds.includes(member.organizationId))
  )
    throw new AuthError(403, 'FORBIDDEN', '只能访问职责组织内成员');
  return member;
}
const page = <T>(records: T[], total: number, current: number, size: number) => ({
  records,
  total,
  current,
  size,
  pages: Math.ceil(total / size),
});
export function attendanceSummary(days: { finalAttendanceStatus: string | null }[]) {
  const count = (...values: string[]) =>
    days.filter((d) => d.finalAttendanceStatus && values.includes(d.finalAttendanceStatus)).length;
  return {
    scheduledCount: days.length,
    presentCount: count('PRESENT'),
    lateCount: count('LATE', 'LATE_EARLY'),
    earlyLeaveCount: count('EARLY_LEAVE', 'LATE_EARLY'),
    leaveCount: count('LEAVE'),
    absentCount: count('ABSENT'),
  };
}
export class PersonnelRecordsService {
  constructor(
    readonly db: PrismaClient,
    readonly files?: FileRegistryService,
  ) {}
  async attendance(query: ProjectAttendanceQuery, principal: AuthPrincipal) {
    const { start, end } = monthDates(query.month);
    return this.db.$transaction(
      async (tx) => {
        const scope = await personnelScope(tx, query.projectId, principal);
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const filters: Prisma.ProjectMemberWhereInput[] = [
          {
            projectId: query.projectId,
            status: {
              in: [
                'PENDING_CONFIRM',
                'PENDING_ENTRY',
                'ACTIVE',
                'PENDING_EXIT',
                'PENDING_TRANSFER',
              ],
            },
          },
        ];
        if (scope.organizationIds) filters.push({ organizationId: { in: scope.organizationIds } });
        if (query.organizationIds?.length)
          filters.push({ organizationId: { in: query.organizationIds } });
        if (query.keyword?.trim())
          filters.push({
            user: {
              OR: ['uid', 'realName', 'displayName'].map((key) => ({
                [key]: { contains: query.keyword!.trim() },
              })),
            },
          });
        const where = { AND: filters };
        const total = await tx.projectMember.count({ where });
        const members = await tx.projectMember.findMany({
          where,
          include: { user: true, organization: true },
          orderBy: [{ organizationId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
          skip: (current - 1) * size,
          take: size,
        });
        // 旧接口仅关联组织关系；个人按PERSONAL范围接入09已实现的本人排班。
        const schedules = members.length
          ? await tx.orgMemberSchedule.findMany({
              where: {
                scheduleDate: { gte: start, lt: end },
                OR: members.map((m) => ({
                  scopeKey: m.organizationId ?? 'PERSONAL',
                  orgId: m.organizationId,
                  userId: m.userId,
                  userOrgRelId: m.userOrgRelId,
                })),
              },
              orderBy: { scheduleDate: 'asc' },
            })
          : [];
        const dailyRows = schedules.length
          ? await tx.orgAttendanceDaily.findMany({
              where: {
                attendanceDate: { gte: start, lt: end },
                OR: members.map((m) => ({
                  scopeKey: m.organizationId ?? 'PERSONAL',
                  orgId: m.organizationId,
                  userId: m.userId,
                  userOrgRelId: m.userOrgRelId,
                })),
              },
            })
          : [];
        return page(
          members.map((m) => {
            const days = schedules
              .filter(
                (s) =>
                  s.userId === m.userId &&
                  s.orgId === m.organizationId &&
                  s.userOrgRelId === m.userOrgRelId,
              )
              .map((s) => {
                const daily = dailyRows.find(
                  (d) =>
                    d.userId === m.userId &&
                    d.orgId === m.organizationId &&
                    d.userOrgRelId === m.userOrgRelId &&
                    dateText(d.attendanceDate) === dateText(s.scheduleDate),
                );
                return {
                  date: dateText(s.scheduleDate),
                  scheduleStatus: s.status,
                  shiftStartAt: wallTime(s.shiftStartAt),
                  shiftEndAt: wallTime(s.shiftEndAt),
                  finalAttendanceStatus: daily?.finalStatus ?? null,
                  firstClockInAt: wallTime(daily?.firstClockInAt, true),
                  lastClockOutAt: wallTime(daily?.lastClockOutAt, true),
                };
              })
              .filter(
                (d) =>
                  !query.attendanceStatuses?.length ||
                  (d.finalAttendanceStatus !== null &&
                    query.attendanceStatuses.includes(d.finalAttendanceStatus)),
              );
            return {
              memberId: m.id,
              userId: m.userId,
              uid: m.user.uid,
              displayName: displayName(m.user.displayName, m.user.realName, m.user.uid),
              organizationId: m.organizationId,
              organizationName: m.organization?.deleted ? null : (m.organization?.name ?? null),
              summary: attendanceSummary(days),
              days,
            };
          }),
          total,
          current,
          size,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async performance(query: PerformanceQuery, principal: AuthPrincipal) {
    const range = performanceDates(query);
    return this.db.$transaction(
      async (tx) => {
        await memberAccess(tx, query.projectId, query.memberId, principal);
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const where = { projectId: query.projectId, memberId: query.memberId, recordDate: range };
        const total = await tx.projectMemberPerformance.count({ where });
        const rows = await tx.projectMemberPerformance.findMany({
          where,
          orderBy: [{ recordDate: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * size,
          take: size,
        });
        const recorders = await tx.user.findMany({
          where: { uid: { in: [...new Set(rows.map((r) => r.recordedBy))] } },
        });
        const attachments = rows.length
          ? await tx.uploadedFile.findMany({
              where: {
                id: { in: rows.flatMap((r) => r.attachmentIds) },
                status: 'CLAIMED',
                claimedBizType: 'MEMBER_PERFORMANCE_ATTACHMENT',
              },
            })
          : [];
        return page(
          rows.map((r) => {
            const u = recorders.find((u) => u.uid === r.recordedBy);
            return {
              performanceId: r.id,
              recordDate: dateText(r.recordDate),
              content: r.content,
              attachmentIds: r.attachmentIds,
              attachments: attachments
                .filter((f) => r.attachmentIds.includes(f.id) && f.claimedBizId === String(r.id))
                .map((f) => ({ fileId: f.id, objectKey: f.objectKey, fileName: f.fileName })),
              recordedByName: u ? displayName(u.displayName, u.realName, u.uid) : r.recordedBy,
              createdAt: projectTime(r.createdAt),
            };
          }),
          total,
          current,
          size,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async createPerformance(input: PerformanceInput, principal: AuthPrincipal, now = new Date()) {
    const recordDate = parseDate(input.recordDate);
    if (input.recordDate > todayText(now)) throw invalid('recordDate不能晚于上海当天');
    if (!input.content?.trim() || input.content.length > 2000)
      throw invalid('content须为1至2000字非空正文');
    if ((input.attachmentIds?.length ?? 0) > 10) throw invalid('附件不能超过10个');
    const ids = [...new Set(input.attachmentIds ?? [])].sort();
    if (Object.keys(input.attachmentUploadTokens ?? {}).some((id) => !ids.includes(id)))
      throw invalid('上传凭证必须对应attachmentIds');
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, input.projectId, [input.memberId], principal.userId);
        const member = await memberAccess(tx, input.projectId, input.memberId, principal, true);
        const row = await tx.projectMemberPerformance.create({
          data: {
            projectId: input.projectId,
            memberId: member.id,
            userId: member.userId,
            recordDate,
            content: input.content.trim(),
            attachmentIds: ids,
            recordedBy: principal.uid,
          },
        });
        for (const id of ids) {
          const file = await tx.uploadedFile.findUnique({ where: { id } });
          if (!file || !this.files) throw invalid('表现附件上传记录不存在');
          await this.files.claim(
            tx,
            file.objectKey,
            input.attachmentUploadTokens?.[id] ?? '',
            'MEMBER_PERFORMANCE_ATTACHMENT',
            'MEMBER_PERFORMANCE_ATTACHMENT',
            String(row.id),
            principal.uid,
          );
        }
        return null;
      },
      { timeout: 30_000 },
    );
  }
}
export async function canReadPerformanceFile(
  db: PrismaClient,
  file: UploadedFile,
  principal: AuthPrincipal,
) {
  if (
    file.claimedBizType !== 'MEMBER_PERFORMANCE_ATTACHMENT' ||
    !file.claimedBizId ||
    !/^[1-9]\d*$/.test(file.claimedBizId) ||
    Number(file.claimedBizId) > 2147483647
  )
    return false;
  return db.$transaction(
    async (tx) => {
      const row = await tx.projectMemberPerformance.findUnique({
        where: { id: Number(file.claimedBizId) },
      });
      if (!row || !row.attachmentIds.includes(file.id)) return false;
      try {
        await memberAccess(tx, row.projectId, row.memberId, principal);
        return true;
      } catch (error) {
        if (error instanceof AuthError && [403, 404].includes(error.status)) return false;
        throw error;
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
