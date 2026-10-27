import type { AuthUser } from './auth.js';

export type ExpertAcceptanceStatus =
  'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';

export interface ExpertTaskQuery {
  keyword?: string | null;
  acceptanceStatus?: ExpertAcceptanceStatus | null;
  /** acceptanceStatus 的兼容别名；同时提供时必须一致。 */
  status?: ExpertAcceptanceStatus | null;
}

/** 普通分配与转入使用各自来源 ID，不为转入身份伪造分配 ID。 */
export type ExpertTask = (
  | { assignmentId: number; movementId: null; sourceBizType: 'EXPERT_ASSIGNMENT' }
  | { assignmentId: null; movementId: number; sourceBizType: 'PROJECT_MEMBER_TRANSFER' }
) & {
  sourceBizId: number;
  basicInfo: {
    projectId: number;
    projectName: string | null;
    projectDescription: string | null;
    requesterName: string;
    creatorId: string | null;
    creatorName: string;
    projectManagerId: string | null;
    projectManagerName: string | null;
    categoryLevel1Name: string | null;
    categoryLevel2Name: string | null;
    categoryLevel3Names: string[];
    /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss。 */
    deadline: string | null;
    subjectType: 'INDIVIDUAL' | 'ORGANIZATION';
    organizationId: string | null;
    organizationName: string | null;
    productionRequirement: number | null;
    operatorHeadcount: number | null;
    inspectorHeadcount: number | null;
    projectOwners: { userId: string | null; name: string; avatarUrl: string | null }[];
    projectOwnerUserId: string | null;
    projectOwnerName: string | null;
    projectOwnerAvatarUrl: string | null;
    assignedAt: string;
  };
  acceptanceStatus: ExpertAcceptanceStatus;
  needWrittenExam: boolean;
  currentNodeCode: string;
  branchNodeCode: string | null;
  accessContext: {
    projectOwner: boolean;
    acceptedOrganizationOwner: boolean;
    canViewOrganizationData: boolean;
  };
  operations: { canAccept: boolean; canReject: boolean; canReportOutput: boolean };
};

export interface ExpertTasksApi {
  getMyExpertTasks(input?: ExpertTaskQuery): Promise<ExpertTask[]>;
  getExpertProjectOwnerCandidates(assignmentId: number): Promise<ExpertProjectOwnerCandidate[]>;
  respondExpertTask(input: ExpertTaskResponseInput): Promise<ExpertTaskResponse>;
}

export interface ExpertProjectOwnerCandidate {
  userId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
  position: 'OWNER' | 'ADMIN' | 'MEMBER';
  projectOwner: boolean;
}

export type ExpertTaskResponseInput = (
  { assignmentId: number; movementId?: null } | { assignmentId?: null; movementId: number }
) & {
  decision: 'ACCEPT' | 'REJECT';
  projectOwnerUserIds?: string[];
  rejectReason?: string;
};

export interface ExpertTaskResponse {
  assignmentId: number | null;
  movementId: number | null;
  status: 'ACCEPTED' | 'REJECTED';
  memberStatus: 'ACCEPTED' | 'REJECTED' | null;
  nextAction:
    | 'NONE'
    | 'VIEW_RESULT'
    | 'MANAGE_PROJECT_MEMBERS'
    | 'TAKE_ENTRANCE_EXAM'
    | 'WAIT_ENTRY_CONFIRMATION';
  notifiedMemberCount: number;
}

/** 负责人为空不代表组织尚未接单；须使用当前用户在该组织的主管身份。 */
export function requiresExpertProjectOwners(
  task: ExpertTask,
  user: Pick<AuthUser, 'organizations' | 'organization'>,
): boolean {
  const memberships = user.organizations ?? (user.organization ? [user.organization] : []);
  return (
    task.assignmentId !== null &&
    task.basicInfo.subjectType === 'ORGANIZATION' &&
    task.acceptanceStatus === 'PENDING_ACCEPTANCE' &&
    memberships.some(
      (membership) =>
        membership.id === task.basicInfo.organizationId &&
        membership.position === 'OWNER' &&
        ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(membership.joinStatus)),
    )
  );
}
