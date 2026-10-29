import { refreshManagementCardSnapshots } from '../projects/project-management-card-snapshot.js';
import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import type { Prisma } from '@prisma/client';
import type { TaskSnapshot, TaskSource, TaskScope } from '../projects/project-task-rounds.js';

export const gradingTaskTypes = ['ENTRANCE_EXAM_GRADING', 'ENTRANCE_EXAM_GRADING_RETRY'];
export function reviewerIds(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.flatMap((item) =>
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.userId === 'string'
              ? [item.userId]
              : [],
          ),
        ),
      ]
    : [];
}
// 历史版本、关闭考试的已交卷轮次继续有效；WAITING 不产生待办。
export async function collectGradingTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const records = await tx.entranceExamGradingRecord.findMany({
    where: {
      status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      attempt: { submittedAt: { not: null }, exam: { projectId, deleted: false } },
    },
    include: { gradingRound: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const assigned = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const ids = [...new Set(records.flatMap((r) => reviewerIds(r.gradingRound.reviewersJson)))];
  if (assigned) ids.push(assigned.candidateUserId);
  const active = new Set(
    (
      await tx.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } })
    ).map((u) => u.id),
  );
  const sources = new Map<string, TaskSource>();
  const scopes = new Map<string, TaskScope>();
  const add = (userId: string, role: 'NAVIGATOR' | 'PM', taskType?: string, recordId?: number) => {
    if (!active.has(userId)) return;
    scopes.set(`${role}:${userId}`, {
      userId,
      role,
      perspective: role === 'PM' ? 'PROJECT_MANAGER' : 'NAVIGATOR',
      currentNodeCode: 'ENTRANCE_EXAM',
      mainEligible: false,
      boardVisible: true,
    });
    if (!taskType) return;
    const key = `${role}:${userId}:${taskType}`;
    const source = sources.get(key) ?? { userId, role, taskType, sources: [] };
    source.sources.push(`GRADING_RECORD:${recordId}`);
    sources.set(key, source);
  };
  // 所有历史人工池人员保留作用域，使被他人完成的轮次正确结算而不是误判离开项目。
  const rounds = await tx.entranceExamGradingRound.findMany({
    where: { gradingMode: 'MANUAL', version: { exam: { projectId, deleted: false } } },
  });
  const allIds = [...new Set(rounds.flatMap((r) => reviewerIds(r.reviewersJson)))];
  const allActive = await tx.user.findMany({
    where: { id: { in: allIds }, status: 'ACTIVE' },
    select: { id: true },
  });
  allActive.forEach((u) => active.add(u.id));
  for (const id of allIds) for (const role of ['NAVIGATOR', 'PM'] as const) add(id, role);
  if (assigned) add(assigned.candidateUserId, 'PM');
  for (const r of records) {
    if (r.gradingRound.gradingMode === 'MANUAL' && ['PENDING', 'PROCESSING'].includes(r.status))
      for (const id of reviewerIds(r.gradingRound.reviewersJson))
        for (const role of ['NAVIGATOR', 'PM'] as const)
          add(id, role, 'ENTRANCE_EXAM_GRADING', r.id);
    if (r.gradingRound.gradingMode === 'AUTO' && r.status === 'FAILED' && assigned)
      add(assigned.candidateUserId, 'PM', 'ENTRANCE_EXAM_GRADING_RETRY', r.id);
  }
  return { scopes: [...scopes.values()], sources: [...sources.values()] };
}

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
