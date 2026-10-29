import type { OrganizationFlowStatus, OrganizationPage } from './organizations.js';

/** 当前后端本人接口；前端工作台视图不作为这些接口的授权依据。 */
export type WorkbenchPage<T> = OrganizationPage<T>;
/** 普通分配与独立转入身份二选一；不得为转入身份伪造分配 ID。 */
export type WorkbenchProjectSource =
  { assignmentId: number; movementId: null } | { assignmentId: null; movementId: number };
export type WorkbenchProject = WorkbenchProjectSource & {
  projectId: number;
  projectName: string | null;
  requesterName: string;
  needWrittenExam: boolean;
  admissionStatus: 'PASSED' | 'PENDING' | 'NOT_PASSED' | 'NOT_EXAMINED';
  currentNodeCode: string;
};
export interface WorkbenchProjectDetail {
  id: number;
  projectNo: string;
  requesterType: 'INDIVIDUAL' | 'ORGANIZATION';
  requesterId: string;
  requesterName: string;
  projectName: string | null;
  projectDescription: string | null;
  categoryLevel1Id: number | null;
  categoryLevel2Id: number | null;
  categoryLevel1Name: string | null;
  categoryLevel2Name: string | null;
  categoryLevel3Ids: number[];
  categoryLevel3Names: string[];
  difficultyLevel: 'EASY' | 'MEDIUM' | 'HARD' | null;
  projectQuantity: number | null;
  quantityUnit: string | null;
  /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss，不按浏览器时区转换。 */
  deadline: string | null;
  requiredHeadcount: number | null;
  educationRequirement: 'PHD' | 'MASTER' | 'BACHELOR' | 'COLLEGE' | 'BELOW_COLLEGE' | null;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'UNLIMITED' | null;
  experienceRequirement: string | null;
  workSummary: string | null;
  specialRequirement: string | null;
  mandatoryRequirement: string | null;
  standardContent: string | null;
  standardLink: string | null;
  status: 'PUBLISHED';
  currentNodeCode: string | null;
  versionNo: number;
  creatorUid: string;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  /** 仅文件台账元数据；objectKey不等于公开下载地址。 */
  attachments: {
    id: number;
    attachmentType: 'STANDARD_REFERENCE' | 'CASE' | 'OTHER';
    fileName: string;
    objectKey: string;
    extension: string;
    contentType: string;
    fileSize: number;
    fileHash: string;
    sortNo: number;
    status: 'ACTIVE';
  }[];
}
export interface WorkbenchProductionPlan {
  hasPlan: boolean;
  planId: number | null;
  operatorHeadcount: number | null;
  operatorCpd: number | null;
  inspectorHeadcount: number | null;
  inspectorCpd: number | null;
  totalExpectedOutput: number | null;
  crowds: {
    id: number | null;
    sequenceNo: number;
    crowdName: string | null;
    profileRequirement: string | null;
  }[];
  stages: {
    id: number | null;
    sequenceNo: number;
    stageName: string | null;
    startDate: string | null;
    endDate: string | null;
    workdayCount: number | null;
    workdayCountSource: 'AUTO' | 'MANUAL' | null;
    operatorHeadcount: number | null;
    operatorCpd: number | null;
    accuracyRate: number | null;
    naturalDayCount: number | null;
    expectedOutput: number | null;
  }[];
}
export type WorkbenchAssignmentDetail = WorkbenchProjectSource & {
  projectDetail: WorkbenchProjectDetail;
  productionPlan: WorkbenchProductionPlan;
  /** 项目主线节点，不是项目列表里的本人支线节点。 */
  currentNodeCode: string | null;
  availableOperations: 'VIEW_DETAIL'[];
};
export interface WorkbenchApplicationQuery {
  /** 省略默认退出组织；null/空白查询全部类型。 */
  businessType?: string | null;
  status?: OrganizationFlowStatus | null;
  /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss，包含边界。 */
  startAt?: string | null;
  endAt?: string | null;
  current?: number;
  size?: number;
}
export interface WorkbenchApplication {
  applicationId: string;
  flowNo: string;
  flowVersionNo: number;
  businessType: string;
  businessId: string;
  businessNo: string | null;
  title: string;
  applicantOrgId: string | null;
  applicantOrgName: string | null;
  applyReason: string | null;
  status: OrganizationFlowStatus;
  currentNode: number | null;
  currentNodeCode: string | null;
  formData: Record<string, unknown> | null;
  targetMemberId: string | null;
  targetMemberName: string | null;
  plannedLeaveDate: string | null;
  /** 上海墙钟时间，保留服务端格式。 */
  appliedAt: string;
  finishedAt: string | null;
  /** 兼容服务端可选权限提示；缺省时仍须按业务类型、状态及写接口鉴权判断。 */
  canWithdraw?: boolean;
}
export type WorkbenchAttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'EARLY_LEAVE'
  | 'LATE_EARLY'
  | 'LEAVE'
  | 'ABSENT'
  | 'REST'
  | 'UNSCHEDULED'
  | 'REVIEW_REQUIRED';
export type WorkbenchAttendanceCalendarStatus = WorkbenchAttendanceStatus | 'PENDING_ATTENDANCE';
export type WorkbenchAttendanceManualStatus = Exclude<
  WorkbenchAttendanceStatus,
  'UNSCHEDULED' | 'REVIEW_REQUIRED'
>;
export interface WorkbenchScheduleRequest {
  schedules: {
    scheduleDate: string;
    dayType: 'WORK' | 'REST';
    startTime?: string | null;
    endTime?: string | null;
  }[];
  overwrite: boolean;
  timezone?: string | null;
  /** 同一草稿重试复用；修改内容后使用新键。 */
  idempotencyKey: string;
}
export interface WorkbenchScheduleResult {
  batchNo: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  conflicts: { scheduleDate: string; scheduleId: number; versionNo: number }[];
}
export interface WorkbenchAttendanceApplyInput {
  orgId: string;
  attendanceDate: string;
  applicationType: 'LEAVE' | 'CORRECTION';
  finalStatus: WorkbenchAttendanceManualStatus;
  reason: string;
  /** 月历 dailyVersionNo；无日考勤显式传 null，不使用排班版本。 */
  versionNo: number | null;
  dailyId?: number | null;
  /** 排班时区下 yyyy-MM-dd HH:mm:ss；请假必填，修正省略或 null。 */
  leaveStartAt?: string | null;
  leaveEndAt?: string | null;
}
export interface WorkbenchAttendanceWithdrawInput {
  applicationId: string;
  flowVersionNo: number;
}
export interface WorkbenchAttendanceApplicationResult {
  applicationId: string;
  flowNo: string;
  flowVersionNo: number;
  businessType: 'ATTENDANCE_LEAVE' | 'ATTENDANCE_CORRECTION';
  applicationType: 'LEAVE' | 'CORRECTION';
  attendanceDate: string;
  finalStatus: WorkbenchAttendanceManualStatus;
  status: OrganizationFlowStatus;
  versionNo: number | null;
  dailyId: number | null;
  leaveStartAt: string | null;
  leaveEndAt: string | null;
  appliedAt: string;
  finishedAt: string | null;
}
export interface WorkbenchAttendanceUpdateInput {
  orgId: string;
  dailyId: number;
  finalStatus: WorkbenchAttendanceManualStatus;
  manualRemark?: string | null;
  versionNo: number;
}
export interface WorkbenchAttendanceUpdateResult {
  id: number;
  beforeStatus: WorkbenchAttendanceStatus | null;
  finalStatus: WorkbenchAttendanceManualStatus;
  manualOverride: true;
  manualRemark: string | null;
  correctedBy: string;
  correctedAt: string;
  versionNo: number;
  adjustmentId: number;
}
export interface WorkbenchAttendanceQuery {
  month: string;
  /** 有有效组织时必传；省略仅用于无组织本人作用域。 */
  orgId?: string;
}
export interface WorkbenchAttendanceDay {
  scheduleId: number | null;
  scheduleDate: string;
  calendarStatus: WorkbenchAttendanceCalendarStatus;
  dayType: 'WORK' | 'REST' | null;
  /** 班次timezone下的墙钟时间，不转换为本机时间。 */
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  timezone: string | null;
  sourceType: 'MANUAL' | 'AI_ASSISTANT' | null;
  batchNo: string | null;
  status: 'ACTIVE' | 'CANCELED' | null;
  /** 排班版本，与日考勤和审批流程版本相互独立。 */
  versionNo: number | null;
  dailyId: number | null;
  autoStatus: WorkbenchAttendanceStatus | null;
  finalStatus: WorkbenchAttendanceStatus | null;
  firstClockInAt: string | null;
  lastClockOutAt: string | null;
  reviewRequired: boolean | null;
  reviewReason: string | null;
  manualOverride: boolean | null;
  dailyVersionNo: number | null;
  application: {
    applicationId: string;
    flowNo: string;
    flowVersionNo: number;
    applicationType: 'LEAVE' | 'CORRECTION';
    status: OrganizationFlowStatus;
    finalStatus: Exclude<WorkbenchAttendanceStatus, 'UNSCHEDULED' | 'REVIEW_REQUIRED'>;
    canWithdraw: boolean;
  } | null;
  /** 如实保留服务端权限提示，写入时服务端仍重新校验。 */
  permissions: {
    canApplyLeave: boolean;
    canApplyCorrection: boolean;
    canWithdraw: boolean;
    canDirectUpdate: boolean;
  };
}
export interface WorkbenchAttendanceMonth {
  organizationId: string | null;
  independentSchedule: boolean;
  month: string;
  memberId: string | null;
  userId: string;
  realName: string | null;
  nickname: string | null;
  summary: {
    presentCount: number;
    lateCount: number;
    earlyLeaveCount: number;
    leaveCount: number;
    absentCount: number;
  };
  days: WorkbenchAttendanceDay[];
  permissions: {
    canBatchSchedule: boolean;
    canDirectUpdate: boolean;
    canApply: boolean;
    canWithdraw: boolean;
  };
}
export interface WorkbenchHolidayMonth {
  month: string;
  days: {
    date: string;
    dayOfWeek: number;
    weekName: string;
    calendarDayType: 'PUBLIC_HOLIDAY' | 'MAKEUP_WORKDAY';
    holidayName: string;
    defaultScheduleDayType: 'WORK' | 'REST';
  }[];
}
export interface WorkbenchApi {
  getMyExpertProjects(keyword?: string): Promise<WorkbenchProject[]>;
  getExpertAssignmentDetail(
    source: number | WorkbenchProjectSource,
  ): Promise<WorkbenchAssignmentDetail>;
  listMyApplications(
    input: WorkbenchApplicationQuery,
  ): Promise<WorkbenchPage<WorkbenchApplication>>;
  getMyAttendance(input: WorkbenchAttendanceQuery): Promise<WorkbenchAttendanceMonth>;
  getAttendanceHolidays(input: WorkbenchAttendanceQuery): Promise<WorkbenchHolidayMonth>;
  batchMySchedules(input: WorkbenchScheduleRequest): Promise<WorkbenchScheduleResult>;
  applyMyAttendance(
    input: WorkbenchAttendanceApplyInput,
  ): Promise<WorkbenchAttendanceApplicationResult>;
  withdrawMyAttendance(
    input: WorkbenchAttendanceWithdrawInput,
  ): Promise<WorkbenchAttendanceApplicationResult>;
  updateMyAttendance(
    input: WorkbenchAttendanceUpdateInput,
  ): Promise<WorkbenchAttendanceUpdateResult>;
}
