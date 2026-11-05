import type { Prisma } from '@prisma/client';
import { refreshManagementCardSnapshots } from './project-management-card-snapshot.js';
import { type TaskSnapshot } from './project-task.types.js';

// 13统一管理卡片仲裁；轮次仍由调用方按本次真实业务动作结算。
export async function syncRecruitmentRetrySnapshot(
  tx: Prisma.TransactionClient,
  projectId: number,
  _snapshot: TaskSnapshot,
) {
  return refreshManagementCardSnapshots(tx, projectId);
}
