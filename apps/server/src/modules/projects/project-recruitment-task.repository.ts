import type { Prisma, Project } from '@prisma/client';
import { collectManagementTasks } from './project-task-rounds.js';

// 06下发与07拒单共用来源，拒单只改变补招支线，不回退项目主线。
export async function collectRecruitmentTasks(tx: Prisma.TransactionClient, project: Project) {
  const snapshot = await collectManagementTasks(tx, project);
  if (project.currentNodeCode === 'COMPLETED') return snapshot;
  const relation = await tx.projectManagerRecruitment.findFirst({
    where: { projectId: project.id, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const userId = relation?.expertRecruitmentHandlerUserId ?? relation?.candidateUserId;
  if (!userId || !snapshot.scopes.some((s) => s.userId === userId && s.role === 'PM'))
    return snapshot;
  const rejected = await tx.projectExpertAssignment.findMany({
    where: { projectId: project.id, status: 'REJECTED', replacements: { none: {} } },
    select: { id: true },
  });
  if (rejected.length)
    snapshot.sources.push({
      userId,
      role: 'PM',
      taskType: 'EXPERT_RECRUITMENT_RETRY',
      sources: rejected.map((a) => `EXPERT_ASSIGNMENT:${a.id}`),
    });
  return snapshot;
}
