import { Prisma } from '@prisma/client';
import { type TaskSnapshot } from '../projects/project-task.types.js';

export async function syncSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  _snapshot: TaskSnapshot,
  now: Date,
) {
  // 保留原有延迟加载时机，统一仲裁仍沿用调用方事务。
  const { refreshManagementCardSnapshots } =
    await import('../projects/project-management-card-snapshot.js');
  const { refreshOwnerProgress } = await import('../expert/expert-progress.service.js');
  await refreshOwnerProgress(tx, projectId, null, now);
  return refreshManagementCardSnapshots(tx, projectId, now);
}
