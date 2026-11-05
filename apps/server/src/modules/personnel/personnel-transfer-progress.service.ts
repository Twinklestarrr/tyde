import { Prisma } from '@prisma/client';
import { refreshOwnerProgress } from '../expert/expert-progress.service.js';
import { reconcileTaskRounds } from '../projects/project-task-rounds.js';
import { syncSnapshots } from './personnel-movement-progress.service.js';
import { movementTasks } from './personnel-movement.repository.js';
import { type Transfer } from './personnel-transfer.types.js';

export async function changeWithProgress<T>(
  tx: Prisma.TransactionClient,
  m: Transfer,
  now: Date,
  operation: string,
  actor: string | undefined,
  work: () => Promise<T>,
) {
  const ids = [
    ...new Set([m.sourceProjectId, ...(m.targetProjectId ? [m.targetProjectId] : [])]),
  ].sort((a, b) => a - b);
  const before = await Promise.all(ids.map((id) => movementTasks(tx, id)));
  const result = await work();
  for (const [i, id] of ids.entries()) {
    const after = await movementTasks(tx, id);
    await reconcileTaskRounds(
      tx,
      id,
      before[i]!,
      after,
      null,
      [],
      [],
      ['MEMBER_MOVEMENT_APPROVAL'],
      now,
    );
    // 流程推进可能打开目标考试，也可能恢复/撤销本人来源；独立轮次不能只随卡片更新。
    // 交接和撤回不计完成；保留另一项目仍有效的培训/考试来源及历史轮次。
    await refreshOwnerProgress(tx, id, [m.userId], now);
    const cards = await syncSnapshots(tx, id, after, now);
    await tx.projectEventOutbox.create({
      data: {
        projectId: id,
        eventType: 'PROJECT_MEMBER_MOVEMENTS_CHANGED',
        operation,
        actorUserId: actor,
        payload: {
          schemaVersion: 1,
          ...cards,
          movementIds: [m.id],
          sourceProjectId: m.sourceProjectId,
          targetProjectId: m.targetProjectId,
          affectedUserIds: [m.userId],
          deliveryStatus: 'NOT_DELIVERED',
        },
      },
    });
  }
  return result;
}
