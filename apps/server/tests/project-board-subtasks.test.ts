import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectBoardService } from '../src/modules/projects/project-board.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import {
  boardSubtasksData,
  boardSubtasksExample,
} from '../src/modules/projects/project-board.schema.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'NAVIGATOR',
  sessionId: 's',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  const subtask = {
    id: 1,
    projectId: 1,
    subtaskNo: 'ST1',
    subtaskName: '任务',
    distributionMode: 'DESIGNATED',
    status: 'IN_PROGRESS',
    createdAt: new Date('2026-10-25T16:00:00Z'),
    expectedDeliveryDate: new Date('2026-10-28'),
    expectedQuantity: new Prisma.Decimal(100),
    quantityUnit: '条',
    reportedQuantity: new Prisma.Decimal(900),
    actualQuantity: new Prisma.Decimal(800),
  };
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([{ organizationId: 'org1' }, { organizationId: 'org2' }]),
    },
    projectSubtask: { findMany: vi.fn().mockResolvedValue([subtask]) },
    projectOutputReport: {
      groupBy: vi
        .fn()
        .mockResolvedValue([{ subtaskId: 1, _sum: { quantity: new Prisma.Decimal(30) } }]),
    },
    projectSubtaskAssignee: {
      groupBy: vi
        .fn()
        .mockResolvedValue([{ subtaskId: 1, _count: { memberId: 4 } }])
        .mockResolvedValueOnce([{ subtaskId: 1, _count: { memberId: 4 } }])
        .mockResolvedValueOnce([{ subtaskId: 1, _count: { memberId: 2 } }]),
    },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return {
    tx,
    db,
    subtask,
    run: (p = principal, now = new Date('2026-10-26T16:00:00Z'), projectId = 1) =>
      new ProjectBoardService(db as unknown as PrismaClient).subtasks(projectId, p, now),
  };
}
test('board subtasks uses actual cumulative reports in one snapshot, whole-project scope, exact risk comparison and Shanghai dates', async () => {
  const { run, db, subtask } = setup();
  expect((await run())[0]).toMatchObject({
    plannedStartDate: '2026-10-26',
    reportedQuantity: 30,
    targetQuantity: 100,
    progressPercent: 30,
    expectedQuantityToDate: 66.6667,
    progressLowRisk: true,
    overdueRisk: false,
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  subtask.expectedQuantity = new Prisma.Decimal('90.0001');
  // 30 < 90.0001 / 3 although both round to 30.0000 at four places.
  expect((await run(principal, new Date('2026-10-25T16:00:00Z')))[0]).toMatchObject({
    expectedQuantityToDate: 30,
    progressLowRisk: true,
  });
  subtask.expectedQuantity = new Prisma.Decimal(90);
  expect((await run(principal, new Date('2026-10-25T16:00:00Z')))[0]!.progressLowRisk).toBe(false);
});
test('board subtasks expert unions managed organizations, designated divides by distinct assignment counts and pool keeps total target', async () => {
  const { run, tx, subtask } = setup();
  expect((await run({ ...principal, role: 'EXPERT' }))[0]).toMatchObject({
    reportedQuantity: 15,
    targetQuantity: 25,
    progressPercent: 60,
  });
  expect(tx.projectOutputReport.groupBy.mock.calls[0][0].where).toEqual({
    projectId: 1,
    subtaskId: { in: [1] },
    member: { organizationId: { in: ['org1', 'org2'] } },
  });
  const assignmentWhere = tx.projectExpertAssignment.findMany.mock.calls[0][0].where;
  expect(assignmentWhere).toMatchObject({
    projectId: 1,
    status: 'ACCEPTED',
    organization: { deleted: false },
    OR: expect.arrayContaining([{ projectOwnerUserId: principal.userId, owners: { none: {} } }]),
  });
  subtask.distributionMode = 'POOL';
  expect((await run({ ...principal, role: 'EXPERT' }))[0]).toMatchObject({
    reportedQuantity: 30,
    targetQuantity: 100,
  });
});
test('board subtasks risk on delivery day, before start, after end, invalid plans and delivered states', async () => {
  const { run, subtask } = setup();
  expect((await run(principal, new Date('2026-10-25T15:59:59Z')))[0]).toMatchObject({
    expectedQuantityToDate: 0,
    progressLowRisk: false,
    overdueRisk: false,
  });
  expect((await run(principal, new Date('2026-10-27T16:00Z')))[0]).toMatchObject({
    overdueRisk: true,
    expectedQuantityToDate: 100,
  });
  for (const status of ['PENDING_ACCEPTANCE', 'ACCEPTED']) {
    subtask.status = status;
    expect((await run(principal, new Date('2026-11-01')))[0]).toMatchObject({
      overdueRisk: false,
      progressLowRisk: false,
    });
  }
  subtask.status = 'REWORK_REQUIRED';
  expect((await run(principal, new Date('2026-11-01')))[0]).toMatchObject({
    overdueRisk: true,
    progressLowRisk: true,
  });
  subtask.expectedDeliveryDate = new Date('2026-10-24');
  expect((await run())[0]).toMatchObject({ expectedQuantityToDate: null, progressLowRisk: false });
  subtask.expectedQuantity = new Prisma.Decimal(0);
  expect((await run())[0]).toMatchObject({ progressPercent: 0, expectedQuantityToDate: null });
});
test('board subtasks zero assignees, over-100 progress, precision and failure propagation', async () => {
  const { run, tx, subtask } = setup();
  tx.projectSubtaskAssignee.groupBy.mockReset().mockResolvedValue([]);
  expect((await run({ ...principal, role: 'EXPERT' }))[0]).toMatchObject({
    reportedQuantity: 0,
    targetQuantity: 0,
    progressPercent: 0,
  });
  subtask.expectedQuantity = new Prisma.Decimal('10000000000000000000000000');
  tx.projectOutputReport.groupBy.mockResolvedValue([
    { subtaskId: 1, _sum: { quantity: new Prisma.Decimal('10000500000000000000000000') } },
  ]);
  expect((await run())[0]!.progressPercent).toBe(100.01);
  tx.projectOutputReport.groupBy.mockRejectedValue(new Error('database error'));
  await expect(run()).rejects.toThrow('database error');
});
test('board subtasks rejects invalid ids and inaccessible projects, empty valid scope returns empty without aggregate', async () => {
  const { run, tx } = setup();
  for (const id of [0, -1, 1.5, 2147483648])
    await expect(run(principal, undefined, id)).rejects.toMatchObject({ status: 400 });
  expect(tx.project.findFirst).not.toHaveBeenCalled();
  tx.project.findFirst.mockResolvedValue(null);
  await expect(run()).rejects.toMatchObject({ status: 403 });
  tx.project.findFirst.mockResolvedValue({ id: 1 });
  tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  await expect(run({ ...principal, role: 'EXPERT' })).rejects.toMatchObject({ status: 403 });
  tx.projectSubtask.findMany.mockResolvedValue([]);
  expect(await run()).toEqual([]);
  expect(tx.projectOutputReport.groupBy).not.toHaveBeenCalled();
});
test('board subtasks complete Swagger example validates and response retains all fields; HTTP validation and schema', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const service = vi
    .spyOn(ProjectBoardService.prototype, 'subtasks')
    .mockResolvedValue(boardSubtasksExample as never);
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/board/subtasks';
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: boardSubtasksData,
      method: 'POST',
      url,
      httpPart: 'body',
    });
    expect(validate(boardSubtasksExample), JSON.stringify(validate.errors)).toBe(true);
    const request = (payload: object) =>
      app.inject({ method: 'POST', url, payload, headers: { authorization: 'Bearer token' } });
    const response = await request({ projectId: 1 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(boardSubtasksExample);
    expect(service).toHaveBeenCalledWith(1, principal);
    for (const body of [{}, { projectId: 0 }, { projectId: 1.5 }, { projectId: 2147483648 }])
      expect((await request(body)).statusCode).toBe(400);
    expect((await app.inject('/api/v1/docs/json')).json().paths[url].post.operationId).toBe(
      'getProjectBoardSubtasks',
    );
  } finally {
    await app.close();
  }
});
