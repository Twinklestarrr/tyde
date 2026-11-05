import type { Prisma } from '@prisma/client';
import { refreshOwnerProgress } from '../expert/expert-progress.service.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import type { TaskSnapshot } from '../projects/project-task.types.js';

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
