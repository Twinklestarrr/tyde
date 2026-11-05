import type { Prisma } from '@prisma/client';
import { refreshOwnerProgress } from '../expert/expert-progress.service.js';
import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import type { TaskSnapshot } from '../projects/project-task.types.js';

// 阅卷结果可能改变其他领域的候选（例如准入产生入项待办），统一重新仲裁。
export async function refreshGradingSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  _snapshot: TaskSnapshot,
  now: Date,
) {
  // 先同步全部真实独立来源；阅卷卡片优先级不能代替考试/培训轮次。
  await refreshOwnerProgress(tx, projectId, null, now);
  return refreshManagementCardSnapshots(tx, projectId, now);
}
