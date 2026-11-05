import type { ProjectPersonnelPage, ProjectPersonnelPagination } from './project-personnel.js';

/** 输入支持精确十进制字符串（最多26位整数及4位小数）；响应沿后端JSON数字，可能舍入大数。 */
export type ProductionDecimal = string | number;
export type ProductionTaskStatus =
  'IN_PROGRESS' | 'PENDING_ACCEPTANCE' | 'REWORK_REQUIRED' | 'ACCEPTED';
export type ProductionDataSource = 'MANUAL' | 'WORK_SYSTEM';
export type ProductionReviewStatus = 'PENDING' | 'VERIFIED' | 'RETURNED';
export interface ProductionTaskQuery extends ProjectPersonnelPagination {
  projectId: number;
  keyword?: string | null;
}
export interface ProductionTasksInput extends ProductionTaskQuery {
  statuses?: ProductionTaskStatus[] | null;
}
export interface ProductionTaskCreateInput {
  projectId: number;
  subtaskName: string;
  expectedDeliveryDate: string;
  expectedQuantity: ProductionDecimal;
  distributionMode: 'POOL' | 'DESIGNATED';
  memberIds?: number[] | null;
}
export interface ProductionTaskMember {
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  subjectType: 'INDIVIDUAL' | 'ORGANIZATION';
  organizationId: string | null;
  organizationName: string | null;
  assignmentType: 'DESIGNATED' | 'CLAIMED' | null;
  assignedAt: string | null;
}
export interface ProductionTask {
  subtaskId: number;
  subtaskNo: string;
  subtaskName: string;
  status: ProductionTaskStatus;
  distributionMode: 'POOL' | 'DESIGNATED';
  assigneeCount: number;
  assigneeNames: string[];
  pendingReportCount: number;
  expectedDeliveryDate: string;
  expectedQuantity: number;
  quantityUnit: string;
  actualDeliveryDate: string | null;
  actualQuantity: number | null;
  reportedQuantity: number | null;
  quantityAdjustmentRemark: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  operationHint: string | null;
  allowedActions: ('CHECK_DATA' | 'CORRECT_REPORT' | 'SUBMIT_ACCEPTANCE' | 'ACCEPT' | 'REJECT')[];
}
export interface ProductionOutputReportsInput extends ProductionTaskQuery {
  /** 缺省/null仅查询项目级，不代表包含全部子任务。 */
  subtaskId?: number | null;
  reviewStatuses?: ProductionReviewStatus[] | null;
  reportDateStart?: string | null;
  reportDateEnd?: string | null;
}
export interface ProductionOutputReport {
  reportId: number;
  subtaskId: number | null;
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  reportDate: string;
  quantity: number;
  quantityUnit: string;
  remark: string | null;
  reviewStatus: ProductionReviewStatus;
  returnReason: string | null;
  updatedAt: string | null;
  allowedActions: ('VERIFY' | 'RETURN' | 'SAVE_REPORT')[];
}
export interface ProductionOutputReports {
  totalReportCount: number;
  totalQuantity: number;
  pendingCount: number;
  returnedCount: number;
  page: ProjectPersonnelPage<ProductionOutputReport>;
}
export interface ProductionOutputReviewInput {
  projectId: number;
  subtaskId?: number | null;
  action: 'VERIFY' | 'RETURN';
  /** VERIFY缺省/null/[]核准当前层级全部PENDING；RETURN去重后必须恰好一条。 */
  reportIds?: number[] | null;
  reason?: string | null;
}
export interface ReportableProductionTask {
  subtaskId: number;
  subtaskNo: string;
  subtaskName: string;
  quantityUnit: string;
  distributionMode: 'POOL' | 'DESIGNATED';
}
export interface ProductionOutputReportItem {
  /** 缺省/null是项目级；具体子任务需仍可写。 */
  subtaskId?: number | null;
  /** 真实项目成员ID。省略/null仅当后端能唯一定位本人有效成员；不可猜测或借其他来源ID。 */
  memberId?: number | null;
  reportDate: string;
  quantity: ProductionDecimal;
  remark?: string | null;
}
export interface ProductionOutputSaveInput {
  projectId: number;
  reports: ProductionOutputReportItem[];
}
export interface ProductionOutputCorrectInput {
  projectId: number;
  /** 只修正当前有SAVE_REPORT权限的原退回报量；不改变成员、日期和层级。 */
  reportId: number;
  quantity: ProductionDecimal;
  remark?: string | null;
}
export interface PersonnelProductionInput extends ProductionTaskQuery {
  /** 分别缺省/null默认上海当天；区间首尾在内最多31天。 */
  reportDateStart?: string | null;
  reportDateEnd?: string | null;
  accountTypes?: ('INDIVIDUAL' | 'ORGANIZATION')[] | null;
  organizationIds?: string[] | null;
  dataSources?: ProductionDataSource[] | null;
}
export interface PersonnelProductionRow {
  memberId: number;
  userId: string;
  uid: string;
  displayName: string;
  accountType: 'INDIVIDUAL' | 'ORGANIZATION';
  organizationId: string | null;
  organizationName: string | null;
  reportDate: string;
  quantity: number;
  quantityUnit: string;
  recent7DayCpd: number;
  inspectedQuantity: number;
  qualifiedQuantity: number;
  unqualifiedQuantity: number;
  accuracyRate: number | null;
  dataSources: ProductionDataSource[];
  remarks: string | null;
  qualityRecordCount: number;
  hasManualQualityEntry: boolean;
  allowedActions: ('SAVE_QUALITY' | 'CREATE_PERFORMANCE')[];
}
export interface PersonnelQualityKey {
  projectId: number;
  memberId: number;
  reportDate: string;
}
export interface PersonnelQualityItem {
  outputReportId: number;
  subtaskId: number | null;
  subtaskName: string | null;
  quantity: number;
  quantityUnit: string;
  reportDataSource: ProductionDataSource;
  qualityId: number | null;
  inspectedQuantity: number | null;
  qualifiedQuantity: number | null;
  unqualifiedReason: string | null;
  operatorName: string | null;
  operationTime: string | null;
  qualityDataSource: ProductionDataSource | null;
  editable: boolean;
}
export interface PersonnelQualityContext {
  memberId: number;
  displayName: string;
  reportDate: string;
  /** 同报量可有多条历史；不可按outputReportId去重覆盖。 */
  items: PersonnelQualityItem[];
}
export interface PersonnelQualitySaveInput extends PersonnelQualityKey {
  /** 每次追加1—100条，可重复同一outputReportId，不是覆盖或幂等保存。 */
  items: {
    outputReportId: number;
    inspectedQuantity: ProductionDecimal;
    qualifiedQuantity: ProductionDecimal;
    unqualifiedReason?: string | null;
  }[];
}
export interface ProductionAcceptanceKey {
  projectId: number;
  subtaskId: number;
}
export interface ProductionAcceptanceContext {
  subtaskId: number;
  subtaskName: string;
  expectedDeliveryDate: string;
  expectedQuantity: number;
  quantityUnit: string;
  reportedQuantity: number;
  pendingCount: number;
  returnedCount: number;
  defaultActualQuantity: number;
  defaultActualDeliveryDate: string;
  canSubmit: boolean;
}
export interface ProductionAcceptanceSubmitInput extends ProductionAcceptanceKey {
  actualQuantity: ProductionDecimal;
  actualDeliveryDate: string;
  quantityAdjustmentRemark?: string | null;
}
export interface ProductionAcceptanceReviewInput extends ProductionAcceptanceKey {
  decision: 'ACCEPT' | 'REJECT';
  /** 驳回时非空白必填，通过禁止非空原因；最多500字符。 */
  rejectReason?: string | null;
}
export const PRODUCTION_REQUEST_MAX_BYTES = 16 * 1024;
export const PRODUCTION_QUALITY_REQUEST_MAX_BYTES = 512 * 1024;
export const PRODUCTION_REPORT_REQUEST_MAX_BYTES = 512 * 1024;
export interface ProjectProductionApi {
  listReportableProductionTasks(projectId: number): Promise<ReportableProductionTask[]>;
  saveProductionOutputReports(input: ProductionOutputSaveInput): Promise<void>;
  correctProductionOutputReport(input: ProductionOutputCorrectInput): Promise<void>;
  listProductionTaskMembers(
    input: ProductionTaskQuery,
  ): Promise<ProjectPersonnelPage<ProductionTaskMember>>;
  createProductionTask(input: ProductionTaskCreateInput): Promise<void>;
  listProductionTasks(input: ProductionTasksInput): Promise<ProjectPersonnelPage<ProductionTask>>;
  listProductionTaskAssignees(
    input: ProductionTaskQuery & { subtaskId: number },
  ): Promise<ProjectPersonnelPage<ProductionTaskMember>>;
  listProductionOutputReports(
    input: ProductionOutputReportsInput,
  ): Promise<ProductionOutputReports>;
  reviewProductionOutputReports(input: ProductionOutputReviewInput): Promise<void>;
  listPersonnelProduction(
    input: PersonnelProductionInput,
  ): Promise<ProjectPersonnelPage<PersonnelProductionRow>>;
  getPersonnelQualityContext(input: PersonnelQualityKey): Promise<PersonnelQualityContext>;
  savePersonnelQuality(input: PersonnelQualitySaveInput): Promise<void>;
  getProductionAcceptanceContext(
    input: ProductionAcceptanceKey,
  ): Promise<ProductionAcceptanceContext>;
  submitProductionAcceptance(input: ProductionAcceptanceSubmitInput): Promise<void>;
  reviewProductionAcceptance(input: ProductionAcceptanceReviewInput): Promise<void>;
}
