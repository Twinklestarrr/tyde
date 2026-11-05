import { Prisma, type PrismaClient } from '@prisma/client';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { qualifiedForEntry } from '../personnel/personnel-entry.domain.js';
import { memberInclude } from '../personnel/personnel.types.js';

/** 与旧标准材料授权SQL一致；ACTIVE项目成员本身不授予附件权限。 */
export async function canReadExpertProjectFile(
  db: PrismaClient,
  projectId: number,
  userId: string,
) {
  const transferred = await db.projectMember.findMany({
    where: {
      projectId,
      userId,
      status: { in: ['ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER'] },
      joinedAt: { not: null },
      leftAt: null,
      admissionAttempt: { sourceBizType: 'PROJECT_MEMBER_TRANSFER' },
    },
    include: memberInclude,
  });
  if (transferred.some((m) => qualifiedForEntry(m, true))) return true;
  const rows = await db.$queryRaw<{ allowed: boolean }[]>`SELECT EXISTS(
    SELECT 1 FROM "ProjectExpertAssignment" a
    LEFT JOIN "ProjectProductionPlan" plan ON plan."projectId"=a."projectId"
    LEFT JOIN "UserOrgRel" rel ON rel."orgId"=a."organizationId" AND rel."userId"=${userId}::uuid
      AND rel."joinStatus" IN (${Prisma.join(participatingStatuses)})
    LEFT JOIN "Organization" org ON org."id"=rel."orgId" AND org."deleted"=false
    WHERE a."projectId"=${projectId} AND a."status"='ACCEPTED'
    AND ((a."subjectType"='INDIVIDUAL' AND a."expertUserId"=${userId}::uuid)
      OR (a."subjectType"='ORGANIZATION' AND rel."id" IS NOT NULL AND org."id" IS NOT NULL))
    AND (COALESCE(plan."needWrittenExam", false)=false
      OR (a."subjectType"='ORGANIZATION' AND (rel."position"='OWNER'
        OR EXISTS(SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId"=a."id" AND o."userId"=${userId}::uuid AND o."status"='ACTIVE')
        OR (a."projectOwnerUserId"=${userId}::uuid AND NOT EXISTS(SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId"=a."id"))))
      OR EXISTS(SELECT 1 FROM "EntranceExamAttempt" attempt JOIN "ProjectEntranceExam" exam ON exam."id"=attempt."examId" AND exam."deleted"=false
        WHERE attempt."candidateUserId"=${userId}::uuid AND exam."projectId"=a."projectId" AND attempt."finalResult"='ADMITTED'))
  ) AS allowed`;
  return rows[0]?.allowed === true;
}
