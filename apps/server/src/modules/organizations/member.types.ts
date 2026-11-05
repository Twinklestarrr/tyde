export interface MemberQuery {
  orgId: string;
  keyword?: string | null;
  joinedStartDate?: string | null;
  joinedEndDate?: string | null;
  leftStartDate?: string | null;
  leftEndDate?: string | null;
  employmentType?: string | null;
  position?: string | null;
  joinStatus?: string | null;
  projectId?: number | null;
  current?: number;
  size?: number;
}

export interface MemberUpdateInput {
  orgId: string;
  memberId: string;
  versionNo: number;
  joinedAt?: string | null;
  employmentType?: string | null;
}

export interface MemberPositionInput {
  orgId: string;
  memberId: string;
  position: string;
}
