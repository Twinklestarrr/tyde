import type { Prisma, Project, ProjectTaskRound } from '@prisma/client';
import {
  type TaskRecipient,
  type TaskScope,
  type TaskSnapshot,
  type TaskSource,
} from './project-task.types.js';

export const managementTaskTypes = [
  'MAIN_RECRUIT_PROJECT_MANAGER',
  'MAIN_PRODUCTION_PLAN',
  'MAIN_ENTRANCE_EXAM',
  'MAIN_STANDARD_TRAINING',
  'MAIN_RECRUIT_EXECUTION_EXPERT',
];

const managerMain = new Set([
  'PRODUCTION_PLAN',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
  'RECRUIT_EXECUTION_EXPERT',
]);

const recipientKey = (r: TaskRecipient) => JSON.stringify([r.userId, r.role]);

const taskKey = (r: { userId: string; role: string; taskType: string }) =>
  JSON.stringify([r.userId, r.role, r.taskType]);

const scopeKey = (s: TaskScope) =>
  JSON.stringify([
    s.userId,
    s.role,
    s.perspective,
    s.currentNodeCode,
    s.mainEligible,
    s.boardVisible,
  ]);

const retains = (snapshot: TaskSnapshot, r: { userId: string; role: string }) =>
  snapshot.scopes.some((s) => s.userId === r.userId && s.role === r.role);

// 本批仅采集管理主线真值；后续支线采集器接入前，不取消未采集的支线轮次。
export async function collectManagementTasks(
  tx: Prisma.TransactionClient,
  project: Project,
): Promise<TaskSnapshot> {
  if (project.deleted || project.status !== 'PUBLISHED') return { scopes: [], sources: [] };
  const creator = await tx.user.findUnique({
    where: { uid: project.createdBy },
    select: { id: true },
  });
  const assigned = await tx.projectManagerRecruitment.findFirst({
    where: { projectId: project.id, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const ids = [
    creator?.id,
    assigned?.candidateUserId,
    assigned?.expertRecruitmentHandlerUserId,
  ].filter((id): id is string => Boolean(id));
  const activeUsers = await tx.user.findMany({
    where: { id: { in: ids }, status: 'ACTIVE' },
    select: { id: true },
  });
  const activeIds = new Set(activeUsers.map((u) => u.id));
  const currentNodeCode =
    project.currentNodeCode ?? (assigned ? 'PRODUCTION_PLAN' : 'RECRUIT_PROJECT_MANAGER');
  const scopes: TaskScope[] = [];
  const add = (
    userId: string | null | undefined,
    role: 'NAVIGATOR' | 'PM',
    perspective: string,
  ) => {
    if (userId && activeIds.has(userId))
      scopes.push({
        userId,
        role,
        perspective,
        currentNodeCode,
        mainEligible: true,
        boardVisible: true,
      });
  };
  add(creator?.id, 'NAVIGATOR', 'NAVIGATOR');
  add(assigned?.candidateUserId, 'PM', 'PROJECT_MANAGER');
  add(assigned?.expertRecruitmentHandlerUserId, 'PM', 'EXPERT_RECRUITMENT_HANDLER');
  const sources = new Map<string, TaskSource>();
  for (const scope of scopes) {
    const eligible =
      scope.perspective === 'NAVIGATOR'
        ? currentNodeCode === 'RECRUIT_PROJECT_MANAGER'
        : scope.perspective === 'PROJECT_MANAGER'
          ? managerMain.has(currentNodeCode)
          : currentNodeCode === 'RECRUIT_EXECUTION_EXPERT';
    if (!eligible || currentNodeCode === 'COMPLETED') continue;
    const source = {
      userId: scope.userId,
      role: scope.role,
      taskType: `MAIN_${currentNodeCode}`,
      sources: [`PROJECT:${project.id}`],
    };
    sources.set(taskKey(source), source);
  }
  return { scopes, sources: [...sources.values()] };
}

// 调用方必须已锁项目；源变化、轮次和业务写入共用同一事务。
export async function reconcileTaskRounds(
  tx: Prisma.TransactionClient,
  projectId: number,
  before: TaskSnapshot,
  after: TaskSnapshot,
  actor: TaskRecipient | null,
  completedTypes: string[],
  completedWithoutSourceTypes: string[],
  trackedTypes: string[],
  now = new Date(),
) {
  const open = new Map<string, ProjectTaskRound>();
  for (const round of await tx.projectTaskRound.findMany({
    where: { projectId, status: 'OPEN', taskType: { in: trackedTypes } },
  }))
    open.set(taskKey(round), round);
  const previous = new Map(before.sources.map((s) => [taskKey(s), s]));
  const remaining = new Map(after.sources.map((s) => [taskKey(s), s]));
  const create = (source: { userId: string; role: string; taskType: string }) =>
    tx.projectTaskRound.create({
      data: {
        projectId,
        userId: source.userId,
        role: source.role,
        taskType: source.taskType,
        status: 'OPEN',
        participated: false,
        openedAt: now,
      },
    });
  for (const [key, source] of previous) {
    if (!open.has(key)) open.set(key, await create(source));
  }
  if (actor)
    for (const taskType of completedWithoutSourceTypes) {
      const source = { ...actor, taskType },
        key = taskKey(source);
      if (!open.has(key) && !remaining.has(key) && retains(after, actor))
        open.set(key, await create(source));
    }
  for (const [key, round] of open) {
    const prev = new Set(previous.get(key)?.sources ?? []),
      next = new Set(remaining.get(key)?.sources ?? []);
    const actorCompleted =
      completedTypes.includes(round.taskType) &&
      actor?.userId === round.userId &&
      actor.role === round.role;
    const processed =
      completedTypes.includes(round.taskType) && [...prev].some((source) => !next.has(source));
    const sourceLess =
      actorCompleted &&
      completedWithoutSourceTypes.includes(round.taskType) &&
      prev.size === 0 &&
      next.size === 0;
    const participated = round.participated || ((processed || sourceLess) && actorCompleted);
    let status = round.status;
    if (!retains(after, round) || (prev.size === 0 && !sourceLess)) status = 'CANCELLED';
    else if (next.size === 0)
      status = (processed || sourceLess) && participated ? 'COMPLETED' : 'CANCELLED';
    const updated = await tx.projectTaskRound.update({
      where: { id: round.id },
      data: { participated, status, finishedAt: status === 'OPEN' ? null : now },
    });
    open.set(key, updated);
  }
  for (const [key, source] of remaining)
    if (!open.has(key) || open.get(key)!.status !== 'OPEN') await create(source);
}

export function taskEventFacts(before: TaskSnapshot, after: TaskSnapshot) {
  const audience = new Map<string, TaskRecipient>(),
    changed = new Map<string, TaskRecipient>();
  for (const scope of [...before.scopes, ...after.scopes])
    audience.set(recipientKey(scope), { userId: scope.userId, role: scope.role });
  const prev = new Map(before.sources.map((s) => [taskKey(s), s])),
    next = new Map(after.sources.map((s) => [taskKey(s), s]));
  for (const key of new Set([...prev.keys(), ...next.keys()])) {
    const a = prev.get(key),
      b = next.get(key);
    if (
      Boolean(a) !== Boolean(b) ||
      JSON.stringify([...(a?.sources ?? [])].sort()) !==
        JSON.stringify([...(b?.sources ?? [])].sort())
    ) {
      const source = a ?? b!;
      changed.set(recipientKey(source), { userId: source.userId, role: source.role });
    }
  }
  const prevScopes = new Set(before.scopes.map(scopeKey)),
    nextScopes = new Set(after.scopes.map(scopeKey));
  for (const scope of [...before.scopes, ...after.scopes])
    if (!prevScopes.has(scopeKey(scope)) || !nextScopes.has(scopeKey(scope)))
      changed.set(recipientKey(scope), { userId: scope.userId, role: scope.role });
  return { projectAudience: [...audience.values()], taskChangedRecipients: [...changed.values()] };
}
