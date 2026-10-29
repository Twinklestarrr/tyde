import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthError } from '../src/modules/auth/auth.error.js';
import { ProjectBoardService } from '../src/modules/projects/project-board.service.js';
import {
  boardProjectsData,
  boardProjectsExample,
} from '../src/modules/projects/project-board.schema.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const p: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'NAVIGATOR',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    id: 1,
    projectNo: 'PRJ1',
    projectName: '项目',
    deadline: new Date('2026-10-26T02:00Z'),
    requesterType: 'INDIVIDUAL',
    requesterName: '快照',
    requester: { displayName: ' 新昵称 ', realName: '姓名' },
    productionPlan: { needWrittenExam: true },
    currentNodeCode: null as string | null,
    projectQuantity: new Prisma.Decimal(3),
    quantityUnit: '条',
    managerRecruitments: [{ candidateUserId: p.userId, expertRecruitmentHandlerUserId: 'handler' }],
  };
  const tx = {
    project: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([project]),
    },
    projectSubtask: {
      groupBy: vi
        .fn()
        .mockResolvedValue([
          { projectId: 1, _sum: { actualQuantity: new Prisma.Decimal('4.0001') } },
        ]),
    },
    projectExpertAssignment: {
      groupBy: vi.fn().mockResolvedValue([{ projectId: 1, _max: { id: 8 } }]),
    },
    userOrgRel: { findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return {
    tx,
    project,
    db,
    run: (query = {}, principal = p) =>
      new ProjectBoardService(db as unknown as PrismaClient).projects(query, principal),
  };
}
test('board projects applies database scope and snapshot keyword before stable pagination, aggregates only current page and reads in one snapshot', async () => {
  const { tx, db, run } = setup();
  expect(await run({ current: 2, size: 1, keyword: ' 快照 ' })).toMatchObject({
    total: 3,
    pages: 3,
    current: 2,
    size: 1,
    records: [
      {
        assignmentId: null,
        requesterName: '新昵称(姓名)',
        currentNodeCode: 'PRODUCTION_PLAN',
        currentNodeName: '生产计划',
        progressQuantity: 4.0001,
        targetQuantity: 3,
        progressPercent: 133.34,
        deadline: '2026-10-26 10:00:00',
      },
    ],
  });
  expect(tx.project.findMany.mock.calls[0][0]).toMatchObject({
    where: {
      deleted: false,
      status: 'PUBLISHED',
      AND: [
        { createdBy: p.uid },
        { OR: [{ projectName: { contains: '快照' } }, { requesterName: { contains: '快照' } }] },
      ],
    },
    skip: 1,
    take: 1,
    orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  });
  expect(tx.projectSubtask.groupBy.mock.calls[0][0]).toMatchObject({
    where: { projectId: { in: [1] } },
    _sum: { actualQuantity: true },
  });
  expect(tx.projectExpertAssignment.groupBy).not.toHaveBeenCalled();
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
test('board projects PM flags are current assigned relations and absent for other roles; node/zero/organization fallback', async () => {
  const { run, project } = setup();
  expect((await run({}, { ...p, role: 'PM' })).records[0]).toMatchObject({
    primaryProjectManager: true,
    expertRecruitmentHandler: false,
  });
  project.managerRecruitments = [];
  project.requesterType = 'ORGANIZATION';
  project.currentNodeCode = 'COMPLETED';
  project.projectQuantity = new Prisma.Decimal(0);
  const row = (await run()).records[0]!;
  expect(row).toMatchObject({ requesterName: '快照', currentNodeName: '结项', progressPercent: 0 });
  expect(row).not.toHaveProperty('primaryProjectManager');
  project.currentNodeCode = null;
  expect((await run()).records[0]!.currentNodeCode).toBe('RECRUIT_PROJECT_MANAGER');
});
test('board projects expert assignment max is constrained by accepted organization membership/owners and removed-row fallback', async () => {
  const { tx, run } = setup();
  expect((await run({}, { ...p, role: 'EXPERT' })).records[0]!.assignmentId).toBe(8);
  const where = tx.projectExpertAssignment.groupBy.mock.calls[0][0].where;
  expect(where).toMatchObject({
    projectId: { in: [1] },
    subjectType: 'ORGANIZATION',
    status: 'ACCEPTED',
    organization: { deleted: false, memberships: { some: { userId: p.userId } } },
    OR: expect.arrayContaining([{ projectOwnerUserId: p.userId, owners: { none: {} } }]),
  });
});
test('board projects empty page retains totals and requires real expert management, skips aggregates and never swallows database errors', async () => {
  const { tx, run } = setup();
  tx.project.findMany.mockResolvedValue([]);
  expect(await run({ current: 4, size: 1 })).toEqual({
    total: 3,
    pages: 3,
    current: 4,
    size: 1,
    records: [],
  });
  expect(tx.userOrgRel.findFirst).not.toHaveBeenCalled();
  await run({}, { ...p, role: 'EXPERT' });
  expect(tx.userOrgRel.findFirst.mock.calls[0][0].where).toMatchObject({
    userId: p.userId,
    organization: { deleted: false },
  });
  tx.userOrgRel.findFirst.mockResolvedValue(null);
  await expect(run({}, { ...p, role: 'EXPERT' })).rejects.toMatchObject({ status: 403 });
  expect(tx.projectSubtask.groupBy).not.toHaveBeenCalled();
  tx.project.count.mockRejectedValue(new Error('database unavailable'));
  await expect(run()).rejects.toThrow('database unavailable');
});
test('board projects rejects invalid direct input before database reads', async () => {
  const { tx, run } = setup();
  for (const query of [
    { current: 0 },
    { current: 1.1 },
    { size: 101 },
    { keyword: 'a'.repeat(129) },
  ])
    await expect(run(query)).rejects.toMatchObject({ status: 400 });
  expect(tx.project.count).not.toHaveBeenCalled();
});
test('board projects HTTP defaults, body validation, role-specific serialization and complete Swagger example', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const service = vi
    .spyOn(ProjectBoardService.prototype, 'projects')
    .mockResolvedValue(boardProjectsExample as never);
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/board/projects';
  const request = (payload: object, headers = { authorization: 'Bearer token' }) =>
    app.inject({ method: 'POST', url, payload, headers });
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: boardProjectsData,
      method: 'POST',
      url,
      httpPart: 'body',
    });
    expect(validate(boardProjectsExample), JSON.stringify(validate.errors)).toBe(true);
    const response = await request({});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(boardProjectsExample);
    expect(service).toHaveBeenCalledWith({ current: 1, size: 20 }, p);
    for (const body of [{ size: 101 }, { current: 0 }, { keyword: 'x'.repeat(129) }])
      expect((await request(body)).statusCode).toBe(400);
    vi.spyOn(AuthService.prototype, 'authenticate').mockRejectedValueOnce(
      new AuthError(401, 'UNAUTHENTICATED', '未登录'),
    );
    expect((await request({}, {})).statusCode).toBe(401);
    expect((await app.inject('/api/v1/docs/json')).json().paths[url].post.operationId).toBe(
      'listProjectBoardProjects',
    );
    const record = { ...boardProjectsExample.records[0] };
    delete (record as Partial<typeof record>).primaryProjectManager;
    delete (record as Partial<typeof record>).expertRecruitmentHandler;
    service.mockResolvedValue({ ...boardProjectsExample, records: [record] } as never);
    expect((await request({})).json().data.records[0]).not.toHaveProperty('primaryProjectManager');
  } finally {
    await app.close();
  }
});

test('board projects preserves exact rounding for large quantities, null actual delivery and no-plan zero defaults', async () => {
  const { tx, project, run } = setup();
  project.projectQuantity = new Prisma.Decimal('10000000000000000000000000');
  tx.projectSubtask.groupBy.mockResolvedValue([
    { projectId: 1, _sum: { actualQuantity: new Prisma.Decimal('10000500000000000000000000') } },
  ]);
  expect((await run()).records[0]!.progressPercent).toBe(100.01);
  tx.projectSubtask.groupBy.mockResolvedValue([
    { projectId: 1, _sum: { actualQuantity: null } },
  ] as never);
  project.productionPlan = null as never;
  expect((await run()).records[0]).toMatchObject({
    progressQuantity: 0,
    progressPercent: 0,
    needWrittenExam: false,
  });
});
