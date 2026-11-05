import type { Prisma } from '@prisma/client';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import type { TaskSnapshot } from '../projects/project-task.types.js';

export async function syncEntrySnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  before: TaskSnapshot,
  after: TaskSnapshot,
  now: Date,
) {
  // 旧轮次参数保留调用契约；卡片在完整真实来源上统一仲裁。
  void before;
  void after;
  return refreshManagementCardSnapshots(tx, projectId, now);
}
