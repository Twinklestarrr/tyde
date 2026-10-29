import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  taskCounts,
  boardStatisticsScope,
  taskStatisticsScope,
  workbenchStatistics,
} from '../src/modules/projects/project-workbench-statistics.js';
import { ProjectBoardService } from '../src/modules/projects/project-board.service.js';
import {
  boardStatisticsData,
  boardStatisticsExamples,
} from '../src/modules/projects/project-board.schema.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
const p: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'NAVIGATOR',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
test('statistics latest round, Shanghai half-open midnight, merged acceptance and live pending suppression', () => {
  const r = (taskType: string, status: string, time: string | null) => ({
    projectId: 1,
    taskType,
    status,
    finishedAt: time ? new Date(time) : null,
  });
  const rounds = [
    r('REOPEN', 'OPEN', null),
    r('REOPEN', 'COMPLETED', '2026-10-26T02:00Z'),
    r('CANCEL', 'CANCELLED', '2026-10-26T03:00Z'),
    r('CANCEL', 'COMPLETED', '2026-10-26T02:00Z'),
    r('OLD', 'COMPLETED', '2026-10-25T15:59:59.999Z'),
    r('START', 'COMPLETED', '2026-10-25T16:00Z'),
    r('END', 'COMPLETED', '2026-10-26T16:00Z'),
    r('LIVE', 'COMPLETED', '2026-10-26T02:00Z'),
    r('SUBTASK_REWORK_REVIEW', 'COMPLETED', '2026-10-26T02:00Z'),
    r('SUBTASK_ACCEPTANCE', 'COMPLETED', '2026-10-26T01:00Z'),
  ];
  const now = new Date('2026-10-26T15:59:59Z');
  expect(
    taskCounts(
      new Map([
        [1, new Set(['LIVE', 'PENDING'])],
        [2, new Set(['PENDING'])],
        [3, new Set()],
      ]),
      rounds,
      now,
    ),
  ).toEqual({ mode: 'TASK', pendingTaskCount: 3, involvedProjectCount: 2, completedTaskCount: 2 });
  expect(taskCounts(new Map(), [], now)).toMatchObject({
    pendingTaskCount: 0,
    completedTaskCount: 0,
    involvedProjectCount: 0,
  });
});
test('statistics scopes exclude pending PM while TASK adds reviewers and personal experts', () => {
  expect(boardStatisticsScope(p)).toEqual({ createdBy: 'creator' });
  expect(boardStatisticsScope({ ...p, role: 'PM' })).toMatchObject({
    managerRecruitments: { some: { status: 'ASSIGNED' } },
  });
  expect(boardStatisticsScope({ ...p, role: 'EXPERT' })).toMatchObject({
    expertAssignments: {
      some: {
        status: 'ACCEPTED',
        subjectType: 'ORGANIZATION',
        OR: expect.arrayContaining([{ projectOwnerUserId: p.userId, owners: { none: {} } }]),
      },
    },
  });
  expect(JSON.stringify(taskStatisticsScope(p))).toContain('reviewersJson');
  expect(JSON.stringify(taskStatisticsScope({ ...p, role: 'EXPERT' }))).toContain('INDIVIDUAL');
  expect(() => boardStatisticsScope({ ...p, role: 'OPS' } as never)).toThrow();
});
test('statistics BOARD aggregates unique projects in database with subtask-linked reports and no review-status restriction', async () => {
  const tx = {
    project: {
      count: vi
        .fn()
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1),
    },
  };
  expect(await workbenchStatistics(tx as never, 'BOARD', p, new Date())).toEqual({
    mode: 'BOARD',
    totalProjectCount: 9,
    startupProjectCount: 2,
    assemblyProjectCount: 3,
    productionProjectCount: 1,
  });
  expect(tx.project.count.mock.calls[3][0].where).toMatchObject({
    deleted: false,
    status: 'PUBLISHED',
    AND: [{ createdBy: 'creator' }],
    currentNodeCode: 'PRODUCTION_TASK',
    subtasks: { some: { outputReports: { some: {} } } },
  });
});
test('statistics rejects bad mode and returns empty TASK in one RepeatableRead snapshot', async () => {
  const tx = { project: { findMany: vi.fn().mockResolvedValue([]) } };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const service = new ProjectBoardService(db as never);
  await expect(service.statistics('bad' as never, p)).rejects.toMatchObject({ status: 400 });
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(await service.statistics('TASK', p)).toEqual({
    mode: 'TASK',
    pendingTaskCount: 0,
    completedTaskCount: 0,
    involvedProjectCount: 0,
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
});
test('statistics HTTP validates mode, discriminated examples, serialization and session identity', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const stats = vi
    .spyOn(ProjectBoardService.prototype, 'statistics')
    .mockImplementation(
      async (mode) => ({ ...boardStatisticsExamples[mode === 'TASK' ? 0 : 1] }) as never,
    );
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/statistics',
    headers = { authorization: 'Bearer token' };
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: boardStatisticsData,
      method: 'GET',
      url,
      httpPart: 'body',
    });
    for (const example of boardStatisticsExamples) {
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      const response = await app.inject({ url: `${url}?mode=${example.mode}`, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(example);
      expect(stats).toHaveBeenCalledWith(example.mode, p);
    }
    for (const query of ['', '?mode=task', '?mode=OTHER', '?mode='])
      expect((await app.inject({ url: url + query, headers })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: url + '?mode=TASK',
          headers: { ...headers, origin: 'https://untrusted.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject('/api/v1/docs/json')).json().paths[url].get.operationId).toBe(
      'getProjectWorkbenchStatistics',
    );
  } finally {
    await app.close();
  }
});

test('statistics combines every business collector, groups source types instead of cards and keeps role/project boundaries', async () => {
  const recruitment = await import('../src/modules/projects/project-recruitment-snapshot.js');
  const grading = await import('../src/modules/entrance-exams/exam-grading-tasks.js');
  const entry = await import('../src/modules/personnel/personnel-progress.js');
  const output = await import('../src/modules/production/output-report-progress.js');
  const acceptance = await import('../src/modules/production/acceptance.service.js');
  const production = await import('../src/modules/production/production.service.js');
  const scope = {
    userId: p.userId,
    role: 'NAVIGATOR' as const,
    perspective: 'NAVIGATOR',
    currentNodeCode: 'PRODUCTION_TASK',
    mainEligible: true,
    boardVisible: true,
  };
  const source = (taskType: string, userId = p.userId) => ({
    userId,
    role: 'NAVIGATOR' as const,
    taskType,
    sources: ['FACT:1', 'FACT:2'],
  });
  vi.spyOn(recruitment, 'collectRecruitmentTasks').mockResolvedValue({
    scopes: [scope],
    sources: [source('MAIN_ENTRANCE_EXAM')],
  });
  vi.spyOn(grading, 'collectGradingTasks').mockResolvedValue({
    scopes: [scope],
    sources: [
      source('ENTRANCE_EXAM_GRADING'),
      { ...source('ENTRANCE_EXAM_GRADING_RETRY'), role: 'PM' },
    ],
  });
  vi.spyOn(entry, 'entryTasks').mockResolvedValue({ scopes: [], sources: [] });
  vi.spyOn(output, 'outputTasks').mockResolvedValue({
    scopes: [],
    sources: [source('PRODUCTION_TASK'), source('OUTPUT_REPORT_CORRECTION')],
  });
  vi.spyOn(acceptance, 'acceptanceTasks').mockResolvedValue({
    scopes: [],
    sources: [
      source('SUBTASK_ACCEPTANCE'),
      source('SUBTASK_REWORK_REVIEW'),
      source('SUBTASK_REWORK_SUBMIT', 'another-user'),
    ],
  });
  vi.spyOn(production, 'creationTasks').mockResolvedValue({ scopes: [], sources: [] });
  const tx = {
    project: {
      findMany: vi.fn().mockResolvedValue([
        { id: 1, currentNodeCode: 'PRODUCTION_TASK' },
        { id: 2, currentNodeCode: 'COMPLETED' },
      ]),
    },
    projectTaskRound: { findMany: vi.fn().mockResolvedValue([]) },
  };
  expect(await workbenchStatistics(tx as never, 'TASK', p, new Date())).toEqual({
    mode: 'TASK',
    pendingTaskCount: 3,
    completedTaskCount: 0,
    involvedProjectCount: 1,
  });
  expect(tx.projectTaskRound.findMany.mock.calls[0][0]).toMatchObject({
    where: { userId: p.userId, role: 'NAVIGATOR', projectId: { in: [1, 2] } },
    orderBy: { id: 'desc' },
  });
  vi.spyOn(output, 'outputTasks').mockRejectedValueOnce(new Error('source query failed'));
  await expect(workbenchStatistics(tx as never, 'TASK', p, new Date())).rejects.toThrow(
    'source query failed',
  );
});

test('statistics personal progress keeps pending movement training, excludes confirmed/invalid members and gates owner exams by live deadline and submission', async () => {
  const { personalTasks } = await import('../src/modules/projects/project-workbench-statistics.js');
  const candidate = await import('../src/modules/entrance-exams/exam-candidate.service.js');
  vi.spyOn(candidate, 'candidateContext').mockResolvedValue({ movement: null } as never);
  const expert = { ...p, role: 'EXPERT' as const },
    project = { id: 1 } as never,
    now = new Date('2026-10-26T02:00Z');
  const member = {
    status: 'PENDING_TRANSFER',
    projectId: 1,
    userId: p.userId,
    user: { status: 'ACTIVE' },
    admittedAt: now,
    joinedAt: now,
    entryDecision: 'YES',
    standardTrainingConfirmedAt: null,
    organizationId: null,
    userOrgRelId: null,
    expertAssignment: {
      status: 'ACCEPTED',
      projectId: 1,
      subjectType: 'INDIVIDUAL',
      expertUserId: p.userId,
    },
  };
  const tx = {
    projectMember: { findFirst: vi.fn().mockResolvedValue(member) },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue({ needWrittenExam: false }) },
    projectExpertAssignment: { count: vi.fn().mockResolvedValue(0) },
    entranceExamAttempt: { count: vi.fn().mockResolvedValue(0) },
    projectEntranceExam: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 1,
          currentVersion: { examId: 1, registrationDeadline: new Date('2026-10-26T02:01Z') },
        },
      ]),
    },
  };
  expect([...(await personalTasks(tx as never, project, expert, now))]).toEqual([
    'STANDARD_TRAINING',
  ]);
  tx.projectMember.findFirst.mockResolvedValueOnce({ ...member, standardTrainingConfirmedAt: now });
  expect((await personalTasks(tx as never, project, expert, now)).size).toBe(0);
  tx.projectMember.findFirst.mockResolvedValueOnce({ ...member, status: 'LEFT' });
  expect((await personalTasks(tx as never, project, expert, now)).size).toBe(0);
  tx.projectMember.findFirst.mockResolvedValue(null);
  tx.projectExpertAssignment.count.mockResolvedValue(1);
  tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  expect([...(await personalTasks(tx as never, project, expert, now))]).toEqual(['ENTRANCE_EXAM']);
  expect(
    (await personalTasks(tx as never, project, expert, new Date('2026-10-26T02:01Z'))).size,
  ).toBe(0);
  tx.entranceExamAttempt.count.mockResolvedValue(1);
  expect((await personalTasks(tx as never, project, expert, now)).size).toBe(0);
});
