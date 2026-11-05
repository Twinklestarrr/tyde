import { Prisma } from '@prisma/client';
import { type TaskSnapshot } from '../projects/project-task.types.js';
import { acceptanceTypes } from './acceptance.domain.js';

export async function acceptanceTotals(
  tx: Prisma.TransactionClient,
  projectId: number,
  subtaskId: number,
) {
  const groups = await tx.projectOutputReport.groupBy({
    by: ['reviewStatus'],
    where: { projectId, subtaskId },
    _count: { _all: true },
    _sum: { quantity: true },
  });
  const count = (s: string) => groups.find((g) => g.reviewStatus === s)?._count._all ?? 0;
  return {
    verified: count('VERIFIED'),
    pending: count('PENDING'),
    returned: count('RETURNED'),
    quantity:
      groups.find((g) => g.reviewStatus === 'VERIFIED')?._sum.quantity ?? new Prisma.Decimal(0),
  };
}

export async function acceptanceTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.deleted || project.currentNodeCode === 'COMPLETED') return snapshot;
  const creator = await tx.user.findUnique({ where: { uid: project.createdBy } });
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    include: { candidate: true },
  });
  const tasks = await tx.projectSubtask.findMany({
    where: { projectId, status: { in: ['PENDING_ACCEPTANCE', 'REWORK_REQUIRED'] } },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
  });
  for (const identity of [
    creator?.status === 'ACTIVE'
      ? { userId: creator.id, role: 'NAVIGATOR' as const, perspective: 'NAVIGATOR' }
      : null,
    manager?.candidate.status === 'ACTIVE'
      ? { userId: manager.candidateUserId, role: 'PM' as const, perspective: 'PROJECT_MANAGER' }
      : null,
  ]) {
    if (!identity) continue;
    snapshot.scopes.push({
      ...identity,
      currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_TASK',
      mainEligible: false,
      boardVisible: true,
    });
    for (const taskType of acceptanceTypes) {
      const sources = tasks
        .filter((t) =>
          identity.role === 'PM'
            ? taskType === 'SUBTASK_REWORK_SUBMIT' && t.status === 'REWORK_REQUIRED'
            : t.status === 'PENDING_ACCEPTANCE' &&
              taskType === (t.acceptanceRound > 1 ? 'SUBTASK_REWORK_REVIEW' : 'SUBTASK_ACCEPTANCE'),
        )
        .map((t) => `SUBTASK:${t.id}`);
      if (sources.length) snapshot.sources.push({ ...identity, taskType, sources });
    }
  }
  return snapshot;
}
