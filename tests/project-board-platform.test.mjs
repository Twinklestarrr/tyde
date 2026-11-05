import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  boardBasicExample,
  boardProjectsExample,
  boardStatisticsExamples,
  boardSubtasksExample,
  boardRisksExample,
  boardTrendsBody,
  boardTrendsExample,
} from '../apps/server/src/modules/projects/project-board.schema.ts';

const projectId = 3001;
const trends = boardTrendsBody.examples[0];
const wrap = (data, status = 200) =>
  new Response(JSON.stringify({ code: status, message: '真实看板结果', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: String(url).slice(origin.length),
      data: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}
const reads = (api) => [
  () => api.getProjectWorkbenchStatistics('BOARD'),
  () => api.listProjectBoardProjects(),
  () => api.getProjectBoardDetail(projectId),
  () => api.getProjectBoardSubtasks(projectId),
  () => api.getProjectBoardRisks(projectId),
  () => api.getProjectBoardTrends(trends),
];

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} board reads match the existing six endpoints and preserve scope, nullable facts and percentages above 100`, async (t) => {
    const data = [
      boardStatisticsExamples[0],
      boardStatisticsExamples[1],
      boardProjectsExample,
      boardBasicExample,
      boardSubtasksExample,
      boardRisksExample,
      boardTrendsExample,
    ];
    const { api, calls } = adapter(t, desktop, () => wrap(data[calls.length - 1]));
    assert.deepEqual(await api.getProjectWorkbenchStatistics('TASK'), data[0]);
    assert.deepEqual(await api.getProjectWorkbenchStatistics('BOARD'), data[1]);
    const query = { current: 1, size: 20, keyword: null };
    assert.deepEqual(await api.listProjectBoardProjects(query), data[2]);
    assert.deepEqual(await api.getProjectBoardDetail(projectId), data[3]);
    assert.deepEqual(await api.getProjectBoardSubtasks(projectId), data[4]);
    assert.deepEqual(await api.getProjectBoardRisks(projectId), data[5]);
    assert.deepEqual(await api.getProjectBoardTrends(trends), data[6]);
    assert.deepEqual(
      calls.map(({ path, data }) => [path, data]),
      [
        ['/api/v1/projects/workbench/statistics?mode=TASK', undefined],
        ['/api/v1/projects/workbench/statistics?mode=BOARD', undefined],
        ['/api/v1/projects/workbench/board/projects', query],
        ['/api/v1/projects/workbench/board/project-detail', { projectId }],
        ['/api/v1/projects/workbench/board/subtasks', { projectId }],
        ['/api/v1/projects/workbench/board/risks', { projectId }],
        ['/api/v1/projects/workbench/board/trends', trends],
      ],
    );
    for (const [i, call] of calls.entries()) {
      assert.equal(call.method, i < 2 ? 'GET' : 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers['X-Tyde-Client'], i < 2 ? undefined : 'web');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers['X-Tyde-Role'], undefined);
    }
    assert.ok(data[2].records[0].progressPercent > 100);
  });

  test(`${mode} board access refusal and unknown reads never broaden role, organization or project scope or replay`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 404, 409, 500, 503, 0]) {
      const before = calls.length;
      for (const read of reads(api)) await assert.rejects(read, (error) => error.status === status);
      assert.equal(calls.length, before + 6);
    }
  });

  test(`${mode} explicit 401 refresh retries the unchanged board detail read only once`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    let attempts = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/auth/')) return wrap(tokens);
      return wrap(++attempts === 1 ? null : boardBasicExample, attempts === 1 ? 401 : 200);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'NAVIGATOR' });
    await api.getProjectBoardDetail(projectId);
    const commands = calls.filter(({ path }) => !path.includes('/auth/'));
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].data, commands[1].data);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
  });
}

test('board inputs reject invalid IDs, modes, paging, date ranges and identity overrides before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const mode of [undefined, null, 'board', '', {}, 'ALL'])
    await assert.rejects(
      () => api.getProjectWorkbenchStatistics(mode),
      (error) => error.status === 400,
    );
  for (const input of [
    null,
    [],
    { current: 0 },
    { current: 2147483648 },
    { size: 101 },
    { size: 0 },
    { keyword: '界'.repeat(129) },
    { role: 'PM' },
    { organizationId: 'other' },
    { currentNodeCode: 'COMPLETED' },
    { projectId },
  ])
    await assert.rejects(
      () => api.listProjectBoardProjects(input),
      (error) => error.status === 400,
    );
  for (const id of [0, -1, '3001', 1.5, 2147483648, null, undefined])
    for (const method of [
      'getProjectBoardDetail',
      'getProjectBoardSubtasks',
      'getProjectBoardRisks',
    ])
      await assert.rejects(
        () => api[method](id),
        (error) => error.status === 400,
      );
  for (const patch of [
    { projectId: 0 },
    { metric: 'ALL' },
    { startDate: '0000-01-01' },
    { startDate: '2026-02-30' },
    { endDate: '2026-10-25' },
    { startDate: '2024-01-01', endDate: '2025-01-01' },
    { organizationId: 'other' },
    { userId: 'other' },
    { role: 'PM' },
  ])
    await assert.rejects(
      () => api.getProjectBoardTrends({ ...trends, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('board queries preserve empty pages, completed or unknown historical nodes and optional PM-only flags', async (t) => {
  const page = structuredClone(boardProjectsExample);
  delete page.records[0].primaryProjectManager;
  delete page.records[0].expertRecruitmentHandler;
  Object.assign(page.records[0], {
    assignmentId: 89,
    currentNodeCode: 'COMPLETED',
    currentNodeName: '结项',
  });
  let data = page;
  const { api, calls } = adapter(t, false, () => wrap(data));
  assert.deepEqual(await api.listProjectBoardProjects(), page);
  assert.deepEqual(calls[0].data, {});
  data.records[0].currentNodeCode = 'HISTORICAL_NODE';
  data.records[0].currentNodeName = null;
  assert.deepEqual(await api.listProjectBoardProjects(), data);
  data = { total: 0, current: 1, size: 20, pages: 0, records: [] };
  assert.deepEqual(await api.listProjectBoardProjects({}), data);
  data = [];
  assert.deepEqual(await api.getProjectBoardSubtasks(projectId), []);
});

test('board basic detail retains draft and nullable fields without inventing attachments, plan or write permissions', async (t) => {
  const data = {
    ...boardBasicExample,
    status: 'DRAFT',
    projectQuantity: null,
    publishedAt: null,
    closedAt: null,
    currentNodeCode: null,
    categoryLevel1Id: null,
    categoryLevel1Name: null,
  };
  const { api } = adapter(t, false, () => wrap(data));
  assert.deepEqual(await api.getProjectBoardDetail(projectId), data);
  assert.equal(Object.hasOwn(data, 'attachments'), false);
});

test('board trends accept 366 inclusive Shanghai days, year 0001, repeated users with distinct members and nullable accuracy', async (t) => {
  let input;
  const { api } = adapter(t, false, () => {
    const start = Date.parse(input.startDate + 'T00:00:00Z');
    const days = (Date.parse(input.endDate + 'T00:00:00Z') - start) / 86400000 + 1;
    const dates = Array.from({ length: days }, (_, i) =>
      new Date(start + i * 86400000).toISOString().slice(0, 10),
    );
    return wrap({
      metric: input.metric,
      viewScope: 'ORGANIZATION',
      dates,
      series: [1, 2].map((id) => ({
        ...boardTrendsExample.series[0],
        memberId: id,
        quantityUnit: null,
        values: dates.map(() => null),
      })),
    });
  });
  for (input of [
    { projectId, metric: 'ACCURACY', startDate: '2024-01-01', endDate: '2024-12-31' },
    { projectId, metric: 'ACCURACY', startDate: '0001-01-01', endDate: '0001-01-01' },
  ]) {
    const result = await api.getProjectBoardTrends(input);
    assert.equal(result.series.length, 2);
    assert.equal(result.dates[0], input.startDate);
    assert.equal(result.dates.at(-1), input.endDate);
  }
});

test('board response parsing rejects wrong source, paging, modes, enum values, risk totals and trend axes', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  const cases = [
    [() => api.getProjectWorkbenchStatistics('TASK'), boardStatisticsExamples[1]],
    [
      () => api.getProjectWorkbenchStatistics('BOARD'),
      { ...boardStatisticsExamples[1], pendingTaskCount: 1 },
    ],
    [() => api.listProjectBoardProjects(), { ...boardProjectsExample, current: 2 }],
    [() => api.listProjectBoardProjects(), { ...boardProjectsExample, pages: 2 }],
    [
      () => api.listProjectBoardProjects(),
      {
        ...boardProjectsExample,
        records: [{ ...boardProjectsExample.records[0], assignmentId: '89' }],
      },
    ],
    [() => api.getProjectBoardDetail(projectId), { ...boardBasicExample, projectId: 9 }],
    [() => api.getProjectBoardDetail(projectId), { ...boardBasicExample, status: 'COMPLETED' }],
    [
      () => api.getProjectBoardDetail(projectId),
      { ...boardBasicExample, deadline: '2026-02-30 12:00:00' },
    ],
    [
      () => api.getProjectBoardSubtasks(projectId),
      [{ ...boardSubtasksExample[0], status: 'UNKNOWN' }],
    ],
    [() => api.getProjectBoardRisks(projectId), { ...boardRisksExample, viewScope: 'ALL' }],
    [
      () => api.getProjectBoardRisks(projectId),
      { ...boardRisksExample, project: { ...boardRisksExample.project, urgentCount: 0 } },
    ],
    [
      () => api.getProjectBoardRisks(projectId),
      {
        ...boardRisksExample,
        project: {
          ...boardRisksExample.project,
          items: [{ ...boardRisksExample.project.items[0], targetId: 9 }],
        },
      },
    ],
    [() => api.getProjectBoardTrends(trends), { ...boardTrendsExample, metric: 'CPD' }],
    [
      () => api.getProjectBoardTrends(trends),
      { ...boardTrendsExample, dates: ['2026-10-26', '2026-10-28'] },
    ],
    [
      () => api.getProjectBoardTrends(trends),
      { ...boardTrendsExample, series: [{ ...boardTrendsExample.series[0], values: [0] }] },
    ],
    [
      () => api.getProjectBoardTrends(trends),
      { ...boardTrendsExample, series: [{ ...boardTrendsExample.series[0], userId: 'other' }] },
    ],
  ];
  for (const [read, value] of cases) {
    data = value;
    await assert.rejects(
      read,
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
  }
});
