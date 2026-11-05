export interface ExitInput {
  orgId: string;
  memberId?: string | null;
  reason: string;
  plannedLeaveDate: string;
}

export interface ApprovalQuery {
  orgId: string;
  businessType?: string | null;
  current?: number;
  size?: number;
  status?: string | null;
  startAt?: string | null;
  endAt?: string | null;
}

export interface ProcessInput {
  orgId: string;
  flowNo: string;
  nodeId: string;
  flowVersionNo: number;
  nodeVersionNo: number;
  action: 'APPROVE' | 'REJECT';
  actionComment?: string | null;
}
