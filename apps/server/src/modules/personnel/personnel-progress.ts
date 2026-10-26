import type { Prisma } from '@prisma/client';
import type { TaskSnapshot } from '../projects/project-task-rounds.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { memberInclude, qualifiedForEntry } from './personnel-access.js';
// 只采集10负责的入项来源；不接管审批/转项支线。
export async function entryTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.deleted || project.currentNodeCode === 'COMPLETED') return snapshot;
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const plan = await tx.projectProductionPlan.findUnique({ where: { projectId } });
  const pending = await tx.projectMember.findMany({
    where: {
      projectId,
      status: { in: ['PENDING_CONFIRM', 'PENDING_ENTRY'] },
      entryDecision: null,
      plannedEntryDate: null,
    },
    include: memberInclude,
    orderBy: [{ admittedAt: 'asc' }, { id: 'asc' }],
  });
  const assignments = await tx.projectExpertAssignment.findMany({
    where: {
      projectId,
      subjectType: 'ORGANIZATION',
      status: 'ACCEPTED',
      organization: { deleted: false },
    },
    include: { owners: true },
  });
  const rels = await tx.userOrgRel.findMany({
    where: {
      orgId: { in: assignments.map((a) => a.organizationId!) },
      joinStatus: { in: participatingStatuses },
      user: { status: 'ACTIVE' },
    },
  });
  const add = (
    userId: string,
    role: 'PM' | 'EXPERT',
    perspective: string,
    organizationIds: string[] | null,
  ) => {
    if (snapshot.scopes.some((s) => s.userId === userId && s.role === role)) return;
    snapshot.scopes.push({
      userId,
      role,
      perspective,
      currentNodeCode: project.currentNodeCode ?? 'PERSONNEL_MANAGEMENT',
      mainEligible: false,
      boardVisible: true,
    });
    const sources = pending
      .filter(
        (m) =>
          (!organizationIds || (m.organizationId && organizationIds.includes(m.organizationId))) &&
          qualifiedForEntry(m, plan?.needWrittenExam ?? false),
      )
      .map((m) => `PROJECT_MEMBER:${m.id}`);
    if (sources.length)
      snapshot.sources.push({ userId, role, taskType: 'MEMBER_ENTRY_CONFIRM', sources });
  };
  if (manager) add(manager.candidateUserId, 'PM', 'PROJECT_MANAGER', null);
  const owners = new Map<string, string[]>();
  for (const a of assignments)
    for (const userId of a.owners.length
      ? a.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.userId)
      : a.projectOwnerUserId
        ? [a.projectOwnerUserId]
        : []) {
      if (!rels.some((r) => r.userId === userId && r.orgId === a.organizationId)) continue;
      owners.set(userId, [...(owners.get(userId) ?? []), a.organizationId!]);
    }
  for (const [userId, orgIds] of owners) add(userId, 'EXPERT', 'EXPERT_PROJECT_OWNER', orgIds);
  return snapshot;
}
export async function syncEntrySnapshots(
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
    if (old && old.branchNodeCode !== 'MEMBER_ENTRY_CONFIRM' && old.branchPriority >= 60) continue;
    const source = after.sources.find((s) => s.userId === scope.userId && s.role === scope.role)
      ?.sources[0];
    if (!source) {
      if (old) await tx.projectRoleNodeSnapshot.delete({ where });
      continue;
    }
    const id = Number(source.split(':')[1]);
    const member = await tx.projectMember.findUniqueOrThrow({ where: { id } });
    const data = {
      branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
      branchPriority: 60,
      sourceBizType: 'PROJECT_MEMBER',
      sourceBizId: id,
      sourceEventAt: member.admittedAt ?? member.createdAt,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where,
      create: { projectId, userId: scope.userId, perspective: scope.perspective, ...data },
      update: data,
    });
  }
}
