import { ordinaryExamTask } from '../expert/expert-exam-task.js';
import type { Prisma } from '@prisma/client';
import { hasTransferExamTask } from '../expert/expert-transfer-exam.js';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { outputScope } from '../production/output-report-access.js';
import { currentApprovers, transferInclude } from '../personnel/personnel-transfer.js';
import type { ManagementBranchCandidate } from './project-management-card-snapshot.js';

export const expertCardPerspectives = [
  'EXPERT_ORG_OWNER',
  'EXPERT_PROJECT_OWNER',
  'EXPERT_MEMBER',
  'EXPERT_INDIVIDUAL',
];

// 一个人可同时主管组织A、负责组织B及以个人身份履约；各视角独立收窄组织范围。
// 不读取会话角色，也不以卡片胜者代替其他任务轮次。
export async function collectExpertCardCandidates(
  tx: Prisma.TransactionClient,
  projectId: number,
  now: Date,
): Promise<ManagementBranchCandidate[]> {
  const [assignments, rels, members, plan, reports, movements] = await Promise.all([
    tx.projectExpertAssignment.findMany({
      where: { projectId, status: 'ACCEPTED' },
      include: { owners: true, organization: true, memberResponses: true },
    }),
    tx.userOrgRel.findMany({
      where: {
        joinStatus: { in: participatingStatuses },
        organization: {
          deleted: false,
          expertAssignments: { some: { projectId, status: 'ACCEPTED' } },
        },
        user: { status: 'ACTIVE' },
      },
    }),
    tx.projectMember.findMany({
      where: { projectId },
      include: memberInclude,
      orderBy: { id: 'desc' },
    }),
    tx.projectProductionPlan.findUnique({ where: { projectId } }),
    tx.projectOutputReport.findMany({
      where: {
        projectId,
        reviewStatus: { in: ['PENDING', 'RETURNED'] },
        OR: [
          { subtaskId: null, project: { currentNodeCode: 'PRODUCTION_TASK' } },
          { subtask: { status: 'IN_PROGRESS' } },
        ],
      },
      include: { member: true },
    }),
    tx.projectMemberMovement.findMany({
      where: {
        OR: [{ sourceProjectId: projectId }, { targetProjectId: projectId }],
        status: 'PROCESSING',
        flow: {
          status: 'PENDING',
          currentNodeCode: { in: ['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER', 'TARGET_ENTRANCE_EXAM'] },
        },
      },
      include: transferInclude,
    }),
  ]);
  const result: ManagementBranchCandidate[] = [];
  const scopes = new Map<string, { userId: string; perspective: string; orgIds: Set<string> }>();
  const addScope = (userId: string, perspective: string, orgId?: string) => {
    const key = JSON.stringify([userId, perspective]);
    const scope = scopes.get(key) ?? { userId, perspective, orgIds: new Set<string>() };
    if (orgId) scope.orgIds.add(orgId);
    scopes.set(key, scope);
  };
  const organizations = assignments.filter(
    (a) => a.subjectType === 'ORGANIZATION' && !a.organization?.deleted,
  );
  for (const a of organizations) {
    for (const r of rels.filter((r) => r.orgId === a.organizationId)) {
      if (r.position === 'OWNER') addScope(r.userId, 'EXPERT_ORG_OWNER', r.orgId);
      if (
        a.owners.length
          ? a.owners.some((o) => o.userId === r.userId && o.status === 'ACTIVE')
          : a.projectOwnerUserId === r.userId
      )
        addScope(r.userId, 'EXPERT_PROJECT_OWNER', r.orgId);
    }
  }
  const latest = new Map<string, (typeof members)[number]>();
  for (const m of members) if (!latest.has(m.userId)) latest.set(m.userId, m);
  const needExam = plan?.needWrittenExam ?? false;
  for (const m of latest.values()) {
    if (m.user.status !== 'ACTIVE' || !qualifiedForEntry(m, needExam)) continue;
    addScope(m.userId, m.organizationId ? 'EXPERT_MEMBER' : 'EXPERT_INDIVIDUAL');
  }
  // 尚无成员关系的已接单个人/组织成员也可能处于本人准入考试节点。
  for (const a of assignments) {
    if (a.subjectType === 'INDIVIDUAL' && a.expertUserId && !latest.has(a.expertUserId))
      addScope(a.expertUserId, 'EXPERT_INDIVIDUAL');
    if (a.subjectType === 'ORGANIZATION' && !a.organization?.deleted)
      for (const response of a.memberResponses)
        if (
          ['ACCEPTED', 'SELECTED'].includes(response.status) &&
          !latest.has(response.userId) &&
          rels.some(
            (r) =>
              r.id === response.userOrgRelId &&
              r.userId === response.userId &&
              r.orgId === a.organizationId,
          )
        )
          addScope(response.userId, 'EXPERT_MEMBER');
  }
  const add = (
    scope: { userId: string; perspective: string },
    branchNodeCode: ManagementBranchCandidate['branchNodeCode'],
    sourceBizType: string,
    sourceBizId: number,
    sourceEventAt: Date,
  ) =>
    result.push({
      userId: scope.userId,
      perspective: scope.perspective,
      branchNodeCode,
      sourceBizType,
      sourceBizId,
      sourceEventAt,
    });
  for (const movement of movements) {
    const code = movement.flow?.currentNodeCode;
    if (
      !code ||
      (code === 'SOURCE_ORG_OWNER' ? movement.sourceProjectId : movement.targetProjectId) !==
        projectId
    )
      continue;
    if (code === 'TARGET_ENTRANCE_EXAM') {
      if (await hasTransferExamTask(tx, movement, now))
        add(
          {
            userId: movement.userId,
            perspective: movement.member.organizationId ? 'EXPERT_MEMBER' : 'EXPERT_INDIVIDUAL',
          },
          'ENTRANCE_EXAM',
          'PROJECT_MEMBER_TRANSFER',
          movement.id,
          movement.createdAt,
        );
      continue;
    }
    for (const user of await currentApprovers(tx, movement, code))
      add(
        { userId: user.id, perspective: 'EXPERT_PROJECT_OWNER' },
        'MEMBER_MOVEMENT_APPROVAL',
        'PROJECT_MEMBER_MOVEMENT',
        movement.id,
        movement.createdAt,
      );
  }
  const outputScopes = new Map<string, Awaited<ReturnType<typeof outputScope>> | null>();
  for (const scope of scopes.values()) {
    if (reports.length && !outputScopes.has(scope.userId)) {
      try {
        outputScopes.set(
          scope.userId,
          await outputScope(
            tx,
            projectId,
            { userId: scope.userId, role: 'EXPERT' } as AuthPrincipal,
            now,
          ),
        );
      } catch (error) {
        if (!(error instanceof AuthError && error.status === 403)) throw error;
        outputScopes.set(scope.userId, null);
      }
    }
    const access = outputScopes.get(scope.userId);
    for (const report of reports) {
      if (
        report.reviewStatus === 'PENDING' &&
        access?.reviewer &&
        scope.orgIds.has(report.member.organizationId ?? '') &&
        access.organizationIds?.includes(report.member.organizationId ?? '')
      )
        add(scope, 'OUTPUT_DATA_REVIEW', 'OUTPUT_REPORT', report.id, report.createdAt);
      // 保留新后端既有修正节点契约；任务类型仍为 OUTPUT_REPORT_CORRECTION。
      if (
        report.reviewStatus === 'RETURNED' &&
        access?.correctionIds.includes(report.memberId) &&
        (!scope.orgIds.size || scope.orgIds.has(report.member.organizationId ?? ''))
      )
        add(
          scope,
          'PRODUCTION_TASK',
          'OUTPUT_REPORT',
          report.id,
          report.returnedAt ?? report.createdAt,
        );
    }
    if (scope.perspective === 'EXPERT_PROJECT_OWNER')
      for (const m of members)
        if (
          scope.orgIds.has(m.organizationId ?? '') &&
          ['PENDING_CONFIRM', 'PENDING_ENTRY'].includes(m.status) &&
          m.entryDecision === null &&
          !m.plannedEntryDate &&
          qualifiedForEntry(m, needExam)
        )
          add(scope, 'MEMBER_ENTRY_CONFIRM', 'PROJECT_MEMBER', m.id, m.admittedAt ?? m.createdAt);
    if (scope.perspective === 'EXPERT_ORG_OWNER') continue;
    const m = latest.get(scope.userId);
    if (scope.perspective !== 'EXPERT_PROJECT_OWNER' && m) {
      if (
        qualifiedForEntry(m, needExam) &&
        ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(m.status) &&
        m.joinedAt &&
        m.joinedAt <= now &&
        !m.leftAt &&
        m.entryDecision !== 'NO'
      )
        add(
          scope,
          m.standardTrainingConfirmedAt ? 'PRODUCTION_TASK' : 'STANDARD_TRAINING',
          'PROJECT_MEMBER',
          m.id,
          m.standardTrainingConfirmedAt ?? m.joinedAt,
        );
      continue;
    }
    if (!needExam) continue;
    const exam = await ordinaryExamTask(tx, projectId, scope.userId, now);
    if (exam) add(scope, 'ENTRANCE_EXAM', 'ENTRANCE_EXAM', exam.examId, exam.sourceEventAt);
  }
  return result;
}
