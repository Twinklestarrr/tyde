import type { PrismaClient } from '@prisma/client';
import { applyMovement } from './personnel-movement-apply.service.js';
import { changeWithProgress } from './personnel-transfer-progress.service.js';
import { lockTransfer } from './personnel-transfer.repository.js';
import { todayText } from './personnel.domain.js';

export async function processDueMovements(db: PrismaClient, now = new Date()) {
  let effective = 0,
    skipped = 0,
    failed = 0,
    cursor = 0;
  while (true) {
    const rows = await db.projectMemberMovement.findMany({
      where: {
        id: { gt: cursor },
        status: 'WAITING_EFFECTIVE',
        plannedEffectiveDate: { lte: new Date(todayText(now)) },
      },
      orderBy: { id: 'asc' },
      take: 200,
      select: { id: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      try {
        const changed = await db.$transaction(
          async (tx) => {
            const m = await lockTransfer(tx, row.id);
            if (
              m.status !== 'WAITING_EFFECTIVE' ||
              m.plannedEffectiveDate.toISOString().slice(0, 10) > todayText(now)
            )
              return false;
            return changeWithProgress(tx, m, now, 'PROCESS_DUE_MOVEMENT', undefined, () =>
              applyMovement(tx, m, now),
            );
          },
          { timeout: 30_000 },
        );
        if (changed) effective++;
        else skipped++;
      } catch {
        failed++;
      }
    }
    if (rows.length < 200) break;
  }
  return { effective, skipped, failed };
}
