import { Prisma } from '@prisma/client';
import { memberInclude } from './personnel.types.js';

export const transferInclude = {
  member: { include: memberInclude },
  targetProject: true,
  flow: { include: { nodes: { orderBy: [{ nodeSeq: 'asc' }, { id: 'asc' }] } } },
  targetExamAttempt: { include: { exam: true } },
} satisfies Prisma.ProjectMemberMovementInclude;

export type Transfer = Prisma.ProjectMemberMovementGetPayload<{ include: typeof transferInclude }>;

export interface MovementProcessInput {
  projectId: number;
  movementId: number;
  flowNo: string;
  nodeId: string;
  nodeVersionNo: number;
  flowVersionNo: number;
  action: 'APPROVE' | 'REJECT';
  actionComment?: string | null;
}

export interface MovementWithdrawInput {
  projectId: number;
  movementId: number;
}
