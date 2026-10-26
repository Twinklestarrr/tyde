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
  for (const scope of [...before.scopes, ...after.scopes]) {
    const where = {
      projectId_userId_perspective: {
        projectId,
        userId: scope.userId,
        perspective: scope.perspective,
      },
    };
    const old = await tx.projectRoleNodeSnapshot.findUnique({ where });
    // 轮次类型与卡片节点是两套契约；修正报量属于个人生产履约节点。
    const ownsSnapshot =
      old?.sourceBizType === 'OUTPUT_REPORT' &&
      ['OUTPUT_DATA_REVIEW', 'PRODUCTION_TASK'].includes(old.branchNodeCode);
    const source = after.sources
      .filter((s) => s.userId === scope.userId && s.role === scope.role)
      .sort(
        (a, b) =>
          Number(b.taskType === 'OUTPUT_REPORT_CORRECTION') -
          Number(a.taskType === 'OUTPUT_REPORT_CORRECTION'),
      )[0];
    if (!source) {
      if (old && ownsSnapshot) await tx.projectRoleNodeSnapshot.delete({ where });
      continue;
    }
    const correction = source.taskType === 'OUTPUT_REPORT_CORRECTION';
    const priority = correction ? 10 : 70;
    if (old && !ownsSnapshot && old.branchPriority >= priority) continue;
    const reportId = Number(source.sources[0]!.split(':')[1]);
    const report = await tx.projectOutputReport.findUniqueOrThrow({ where: { id: reportId } });
    const data = {
      branchNodeCode: correction ? 'PRODUCTION_TASK' : 'OUTPUT_DATA_REVIEW',
      branchPriority: priority,
      sourceBizType: 'OUTPUT_REPORT',
      sourceBizId: reportId,
      sourceEventAt: report.updatedAt,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where,
      create: { projectId, userId: scope.userId, perspective: scope.perspective, ...data },
      update: data,
    });
  }
}
