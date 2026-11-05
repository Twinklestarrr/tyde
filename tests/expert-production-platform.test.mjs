import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  reportableResponse,
  saveBody,
  correctBody,
  reportsResponse,
} from '../apps/server/src/modules/production/output-report.schema.ts';

const save = saveBody.examples[0];
const correct = correctBody.examples[0];
const tasks = reportableResponse.examples[0];
const largeQuantity = '99999999999999999999999999.9999';
const wrap = (data, status = 200, message = '后端结果') =>
  new Response(JSON.stringify({ code: status, message, data }), {
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

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} reportable task reads use the real project-only POST and preserve an empty eligible set`, async (t) => {
    let data = tasks;
    const { api, calls } = adapter(t, desktop, () => wrap(data));
    assert.deepEqual(await api.listReportableProductionTasks(1), tasks);
    data = [];
    assert.deepEqual(await api.listReportableProductionTasks(1), []);
    assert.equal(calls[0].path, '/api/v1/production-tasks/reportable-list');
    assert.deepEqual(calls[0].data, { projectId: 1 });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].credentials, desktop ? 'include' : 'same-origin');
    assert.equal(calls[0].headers['X-Tyde-Client'], 'web');
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  test(`${mode} output saves retain exact decimal strings, source member IDs and explicit project or task levels`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    const input = {
      projectId: 1,
      reports: [
        { reportDate: '2026-10-26', quantity: '0', remark: null },
        { subtaskId: 1, memberId: null, reportDate: '2026-10-26', quantity: largeQuantity },
        {
          subtaskId: null,
          memberId: 17,
          reportDate: '2026-10-26',
          quantity: '9007199254740993.0001',
          remark: '仅指定此成员来源',
        },
        { subtaskId: 1, memberId: 18, reportDate: '2026-10-25', quantity: 0 },
      ],
    };
    assert.equal(await api.saveProductionOutputReports(input), undefined);
    assert.deepEqual(calls[0].data, input);
    assert.equal(Object.hasOwn(calls[0].data.reports[0], 'memberId'), false);
    assert.equal(calls[0].path, '/api/v1/production-tasks/report/save');
    assert.equal(calls[0].credentials, desktop ? 'include' : 'same-origin');
    assert.equal(calls[0].headers['Idempotency-Key'], undefined);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].headers['X-Tyde-Role'], undefined);
  });

  test(`${mode} returned-report correction only submits the original report ID and revised values`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    const input = { ...correct, quantity: largeQuantity };
    assert.equal(await api.correctProductionOutputReport(input), undefined);
    assert.equal(calls[0].path, '/api/v1/production-tasks/report/correct');
    assert.deepEqual(calls[0].data, input);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['Idempotency-Key'], undefined);
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  test(`${mode} identity ambiguity, denied sources, conflicts and unknown writes never fall back to another member or replay`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status, '原成员来源失效或身份不唯一');
    });
    for (status of [400, 403, 404, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      for (const write of [
        () => api.saveProductionOutputReports(save),
        () => api.correctProductionOutputReport(correct),
      ])
        await assert.rejects(write, (error) => error.status === status);
      assert.equal(calls.length - before, 2);
      assert.deepEqual(calls.at(-2).data, save);
      assert.deepEqual(calls.at(-1).data, correct);
    }
  });

  test(`${mode} explicit 401 refresh retries unchanged expert commands only once`, async (t) => {
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
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'EXPERT' });
    await api.saveProductionOutputReports(save);
    await api.correctProductionOutputReport(correct);
    const commands = calls.filter(({ path }) => !path.includes('/auth/'));
    assert.equal(commands.length, 4);
    assert.deepEqual(commands[0].data, commands[1].data);
    assert.deepEqual(commands[2].data, commands[3].data);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 2);
  });
}

test('expert output trust boundaries reject invalid sources, duplicate member-level-days and malformed decimals before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const projectId of [0, -1, '1', 2147483648])
    await assert.rejects(
      () => api.listReportableProductionTasks(projectId),
      (error) => error.status === 400,
    );
  for (const patch of [
    { memberId: 0 },
    { memberId: '1' },
    { subtaskId: 0 },
    { reportDate: '2026-02-30' },
    { quantity: '-1' },
    { quantity: 0.00001 },
    { quantity: '1e25' },
    { quantity: '100000000000000000000000000' },
    { quantity: NaN },
    { remark: 'x'.repeat(1001) },
    { assignmentId: 17 },
    { movementId: 17 },
    { organizationId: 'other' },
  ])
    await assert.rejects(
      () =>
        api.saveProductionOutputReports({
          projectId: 1,
          reports: [{ reportDate: '2026-10-26', quantity: '1', ...patch }],
        }),
      (error) => error.status === 400,
    );
  for (const reports of [
    [],
    Array(101).fill(save.reports[0]),
    [save.reports[0], save.reports[0]],
    [
      { reportDate: '2026-10-26', quantity: 1 },
      { memberId: null, subtaskId: null, reportDate: '2026-10-26', quantity: 2 },
    ],
  ])
    await assert.rejects(
      () => api.saveProductionOutputReports({ projectId: 1, reports }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { reportId: 0 },
    { reportDate: '2026-10-25' },
    { memberId: 17 },
    { subtaskId: 1 },
    { quantity: -1 },
    { remark: 'x'.repeat(1001) },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.correctProductionOutputReport({ ...correct, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('expert output batches accept exactly 512 KiB UTF-8 JSON and reject the next byte before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null));
  const input = {
    projectId: 1,
    reports: Array.from({ length: 100 }, (_, index) => ({
      memberId: index + 1,
      subtaskId: null,
      reportDate: '2026-10-26',
      quantity: '0',
      remark: '',
    })),
  };
  let remaining = 512 * 1024 - Buffer.byteLength(JSON.stringify(input), 'utf8');
  for (const row of input.reports) {
    const characters = Math.min(1000, Math.floor(remaining / 6));
    row.remark = '\u0001'.repeat(characters);
    remaining -= characters * 6;
  }
  assert.ok(remaining >= 0 && remaining < 6);
  input.reports.at(-1).remark += 'a'.repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify(input), 'utf8'), 512 * 1024);
  assert.ok(input.reports.every(({ remark }) => remark.length <= 1000));
  await api.saveProductionOutputReports(input);
  assert.equal(calls.length, 1);
  input.reports.at(-1).remark += 'a';
  await assert.rejects(
    () => api.saveProductionOutputReports(input),
    (error) => error.status === 413,
  );
  assert.equal(calls.length, 1);
});

test('expert production reuses common report reads and preserves the backend-provided correction authority', async (t) => {
  const data = {
    ...reportsResponse.examples[0],
    page: {
      ...reportsResponse.examples[0].page,
      records: [
        {
          ...reportsResponse.examples[0].page.records[0],
          reviewStatus: 'RETURNED',
          returnReason: '请修正',
          allowedActions: ['SAVE_REPORT'],
        },
      ],
    },
  };
  const { api, calls } = adapter(t, false, () => wrap(data));
  assert.deepEqual(await api.listProductionOutputReports({ projectId: 1, subtaskId: null }), data);
  assert.equal(calls[0].path, '/api/v1/production-tasks/reports');
  assert.deepEqual(calls[0].data, { projectId: 1, subtaskId: null });
});

test('expert production rejects malformed reportable tasks and fake successful command responses', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  for (data of [
    null,
    {},
    [{ ...tasks[0], subtaskId: 0 }],
    [{ ...tasks[0], quantityUnit: undefined }],
    [{ ...tasks[0], distributionMode: 'OTHER' }],
    [tasks[0], tasks[0]],
  ])
    await assert.rejects(
      () => api.listReportableProductionTasks(1),
      (error) => error.status === 502,
    );
  for (data of [{ success: true }, undefined, []]) {
    await assert.rejects(
      () => api.saveProductionOutputReports(save),
      (error) => error.status === 502,
    );
    await assert.rejects(
      () => api.correctProductionOutputReport(correct),
      (error) => error.status === 502,
    );
  }
});
