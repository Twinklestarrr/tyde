import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import { requireExamViewer } from './exam-access.js';

export type AdmissionStatus =
  'PENDING' | 'PENDING_ENTRY' | 'ADMITTED' | 'ENTRY_DECLINED' | 'ELIMINATED';
export interface ExamAdmissionInput {
  projectId: number;
  keyword?: string;
  admissionStatus?: AdmissionStatus;
  current?: number;
  size?: number;
}

// 顺序与旧SQL CASE一致：未完成/淘汰优先于入项；拒绝优先于joinedAt。
export function examAdmissionStatus(
  finalResult: string,
  member: { status: string; joinedAt: Date | null } | null,
): AdmissionStatus {
  if (finalResult === 'PENDING' || finalResult === 'ELIMINATED') return finalResult;
  if (member?.status === 'ENTRY_DECLINED') return 'ENTRY_DECLINED';
  return member?.joinedAt ? 'ADMITTED' : 'PENDING_ENTRY';
}
function statusFilter(status: AdmissionStatus | undefined): Prisma.EntranceExamAttemptWhereInput {
  if (!status) return {};
  if (status === 'PENDING' || status === 'ELIMINATED') return { finalResult: status };
  const member: Prisma.ProjectMemberWhereInput =
    status === 'ENTRY_DECLINED'
      ? { status: 'ENTRY_DECLINED' }
      : status === 'ADMITTED'
        ? { status: { not: 'ENTRY_DECLINED' }, joinedAt: { not: null } }
        : { status: { not: 'ENTRY_DECLINED' }, joinedAt: null };
  return {
    finalResult: 'ADMITTED',
    ...(status === 'PENDING_ENTRY'
      ? { OR: [{ admittedMember: { is: null } }, { admittedMember: { is: member } }] }
      : { admittedMember: { is: member } }),
  };
}
export async function queryExamAdmissions(
  tx: Prisma.TransactionClient,
  input: ExamAdmissionInput,
  principal: AuthPrincipal,
) {
  const current = input.current ?? 1,
    size = input.size ?? 20;
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100 ||
    !Number.isSafeInteger((current - 1) * size)
  )
    throw new AppError(400, 'VALIDATION_ERROR', '页码须为正安全整数，每页1至100条且偏移不能溢出');
  let organizationIds: string[] | undefined;
  if (principal.role === 'EXPERT') {
    const project = await tx.project.findFirst({ where: { id: input.projectId, deleted: false } });
    if (!project) throw new AppError(404, 'NOT_FOUND', '项目不存在');
    if (project.status !== 'PUBLISHED')
      throw new AppError(400, 'VALIDATION_ERROR', '只有已发布项目可以查询准入情况');
    const memberships = await tx.userOrgRel.findMany({
      where: {
        userId: principal.userId,
        position: 'OWNER',
        joinStatus: { in: participatingStatuses },
      },
      select: { orgId: true },
    });
    const assignments = await tx.projectExpertAssignment.findMany({
      where: {
        projectId: input.projectId,
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
        OR: [
          { organizationId: { in: memberships.map((r) => r.orgId) } },
          { owners: { some: { userId: principal.userId, status: 'ACTIVE' } } },
          { projectOwnerUserId: principal.userId, owners: { none: {} } },
        ],
      },
      select: { organizationId: true },
    });
    organizationIds = [
      ...new Set(assignments.flatMap((a) => (a.organizationId ? [a.organizationId] : []))),
    ];
    if (!organizationIds.length)
      throw new AppError(403, 'FORBIDDEN', '只有组织主管或项目负责人可以查看当前组织准入情况');
  } else await requireExamViewer(tx, input.projectId, principal);
  const keyword = input.keyword?.trim();
  const where: Prisma.EntranceExamAttemptWhereInput = {
    exam: { projectId: input.projectId, deleted: false },
    submittedAt: { not: null },
    ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
    AND: [
      statusFilter(input.admissionStatus),
      ...(keyword
        ? [
            {
              OR: [
                { candidateName: { contains: keyword } },
                { candidateUid: { contains: keyword } },
                { organizationName: { contains: keyword } },
              ],
            },
          ]
        : []),
    ],
  };
  const total = await tx.entranceExamAttempt.count({ where });
  const rows =
    (current - 1) * size >= total
      ? []
      : await tx.entranceExamAttempt.findMany({
          where,
          skip: (current - 1) * size,
          take: size,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          include: {
            exam: { select: { examName: true } },
            version: { select: { examNameSnapshot: true } },
            candidate: { select: { uid: true, displayName: true, realName: true } },
            membership: { select: { employmentType: true } },
            admittedMember: { select: { status: true, joinedAt: true } },
          },
        });
  return {
    current,
    size,
    total,
    pages: Math.ceil(total / size),
    records: rows.map((a) => ({
      attemptId: a.id,
      examId: a.examId,
      examName: a.version?.examNameSnapshot ?? a.exam.examName,
      candidateUserId: a.candidateUserId,
      candidateUid: a.candidateUid,
      candidateName: displayName(a.candidate.displayName, a.candidate.realName, a.candidate.uid),
      organizationId: a.organizationId,
      organizationName: a.organizationName,
      employmentType: a.membership?.employmentType ?? null,
      examDate: projectTime(a.submittedAt!),
      admissionStatus: examAdmissionStatus(a.finalResult, a.admittedMember),
    })),
  };
}
