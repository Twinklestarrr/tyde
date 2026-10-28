import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectBoardService } from '../src/modules/projects/project-board.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
import {
  boardTrendsData,
  boardTrendsExample,
} from '../src/modules/projects/project-board.schema.js';
import type { BoardTrendsQuery } from '../src/modules/projects/project-board-trends.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';

const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'pm',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
};
const query: BoardTrendsQuery = {
  projectId: 1,
  metric: 'QUANTITY',
  startDate: '2026-10-26',
  endDate: '2026-10-28',
};
const dec = (n: number | string) => new Prisma.Decimal(n);
const row = (day: string | null, quantity = 0, inspected = 0, qualified = 0, memberId = 2) => ({
  memberId,
  userId: principal.userId,
  displayName: ' 昵称 ',
  realName: ' 姓名 ',
  uid: 'uid',
  quantityUnit: '条',
  reportDate: day ? new Date(day) : null,
  quantity: dec(quantity),
  inspected: dec(inspected),
  qualified: dec(qualified),
});
afterEach(() => vi.restoreAllMocks());
function setup() {
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 1, currentNodeCode: 'ENTRANCE_EXAM' }) },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([{ organizationId: principal.userId }]),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        row('2026-10-26', 10, 10, 9),
        row('2026-10-28', 20),
        row(null, 0, 0, 0, 3),
      ]),
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const run = (q = query, p = principal) =>
    new ProjectBoardService(db as unknown as PrismaClient).trends(q, p);
  return { tx, db, run };
}
test('trends quantities preserve zero-report members, gaps, member identity, live names and one read snapshot outside production', async () => {
  const { run, db } = setup();
  expect(await run()).toEqual({
    metric: 'QUANTITY',
    viewScope: 'FULL_PROJECT',
    dates: ['2026-10-26', '2026-10-27', '2026-10-28'],
    series: [
      {
        memberId: 2,
        userId: principal.userId,
        displayName: '昵称(姓名)',
        quantityUnit: '条',
        values: [10, 0, 20],
      },
      {
        memberId: 3,
        userId: principal.userId,
        displayName: '昵称(姓名)',
        quantityUnit: '条',
        values: [0, 0, 0],
      },
    ],
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
test('trends daily weighted accuracy, rounding, null inspection and zero qualification', async () => {
  const { run, tx } = setup();
  tx.$queryRaw.mockResolvedValue([
    row('2026-10-26', 100, 10, 8.1),
    row('2026-10-27', 20, 3, 2),
    row('2026-10-28', 2, 1, 0),
  ]);
  expect((await run({ ...query, metric: 'ACCURACY' })).series[0].values).toEqual([81, 66.67, 0]);
  tx.$queryRaw.mockResolvedValue([row('2026-10-26', 10)]);
  expect((await run({ ...query, metric: 'ACCURACY' })).series[0].values).toEqual([
    null,
    null,
    null,
  ]);
});
test('trends CPD includes six prior dates, fixed seven-day denominator, moving window and high precision', async () => {
  const { run, tx } = setup();
  tx.$queryRaw.mockResolvedValue([
    row('2026-10-20', 7),
    row('2026-10-25', 1),
    row('2026-10-26', 2),
    row('2026-10-28', 4),
  ]);
  expect((await run({ ...query, metric: 'CPD' })).series[0].values).toEqual([1.43, 0.43, 1]);
  const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
  expect(sql.values).toEqual(['2026-10-20', '2026-10-28', 1]);
});
test('trends calendar validation accepts leap dates and 366 inclusive days, rejects reversed, oversized, impossible or timestamp dates', async () => {
  const { run, tx } = setup();
  for (const q of [
    { ...query, startDate: '2026-02-29' },
    { ...query, endDate: '2026-04-31' },
    { ...query, startDate: '2026-10-29' },
    { ...query, startDate: '2025-10-27' },
    { ...query, startDate: '2026-10-26T00:00:00Z' },
    { ...query, startDate: '0000-01-01' },
    { ...query, metric: 'OTHER' as never },
  ])
    await expect(run(q)).rejects.toMatchObject({ status: 400 });
  expect(tx.project.findFirst).not.toHaveBeenCalled();
  expect(
    (await run({ ...query, startDate: '2024-02-29', endDate: '2025-02-28' })).dates,
  ).toHaveLength(366);
  expect((await run({ ...query, startDate: '2026-12-31', endDate: '2027-01-01' })).dates).toEqual([
    '2026-12-31',
    '2027-01-01',
  ]);
});
test('trends navigator skips personnel, expert union is bound in SQL, lost scopes deny before metrics and database errors propagate', async () => {
  const { run, tx } = setup();
  expect((await run(query, { ...principal, role: 'NAVIGATOR' })).series).toEqual([]);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  const otherOrg = '00000000-0000-4000-8000-000000000002';
  tx.projectExpertAssignment.findMany.mockResolvedValue([
    { organizationId: principal.userId },
    { organizationId: otherOrg },
  ]);
  expect((await run(query, { ...principal, role: 'EXPERT' })).viewScope).toBe('ORGANIZATION');
  const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
  expect(sql.values).toEqual(['2026-10-26', '2026-10-28', 1, principal.userId, otherOrg]);
  tx.$queryRaw.mockClear();
  tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  await expect(run(query, { ...principal, role: 'EXPERT' })).rejects.toMatchObject({ status: 403 });
  tx.project.findFirst.mockResolvedValue(null);
  await expect(run()).rejects.toMatchObject({ status: 403 });
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  tx.project.findFirst.mockRejectedValue(new Error('database failure'));
  await expect(run()).rejects.toThrow('database failure');
});
test('board trends complete Swagger examples, HTTP serialization, validation and authentication', async () => {
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
    .spyOn(ProjectBoardService.prototype, 'trends')
    .mockResolvedValue(boardTrendsExample as never);
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/board/trends';
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: boardTrendsData,
      method: 'POST',
      url,
      httpPart: 'body',
    });
    expect(validate(boardTrendsExample), JSON.stringify(validate.errors)).toBe(true);
    const request = (payload: object) =>
      app.inject({ method: 'POST', url, payload, headers: { authorization: 'Bearer token' } });
    const response = await request(query);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(boardTrendsExample);
    expect(service).toHaveBeenCalledWith(query, principal);
    for (const body of [{}, { projectId: 0 }, { projectId: 1.5 }, { projectId: 2147483648 }])
      expect((await request(body)).statusCode).toBe(400);
    service.mockResolvedValue({
      metric: 'ACCURACY',
      viewScope: 'ORGANIZATION',
      dates: ['2026-10-26'],
      series: [{ ...boardTrendsExample.series[0], values: [null] }],
    } as never);
    expect((await request(query)).json().data.series[0].values).toEqual([null]);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[url].post.operationId).toBe('getProjectBoardTrends');
    auth.mockRejectedValue(new AuthError(401, 'UNAUTHORIZED', '未登录'));
    expect((await request(query)).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
