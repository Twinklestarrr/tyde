import type { ProjectAttachmentUploadResult } from './projects.js';

export type ProjectPersonnelStatus =
  | 'PENDING_CONFIRM'
  | 'PENDING_ENTRY'
  | 'ACTIVE'
  | 'ENTRY_DECLINED'
  | 'PENDING_EXIT'
  | 'PENDING_TRANSFER'
  | 'LEFT'
  | 'REMOVED';
export type ProjectPersonnelAttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'EARLY_LEAVE'
  | 'LATE_EARLY'
  | 'LEAVE'
  | 'ABSENT'
  | 'REST'
  | 'UNSCHEDULED'
  | 'REVIEW_REQUIRED';
export interface ProjectPersonnelPage<T> {
  total: number;
  current: number;
  size: number;
  pages: number;
  records: T[];
}
export interface ProjectPersonnelPagination {
  current?: number;
  size?: number;
}
export interface ProjectPersonnelRosterInput extends ProjectPersonnelPagination {
  projectId: number;
  keyword?: string | null;
  accountTypes?: ('INDIVIDUAL' | 'ORGANIZATION')[] | null;
  orgPositions?: ('OWNER' | 'ADMIN' | 'MEMBER')[] | null;
  organizationIds?: string[] | null;
  employmentTypes?: ('FULL_TIME' | 'PART_TIME')[] | null;
  responsibleUserIds?: string[] | null;
  statuses?: ProjectPersonnelStatus[] | null;
}
export interface ProjectPersonnelMember {
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  accountType: 'INDIVIDUAL' | 'ORGANIZATION';
  organizationId: string | null;
  organizationName: string | null;
  orgPosition: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  employmentType: 'FULL_TIME' | 'PART_TIME' | null;
  responsibleUserId: string | null;
  responsibleUserName: string | null;
  projectOwners: { userId: string; name: string; avatarUrl: string | null }[];
  admittedAt: string | null;
  entryDecision: 'YES' | 'NO' | null;
  plannedEntryDate: string | null;
  joinedAt: string | null;
  plannedLeaveDate: string | null;
  leftAt: string | null;
  status: ProjectPersonnelStatus;
  statusName: string;
  allowedActions: 'SET_ENTRY'[];
}
export interface ProjectPersonnelEntryInput {
  projectId: number;
  memberIds: number[];
  entryDecision: 'YES' | 'NO';
  plannedEntryDate?: string | null;
  declineReason?: string | null;
}
export interface ProjectPersonnelAttendanceInput extends ProjectPersonnelPagination {
  projectId: number;
  month: string;
  keyword?: string | null;
  organizationIds?: string[] | null;
  attendanceStatuses?: ProjectPersonnelAttendanceStatus[] | null;
}
export interface ProjectPersonnelAttendanceMember {
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  organizationId: string | null;
  organizationName: string | null;
  summary: {
    scheduledCount: number;
    presentCount: number;
    lateCount: number;
    earlyLeaveCount: number;
    leaveCount: number;
    absentCount: number;
  };
  /** 只返回真实排班行；筛选考勤状态不会过滤成员总数。不补齐缺日。 */
  days: {
    date: string;
    scheduleStatus: 'ACTIVE' | 'CANCELLED';
    shiftStartAt: string | null;
    shiftEndAt: string | null;
    finalAttendanceStatus: ProjectPersonnelAttendanceStatus | null;
    firstClockInAt: string | null;
    lastClockOutAt: string | null;
  }[];
}
export interface ProjectMemberPerformanceQuery extends ProjectPersonnelPagination {
  projectId: number;
  memberId: number;
  recordDateStart?: string | null;
  recordDateEnd?: string | null;
}
export interface ProjectMemberPerformanceRecord {
  performanceId: number;
  recordDate: string;
  content: string;
  attachmentIds: string[];
  attachments: { fileId: string; objectKey: string; fileName: string }[];
  recordedByName: string;
  createdAt: string | null;
}
export interface ProjectMemberPerformanceInput {
  projectId: number;
  memberId: number;
  recordDate: string;
  content: string;
  attachmentIds?: string[] | null;
  attachmentUploadTokens?: Record<string, string> | null;
}
export interface ExpertProjectOwnersInput {
  assignmentId: number;
  /** 完整替换已接单组织的负责人集合，UUID去重后1至20人。仅有效组织主管可写。 */
  projectOwnerUserIds: string[];
}
export interface ProjectPersonnelApi {
  /** 相同集合幂等；无版本或请求幂等键，未知结果须先核对当前负责人。 */
  setExpertProjectOwners(input: ExpertProjectOwnersInput): Promise<void>;
  listProjectPersonnelRoster(
    input: ProjectPersonnelRosterInput,
  ): Promise<ProjectPersonnelPage<ProjectPersonnelMember>>;
  saveProjectPersonnelEntry(input: ProjectPersonnelEntryInput): Promise<void>;
  listProjectPersonnelAttendance(
    input: ProjectPersonnelAttendanceInput,
  ): Promise<ProjectPersonnelPage<ProjectPersonnelAttendanceMember>>;
  listProjectMemberPerformance(
    input: ProjectMemberPerformanceQuery,
  ): Promise<ProjectPersonnelPage<ProjectMemberPerformanceRecord>>;
  /** 成功每次新增记录，无请求幂等承诺；未知写入结果先显式回读核实。 */
  createProjectMemberPerformance(input: ProjectMemberPerformanceInput): Promise<void>;
  uploadMemberPerformanceAttachment(file: File): Promise<ProjectAttachmentUploadResult>;
  readMemberPerformanceAttachment(objectKey: string): Promise<Blob>;
  listPersonnelTransferTargets(
    input: PersonnelTransferTargetsInput,
  ): Promise<ProjectPersonnelPage<PersonnelTransferTarget>>;
  createPersonnelMovement(input: PersonnelMovementCreateInput): Promise<void>;
  listPersonnelMovements(
    input: PersonnelMovementsInput,
  ): Promise<ProjectPersonnelPage<PersonnelMovement>>;
  /** 原项目+成员读取最新记录；读取指定历史变动请使用list的movementId筛选。 */
  getPersonnelMovementDetail(input: PersonnelMovementDetailInput): Promise<PersonnelMovement>;
  withdrawPersonnelMovement(input: PersonnelMovementWithdrawInput): Promise<void>;
  processPersonnelMovement(input: PersonnelMovementProcessInput): Promise<void>;
}

export type PersonnelMovementType = 'REMOVAL' | 'TRANSFER';
export type PersonnelMovementStatus =
  'PROCESSING' | 'WAITING_EFFECTIVE' | 'EFFECTIVE' | 'REJECTED' | 'WITHDRAWN';
export type PersonnelMovementAction =
  'WITHDRAW' | 'APPROVE' | 'REJECT' | 'ACCEPT_TRANSFER' | 'REJECT_TRANSFER' | 'TAKE_TARGET_EXAM';
export interface PersonnelTransferTargetsInput extends ProjectPersonnelPagination {
  projectId: number;
  memberIds: number[];
  keyword?: string | null;
}
export interface PersonnelTransferTarget {
  projectId: number;
  projectNo: string;
  projectName: string | null;
  requesterName: string;
  examRequired: boolean;
}
export interface PersonnelMovementCreateInput {
  projectId: number;
  memberIds: number[];
  movementType: PersonnelMovementType;
  reason: string;
  targetProjectId?: number | null;
  plannedEffectiveDate: string;
}
export interface PersonnelMovementsInput extends ProjectPersonnelPagination {
  projectId: number;
  movementId?: number | null;
  memberId?: number | null;
  movementTypes?: PersonnelMovementType[] | null;
  statuses?: PersonnelMovementStatus[] | null;
  keyword?: string | null;
  createdStartAt?: string | null;
  createdEndAt?: string | null;
}
export interface PersonnelMovementDetailInput {
  projectId: number;
  memberId: number;
}
export interface PersonnelMovementWithdrawInput {
  projectId: number;
  movementId: number;
}
export interface PersonnelMovementProcessInput extends PersonnelMovementWithdrawInput {
  flowNo: string;
  nodeId: string;
  nodeVersionNo: number;
  flowVersionNo: number;
  action: 'APPROVE' | 'REJECT';
  actionComment?: string | null;
}
export interface PersonnelMovementStep {
  nodeId: string;
  nodeSeq: number;
  nodeCode: string;
  nodeName: string;
  nodeStatus: string;
  /** 最后实际操作人，不能当作当前候选审批人ID。 */
  operatorId: string | null;
  operatorName: string | null;
  action: string | null;
  actionComment: string | null;
  actionAt: string | null;
  nodeVersionNo: number;
}
export interface PersonnelMovement {
  movementId: number;
  movementNo: string;
  movementType: PersonnelMovementType;
  status: PersonnelMovementStatus;
  statusName: string;
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  accountType: 'INDIVIDUAL' | 'ORGANIZATION';
  organizationId: string | null;
  organizationName: string | null;
  sourceProjectId: number;
  sourceProjectName: string | null;
  targetProjectId: number | null;
  targetProjectName: string | null;
  reason: string;
  plannedEffectiveDate: string;
  initiatedBy: string;
  initiatorName: string;
  initiatedAt: string;
  effectiveAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  examAttemptId: number | null;
  examStatus: string | null;
  examSubmittedAt: string | null;
  examCancelledAt: string | null;
  flowNo: string | null;
  flowStatus: string | null;
  flowVersionNo: number | null;
  currentNode: number | null;
  /** 当前角色本人唯一可处理的人工节点；旧部署可能缺省，不能用历史operatorId推断。 */
  actionableNodeId?: string | null;
  approvalSteps: PersonnelMovementStep[];
  allowedActions: PersonnelMovementAction[];
}
