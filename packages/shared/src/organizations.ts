import type { OrganizationCreateInput } from './auth.js';
import type { OrganizationDetail } from './index.js';

/** 组织客户端契约，逐项对应现有 HTTP 接口；不定义服务端 schema。 */
export type OrganizationPosition = 'OWNER' | 'ADMIN' | 'MEMBER';
export type OrganizationEmploymentType = 'FULL_TIME' | 'PART_TIME';
export type OrganizationJoinStatus =
  | 'PENDING'
  | 'PENDING_ACTIVATION'
  | 'ACTIVE'
  | 'EXIT_APPROVING'
  | 'PENDING_LEAVE'
  | 'LEFT'
  | 'REMOVED';
export type OrganizationFlowStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'CANCELED';
export type OrganizationNodeStatus =
  'WAITING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELED' | 'TRANSFERRED';
export interface OrganizationPage<T> {
  total: number;
  pages: number;
  current: number;
  size: number;
  records: T[];
}
export interface OrganizationUpdateInput {
  orgId: string;
  description?: string | null;
  logoUrl?: string | null;
  /** 本地 Logo 图片上传返回的认领凭证，与 logoUrl 中的 objectKey 一同提交。 */
  logoUploadToken?: string;
}
export interface OrganizationUpdateResult {
  id: string;
  description: string | null;
  logoUrl: string | null;
  updatedAt: string;
}
export interface OrganizationMemberQuery {
  orgId: string;
  keyword?: string | null;
  joinedStartDate?: string | null;
  joinedEndDate?: string | null;
  leftStartDate?: string | null;
  leftEndDate?: string | null;
  employmentType?: OrganizationEmploymentType | null;
  position?: OrganizationPosition | null;
  joinStatus?: OrganizationJoinStatus | null;
  projectId?: number | null;
  current?: number;
  size?: number;
}
export interface OrganizationMember {
  memberId: string;
  userId: string;
  uid: string;
  realName: string | null;
  nickname: string | null;
  phoneMasked: string;
  avatarUrl: string | null;
  userStatus: 'ACTIVE' | 'FROZEN' | 'BANNED';
  employmentType: OrganizationEmploymentType | null;
  position: OrganizationPosition;
  joinStatus: OrganizationJoinStatus | null;
  joinedAt: string | null;
  plannedLeaveDate: string | null;
  leftAt: string | null;
  activeProjectCount: number;
  versionNo: number;
}
export interface OrganizationMemberUpdateInput {
  orgId: string;
  memberId: string;
  versionNo: number;
  /** yyyy-MM-dd HH:mm:ss，按上海时间解释。 */
  joinedAt?: string | null;
  employmentType?: OrganizationEmploymentType | null;
}
export interface OrganizationMemberUpdateResult {
  memberId: string;
  userId: string;
  joinedAt: string | null;
  employmentType: OrganizationEmploymentType | null;
  versionNo: number;
  updatedAt: string;
}
export interface OrganizationMemberRoleInput {
  orgId: string;
  memberId: string;
  position: OrganizationPosition;
}
export interface OrganizationMemberRoleResult {
  memberId: string;
  beforePosition: OrganizationPosition;
  position: OrganizationPosition;
  updatedAt: string;
}
export interface OrganizationDepartureInput {
  orgId: string;
  /** 省略表示本人；代操作须传成员关系 ID。 */
  memberId?: string | null;
  reason: string;
  plannedLeaveDate: string;
}
export interface OrganizationDepartureResult {
  flowNo: string;
  businessType: 'ORG_MEMBER_EXIT';
  businessId: string;
  flowStatus: OrganizationFlowStatus;
  memberId: string;
  joinStatus: OrganizationJoinStatus | null;
  plannedLeaveDate: string | null;
  appliedAt: string;
}
export interface OrganizationApprovalQuery {
  orgId: string;
  businessType?: string | null;
  current?: number;
  size?: number;
}
export interface OrganizationApprovalRecordQuery extends OrganizationApprovalQuery {
  status?: OrganizationNodeStatus | null;
  /** yyyy-MM-dd HH:mm:ss，按上海时间解释。 */
  startAt?: string | null;
  endAt?: string | null;
}
export interface OrganizationApprovalSummary {
  flowNo: string;
  businessType: string;
  businessId: string;
  businessNo: string | null;
  title: string;
  applicantName: string | null;
  applyReason: string | null;
  targetMemberId: string | null;
  targetMemberName: string | null;
  plannedLeaveDate: string | null;
  appliedAt: string;
}
export interface OrganizationPendingApproval extends OrganizationApprovalSummary {
  nodeId: string;
  nodeVersionNo: number;
  nodeName: string;
  flowVersionNo: number;
  applicantId: string;
  applicantOrgId: string | null;
  formData: Record<string, unknown> | null;
  dueAt: string | null;
}
export interface OrganizationApprovalRecord extends OrganizationApprovalSummary {
  nodeId: string;
  nodeSeq: number;
  nodeCode: string;
  nodeName: string;
  nodeStatus: OrganizationNodeStatus;
  actionType:
    | 'SUBMIT'
    | 'APPROVE'
    | 'REJECT'
    | 'WITHDRAW'
    | 'TRANSFER'
    | 'AUTO_PASS'
    | 'AUTO_REJECT'
    | 'CANCEL'
    | 'SKIP'
    | null;
  operatorName: string;
  actionComment: string | null;
  actionAt: string;
  applicantOrgName: string | null;
  flowStatus: OrganizationFlowStatus;
  finishedAt: string | null;
}
export interface OrganizationApprovalProcessInput {
  orgId: string;
  flowNo: string;
  nodeId: string;
  nodeVersionNo: number;
  flowVersionNo: number;
  action: 'APPROVE' | 'REJECT';
  actionComment?: string | null;
}
export interface OrganizationApprovalProcessResult {
  flowNo: string;
  nodeId: string;
  action: 'APPROVE' | 'REJECT';
  nodeStatus: OrganizationNodeStatus;
  flowStatus: OrganizationFlowStatus;
  currentNode: number | null;
  joinStatus: OrganizationJoinStatus | null;
  plannedLeaveDate: string | null;
  processedAt: string;
  finishedAt: string | null;
}
export interface OrganizationImportInput {
  orgId: string;
  memberText?: string;
  file?: File;
}
export interface OrganizationImportRowError {
  rowNo: number;
  field: string;
  value: string | null;
  errorCode:
    | 'REQUIRED_MISSING'
    | 'ACCOUNT_REGISTERED'
    | 'FORMAT_INVALID'
    | 'ALREADY_JOINED_OTHER_ORGANIZATION'
    | 'DUPLICATE_IN_BATCH'
    | 'LIMIT_EXCEEDED';
  message: string;
}
export interface OrganizationImportedMember {
  memberId: string;
  userId: string;
  uid: string;
  accountType: 'INDIVIDUAL' | 'ORGANIZATION';
  phoneMasked: string | null;
  realName: string;
  position: 'ADMIN' | 'MEMBER';
  employmentType: OrganizationEmploymentType | null;
  joinedAt: string | null;
  joinStatus: 'PENDING_ACTIVATION' | 'ACTIVE';
}
export interface OrganizationImportResult {
  sourceType: 'EXCEL' | 'CSV' | 'TEXT';
  textIgnored: boolean;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  createdCount: number;
  rowErrors: OrganizationImportRowError[];
  members: OrganizationImportedMember[];
  createdAt: string | null;
}
export interface OrganizationApi {
  createOrganization(input: OrganizationCreateInput): Promise<OrganizationDetail>;
  updateOrganization(input: OrganizationUpdateInput): Promise<OrganizationUpdateResult>;
  listOrganizationMembers(
    input: OrganizationMemberQuery,
  ): Promise<OrganizationPage<OrganizationMember>>;
  updateOrganizationMember(
    input: OrganizationMemberUpdateInput,
  ): Promise<OrganizationMemberUpdateResult>;
  changeOrganizationMemberRole(
    input: OrganizationMemberRoleInput,
  ): Promise<OrganizationMemberRoleResult>;
  requestOrganizationDeparture(
    input: OrganizationDepartureInput,
    idempotencyKey: string,
  ): Promise<OrganizationDepartureResult>;
  listPendingOrganizationApprovals(
    input: OrganizationApprovalQuery,
  ): Promise<OrganizationPage<OrganizationPendingApproval>>;
  listOrganizationApprovalRecords(
    input: OrganizationApprovalRecordQuery,
  ): Promise<OrganizationPage<OrganizationApprovalRecord>>;
  processOrganizationApproval(
    input: OrganizationApprovalProcessInput,
  ): Promise<OrganizationApprovalProcessResult>;
  downloadOrganizationMemberTemplate(
    language?: 'zh' | 'en',
  ): Promise<{ blob: Blob; fileName: string }>;
  importOrganizationMembers(
    input: OrganizationImportInput,
    idempotencyKey: string,
  ): Promise<OrganizationImportResult>;
}

/** 营业执照上传返回一次性认领凭证；敏感文件没有公开 URL。 */
export interface BusinessLicenseUploadResult {
  objectKey: string;
  uploadToken: string;
  url: null;
  sensitive: true;
  fileName: string;
  extension: 'jpg' | 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp';
  size: number;
  contentType: string;
  fileHash: string;
}
