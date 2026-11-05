export type ProjectRecruitmentSubjectType = 'INDIVIDUAL' | 'ORGANIZATION';

export interface ProjectExpertRecruitmentUser {
  userId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
}
export interface ProjectExpertRecruitmentHandlerCandidate extends ProjectExpertRecruitmentUser {
  currentProjectCount: number;
  currentHandler: boolean;
}
export interface ProjectExpertRecruitmentHandlerInput {
  projectId: number;
  handlerUserId: string;
}
export interface ProjectExpertRecruitmentDetail {
  projectId: number;
  projectName: string | null;
  projectQuantity: number | null;
  quantityUnit: string | null;
  currentNodeCode: string | null;
  primaryManager: ProjectExpertRecruitmentUser | null;
  handler: ProjectExpertRecruitmentUser | null;
  currentOperatorRole: 'PRIMARY_MANAGER' | 'EXPERT_RECRUITMENT_HANDLER';
  canChangeHandler: boolean;
  summary: {
    activeAssignmentCount: number;
    pendingAcceptanceCount: number;
    acceptedCount: number;
    rejectedCount: number;
    assignedProductionRequirement: number;
    remainingProductionRequirement: number;
  };
}
export interface ProjectExpertRecruitmentAssignment {
  assignmentId: number;
  status: 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'REJECTED' | 'REPLACED';
  productionRequirement: number | null;
  operatorHeadcount: number | null;
  inspectorHeadcount: number | null;
}
export interface ProjectExpertRecruitmentCandidate {
  /** 必须与 subjectType 联合标识候选，不按 UUID 单独去重。 */
  subjectId: string;
  subjectType: ProjectRecruitmentSubjectType;
  realName: string | null;
  nickname: string | null;
  organizationName: string | null;
  avatarUrl: string | null;
  supervisorName: string | null;
  supervisorNickname: string | null;
  description: string | null;
  assignment: ProjectExpertRecruitmentAssignment | null;
  availableAction: 'RECRUIT' | 'RECRUIT_AGAIN' | 'NONE';
}
export interface ProjectExpertRecruitmentCandidatesInput {
  projectId: number;
  subjectType?: ProjectRecruitmentSubjectType;
  keyword?: string;
  current?: number;
  size?: number;
}
export interface ProjectExpertRecruitmentCandidatesPage {
  records: ProjectExpertRecruitmentCandidate[];
  total: number;
  current: number;
  size: number;
  pages: number;
}
export interface ProjectExpertRecruitmentItem {
  subjectType: ProjectRecruitmentSubjectType;
  subjectId: string;
  /** HTTP number；0.0001以上、小于1e16、最多4位小数。不限制累计量级小于项目总量。 */
  productionRequirement: number;
  operatorHeadcount: number;
  inspectorHeadcount?: number | null;
  /** 本项目未处理拒单来源，可与新主体不同；缺省/null为普通下发。 */
  sourceRejectedAssignmentId?: number | null;
}
export interface ProjectExpertRecruitmentSubmitInput {
  projectId: number;
  assignments: ProjectExpertRecruitmentItem[];
}
export interface ProjectExpertRecruitmentApi {
  listExpertRecruitmentHandlerCandidates(
    projectId: number,
  ): Promise<ProjectExpertRecruitmentHandlerCandidate[]>;
  changeExpertRecruitmentHandler(input: ProjectExpertRecruitmentHandlerInput): Promise<void>;
  getExpertRecruitmentDetail(projectId: number): Promise<ProjectExpertRecruitmentDetail>;
  listExpertRecruitmentCandidates(
    input: ProjectExpertRecruitmentCandidatesInput,
  ): Promise<ProjectExpertRecruitmentCandidatesPage>;
  /** 追加1—100项，无版本或幂等键；未知写入结果必须先显式回读，不能自动重发。 */
  submitExpertRecruitment(input: ProjectExpertRecruitmentSubmitInput): Promise<void>;
}
