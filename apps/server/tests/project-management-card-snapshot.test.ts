import { beforeEach, expect, test, vi } from 'vitest';
import {
  managementBranchWinners,
  managementCardChanges,
  refreshManagementCardSnapshots,
  type ManagementBranchCandidate,
} from '../src/modules/projects/project-management-card-snapshot.js';
import type { TaskSnapshot } from '../src/modules/projects/project-task-rounds.js';

const state = vi.hoisted(() => ({
  snapshots: {} as Record<string, TaskSnapshot>,
  experts: [] as ManagementBranchCandidate[],
}));
vi.mock('../src/modules/projects/project-expert-card-candidates.js', () => ({
  collectExpertCardCandidates: vi.fn(async () => state.experts),
  expertCardPerspectives: [
    'EXPERT_ORG_OWNER',
    'EXPERT_PROJECT_OWNER',
    'EXPERT_MEMBER',
    'EXPERT_INDIVIDUAL',
  ],
}));
vi.mock('../src/modules/projects/project-recruitment-snapshot.js', () => ({
  collectRecruitmentTasks: vi.fn(async () => state.snapshots.recruitment),
}));
vi.mock('../src/modules/entrance-exams/exam-grading-tasks.js', () => ({
  collectGradingTasks: vi.fn(async () => state.snapshots.grading),
}));
vi.mock('../src/modules/personnel/personnel-progress.js', () => ({
  entryTasks: vi.fn(async () => state.snapshots.entry),
}));
vi.mock('../src/modules/production/output-report-progress.js', () => ({
  outputTasks: vi.fn(async () => state.snapshots.output),
}));
vi.mock('../src/modules/production/acceptance.service.js', () => ({
  acceptanceTasks: vi.fn(async () => state.snapshots.acceptance),
}));
vi.mock('../src/modules/production/production.service.js', () => ({
  creationTasks: vi.fn(async () => state.snapshots.creation),
}));
vi.mock('../src/modules/personnel/personnel-transfer.js', () => ({
  currentApprovers: vi.fn(async () => [{ id: 'manager' }]),
  transferInclude: {},
}));
const early = new Date('2026-10-01'),
  later = new Date('2026-10-02');
const scope = (
  userId = 'manager',
  perspective = 'PROJECT_MANAGER',
  role: 'PM' | 'NAVIGATOR' | 'EXPERT' = 'PM',
) => ({
  userId,
  role,
  perspective,
  currentNodeCode: 'PRODUCTION_TASK',
  mainEligible: false,
  boardVisible: true,
});
const snapshot = (taskType: string, source: string, identity = scope()): TaskSnapshot => ({
  scopes: [identity],
  sources: [{ ...identity, taskType, sources: [source] }],
});
beforeEach(() => {
  state.experts = [];
  for (const name of ['recruitment', 'grading', 'entry', 'output', 'acceptance', 'creation'])
    state.snapshots[name] = { scopes: [], sources: [] };
});
function setup() {
  const project = {
    id: 1,
    status: 'PUBLISHED',
    deleted: false,
    currentNodeCode: 'PRODUCTION_TASK',
    createdAt: early,
  };
  const tx = {
    project: { findUniqueOrThrow: vi.fn(async () => project) },
    projectMemberMovement: { findMany: vi.fn(async () => [] as { id: number; createdAt: Date }[]) },
    projectExpertAssignment: {
      findMany: vi.fn(async () => [{ id: 2, rejectedAt: later, createdAt: early }]),
    },
    entranceExamGradingRecord: {
      findMany: vi.fn(async () => [
        { id: 3, createdAt: early },
        { id: 4, createdAt: later },
      ]),
    },
    projectMember: {
      findMany: vi.fn(async () => [{ id: 5, admittedAt: early, createdAt: early }]),
    },
    projectOutputReport: { findMany: vi.fn(async () => [{ id: 6, createdAt: early }]) },
    projectSubtask: {
      findMany: vi.fn(async () => [{ id: 7, submittedAt: early, reviewedAt: later }]),
    },
    user: { findMany: vi.fn(async () => [{ id: 'manager' }]) },
    projectRoleNodeSnapshot: {
      findMany: vi.fn(async () => [
        {
          id: 10,
          userId: 'lost',
          perspective: 'PROJECT_MANAGER',
          branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
          sourceBizType: 'PROJECT_MEMBER',
          sourceBizId: 5,
          sourceEventAt: early,
        },
      ]),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return {
    tx,
    project,
    refresh: () => refreshManagementCardSnapshots(tx as never, 1, later),
    winner: () =>
      tx.projectRoleNodeSnapshot.upsert.mock.calls.at(-1)?.[0] as unknown as {
        create: ManagementBranchCandidate & { branchPriority: number };
      },
  };
}
test('cross-domain priority reveals the next real source after each winning source disappears; rounds remain independent', async () => {
  const f = setup();
  state.snapshots.recruitment = snapshot('EXPERT_RECRUITMENT_RETRY', 'EXPERT_ASSIGNMENT:2');
  state.snapshots.grading = snapshot('ENTRANCE_EXAM_GRADING_RETRY', 'GRADING_RECORD:3');
  state.snapshots.acceptance = snapshot('SUBTASK_REWORK_SUBMIT', 'SUBTASK:7');
  state.snapshots.output = snapshot('OUTPUT_DATA_REVIEW', 'OUTPUT_REPORT:6');
  state.snapshots.creation = snapshot('SUBTASK_CREATE', 'PROJECT:1');
  state.snapshots.entry = snapshot('MEMBER_ENTRY_CONFIRM', 'PROJECT_MEMBER:5');
  f.tx.projectMemberMovement.findMany.mockResolvedValueOnce([{ id: 8, createdAt: early }]);
  await f.refresh();
  expect(f.winner().create).toMatchObject({
    branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
    branchPriority: 100,
    sourceBizId: 8,
  });
  for (const [domain, type] of [
    ['grading', 'ENTRANCE_EXAM_GRADING_RETRY'],
    ['recruitment', 'EXPERT_RECRUITMENT_RETRY'],
    ['acceptance', 'SUBTASK_REWORK_SUBMIT'],
    ['output', 'OUTPUT_DATA_REVIEW'],
    ['creation', 'SUBTASK_CREATE'],
    ['entry', 'MEMBER_ENTRY_CONFIRM'],
  ]) {
    await f.refresh();
    expect(f.winner().create.branchNodeCode).toBe(type);
    state.snapshots[domain!] = { scopes: [], sources: [] };
  }
  f.tx.projectRoleNodeSnapshot.upsert.mockClear();
  await f.refresh();
  expect(f.tx.projectRoleNodeSnapshot.upsert).not.toHaveBeenCalled();
  expect(f.tx.projectRoleNodeSnapshot.deleteMany).toHaveBeenCalledWith({ where: { id: 10 } });
});
test('same priority uses actual business time then ID, irrespective of collector order; separate perspectives never merge', () => {
  const base = {
    userId: 'manager',
    perspective: 'PROJECT_MANAGER',
    branchNodeCode: 'EXPERT_RECRUITMENT_RETRY' as const,
    sourceBizType: 'EXPERT_ASSIGNMENT',
  };
  const winners = [
    ...managementBranchWinners([
      { ...base, sourceBizId: 9, sourceEventAt: later },
      { ...base, sourceBizId: 8, sourceEventAt: early },
      { ...base, sourceBizId: 2, sourceEventAt: early },
      {
        ...base,
        perspective: 'NAVIGATOR',
        branchNodeCode: 'SUBTASK_REWORK_REVIEW',
        sourceBizId: 7,
        sourceEventAt: early,
      },
    ]).values(),
  ];
  expect(winners.map((r) => r.sourceBizId)).toEqual([2, 7]);
});
test('recruitment handler gets only recruitment retry, dual-role manual grading gets independent NAV and PM snapshots', async () => {
  const f = setup();
  state.snapshots.recruitment = snapshot('EXPERT_RECRUITMENT_RETRY', 'EXPERT_ASSIGNMENT:2');
  state.snapshots.recruitment.scopes.push(scope('manager', 'EXPERT_RECRUITMENT_HANDLER'));
  state.snapshots.grading = snapshot(
    'ENTRANCE_EXAM_GRADING',
    'GRADING_RECORD:3',
    scope('manager', 'NAVIGATOR', 'NAVIGATOR'),
  );
  state.snapshots.grading.scopes.push(scope());
  state.snapshots.grading.sources.push({
    userId: 'manager',
    role: 'PM',
    taskType: 'ENTRANCE_EXAM_GRADING',
    sources: ['GRADING_RECORD:4'],
  });
  await f.refresh();
  expect(f.tx.projectRoleNodeSnapshot.upsert).toHaveBeenCalledTimes(2);
  expect(
    f.tx.projectRoleNodeSnapshot.upsert.mock.calls.map(
      (c) => (c as unknown as [{ create: ManagementBranchCandidate }])[0].create,
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        perspective: 'PROJECT_MANAGER',
        branchNodeCode: 'EXPERT_RECRUITMENT_RETRY',
      }),
      expect.objectContaining({
        perspective: 'NAVIGATOR',
        branchNodeCode: 'ENTRANCE_EXAM_GRADING',
      }),
    ]),
  );
});
test('missing source or a failed collector cannot erase or replace any existing snapshot', async () => {
  const f = setup();
  state.snapshots.grading = snapshot('ENTRANCE_EXAM_GRADING_RETRY', 'GRADING_RECORD:999');
  await expect(f.refresh()).rejects.toThrow('缺少真实来源');
  expect(f.tx.projectRoleNodeSnapshot.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.projectRoleNodeSnapshot.upsert).not.toHaveBeenCalled();
  f.tx.projectMember.findMany.mockRejectedValueOnce(new Error('source unavailable'));
  await expect(f.refresh()).rejects.toThrow('source unavailable');
  expect(f.tx.projectRoleNodeSnapshot.deleteMany).not.toHaveBeenCalled();
});
test('inactive users, completed/deleted/unpublished projects clean management snapshots and expert perspectives', async () => {
  const f = setup();
  state.snapshots.grading = snapshot('ENTRANCE_EXAM_GRADING', 'GRADING_RECORD:3');
  f.tx.user.findMany.mockResolvedValue([]);
  await f.refresh();
  expect(f.tx.projectRoleNodeSnapshot.upsert).not.toHaveBeenCalled();
  for (const change of [{ currentNodeCode: 'COMPLETED' }, { deleted: true }, { status: 'DRAFT' }]) {
    Object.assign(f.project, change);
    f.tx.projectMember.findMany.mockClear();
    await f.refresh();
    expect(f.tx.projectMember.findMany).not.toHaveBeenCalled();
  }
  expect(f.tx.projectRoleNodeSnapshot.findMany).toHaveBeenCalledWith({
    where: {
      projectId: 1,
      perspective: {
        in: [
          'NAVIGATOR',
          'PROJECT_MANAGER',
          'EXPERT_RECRUITMENT_HANDLER',
          'EXPERT_ORG_OWNER',
          'EXPERT_PROJECT_OWNER',
          'EXPERT_MEMBER',
          'EXPERT_INDIVIDUAL',
        ],
      },
    },
  });
});

test('card recipients include removed and new identities, collapse PM perspectives and keep the same account NAV role separate', () => {
  const row = {
    userId: 'same',
    perspective: 'PROJECT_MANAGER',
    branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
    sourceBizType: 'PROJECT_MEMBER',
    sourceBizId: 5,
    sourceEventAt: early,
  };
  expect(managementCardChanges([row], [{ ...row }])).toEqual({ cardChangedRecipients: [] });
  expect(
    managementCardChanges(
      [row, { ...row, userId: 'lost' }],
      [
        { ...row, sourceBizId: 6 },
        { ...row, perspective: 'EXPERT_RECRUITMENT_HANDLER' },
        { ...row, perspective: 'NAVIGATOR' },
        { ...row, userId: 'new' },
      ],
    ).cardChangedRecipients,
  ).toEqual([
    { userId: 'same', role: 'PM' },
    { userId: 'lost', role: 'PM' },
    { userId: 'same', role: 'NAVIGATOR' },
    { userId: 'new', role: 'PM' },
  ]);
  expect(
    managementCardChanges([row], [{ ...row, sourceEventAt: later }]).cardChangedRecipients,
  ).toEqual([{ userId: 'same', role: 'PM' }]);
});
test('refresh returns changed card recipients together with persisted fallback and revoked scopes', async () => {
  const f = setup();
  state.snapshots.entry = snapshot('MEMBER_ENTRY_CONFIRM', 'PROJECT_MEMBER:5');
  expect(await f.refresh()).toEqual({
    cardChangedRecipients: [
      { userId: 'lost', role: 'PM' },
      { userId: 'manager', role: 'PM' },
    ],
  });
});

test('expert perspectives compete independently and emit one EXPERT recipient alongside separate NAV and PM roles', async () => {
  const f = setup();
  const candidate = {
    userId: 'manager',
    perspective: 'EXPERT_PROJECT_OWNER',
    branchNodeCode: 'MEMBER_ENTRY_CONFIRM' as const,
    sourceBizType: 'PROJECT_MEMBER',
    sourceBizId: 5,
    sourceEventAt: early,
  };
  state.experts = [
    candidate,
    {
      ...candidate,
      perspective: 'EXPERT_ORG_OWNER',
      branchNodeCode: 'OUTPUT_DATA_REVIEW',
      sourceBizType: 'OUTPUT_REPORT',
      sourceBizId: 6,
    },
  ];
  state.snapshots.entry = snapshot('MEMBER_ENTRY_CONFIRM', 'PROJECT_MEMBER:5');
  const changed = await f.refresh();
  expect(changed.cardChangedRecipients).toEqual(
    expect.arrayContaining([
      { userId: 'manager', role: 'PM' },
      { userId: 'manager', role: 'EXPERT' },
    ]),
  );
  expect(changed.cardChangedRecipients.filter((r) => r.role === 'EXPERT')).toHaveLength(1);
  f.tx.projectRoleNodeSnapshot.findMany.mockResolvedValue([{ id: 11, ...candidate }]);
  state.experts = [];
  expect((await f.refresh()).cardChangedRecipients).toContainEqual({
    userId: 'manager',
    role: 'EXPERT',
  });
  expect(f.tx.projectRoleNodeSnapshot.deleteMany).toHaveBeenCalledWith({ where: { id: 11 } });
});
