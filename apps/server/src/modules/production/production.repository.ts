import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { type TaskSnapshot } from '../projects/project-task.types.js';

export const published = async (tx: Prisma.TransactionClient, projectId: number) => {
  const project = await tx.project.findFirst({
    where: { id: projectId, deleted: false, status: 'PUBLISHED' },
  });
  if (!project) throw new AppError(404, 'NOT_FOUND', '已发布项目不存在');
  return project;
};

// 本批只采集首次创建支线；验收和报量来源随后接入，不取消其他领域轮次。
export async function creationTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const project = await published(tx, projectId);
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  if (!manager || project.currentNodeCode === 'COMPLETED') return { scopes: [], sources: [] };
  const scope = {
    userId: manager.candidateUserId,
    role: 'PM' as const,
    perspective: 'PROJECT_MANAGER',
    currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_TASK',
    mainEligible: false,
    boardVisible: true,
  };
  const count = await tx.projectSubtask.count({ where: { projectId } });
  return {
    scopes: [scope],
    sources:
      count || project.currentNodeCode !== 'PRODUCTION_TASK'
        ? []
        : [{ ...scope, taskType: 'SUBTASK_CREATE', sources: [`PROJECT:${projectId}`] }],
  };
}
