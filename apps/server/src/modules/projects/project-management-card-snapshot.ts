import type { Prisma } from '@prisma/client';
import {
  collectExpertCardCandidates,
  expertCardPerspectives,
} from './project-expert-card-candidates.js';
import { collectRecruitmentTasks } from './project-recruitment-snapshot.js';
import { collectGradingTasks } from '../entrance-exams/exam-grading-tasks.js';
import { entryTasks } from '../personnel/personnel-progress.js';
import { outputTasks } from '../production/output-report-progress.js';
import { acceptanceTasks } from '../production/acceptance.service.js';
import { creationTasks } from '../production/production.service.js';
import { currentApprovers, transferInclude } from '../personnel/personnel-transfer.js';
import type { TaskRecipient, TaskSnapshot } from './project-task-rounds.js';

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
type Branch = keyof typeof managementBranchPriority;
export interface ManagementBranchCandidate {
  userId: string;
  perspective: string;
  branchNodeCode: Branch;
  sourceBizType: string;
  sourceBizId: number;
  sourceEventAt: Date;
}
const key = (r: { userId: string; perspective: string }) =>
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

type CardState = {
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

// 统一管理 NAV/PM 与 EXPERT 多组织管理、个人履约视角。
// 调用方已持有项目锁，所有来源读取和快照落库共用业务事务。查询失败直接抛出，
// 不能把部分候选当成完整候选集，删除/覆盖正确的旧快照。
export async function refreshManagementCardSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  now = new Date(),
) {
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const existing = await tx.projectRoleNodeSnapshot.findMany({
    where: {
      projectId,
      perspective: {
        in: [
          'NAVIGATOR',
          'PROJECT_MANAGER',
          'EXPERT_RECRUITMENT_HANDLER',
          ...expertCardPerspectives,
        ],
      },
    },
  });
  const candidates: ManagementBranchCandidate[] = [];
  if (
    !project.deleted &&
    project.status === 'PUBLISHED' &&
    project.currentNodeCode !== 'COMPLETED'
  ) {
    const snapshots = await Promise.all([
      collectRecruitmentTasks(tx, project),
      collectGradingTasks(tx, projectId),
      entryTasks(tx, projectId),
      outputTasks(tx, projectId, now),
      acceptanceTasks(tx, projectId),
      creationTasks(tx, projectId),
    ]);
    candidates.push(...(await collectExpertCardCandidates(tx, projectId, now)));
    const movements = await tx.projectMemberMovement.findMany({
      where: {
        targetProjectId: projectId,
        status: 'PROCESSING',
        flow: { status: 'PENDING', currentNodeCode: 'TARGET_MANAGER' },
      },
      include: transferInclude,
    });
    // 审批受众按当前任职重新判定，不依赖未同步的历史 approverId。
    for (const movement of movements)
      for (const user of await currentApprovers(tx, movement, 'TARGET_MANAGER'))
        candidates.push({
          userId: user.id,
          perspective: 'PROJECT_MANAGER',
          branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
          sourceBizType: 'PROJECT_MEMBER_MOVEMENT',
          sourceBizId: movement.id,
          sourceEventAt: movement.createdAt,
        });

    const refs: {
      userId: string;
      perspective: string;
      branchNodeCode: Branch;
      type: string;
      id: number;
    }[] = [];
    for (const snapshot of snapshots)
      for (const source of snapshot.sources) {
        if (!(source.taskType in managementBranchPriority)) continue;
        for (const scope of sourceScopes(snapshot, source))
          for (const ref of source.sources) {
            const [type, id] = ref.split(':');
            refs.push({
              ...scope,
              branchNodeCode: source.taskType as Branch,
              type: type!,
              id: Number(id),
            });
          }
      }
    const ids = (type: string) => [
      ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
    ];
    const [assignments, records, members, reports, subtasks] = await Promise.all([
      tx.projectExpertAssignment.findMany({
        where: { projectId, id: { in: ids('EXPERT_ASSIGNMENT') } },
      }),
      tx.entranceExamGradingRecord.findMany({
        where: { id: { in: ids('GRADING_RECORD') }, attempt: { exam: { projectId } } },
      }),
      tx.projectMember.findMany({ where: { projectId, id: { in: ids('PROJECT_MEMBER') } } }),
      tx.projectOutputReport.findMany({ where: { projectId, id: { in: ids('OUTPUT_REPORT') } } }),
      tx.projectSubtask.findMany({ where: { projectId, id: { in: ids('SUBTASK') } } }),
    ]);
    for (const ref of refs) {
      let sourceEventAt: Date | null | undefined;
      if (ref.type === 'PROJECT') sourceEventAt = ref.id === projectId ? project.createdAt : null;
      if (ref.type === 'EXPERT_ASSIGNMENT') {
        const row = assignments.find((r) => r.id === ref.id);
        sourceEventAt = row?.rejectedAt ?? row?.createdAt;
      }
      if (ref.type === 'GRADING_RECORD')
        sourceEventAt = records.find((r) => r.id === ref.id)?.createdAt;
      if (ref.type === 'PROJECT_MEMBER') {
        const row = members.find((r) => r.id === ref.id);
        sourceEventAt = row?.admittedAt ?? row?.createdAt;
      }
      if (ref.type === 'OUTPUT_REPORT')
        sourceEventAt = reports.find((r) => r.id === ref.id)?.createdAt;
      if (ref.type === 'SUBTASK') {
        const row = subtasks.find((r) => r.id === ref.id);
        sourceEventAt =
          ref.branchNodeCode === 'SUBTASK_REWORK_SUBMIT' ? row?.reviewedAt : row?.submittedAt;
      }
      if (!sourceEventAt) throw new Error(`卡片候选缺少真实来源或业务时间：${ref.type}:${ref.id}`);
      candidates.push({ ...ref, sourceBizType: ref.type, sourceBizId: ref.id, sourceEventAt });
    }
  }
  // 统一账号的会话角色不参与候选过滤；仅账号被停用时撤销其所有管理快照。
  const active = new Set(
    (
      await tx.user.findMany({
        where: { id: { in: [...new Set(candidates.map((r) => r.userId))] }, status: 'ACTIVE' },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const winners = managementBranchWinners(candidates.filter((r) => active.has(r.userId)));
  // 在完整采集成功后才写入；失权、终态和最后一个来源消失均清除旧快照。
  for (const old of existing)
    if (!winners.has(key(old)))
      await tx.projectRoleNodeSnapshot.deleteMany({ where: { id: old.id } });
  for (const winner of winners.values()) {
    const { userId, perspective, branchNodeCode, sourceBizType, sourceBizId, sourceEventAt } =
      winner;
    const data = {
      branchNodeCode,
      branchPriority: managementBranchPriority[branchNodeCode],
      sourceBizType,
      sourceBizId,
      sourceEventAt,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where: { projectId_userId_perspective: { projectId, userId, perspective } },
      create: { projectId, userId, perspective, ...data },
      update: data,
    });
  }
  return managementCardChanges(existing, [...winners.values()]);
}

function sourceScopes(snapshot: TaskSnapshot, source: TaskSnapshot['sources'][number]) {
  const scopes = snapshot.scopes.filter(
    (s) => s.role !== 'EXPERT' && s.userId === source.userId && s.role === source.role,
  );
  // 负责人兼任招募协作时，补招只落主策略官视角；协作人不获得其他 PM 支线。
  return scopes.filter(
    (s) =>
      s.perspective !== 'EXPERT_RECRUITMENT_HANDLER' ||
      (source.taskType === 'EXPERT_RECRUITMENT_RETRY' &&
        !scopes.some((r) => r.perspective === 'PROJECT_MANAGER')),
  );
}
