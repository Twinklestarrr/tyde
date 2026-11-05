import type { ApprovalFlow, OrgAttendanceDaily, OrgMemberSchedule } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { businessDate } from '../organizations/member.domain.js';
import { calendarDay, invalid, manualStatuses, parseDate } from './attendance.domain.js';
export const attendanceBusinessTypes = ['ATTENDANCE_LEAVE', 'ATTENDANCE_CORRECTION'];
export const isAttendanceBusiness = (value: string) => attendanceBusinessTypes.includes(value);
export const attendanceBusinessId = (userId: string, date: string) => `${userId}:${date}`;
export interface AttendanceApplyInput {
  orgId: string;
  attendanceDate: string;
  applicationType: 'LEAVE' | 'CORRECTION';
  finalStatus: string;
  reason: string;
  versionNo: number | null;
  dailyId?: number | null;
  leaveStartAt?: string | null;
  leaveEndAt?: string | null;
}
export interface AttendanceForm extends AttendanceApplyInput {
  schemaVersion: 1;
  targetMemberId: string;
  targetMemberName: string;
  dailyId: number | null;
  scheduleId: number | null;
  scheduleVersionNo: number | null;
  timezone: string;
}
export const applicationConflict = (message = '申请或考勤已发生变化，请刷新后重试') =>
  new AppError(409, 'DUPLICATE', message);
export function validateApplication(input: AttendanceApplyInput, today: string) {
  parseDate(input.attendanceDate);
  if (!['LEAVE', 'CORRECTION'].includes(input.applicationType))
    throw invalid('applicationType须为LEAVE或CORRECTION');
  if (!input.reason?.trim() || input.reason.trim().length > 1000)
    throw invalid('reason须为1至1000个非空字符');
  if (!(
    input.versionNo === null ||
    (Number.isInteger(input.versionNo) && input.versionNo >= 0 && input.versionNo < 2147483647)
  ))
    throw invalid('versionNo须为日考勤版本，尚无日考勤时显式传null');
  if (input.applicationType === 'CORRECTION') {
    if (!manualStatuses.includes(input.finalStatus) || input.finalStatus === 'LEAVE')
      throw invalid('CORRECTION不接受LEAVE或自动计算专用状态，请假须使用LEAVE类型');
    if (input.attendanceDate > today) throw invalid('不能申请修正未来日期考勤');
    if (input.leaveStartAt != null || input.leaveEndAt != null)
      throw invalid('CORRECTION不能提供请假时段');
  } else {
    if (input.finalStatus !== 'LEAVE') throw invalid('LEAVE类型的finalStatus必须为LEAVE');
    if (!input.leaveStartAt || !input.leaveEndAt)
      throw invalid('请假须提供leaveStartAt与leaveEndAt');
    businessDate(input.leaveStartAt);
    businessDate(input.leaveEndAt);
    if (
      input.leaveStartAt.slice(0, 10) !== input.attendanceDate ||
      input.leaveEndAt.slice(0, 10) !== input.attendanceDate ||
      input.leaveStartAt >= input.leaveEndAt
    )
      throw invalid('请假时段须在申请日期内且结束晚于开始，不支持跨日');
  }
}
export function validateLeaveSchedule(
  input: AttendanceApplyInput,
  schedule: OrgMemberSchedule | null,
) {
  if (input.applicationType !== 'LEAVE') return;
  if (
    !schedule ||
    schedule.status !== 'ACTIVE' ||
    schedule.dayType !== 'WORK' ||
    !schedule.shiftStartAt ||
    !schedule.shiftEndAt
  )
    throw invalid('仅可对生效的工作排班申请请假');
  const start = new Date(input.leaveStartAt!.replace(' ', 'T') + 'Z');
  const end = new Date(input.leaveEndAt!.replace(' ', 'T') + 'Z');
  if (start < schedule.shiftStartAt || end > schedule.shiftEndAt)
    throw invalid('请假时段必须位于当日排班时段内，按排班timezone解释');
}
export function readAttendanceForm(flow: ApprovalFlow): AttendanceForm {
  const malformed = () => new AppError(500, 'INVALID_FORM', '考勤申请表单快照不完整或与流程不匹配');
  const value = flow.formData;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const numberOrNull = (v: unknown) => v === null || (Number.isInteger(v) && Number(v) >= 0);
  if (
    value.schemaVersion !== 1 ||
    value.orgId !== flow.applicantOrgId ||
    typeof value.attendanceDate !== 'string' ||
    value.reason !== flow.applyReason ||
    flow.businessId !== attendanceBusinessId(flow.applicantId, value.attendanceDate) ||
    flow.businessType !== `ATTENDANCE_${value.applicationType}` ||
    typeof value.targetMemberId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.targetMemberId) ||
    typeof value.targetMemberName !== 'string' ||
    typeof value.timezone !== 'string' ||
    (value.dailyId === null) !== (value.versionNo === null) ||
    (value.scheduleId === null) !== (value.scheduleVersionNo === null) ||
    !numberOrNull(value.dailyId) ||
    !numberOrNull(value.scheduleId) ||
    !numberOrNull(value.scheduleVersionNo)
  )
    throw malformed();
  const form = value as unknown as AttendanceForm;
  try {
    validateApplication(form, '9999-12-31');
  } catch {
    throw malformed();
  }
  return form;
}
export function newDailyAutoStatus(
  date: string,
  today: string,
  schedule: OrgMemberSchedule | null,
) {
  const status = calendarDay(date, today, schedule ?? undefined).calendarStatus;
  return status === 'PENDING_ATTENDANCE' ? null : status;
}
export function attendanceApplicationResult(flow: ApprovalFlow) {
  const form = readAttendanceForm(flow);
  return {
    applicationId: flow.id,
    flowNo: flow.flowNo,
    flowVersionNo: flow.versionNo,
    businessType: flow.businessType,
    applicationType: form.applicationType,
    attendanceDate: form.attendanceDate,
    finalStatus: form.finalStatus,
    status: flow.status,
    versionNo: form.versionNo,
    dailyId: form.dailyId,
    leaveStartAt: form.leaveStartAt ?? null,
    leaveEndAt: form.leaveEndAt ?? null,
    appliedAt: flow.appliedAt.toISOString(),
    finishedAt: flow.finishedAt?.toISOString() ?? null,
  };
}
export function assertDailySnapshot(daily: OrgAttendanceDaily | null, input: AttendanceApplyInput) {
  if (
    (daily?.versionNo ?? null) !== input.versionNo ||
    (input.dailyId != null && daily?.id !== input.dailyId)
  )
    throw applicationConflict('日考勤版本或记录已变化；尚无日考勤时versionNo须传null');
}
