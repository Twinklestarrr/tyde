import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  createBody,
  memberExample,
  taskExample,
} from '../apps/server/src/modules/production/production.schema.ts';
import {
  assigneesResponse,
  reportsResponse,
  reviewBody,
} from '../apps/server/src/modules/production/output-report.schema.ts';
import {
  productionListBody,
  productionListResponse,
  qualityContextBody,
  qualityContextResponse,
  qualitySaveBody,
  acceptanceContextResponse,
  acceptanceSubmitBody,
} from '../apps/server/src/modules/production/quality-acceptance.schema.ts';

const create = createBody.examples[0];
const review = reviewBody.examples[0];
const qualityKey = qualityContextBody.examples[0];
const quality = qualitySaveBody.examples[0];
const acceptanceKey = { projectId: 1, subtaskId: 1 };
const acceptance = acceptanceSubmitBody.examples[0];
const reports = reportsResponse.examples[0];
const wrap = (data, status = 200) =>
  new Response(JSON.stringify({ code: status, message: '服务端结果', data }), {
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
const writes = (api) => [
  () => api.createProductionTask(create),
  () => api.reviewProductionOutputReports(review),
  () => api.savePersonnelQuality(quality),
  () => api.submitProductionAcceptance(acceptance),
];

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} production reads use the exact POST contracts and preserve full totals, history and permission gates`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(
        path.endsWith('/members')
          ? memberExample
          : path.endsWith('/member-list')
            ? assigneesResponse.examples[0]
            : path.endsWith('/production-tasks/list')
              ? taskExample
              : path.endsWith('/reports')
                ? reports
                : path.endsWith('/production/list')
                  ? productionListResponse.examples[0]
                  : path.endsWith('/quality/context')
                    ? qualityContextResponse.examples[0]
                    : acceptanceContextResponse.examples[0],
      ),
    );
    const memberQuery = { projectId: 1, keyword: '成员', current: 1, size: 20 };
    const taskQuery = { projectId: 1, statuses: ['IN_PROGRESS'], keyword: null };
    const reportQuery = {
      projectId: 1,
      subtaskId: null,
      reviewStatuses: ['PENDING'],
      reportDateStart: '2026-10-01',
      reportDateEnd: '2026-10-31',
    };
    assert.deepEqual(await api.listProductionTaskMembers(memberQuery), memberExample);
    assert.deepEqual(await api.listProductionTasks(taskQuery), taskExample);
    assert.deepEqual(
      await api.listProductionTaskAssignees({ ...memberQuery, subtaskId: 1 }),
      assigneesResponse.examples[0],
    );
    assert.deepEqual(await api.listProductionOutputReports(reportQuery), reports);
    assert.deepEqual(
      await api.listPersonnelProduction(productionListBody.examples[0]),
      productionListResponse.examples[0],
    );
    assert.deepEqual(
      await api.getPersonnelQualityContext(qualityKey),
      qualityContextResponse.examples[0],
    );
    assert.deepEqual(
      await api.getProductionAcceptanceContext(acceptanceKey),
      acceptanceContextResponse.examples[0],
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/production-tasks/members',
        '/api/v1/production-tasks/list',
        '/api/v1/production-tasks/member-list',
        '/api/v1/production-tasks/reports',
        '/api/v1/project-personnel/production/list',
        '/api/v1/project-personnel/production/quality/context',
        '/api/v1/production-tasks/acceptance/context',
      ],
    );
    assert.deepEqual(calls[0].data, memberQuery);
    assert.deepEqual(calls[3].data, reportQuery);
    assert.deepEqual(calls[5].data, qualityKey);
    for (const call of calls) {
      assert.equal(call.method, 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], 'web');
    }
  });

  test(`${mode} PM writes preserve exact decimal strings, selected level and dual-mode assignment without invented version keys`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    for (const write of writes(api)) assert.equal(await write(), undefined);
    assert.deepEqual(
      calls.map(({ path, data }) => [path, data]),
      [
        ['/api/v1/production-tasks/create', create],
        ['/api/v1/production-tasks/report/review', review],
        ['/api/v1/project-personnel/production/quality/save', quality],
        ['/api/v1/production-tasks/acceptance/submit', acceptance],
      ],
    );
    for (const call of calls) {
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['Content-Type'], 'application/json');
    }
    await api.createProductionTask(createBody.examples[1]);
    assert.equal(calls.at(-1).data.distributionMode, 'POOL');
    for (const reportIds of [undefined, null, []]) {
      const input = {
        projectId: 1,
        subtaskId: null,
        action: 'VERIFY',
        ...(reportIds === undefined ? {} : { reportIds }),
      };
      await api.reviewProductionOutputReports(input);
      assert.deepEqual(calls.at(-1).data, input);
    }
    assert.equal(typeof calls[3].data.actualQuantity, 'string');
  });

  test(`${mode} PM command refusal and unknown response paths never replay writes`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 404, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      for (const write of writes(api))
        await assert.rejects(write, (error) => error.status === status);
      assert.equal(calls.length - before, 4);
    }
  });

  test(`${mode} explicit 401 refreshes and retries an unchanged command once`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    const first = new Set();
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) return wrap(tokens);
      if (!first.has(path)) {
        first.add(path);
        return wrap(null, 401);
      }
      return wrap(null);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'PM' });
    for (const write of writes(api)) await write();
    const commands = calls.filter(({ path }) => !path.includes('/auth/'));
    assert.equal(commands.length, 8);
    for (let i = 0; i < commands.length; i += 2)
      assert.deepEqual(commands[i].data, commands[i + 1].data);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 4);
  });
}

test('production decimal input retains all 26 integer and 4 fractional digits, including exact quality comparisons', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null));
  const large = '99999999999999999999999999.9999';
  for (const quantity of [large, '9007199254740993.0001', '0.0001', 1e25, 10.1234]) {
    await api.createProductionTask({ ...create, expectedQuantity: quantity });
    assert.equal(calls.at(-1).data.expectedQuantity, quantity);
  }
  const exact = {
    ...quality,
    items: [
      {
        outputReportId: 1,
        inspectedQuantity: large,
        qualifiedQuantity: '99999999999999999999999999.9998',
      },
    ],
  };
  await api.savePersonnelQuality(exact);
  assert.deepEqual(calls.at(-1).data, exact);
  const repeated = {
    ...quality,
    items: [quality.items[0], { ...quality.items[0], qualifiedQuantity: '0' }],
  };
  await api.savePersonnelQuality(repeated);
  assert.deepEqual(calls.at(-1).data, repeated);
  await api.submitProductionAcceptance({ ...acceptance, actualQuantity: large });
  assert.equal(calls.at(-1).data.actualQuantity, large);
  const before = calls.length;
  for (const expectedQuantity of [
    '0',
    0,
    '-1',
    '1e25',
    '0.00001',
    '100000000000000000000000000',
    1e26,
    Infinity,
    NaN,
  ])
    await assert.rejects(
      () => api.createProductionTask({ ...create, expectedQuantity }),
      (error) => error.status === 400,
    );
  await assert.rejects(
    () =>
      api.savePersonnelQuality({
        ...quality,
        items: [
          {
            outputReportId: 1,
            inspectedQuantity: '99999999999999999999999999.9998',
            qualifiedQuantity: large,
          },
        ],
      }),
    (error) => error.status === 400,
  );
  assert.equal(calls.length, before);
});

test('quality requests honor the distinct exact 512 KiB JSON UTF-8 boundary rather than the default 16 KiB limit', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null));
  const input = {
    ...qualityKey,
    items: Array.from({ length: 100 }, () => ({
      outputReportId: 1,
      inspectedQuantity: '1',
      qualifiedQuantity: '0',
      unqualifiedReason: '',
    })),
  };
  let remaining = 512 * 1024 - Buffer.byteLength(JSON.stringify(input), 'utf8');
  for (const item of input.items) {
    const escapedCharacters = Math.min(1000, Math.floor(remaining / 6));
    item.unqualifiedReason = '\u0001'.repeat(escapedCharacters);
    remaining -= escapedCharacters * 6;
  }
  assert.ok(remaining >= 0 && remaining < 6);
  input.items.at(-1).unqualifiedReason += 'a'.repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify(input), 'utf8'), 512 * 1024);
  assert.ok(input.items.every(({ unqualifiedReason }) => unqualifiedReason.length <= 1000));
  await api.savePersonnelQuality(input);
  assert.equal(calls.length, 1);
  input.items.at(-1).unqualifiedReason += 'a';
  await assert.rejects(
    () => api.savePersonnelQuality(input),
    (error) => error.status === 413,
  );
  assert.equal(calls.length, 1);
});

test('production inputs enforce paging, task modes, date ranges and report-review scope without accepting foreign operations', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const patch of [
    { projectId: 0 },
    { current: 0 },
    { size: 101 },
    { keyword: 'x'.repeat(101) },
    { statuses: ['IN_PROGRESS'] },
  ])
    await assert.rejects(
      () => api.listProductionTaskMembers({ projectId: 1, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { subtaskName: ' ' },
    { subtaskName: 'x'.repeat(129) },
    { expectedDeliveryDate: '2026-02-30' },
    { distributionMode: 'POOL' },
    { memberIds: [] },
    { memberIds: Array(1001).fill(1) },
    { memberIds: ['1'] },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.createProductionTask({ ...create, ...patch }),
      (error) => error.status === 400,
    );
  await assert.rejects(
    () => api.listProductionTasks({ projectId: 1, statuses: ['CLOSED'] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => api.listProductionTaskAssignees({ projectId: 1, subtaskId: 0 }),
    (error) => error.status === 400,
  );
  for (const patch of [
    { subtaskId: 0 },
    { reviewStatuses: ['APPROVED'] },
    { reportDateStart: '' },
    { reportDateStart: '2026-10-26', reportDateEnd: '2026-10-01' },
  ])
    await assert.rejects(
      () => api.listProductionOutputReports({ projectId: 1, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { reportIds: [] },
    { reportIds: [1, 2] },
    { reason: ' ' },
    { action: 'ACCEPT' },
    { reason: 'x'.repeat(501) },
    { reportIds: Array(1001).fill(1) },
  ])
    await assert.rejects(
      () => api.reviewProductionOutputReports({ ...review, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { reportDateStart: '2026-10-01', reportDateEnd: '2026-11-01' },
    { reportDateStart: '2026-10-26', reportDateEnd: '2026-10-01' },
    { organizationIds: ['1'] },
    { dataSources: ['AUTO'] },
    { accountTypes: ['USER'] },
  ])
    await assert.rejects(
      () => api.listPersonnelProduction({ projectId: 1, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { items: [] },
    { items: Array(101).fill(quality.items[0]) },
    { items: [{ outputReportId: 1, inspectedQuantity: 0, qualifiedQuantity: 0 }] },
    { items: [{ ...quality.items[0], unqualifiedReason: 'x'.repeat(1001) }] },
  ])
    await assert.rejects(
      () => api.savePersonnelQuality({ ...quality, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { subtaskId: 0 },
    { actualQuantity: 0 },
    { actualDeliveryDate: '2026-02-30' },
    { quantityAdjustmentRemark: 'x'.repeat(1001) },
    { decision: 'ACCEPT' },
  ])
    await assert.rejects(
      () => api.submitProductionAcceptance({ ...acceptance, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('production decoding preserves large numeric outputs, readonly quality history, nullable placeholders and acceptance gates', async (t) => {
  let data = {
    ...taskExample,
    records: [
      {
        ...taskExample.records[0],
        expectedQuantity: 1e25,
        actualQuantity: 1e25,
        allowedActions: ['SUBMIT_ACCEPTANCE'],
      },
    ],
  };
  const { api } = adapter(t, false, () => wrap(data));
  assert.deepEqual(await api.listProductionTasks({ projectId: 1 }), data);
  const history = qualityContextResponse.examples[0];
  data = {
    ...history,
    items: [
      { ...history.items[0], qualityId: 2, qualityDataSource: 'WORK_SYSTEM', editable: false },
      { ...history.items[0], editable: false },
      {
        ...history.items[0],
        outputReportId: 2,
        qualityId: null,
        inspectedQuantity: null,
        qualifiedQuantity: null,
        unqualifiedReason: null,
        operatorName: null,
        operationTime: null,
        qualityDataSource: null,
        editable: true,
      },
    ],
  };
  assert.deepEqual(await api.getPersonnelQualityContext(qualityKey), data);
  data = {
    ...acceptanceContextResponse.examples[0],
    reportedQuantity: 1e25,
    defaultActualQuantity: 1e25,
    canSubmit: false,
  };
  assert.deepEqual(await api.getProductionAcceptanceContext(acceptanceKey), data);
  data = {
    ...productionListResponse.examples[0],
    records: [
      {
        ...productionListResponse.examples[0].records[0],
        inspectedQuantity: 0,
        qualifiedQuantity: 0,
        unqualifiedQuantity: 0,
        accuracyRate: null,
        allowedActions: [],
      },
    ],
  };
  assert.deepEqual(await api.listPersonnelProduction({ projectId: 1 }), data);
});

test('production response decoders reject mismatched levels, missing permissions, malformed facts and fake write success', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  for (const patch of [
    { subtaskId: 0 },
    { allowedActions: undefined },
    { expectedDeliveryDate: '2026-02-30' },
    { assigneeNames: ['1', '2', '3', '4'] },
    { submittedAt: '2026-02-30 09:00:00' },
  ]) {
    data = { ...taskExample, records: [{ ...taskExample.records[0], ...patch }] };
    await assert.rejects(
      () => api.listProductionTasks({ projectId: 1 }),
      (error) => error.status === 502,
    );
  }
  data = reports;
  await assert.rejects(
    () => api.listProductionOutputReports({ projectId: 1, subtaskId: 1 }),
    (error) => error.status === 502,
  );
  data = { ...reports, totalReportCount: 2 };
  await assert.rejects(
    () => api.listProductionOutputReports({ projectId: 1 }),
    (error) => error.status === 502,
  );
  for (const patch of [
    { memberId: 2 },
    { reportDate: '2026-10-25' },
    { items: [{ ...qualityContextResponse.examples[0].items[0], editable: undefined }] },
  ]) {
    data = { ...qualityContextResponse.examples[0], ...patch };
    await assert.rejects(
      () => api.getPersonnelQualityContext(qualityKey),
      (error) => error.status === 502,
    );
  }
  data = { ...acceptanceContextResponse.examples[0], subtaskId: 2 };
  await assert.rejects(
    () => api.getProductionAcceptanceContext(acceptanceKey),
    (error) => error.status === 502,
  );
  for (data of [{ success: true }, [], undefined])
    for (const write of writes(api)) await assert.rejects(write, (error) => error.status === 502);
});
