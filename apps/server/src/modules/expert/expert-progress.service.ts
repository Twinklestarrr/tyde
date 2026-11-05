import { Prisma } from '@prisma/client';
import { collectExpertCardCandidates } from '../projects/project-expert-card-candidates.js';

// 只同步本域考试/培训轮次，不把交接计为完成；调用方在全部更新后统一仲裁卡片。
export async function refreshOwnerProgress(
  tx: Prisma.TransactionClient,
  projectId: number,
  ids: string[] | null,
  now: Date,
) {
  if (ids?.length === 0) return;
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const types = ['ENTRANCE_EXAM', 'STANDARD_TRAINING'];
  // 收集全部真实来源，不能因报量核查/入项等卡片胜者遮挡而取消独立轮次。
  const candidates =
    !project.deleted && project.status === 'PUBLISHED' && project.currentNodeCode !== 'COMPLETED'
      ? await collectExpertCardCandidates(tx, projectId, now)
      : [];
  // 配置变更影响全项目：兼顾新增来源和仅剩旧 OPEN 轮次的失效用户。
  if (ids === null) {
    const open = await tx.projectTaskRound.findMany({
      where: { projectId, role: 'EXPERT', status: 'OPEN', taskType: { in: types } },
      select: { userId: true },
    });
    ids = [
      ...new Set([
        ...candidates.filter((c) => types.includes(c.branchNodeCode)).map((c) => c.userId),
        ...open.map((r) => r.userId),
      ]),
    ];
  }
  if (!ids.length) return;
  const active = new Set(
    (
      await tx.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } })
    ).map((u) => u.id),
  );
  for (const userId of new Set(ids)) {
    const sources = new Set<string>(
      candidates.flatMap((c) =>
        active.has(userId) && c.userId === userId && types.includes(c.branchNodeCode)
          ? [c.branchNodeCode]
          : [],
      ),
    );
    const open = await tx.projectTaskRound.findMany({
      where: { projectId, userId, role: 'EXPERT', status: 'OPEN', taskType: { in: types } },
    });
    for (const round of open)
      if (!sources.has(round.taskType))
        await tx.projectTaskRound.update({
          where: { id: round.id },
          data: { status: 'CANCELLED', finishedAt: now },
        });
    for (const taskType of sources)
      if (!open.some((r) => r.taskType === taskType))
        await tx.projectTaskRound.create({
          data: { projectId, userId, role: 'EXPERT', taskType, openedAt: now },
        });
  }
}
