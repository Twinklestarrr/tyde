import { expertCardPerspectives } from '../expert/expert-card.domain.js';
import type { TaskRecipient } from './project-task.types.js';

// 与旧 ProjectBranchNode 一致；轮次保留全部任务，卡片只展示竞争胜者。
export const managementBranchPriority = {
  MEMBER_MOVEMENT_APPROVAL: 100,
  ENTRANCE_EXAM_GRADING_RETRY: 95,
  EXPERT_RECRUITMENT_RETRY: 90,
  SUBTASK_REWORK_REVIEW: 90,
  SUBTASK_REWORK_SUBMIT: 85,
  SUBTASK_ACCEPTANCE: 80,
  ENTRANCE_EXAM_GRADING: 75,
  OUTPUT_DATA_REVIEW: 70,
  SUBTASK_CREATE: 65,
  MEMBER_ENTRY_CONFIRM: 60,
  ENTRANCE_EXAM: 10,
  STANDARD_TRAINING: 10,
  PRODUCTION_TASK: 10,
} as const;

export type Branch = keyof typeof managementBranchPriority;

export interface ManagementBranchCandidate {
  userId: string;
  perspective: string;
  branchNodeCode: Branch;
  sourceBizType: string;
  sourceBizId: number;
  sourceEventAt: Date;
}

export const key = (r: { userId: string; perspective: string }) =>
  JSON.stringify([r.userId, r.perspective]);

export function managementBranchWinners(candidates: ManagementBranchCandidate[]) {
  const winners = new Map<string, ManagementBranchCandidate>();
  const compare = (a: ManagementBranchCandidate, b: ManagementBranchCandidate) =>
    managementBranchPriority[b.branchNodeCode] - managementBranchPriority[a.branchNodeCode] ||
    a.sourceEventAt.getTime() - b.sourceEventAt.getTime() ||
    a.sourceBizId - b.sourceBizId ||
    a.branchNodeCode.localeCompare(b.branchNodeCode);
  for (const candidate of candidates) {
    const old = winners.get(key(candidate));
    if (!old || compare(candidate, old) < 0) winners.set(key(candidate), candidate);
  }
  return winners;
}

export type CardState = {
  userId: string;
  perspective: string;
  branchNodeCode: string;
  sourceBizType: string | null;
  sourceBizId: number | null;
  sourceEventAt: Date;
};

// calculatedAt 只是重算时间；只有可见节点或来源发生变化才通知卡片受众。
export function managementCardChanges(before: CardState[], after: CardState[]) {
  const previous = new Map(before.map((r) => [key(r), r]));
  const next = new Map(after.map((r) => [key(r), r]));
  const recipients = new Map<string, TaskRecipient>();
  const signature = (r: CardState | undefined) =>
    r &&
    JSON.stringify([r.branchNodeCode, r.sourceBizType, r.sourceBizId, r.sourceEventAt.getTime()]);
  for (const k of new Set([...previous.keys(), ...next.keys()])) {
    if (signature(previous.get(k)) === signature(next.get(k))) continue;
    const r = next.get(k) ?? previous.get(k)!;
    const role =
      r.perspective === 'NAVIGATOR'
        ? 'NAVIGATOR'
        : expertCardPerspectives.includes(r.perspective)
          ? 'EXPERT'
          : 'PM';
    recipients.set(JSON.stringify([r.userId, role]), { userId: r.userId, role });
  }
  return { cardChangedRecipients: [...recipients.values()] };
}
