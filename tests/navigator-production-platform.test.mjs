import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { taskExample } from '../apps/server/src/modules/production/production.schema.ts';
import { assigneesResponse } from '../apps/server/src/modules/production/output-report.schema.ts';
import { acceptanceReviewBody } from '../apps/server/src/modules/production/quality-acceptance.schema.ts';

const review = acceptanceReviewBody.examples[0];
const endpoint = '/api/v1/production-tasks/acceptance/review';
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};
const wrap = (data, status = 200, code = status) =>
  new Response(JSON.stringify({ code, message: '真实验收结果', data }), {
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
  test(`${mode} navigator acceptance uses the existing review route, exact source and unmodified decision body`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    for (const input of [
      review,
      { projectId: 17, subtaskId: 29, decision: 'ACCEPT' },
      { projectId: 17, subtaskId: 29, decision: 'ACCEPT', rejectReason: null },
      { projectId: 17, subtaskId: 29, decision: 'ACCEPT', rejectReason: ' \n\t ' },
      {
        projectId: 2147483647,
        subtaskId: 2147483647,
        decision: 'REJECT',
        rejectReason: '界'.repeat(500),
      },
    ]) {
      assert.equal(await api.reviewProductionAcceptance(input), undefined);
      assert.deepEqual(calls.at(-1).data, input);
    }
    for (const call of calls) {
      assert.equal(call.path, endpoint);
      assert.equal(call.method, 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.headers['Content-Type'], 'application/json');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers['X-Tyde-Role'], undefined);
    }
  });

  test(`${mode} navigator reuses task snapshots and actual assignees without PM context or report requests`, async (t) => {
    const tasks = structuredClone(taskExample);
    Object.assign(tasks.records[0], {
      status: 'PENDING_ACCEPTANCE',
      actualDeliveryDate: '2026-11-04',
      actualQuantity: 12.1234,
      reportedQuantity: 12,
      quantityAdjustmentRemark: '补充交付量',
      submittedByName: '真实提交人',
      submittedAt: '2026-11-04 10:00:00',
      allowedActions: ['ACCEPT', 'REJECT'],
    });
    const assignees = assigneesResponse.examples[0];
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(path.endsWith('/member-list') ? assignees : tasks),
    );
    const query = { projectId: 7, statuses: ['PENDING_ACCEPTANCE'], keyword: null };
    const memberQuery = { projectId: 7, subtaskId: tasks.records[0].subtaskId };
    assert.deepEqual(await api.listProductionTasks(query), tasks);
    assert.deepEqual(await api.listProductionTaskAssignees(memberQuery), assignees);
    assert.deepEqual(
      calls.map(({ path, data }) => [path, data]),
      [
        ['/api/v1/production-tasks/list', query],
        ['/api/v1/production-tasks/member-list', memberQuery],
      ],
    );
  });

  test(`${mode} rejected and unknown reviews never replay, change source or fall back to another API`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 404, 408, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.reviewProductionAcceptance(review),
        (error) => error.status === status,
      );
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).path, endpoint);
      assert.deepEqual(calls.at(-1).data, review);
    }
  });

  test(`${mode} an explicit 401 refreshes once and retries the identical navigator review`, async (t) => {
    let attempts = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) return wrap(tokens);
      return wrap(null, ++attempts === 1 ? 401 : 200);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'NAVIGATOR' });
    await api.reviewProductionAcceptance(review);
    const commands = calls.filter(({ path }) => path === endpoint);
    assert.equal(commands.length, 2);
    assert.deepEqual(
      commands.map(({ data }) => data),
      [review, review],
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
  });

  test(`${mode} a second 401 stops after the existing single refresh`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(path.includes('/auth/') ? tokens : null, path.includes('/auth/') ? 200 : 401),
    );
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'NAVIGATOR' });
    await assert.rejects(
      () => api.reviewProductionAcceptance(review),
      (error) => error.status === 401,
    );
    assert.equal(calls.filter(({ path }) => path === endpoint).length, 2);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
  });
}

test('navigator review rejects invalid IDs, extra source fields and contradictory or overlong reasons before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  const invalid = [null, [], {}, { ...review, decision: 'APPROVE' }];
  for (const key of ['projectId', 'subtaskId'])
    for (const value of [undefined, null, 0, -1, 1.5, '1', 2147483648, Infinity, NaN])
      invalid.push({ ...review, [key]: value });
  for (const rejectReason of [undefined, null, '', ' \n\t ', 1, false, {}, [], '界'.repeat(501)])
    invalid.push({ ...review, rejectReason });
  invalid.push({ ...review, rejectReason: ' '.repeat(500) + 'x' });
  invalid.push({ ...review, decision: 'ACCEPT', rejectReason: '不应通过' });
  for (const key of [
    'versionNo',
    'idempotencyKey',
    'expectedSubmittedAt',
    'memberId',
    'organizationId',
    'sourceBizId',
    'role',
  ])
    invalid.push({ ...review, [key]: 1 });
  for (const input of invalid)
    await assert.rejects(
      () => api.reviewProductionAcceptance(input),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('navigator review success requires null data and never accepts another source or guessed result as a receipt', async (t) => {
  let data;
  const { api, calls } = adapter(t, false, () => wrap(data));
  for (data of [undefined, {}, [], false, 0, '', { projectId: 9, subtaskId: 99, success: true }]) {
    const before = calls.length;
    await assert.rejects(
      () => api.reviewProductionAcceptance(review),
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
    assert.equal(calls.length, before + 1);
  }
});

test('navigator review preserves a 2xx business refusal and never retries it', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null, 200, 409));
  await assert.rejects(
    () => api.reviewProductionAcceptance(review),
    (error) => error.status === 200 && error.code === 409,
  );
  assert.equal(calls.length, 1);
});
