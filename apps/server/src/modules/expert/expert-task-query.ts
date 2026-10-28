import { ordinaryExamTask } from './expert-exam-task.js';
import { expertOutputTask } from './expert-output-task.js';
import { canReportExpertOutput, hasReportedExpertOutputToday } from './expert-report-capability.js';
import { queryTransferTasks } from './expert-transfer-query.js';
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

/** 聚合真实接单、成员及报量权限；读取不修复快照或任务轮次。 */
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
  const transferCards = await queryTransferTasks(tx, query, principal, projectId, now);
  if (!rows.length) return transferCards;
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const [members, exams, managers, creators, pendingEntries] = await Promise.all([
    tx.projectMember.findMany({
      where: { projectId: { in: ids }, userId: principal.userId },
      orderBy: { id: 'desc' },
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
    const member = members.find((m) => m.projectId === row.projectId);
    const activeAccess =
      !!member &&
      ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(member.status) &&
      member.entryDecision !== 'NO' &&
      !!member.joinedAt;
    const examTask =
      acceptanceStatus === 'ACCEPTED' &&
      needWrittenExam &&
      (projectOwner || (!acceptedOrganizationOwner && !member))
        ? await ordinaryExamTask(tx, project.id, principal.userId, now)
        : null;
    const hasExamTask = examTask?.assignmentId === row.id;
    let branch: string | null = null;
    if (acceptanceStatus === 'ACCEPTED') {
      // 仅本域已接实来源可展示；其他快照须由10—12回补真值，不能凭旧快照开放动作。
      if (projectOwner)
        branch = hasExamTask
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
          : hasExamTask
            ? 'ENTRANCE_EXAM'
            : null;
    }
    let outputBranch: string | null = null;
    if (acceptanceStatus === 'ACCEPTED') {
      outputBranch = await expertOutputTask(tx, project.id, row.organizationId, principal, now);
      if (outputBranch === 'OUTPUT_DATA_REVIEW' || (outputBranch && !branch)) branch = outputBranch;
    }
    // 日报量只消解普通生产待办；实时核查、退回修正及独立培训仍保留。
    if (
      acceptanceStatus === 'ACCEPTED' &&
      !outputBranch &&
      (branch ?? main) === 'PRODUCTION_TASK' &&
      (await hasReportedExpertOutputToday(tx, project.id, principal.userId, now))
    )
      continue;
    const ownerWithoutExam = projectOwner && (!needWrittenExam || !enterable);
    if (acceptanceStatus === 'ACCEPTED' && !ownerWithoutExam && !branch) continue;
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
      movementId: null,
      sourceBizType: 'EXPERT_ASSIGNMENT',
      sourceBizId: row.id,
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
      operations: {
        canAccept: acceptanceStatus === 'PENDING_ACCEPTANCE',
        canReject: acceptanceStatus === 'PENDING_ACCEPTANCE',
        canReportOutput:
          acceptanceStatus === 'ACCEPTED' &&
          (branch ?? main) === 'PRODUCTION_TASK' &&
          (await canReportExpertOutput(tx, project.id, row.organizationId, principal, now)),
      },
    });
  }
  return [
    ...transferCards,
    ...cards.filter(
      (c) =>
        !transferCards.some(
          (t) =>
            t.basicInfo.projectId === c.basicInfo.projectId &&
            t.basicInfo.organizationId === c.basicInfo.organizationId &&
            t.branchNodeCode !== 'MEMBER_MOVEMENT_APPROVAL',
        ),
    ),
  ].sort(
    (a, b) =>
      b.basicInfo.assignedAt.localeCompare(a.basicInfo.assignedAt) ||
      b.sourceBizId - a.sourceBizId ||
      a.sourceBizType.localeCompare(b.sourceBizType),
  );
}
