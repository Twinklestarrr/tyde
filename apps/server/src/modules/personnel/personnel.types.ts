import type { Prisma } from '@prisma/client';

export const memberInclude = {
  user: true,
  organization: true,
  organizationMembership: true,
  expertAssignment: {
    include: {
      owners: { include: { user: true }, orderBy: { id: 'asc' as const } },
      legacyOwner: true,
      memberResponses: true,
    },
  },
  admissionAttempt: {
    include: {
      exam: { select: { projectId: true } },
      transferMovement: { include: { flow: true } },
    },
  },
} satisfies Prisma.ProjectMemberInclude;

export type PersonnelMember = Prisma.ProjectMemberGetPayload<{ include: typeof memberInclude }>;
