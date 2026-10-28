import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import type { Prisma } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { outputScope } from './output-report-access.js';
import type { TaskSnapshot } from '../projects/project-task-rounds.js';
// 仅采集报量核查和退回修正；跨域日常报量卡片由04统一采集。
export async function outputTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
  now: Date,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.deleted || project.currentNodeCode === 'COMPLETED') return snapshot;
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const reports = await tx.projectOutputReport.findMany({
    where: {
      projectId,
      reviewStatus: { in: ['PENDING', 'RETURNED'] },
      OR: [
        ...(project.currentNodeCode === 'PRODUCTION_TASK' ? [{ subtaskId: null }] : []),
        { subtask: { status: 'IN_PROGRESS' } },
      ],
    },
    include: { member: true },
  });
  const rels = await tx.userOrgRel.findMany({
    where: {
      organization: { expertAssignments: { some: { projectId, status: 'ACCEPTED' } } },
      user: { status: 'ACTIVE' },
    },
    include: { user: true },
  });
  const members = await tx.projectMember.findMany({
    where: { projectId },
    include: { user: true },
  });
  const candidates = new Map<string, { userId: string; uid: string; role: 'PM' | 'EXPERT' }>();
  for (const m of members)
    if (m.user.status === 'ACTIVE')
      candidates.set(m.userId, { userId: m.userId, uid: m.user.uid, role: 'EXPERT' });
  for (const r of rels)
    candidates.set(r.userId, { userId: r.userId, uid: r.user.uid, role: 'EXPERT' });
  const identities = [...candidates.values()];
  if (manager) {
    const user = await tx.user.findUnique({ where: { id: manager.candidateUserId } });
    if (user?.status === 'ACTIVE') identities.push({ userId: user.id, uid: user.uid, role: 'PM' });
  }
  for (const identity of identities) {
    let scope;
    try {
      scope = await outputScope(tx, projectId, identity as AuthPrincipal, now);
    } catch (error) {
      if (error instanceof AuthError && error.status === 403) continue;
      throw error;
    }
    const perspective =
      identity.role === 'PM'
        ? 'PROJECT_MANAGER'
        : scope.reviewer
          ? rels.some(
              (r) =>
                r.userId === identity.userId &&
                r.position === 'OWNER' &&
                scope.organizationIds?.includes(r.orgId),
            )
            ? 'EXPERT_ORG_OWNER'
            : 'EXPERT_PROJECT_OWNER'
          : scope.active.some((m) => m.userId === identity.userId && m.organizationId)
            ? 'EXPERT_MEMBER'
            : 'EXPERT_INDIVIDUAL';
    snapshot.scopes.push({
      ...identity,
      perspective,
      currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_TASK',
      mainEligible: false,
      boardVisible: true,
    });
    for (const taskType of ['OUTPUT_DATA_REVIEW', 'OUTPUT_REPORT_CORRECTION']) {
      const sources = reports
        .filter((r) =>
          taskType === 'OUTPUT_DATA_REVIEW'
            ? scope.reviewer &&
              r.reviewStatus === 'PENDING' &&
              (scope.memberIds === null ||
                scope.organizationIds?.includes(r.member.organizationId ?? ''))
            : r.reviewStatus === 'RETURNED' && scope.correctionIds.includes(r.memberId),
        )
        .map((r) => `OUTPUT_REPORT:${r.id}`);
      if (sources.length) snapshot.sources.push({ ...identity, taskType, sources });
    }
  }
  return snapshot;
}
export async function syncOutputSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  before: TaskSnapshot,
  after: TaskSnapshot,
  now: Date,
) {
  // 旧轮次参数保留调用契约；卡片在完整真实来源上统一仲裁。
  void before;
  void after;
  await refreshOwnerProgress(tx, projectId, null, now);
  return refreshManagementCardSnapshots(tx, projectId, now);
}
