import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';

export interface ExpertTaskQuery {
  keyword?: string | null;
  acceptanceStatus?: string | null;
  status?: string | null;
}
const statuses = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'REPLACED'];
export function validateTaskQuery(query: ExpertTaskQuery) {
  if (
    (query.keyword != null && (typeof query.keyword !== 'string' || query.keyword.length > 100)) ||
    [query.acceptanceStatus, query.status].some((s) => s != null && !statuses.includes(s)) ||
    (query.acceptanceStatus != null &&
      query.status != null &&
      query.acceptanceStatus !== query.status)
  )
    throw new AuthError(400, 'VALIDATION_ERROR', '关键字或接单状态参数无效，别名状态不得冲突');
}

/** 仅聚合已有接单/成员事实；生产报量与跨领域审批能力由对应任务接回。 */
export async function queryExpertTasks(
  tx: Prisma.TransactionClient,
  query: ExpertTaskQuery,
  principal: AuthPrincipal,
  now = new Date(),
  projectId?: number,
) {
  const rels = await tx.userOrgRel.findMany({
    where: {
      userId: principal.userId,
      joinStatus: { in: participatingStatuses },
      organization: { deleted: false },
    },
  });
  const keyword = query.keyword?.trim();
  const rows = await tx.projectExpertAssignment.findMany({
    where: {
      project: {
        ...(projectId === undefined ? {} : { id: projectId }),
        deleted: false,
        ...(keyword
          ? {
              OR: [
                { projectName: { contains: keyword } },
                { requesterName: { contains: keyword } },
              ],
            }
          : {}),
      },
      OR: [
        { subjectType: 'INDIVIDUAL', expertUserId: principal.userId },
        {
          subjectType: 'ORGANIZATION',
          organizationId: { in: rels.map((r) => r.orgId) },
          status: 'ACCEPTED',
        },
        {
          subjectType: 'ORGANIZATION',
          organizationId: { in: rels.filter((r) => r.position === 'OWNER').map((r) => r.orgId) },
          status: { in: ['PENDING_ACCEPTANCE', 'REJECTED'] },
        },
      ],
    },
    include: {
      owners: { include: { user: true }, orderBy: { id: 'asc' } },
      legacyOwner: true,
      organization: true,
      memberResponses: { where: { userId: principal.userId } },
      project: {
        include: {
          requester: true,
          productionPlan: true,
          categories: { orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }] },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const [members, attempts, exams, managers, creators, pendingEntries] = await Promise.all([
    tx.projectMember.findMany({
      where: { projectId: { in: ids }, userId: principal.userId },
      orderBy: { id: 'desc' },
    }),
    tx.entranceExamAttempt.findMany({
      where: {
        candidateUserId: principal.userId,
        OR: [{ submittedAt: { not: null } }, { cancelledAt: { not: null } }],
        exam: { projectId: { in: ids }, deleted: false },
      },
      include: { exam: { select: { projectId: true } } },
    }),
    tx.projectEntranceExam.findMany({
      where: {
        projectId: { in: ids },
        deleted: false,
        status: 'ACTIVE',
        currentVersion: { registrationDeadline: { gt: now } },
      },
    }),
    tx.projectManagerRecruitment.findMany({
      where: { projectId: { in: ids }, status: 'ASSIGNED' },
      include: { candidate: true },
    }),
    tx.user.findMany({
      where: { uid: { in: [...new Set(rows.map((r) => r.project.createdBy))] } },
    }),
    tx.projectMember.findMany({
      where: {
        projectId: { in: ids },
        status: { in: ['PENDING_CONFIRM', 'PENDING_ENTRY'] },
        entryDecision: null,
        plannedEntryDate: null,
      },
      include: memberInclude,
    }),
  ]);
  const ownersOf = (row: (typeof rows)[number]) =>
    row.subjectType !== 'ORGANIZATION' || row.status !== 'ACCEPTED'
      ? []
      : row.owners.length
        ? row.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.user)
        : row.legacyOwner
          ? [row.legacyOwner]
          : [];
  const isOwner = (row: (typeof rows)[number]) =>
    ownersOf(row).some((u) => u.id === principal.userId);
  const relOf = (row: (typeof rows)[number]) => rels.find((r) => r.orgId === row.organizationId);
  const organizationProjects = new Set(
    rows
      .filter(
        (r) =>
          r.subjectType === 'ORGANIZATION' &&
          r.status === 'ACCEPTED' &&
          (relOf(r)?.position === 'OWNER' ||
            isOwner(r) ||
            !['REJECTED', 'CANCELLED'].includes(
              r.memberResponses[0]?.status ?? 'PENDING_ACCEPTANCE',
            )),
      )
      .map((r) => r.projectId),
  );
  const cards = [];
  for (const row of rows) {
    if (row.subjectType === 'INDIVIDUAL' && organizationProjects.has(row.projectId)) continue;
    const project = row.project;
    const projectOwner = isOwner(row);
    const acceptedOrganizationOwner =
      row.subjectType === 'ORGANIZATION' &&
      row.status === 'ACCEPTED' &&
      relOf(row)?.position === 'OWNER';
    const acceptanceStatus =
      row.subjectType === 'ORGANIZATION' && row.status === 'ACCEPTED'
        ? projectOwner || acceptedOrganizationOwner
          ? 'ACCEPTED'
          : row.memberResponses[0]?.status === 'SELECTED'
            ? 'ACCEPTED'
            : (row.memberResponses[0]?.status ?? 'PENDING_ACCEPTANCE')
        : row.status;
    if (
      (query.acceptanceStatus ?? query.status) &&
      acceptanceStatus !== (query.acceptanceStatus ?? query.status)
    )
      continue;
    const main = project.currentNodeCode ?? 'RECRUIT_PROJECT_MANAGER';
    if (main === 'COMPLETED' || !['ACCEPTED', 'PENDING_ACCEPTANCE'].includes(acceptanceStatus))
      continue;
    const needWrittenExam = project.productionPlan?.needWrittenExam ?? false;
    const enterable = exams.some((e) => e.projectId === row.projectId);
    const finishedExam = attempts.some((a) => a.exam.projectId === row.projectId);
    const member = members.find((m) => m.projectId === row.projectId);
    const activeAccess =
      !!member &&
      ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(member.status) &&
      member.entryDecision !== 'NO' &&
      !!member.joinedAt;
    let branch: string | null = null;
    if (acceptanceStatus === 'ACCEPTED') {
      // 仅本域已接实来源可展示；其他快照须由10—12回补真值，不能凭旧快照开放动作。
      if (projectOwner)
        branch =
          needWrittenExam && enterable && !finishedExam
            ? 'ENTRANCE_EXAM'
            : pendingEntries.some(
                  (m) =>
                    m.expertAssignmentId === row.id &&
                    m.organizationId === row.organizationId &&
                    qualifiedForEntry(m, needWrittenExam),
                )
              ? 'MEMBER_ENTRY_CONFIRM'
              : null;
      else if (!acceptedOrganizationOwner)
        branch = member
          ? activeAccess
            ? member.standardTrainingConfirmedAt
              ? 'PRODUCTION_TASK'
              : 'STANDARD_TRAINING'
            : null
          : needWrittenExam && !finishedExam
            ? 'ENTRANCE_EXAM'
            : null;
    }
    const ownerWithoutExam = projectOwner && (!needWrittenExam || !enterable);
    if (
      acceptanceStatus === 'ACCEPTED' &&
      !ownerWithoutExam &&
      (!branch || (branch === 'PRODUCTION_TASK' && !activeAccess))
    )
      continue;
    const owners = ownersOf(row).map((u) => ({
      userId: u.id,
      name: displayName(u.displayName, u.realName, u.uid),
      avatarUrl: u.avatarUrl,
    }));
    const legacy = owners.length === 1 ? owners[0] : null;
    const creator = creators.find((u) => u.uid === project.createdBy);
    const manager = managers.find((m) => m.projectId === row.projectId)?.candidate;
    cards.push({
      assignmentId: row.id,
      basicInfo: {
        projectId: project.id,
        projectName: project.projectName,
        projectDescription: project.projectDescription,
        requesterName:
          project.requesterType === 'INDIVIDUAL'
            ? displayName(
                project.requester.displayName,
                project.requester.realName,
                project.requesterName,
              )
            : project.requesterName,
        creatorId: creator?.id ?? null,
        creatorName: creator
          ? displayName(creator.displayName, creator.realName, project.requesterName)
          : project.requesterName,
        projectManagerId: manager?.id ?? null,
        projectManagerName: manager
          ? displayName(manager.displayName, manager.realName, manager.uid)
          : null,
        categoryLevel1Name:
          project.categories.find((c) => c.categoryLevel === 1)?.categoryNameSnapshot ?? null,
        categoryLevel2Name:
          project.categories.find((c) => c.categoryLevel === 2)?.categoryNameSnapshot ?? null,
        categoryLevel3Names: project.categories
          .filter((c) => c.categoryLevel === 3)
          .map((c) => c.categoryNameSnapshot),
        deadline: project.deadline ? projectTime(project.deadline) : null,
        subjectType: row.subjectType,
        organizationId: row.organizationId,
        organizationName: row.organization?.name ?? null,
        productionRequirement: row.productionRequirement?.toNumber() ?? null,
        operatorHeadcount: row.operatorHeadcount,
        inspectorHeadcount: row.inspectorHeadcount,
        projectOwners: owners,
        projectOwnerUserId: legacy?.userId ?? null,
        projectOwnerName: legacy?.name ?? null,
        projectOwnerAvatarUrl: legacy?.avatarUrl ?? null,
        assignedAt: projectTime(row.createdAt),
      },
      acceptanceStatus,
      needWrittenExam,
      currentNodeCode: main,
      branchNodeCode: branch,
      accessContext: {
        projectOwner,
        acceptedOrganizationOwner,
        canViewOrganizationData: projectOwner || acceptedOrganizationOwner,
      },
      // 仅待响应分配/普通成员开放067，报量能力由11接回。
      operations: {
        canAccept: acceptanceStatus === 'PENDING_ACCEPTANCE',
        canReject: acceptanceStatus === 'PENDING_ACCEPTANCE',
        canReportOutput: false,
      },
    });
  }
  return cards;
}
