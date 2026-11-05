import type { Prisma, PrismaClient, UserOrgRel } from '@prisma/client';
import { businessDate } from './member.domain.js';
import { lockOrganization } from './organization.repository.js';
export const shanghaiDay = (now: Date) =>
  new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

// 与LEFT状态写入同事务持久化；项目处理器未迁移前不把此记录标成已完成。
export function recordDeparture(tx: Prisma.TransactionClient, rel: UserOrgRel, effectiveAt: Date) {
  return tx.organizationDeparture.upsert({
    where: { memberId_memberVersion: { memberId: rel.id, memberVersion: rel.versionNo } },
    create: {
      memberId: rel.id,
      memberVersion: rel.versionNo,
      orgId: rel.orgId,
      userId: rel.userId,
      effectiveAt,
    },
    update: {},
  });
}
export class DepartureService {
  constructor(readonly db: PrismaClient) {}
  async processDue(now = new Date(), batchSize = 200) {
    const today = shanghaiDay(now);
    let cursor: string | undefined;
    let processed = 0,
      failed = 0;
    while (true) {
      const candidates = await this.db.userOrgRel.findMany({
        where: {
          joinStatus: 'PENDING_LEAVE',
          plannedLeaveDate: { lte: new Date(`${today}T00:00:00Z`) },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (!candidates.length) break;
      for (const candidate of candidates) {
        try {
          processed += await this.db.$transaction(async (tx) => {
            await lockOrganization(tx, candidate.orgId);
            const rel = await tx.userOrgRel.findUnique({ where: { id: candidate.id } });
            if (
              !rel ||
              rel.joinStatus !== 'PENDING_LEAVE' ||
              !rel.plannedLeaveDate ||
              rel.plannedLeaveDate.toISOString().slice(0, 10) > today
            )
              return 0;
            const effectiveAt = businessDate(rel.plannedLeaveDate.toISOString().slice(0, 10), true);
            const ended = await tx.userOrgRel.update({
              where: { id: rel.id },
              data: {
                joinStatus: 'LEFT',
                leftAt: effectiveAt,
                versionNo: { increment: 1 },
                updatedBy: 'SYSTEM',
                updatedAt: now,
              },
            });
            await recordDeparture(tx, ended, effectiveAt);
            return 1;
          });
        } catch {
          failed++;
        }
        cursor = candidate.id;
      }
      if (candidates.length < batchSize) break;
    }
    return {
      processed,
      failed,
      pendingProjectCleanup: await this.db.organizationDeparture.count({
        where: { status: 'PENDING' },
      }),
    };
  }
}
