import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectBoardService } from '../src/modules/projects/project-board.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
import { boardRisksData, boardRisksExample } from '../src/modules/projects/project-board.schema.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';

const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
};
const now = new Date('2026-10-26T16:00:00Z');
const decimal = (s: string | number) => new Prisma.Decimal(s);
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    id: 1,
    projectName: '项目',
    deadline: new Date('2026-10-26T15:59:59Z'),
    currentNodeCode: 'PRODUCTION_TASK',
  };
  const subtask = {
    id: 2,
    subtaskNo: 'ST2',
    subtaskName: '任务',
    status: 'IN_PROGRESS',
    distributionMode: 'POOL',
    createdAt: new Date('2026-10-25T16:00:00Z'),
    expectedDeliveryDate: new Date('2026-10-27'),
    expectedQuantity: decimal(100),
    quantityUnit: '条',
  };
  const plan = {
    operatorCpd: decimal(20),
    stages: [{ operatorCpd: decimal(10), accuracyRate: decimal(90) as Prisma.Decimal | null }],
  };
  const metric = {
    id: 3,
    displayName: ' 昵称 ',
    realName: ' 姓名 ' as string | null,
    uid: 'uid',
    todayQuantity: decimal(0),
    inspected: decimal(3),
    qualified: decimal(2),
  };
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue(project) },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([{ organizationId: principal.userId }]),
    },
    projectSubtask: { findMany: vi.fn().mockResolvedValue([subtask]) },
    projectOutputReport: {
      groupBy: vi.fn().mockResolvedValue([{ subtaskId: 2, _sum: { quantity: decimal(30) } }]),
    },
    projectSubtaskAssignee: { groupBy: vi.fn().mockResolvedValue([]) },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    $queryRaw: vi.fn().mockResolvedValue([metric]),
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const run = (p = principal, date = now, id = 1) =>
    new ProjectBoardService(db as unknown as PrismaClient).risks(id, p, date);
  return { project, subtask, plan, metric, tx, db, run };
}
test('board risks independent counts, overdue-first ordering, member double risks, names and one read snapshot', async () => {
  const { run, db, tx } = setup();
  const result = await run();
  expect(result).toMatchObject({
    viewScope: 'FULL_PROJECT',
    project: {
      pendingCount: 1,
      urgentCount: 1,
      items: [{ code: 'PROJECT_OVERDUE', overdueDays: 1 }],
    },
    subtasks: {
      pendingCount: 2,
      urgentCount: 1,
      items: [
        { code: 'SUBTASK_OVERDUE', overdueDays: 0 },
        { code: 'SUBTASK_PROGRESS_LOW', overdueDays: null },
      ],
    },
    members: {
      pendingCount: 2,
      urgentCount: 0,
      items: [{ code: 'MEMBER_EFFICIENCY', targetName: '昵称(姓名)' }, { code: 'MEMBER_QUALITY' }],
    },
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(tx.project.findFirst).toHaveBeenCalledTimes(1);
  expect(tx.projectProductionPlan.findUnique.mock.calls[0][0].select.stages).toMatchObject({
    where: { startDate: { lte: new Date('2026-10-27') }, endDate: { gte: new Date('2026-10-27') } },
    orderBy: { sequenceNo: 'asc' },
    take: 1,
  });
});
test('board risks strict project instant boundary, Shanghai natural days, completed project and delivered tasks', async () => {
  const { run, project, subtask } = setup();
  project.deadline = now;
  expect((await run()).project.pendingCount).toBe(0);
  project.deadline = new Date(now.getTime() - 1);
  expect((await run()).project.items[0]).toMatchObject({ overdueDays: 1 });
  project.deadline = new Date(now.getTime() + 1000);
  expect((await run(principal, new Date(now.getTime() + 1001))).project.items[0]).toMatchObject({
    overdueDays: 0,
    message: '项目已逾期，不足一天',
  });
  project.currentNodeCode = 'COMPLETED';
  subtask.status = 'ACCEPTED';
  expect(await run()).toMatchObject({
    project: { pendingCount: 0 },
    subtasks: { pendingCount: 0 },
    members: { pendingCount: 0 },
  });
});
test('board risks cumulative quality rounds before comparison, strict CPD, no inspection and missing stage thresholds', async () => {
  const { run, metric, plan, tx } = setup();
  metric.todayQuantity = decimal(10);
  metric.qualified = decimal('2.6999'); // 89.9966... rounds to 90, equals threshold.
  expect((await run()).members.pendingCount).toBe(0);
  metric.qualified = decimal('2.6998');
  expect((await run()).members.items.map((i) => i.code)).toEqual(['MEMBER_QUALITY']);
  metric.inspected = decimal(0);
  expect((await run()).members.pendingCount).toBe(0);
  plan.stages = [];
  expect((await run()).members.items.map((i) => i.code)).toEqual(['MEMBER_EFFICIENCY']);
  plan.stages = [{ operatorCpd: decimal(5), accuracyRate: null }];
  expect((await run()).members.pendingCount).toBe(0);
  tx.projectProductionPlan.findUnique.mockResolvedValue(null);
  expect((await run()).members.pendingCount).toBe(0);
});
test('board risks navigator and non-production skip member metrics; experts bind organization union in SQL and subtasks', async () => {
  const { run, tx, project } = setup();
  expect((await run({ ...principal, role: 'NAVIGATOR' })).members.items).toEqual([]);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  project.currentNodeCode = 'ENTRANCE_EXAM';
  expect((await run()).members.pendingCount).toBe(0);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  project.currentNodeCode = 'PRODUCTION_TASK';
  const otherOrg = '00000000-0000-4000-8000-000000000002';
  tx.projectExpertAssignment.findMany.mockResolvedValue([
    { organizationId: principal.userId },
    { organizationId: otherOrg },
  ]);
  expect((await run({ ...principal, role: 'EXPERT' })).viewScope).toBe('ORGANIZATION');
  const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
  expect(sql.values).toEqual(['2026-10-27', 1, principal.userId, otherOrg]);
  expect(sql.sql).toContain('LEFT JOIN LATERAL');
  expect(sql.sql).toContain('ORDER BY id DESC LIMIT 1');
  expect(
    tx.projectOutputReport.groupBy.mock.calls.at(-1)![0].where.member.organizationId.in,
  ).toEqual([principal.userId, otherOrg]);
});
test('board risks validates ids, rejects lost access before data reads and propagates infrastructure failures', async () => {
  const { run, tx } = setup();
  for (const id of [0, -1, 1.5, 2147483648])
    await expect(run(principal, now, id)).rejects.toMatchObject({ status: 400 });
  tx.project.findFirst.mockResolvedValue(null);
  await expect(run()).rejects.toMatchObject({ status: 403 });
  expect(tx.projectSubtask.findMany).not.toHaveBeenCalled();
  tx.project.findFirst.mockResolvedValue({ id: 1 });
  tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  await expect(run({ ...principal, role: 'EXPERT' })).rejects.toMatchObject({ status: 403 });
  tx.project.findFirst.mockRejectedValue(new Error('database failure'));
  await expect(run()).rejects.toThrow('database failure');
});
test('board risks complete Swagger examples, HTTP serialization, validation and authentication', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  const auth = vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const service = vi
    .spyOn(ProjectBoardService.prototype, 'risks')
    .mockResolvedValue(boardRisksExample as never);
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/board/risks';
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: boardRisksData,
      method: 'POST',
      url,
      httpPart: 'body',
    });
    expect(validate(boardRisksExample), JSON.stringify(validate.errors)).toBe(true);
    const request = (payload: object) =>
      app.inject({ method: 'POST', url, payload, headers: { authorization: 'Bearer token' } });
    const response = await request({ projectId: 1 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(boardRisksExample);
    expect(service).toHaveBeenCalledWith(1, principal);
    for (const body of [{}, { projectId: 0 }, { projectId: 1.5 }, { projectId: 2147483648 }])
      expect((await request(body)).statusCode).toBe(400);
    service.mockResolvedValue({
      viewScope: 'ORGANIZATION',
      project: { pendingCount: 0, urgentCount: 0, items: [] },
      subtasks: { pendingCount: 0, urgentCount: 0, items: [] },
      members: { pendingCount: 0, urgentCount: 0, items: [] },
    });
    expect((await request({ projectId: 1 })).json().data.members).toEqual({
      pendingCount: 0,
      urgentCount: 0,
      items: [],
    });
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[url].post.operationId).toBe('getProjectBoardRisks');
    auth.mockRejectedValue(new AuthError(401, 'UNAUTHORIZED', '未登录'));
    expect((await request({ projectId: 1 })).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
