import type { ProjectPersonnelPage, ProjectPersonnelPagination } from './project-personnel.js';
import type { ProductionTaskStatus } from './project-production.js';
import type { WorkbenchProjectDetail } from './workbench.js';

export type ProjectWorkbenchMode = 'TASK' | 'BOARD';
export type ProjectWorkbenchStatistics =
  | {
      mode: 'TASK';
      pendingTaskCount: number;
      completedTaskCount: number;
      involvedProjectCount: number;
    }
  | {
      mode: 'BOARD';
      totalProjectCount: number;
      startupProjectCount: number;
      assemblyProjectCount: number;
      productionProjectCount: number;
    };
export interface ProjectBoardProjectsInput extends ProjectPersonnelPagination {
  keyword?: string | null;
}
export interface ProjectBoardProject {
  projectId: number;
  /** 仅EXPERT管理来源；其他角色为null，不代表完整专家待办。 */
  assignmentId: number | null;
  deadline: string | null;
  projectNo: string;
  projectName: string;
  requesterName: string;
  needWrittenExam: boolean;
  /** 仅PM返回；其他角色省略。 */
  primaryProjectManager?: boolean;
  expertRecruitmentHandler?: boolean;
  currentNodeCode: string;
  currentNodeName: string | null;
  progressQuantity: number;
  targetQuantity: number;
  /** 百分数，允许超过100。响应数量均为JSON数字。 */
  progressPercent: number;
  quantityUnit: string | null;
}
export type ProjectBoardProjects = ProjectPersonnelPage<ProjectBoardProject>;
/** 独立基础详情不含附件、任务或生产计划，允许合法关系下的草稿。 */
export type ProjectBoardDetail = Pick<
  WorkbenchProjectDetail,
  | 'projectNo'
  | 'projectName'
  | 'projectDescription'
  | 'requesterType'
  | 'requesterId'
  | 'requesterName'
  | 'categoryLevel1Id'
  | 'categoryLevel1Name'
  | 'categoryLevel2Id'
  | 'categoryLevel2Name'
  | 'categoryLevel3Ids'
  | 'categoryLevel3Names'
  | 'difficultyLevel'
  | 'projectQuantity'
  | 'quantityUnit'
  | 'deadline'
  | 'requiredHeadcount'
  | 'educationRequirement'
  | 'employmentType'
  | 'experienceRequirement'
  | 'workSummary'
  | 'specialRequirement'
  | 'mandatoryRequirement'
  | 'standardContent'
  | 'standardLink'
  | 'currentNodeCode'
> & {
  projectId: number;
  status: 'DRAFT' | 'PUBLISHED';
  publishedAt: string | null;
  closedAt: string | null;
};
export interface ProjectBoardSubtask {
  subtaskId: number;
  subtaskNo: string;
  subtaskName: string;
  status: ProductionTaskStatus;
  statusName: string | null;
  distributionMode: 'POOL' | 'DESIGNATED';
  plannedStartDate: string;
  expectedDeliveryDate: string;
  expectedQuantityToDate: number | null;
  progressLowRisk: boolean;
  reportedQuantity: number;
  targetQuantity: number;
  progressPercent: number;
  quantityUnit: string;
  overdueRisk: boolean;
}
export type ProjectBoardViewScope = 'FULL_PROJECT' | 'ORGANIZATION';
export type ProjectBoardRiskCode =
  | 'PROJECT_OVERDUE'
  | 'SUBTASK_OVERDUE'
  | 'SUBTASK_PROGRESS_LOW'
  | 'MEMBER_EFFICIENCY'
  | 'MEMBER_QUALITY';
export interface ProjectBoardRisk {
  code: ProjectBoardRiskCode;
  severity: 'URGENT' | 'WARNING';
  targetId: number;
  targetName: string | null;
  message: string;
  overdueDays: number | null;
}
export interface ProjectBoardRiskCard {
  pendingCount: number;
  urgentCount: number;
  items: ProjectBoardRisk[];
}
export interface ProjectBoardRisks {
  viewScope: ProjectBoardViewScope;
  project: ProjectBoardRiskCard;
  subtasks: ProjectBoardRiskCard;
  members: ProjectBoardRiskCard;
}
export type ProjectBoardTrendMetric = 'QUANTITY' | 'ACCURACY' | 'CPD';
export interface ProjectBoardTrendsInput {
  projectId: number;
  metric: ProjectBoardTrendMetric;
  /** 上海业务日期，包含首尾且最多366天。 */
  startDate: string;
  endDate: string;
}
export interface ProjectBoardTrends {
  metric: ProjectBoardTrendMetric;
  viewScope: ProjectBoardViewScope;
  dates: string[];
  /** 按实际成员区分；同一用户的多个成员身份不合并。NAV固定为空。 */
  series: {
    memberId: number;
    userId: string;
    displayName: string;
    quantityUnit: string | null;
    values: (number | null)[];
  }[];
}
export interface ProjectBoardApi {
  getProjectWorkbenchStatistics(mode: ProjectWorkbenchMode): Promise<ProjectWorkbenchStatistics>;
  listProjectBoardProjects(input?: ProjectBoardProjectsInput): Promise<ProjectBoardProjects>;
  getProjectBoardDetail(projectId: number): Promise<ProjectBoardDetail>;
  getProjectBoardSubtasks(projectId: number): Promise<ProjectBoardSubtask[]>;
  getProjectBoardRisks(projectId: number): Promise<ProjectBoardRisks>;
  getProjectBoardTrends(input: ProjectBoardTrendsInput): Promise<ProjectBoardTrends>;
}
