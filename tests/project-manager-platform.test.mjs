import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';

const candidateUserId = '00000000-0000-4000-8000-00000000000a';
const previousUserId = '00000000-0000-4000-8000-00000000000b';
const candidate = {
  status: 'RECOMMENDED',
  userId: candidateUserId,
  uid: 'PM-FIXTURE-1',
  name: '候选昵称(候选姓名)',
  avatarUrl: null,
  currentProjectCount: 0,
};
const current = {
  ...candidate,
  status: 'CURRENT',
  userId: previousUserId,
  currentProjectCount: 3,
};
const input = { projectId: 17, candidateUserId };
const assigned = {
  recruitmentId: 51,
  projectId: 17,
  recruitmentType: 'INITIAL',
  assignmentMode: 'DIRECT',
  status: 'ASSIGNED',
  manager: { ...candidate, status: 'CURRENT', currentProjectCount: 1 },
  currentNodeCode: 'PRODUCTION_PLAN',
  nextStage: 'PRODUCTION_PLAN',
  primaryAction: 'CHANGE_PROJECT_MANAGER',
  assignedAt: '2026-10-26 09:30:01',
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 3600,
};
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '服务端真实错误', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: url.slice(origin.length),
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
  const mode = desktop ? 'Electron renderer' : 'Web';
  test(`${mode} manager candidates use the real unpaged query and preserve server results`, async (t) => {
    let data = [current, candidate];
    const { api, calls } = adapter(t, desktop, () => result(data));
    assert.deepEqual(await api.listProjectManagerCandidates({ projectId: 17 }), data);
    assert.deepEqual(
      await api.listProjectManagerCandidates({ projectId: 17, keyword: '  姓名&昵称%_  ' }),
      data,
    );
    data = [];
    assert.deepEqual(await api.listProjectManagerCandidates({ projectId: 17, keyword: '   ' }), []);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/projects/manager-candidates?projectId=17',
        '/api/v1/projects/manager-candidates?projectId=17&keyword=%E5%A7%93%E5%90%8D%26%E6%98%B5%E7%A7%B0%25_',
        '/api/v1/projects/manager-candidates?projectId=17',
      ],
    );
    assert.ok(
      calls.every(
        ({ method, body, headers, credentials }) =>
          method === 'GET' &&
          body === undefined &&
          !headers.Authorization &&
          !headers['X-Tyde-Client'] &&
          credentials === (desktop ? 'include' : 'same-origin'),
      ),
    );
  });

  test(`${mode} direct manager assignment sends only project and candidate and accepts truthful replacement stages`, async (t) => {
    let data = assigned;
    const { api, calls } = adapter(t, desktop, () => result(data));
    assert.deepEqual(await api.recruitProjectManager(input), assigned);
    for (const stage of [
      'RECRUIT_PROJECT_MANAGER',
      'PRODUCTION_PLAN',
      'ENTRANCE_EXAM',
      'STANDARD_TRAINING',
      'RECRUIT_EXECUTION_EXPERT',
      'PERSONNEL_MANAGEMENT',
      'PRODUCTION_TASK',
      'COMPLETED',
      null,
    ]) {
      data = {
        ...assigned,
        recruitmentType: 'REPLACEMENT',
        currentNodeCode: stage,
        nextStage: stage,
      };
      assert.deepEqual(await api.recruitProjectManager(input), data);
    }
    assert.deepEqual(
      await api.recruitProjectManager({ ...input, candidateUserId: candidateUserId.toUpperCase() }),
      data,
    );
    assert.ok(
      calls.every(
        ({ path, method, headers, credentials, data: body }) =>
          path === '/api/v1/projects/manager-recruitments' &&
          method === 'POST' &&
          headers['Content-Type'] === 'application/json' &&
          headers['X-Tyde-Client'] === 'web' &&
          !headers.Authorization &&
          !headers['Idempotency-Key'] &&
          credentials === (desktop ? 'include' : 'same-origin') &&
          body.projectId === 17 &&
          Object.keys(body).length === 2,
      ),
    );
  });

  test(`${mode} manager failures keep server statuses and do not replay unknown assignment outcomes`, async (t) => {
    let outcome = 400;
    const { api, calls } = adapter(t, desktop, () => {
      if (outcome === 'network') throw new TypeError('offline');
      if (outcome === 'malformed') return result({ ...assigned, projectId: 18 });
      return result(null, outcome);
    });
    for (outcome of [400, 403, 404, 409, 500, 503]) {
      const before = calls.length;
      await assert.rejects(
        api.recruitProjectManager(input),
        (error) => error.status === outcome && error.message === '服务端真实错误',
      );
      assert.equal(calls.length, before + 1);
    }
    outcome = 'network';
    await assert.rejects(
      api.recruitProjectManager(input),
      (error) => error.status === 0 && error.code === 'NETWORK_ERROR',
    );
    outcome = 'malformed';
    await assert.rejects(api.recruitProjectManager(input), (error) => error.status === 502);
    assert.equal(calls.length, 8);
  });

  test(`${mode} explicit 401 refreshes once, retains exact assignment payload and stops after a second 401`, async (t) => {
    let rejected = 0;
    let alwaysReject = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/auth/login') return result(tokens);
      if (path === '/api/v1/auth/refresh')
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      if (path === '/api/v1/projects/manager-recruitments')
        return ++rejected === 1 || alwaysReject ? result(null, 401) : result(assigned);
      throw new Error('Unexpected endpoint');
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    assert.deepEqual(await api.recruitProjectManager(input), assigned);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/auth/login',
        '/api/v1/projects/manager-recruitments',
        '/api/v1/auth/refresh',
        '/api/v1/projects/manager-recruitments',
      ],
    );
    assert.equal(calls[1].body, calls[3].body);
    alwaysReject = true;
    const before = calls.length;
    await assert.rejects(api.recruitProjectManager(input), (error) => error.status === 401);
    assert.equal(calls.length, before + 3);
    assert.equal(calls.filter(({ path }) => path === '/api/v1/auth/refresh').length, 2);
  });
}

test('manager candidate decoding rejects incomplete or mistyped identities and candidate fields', async (t) => {
  let value;
  const { api } = adapter(t, false, () => result(value));
  for (const patch of [
    { status: 'ASSIGNED' },
    { userId: 1 },
    { userId: 'other-user' },
    { uid: null },
    { name: null },
    { avatarUrl: undefined },
    { currentProjectCount: -1 },
    { currentProjectCount: 1.5 },
    { currentProjectCount: '2' },
  ]) {
    value = [{ ...candidate, ...patch }];
    await assert.rejects(
      api.listProjectManagerCandidates({ projectId: 17 }),
      (error) => error.status === 502,
    );
  }
  value = { records: [candidate] };
  await assert.rejects(
    api.listProjectManagerCandidates({ projectId: 17 }),
    (error) => error.status === 502,
  );
});

test('manager assignment decoding correlates project, candidate, state and Shanghai timestamp', async (t) => {
  let value;
  const { api } = adapter(t, false, () => result(value));
  for (const patch of [
    { recruitmentId: 0 },
    { recruitmentId: '51' },
    { projectId: 18 },
    { recruitmentType: 'OTHER' },
    { assignmentMode: 'REQUIRE_ACCEPTANCE' },
    { status: 'PENDING' },
    { manager: { ...assigned.manager, status: 'RECOMMENDED' } },
    { manager: { ...assigned.manager, userId: previousUserId } },
    { manager: { ...assigned.manager, name: undefined } },
    { currentNodeCode: 'OTHER', nextStage: 'OTHER' },
    { currentNodeCode: 'STANDARD_TRAINING', nextStage: 'STANDARD_TRAINING' },
    { currentNodeCode: null, nextStage: null },
    { nextStage: null },
    { primaryAction: 'VIEW_DETAIL' },
    { assignedAt: '2026-02-30 09:30:01' },
    { assignedAt: '2026-10-26T09:30:01Z' },
  ]) {
    value = { ...assigned, ...patch };
    await assert.rejects(api.recruitProjectManager(input), (error) => error.status === 502);
  }
});

test('manager trust boundaries reject invalid IDs, keyword and unexpected input before requesting', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('Should not request');
  });
  for (const projectId of [0, -1, 1.5, 2147483648, '17', undefined]) {
    await assert.rejects(
      api.listProjectManagerCandidates({ projectId }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      api.recruitProjectManager({ ...input, projectId }),
      (error) => error.status === 400,
    );
  }
  for (const query of [
    null,
    { projectId: 17, keyword: 1 },
    { projectId: 17, keyword: '名'.repeat(101) },
    { projectId: 17, current: 1 },
  ])
    await assert.rejects(api.listProjectManagerCandidates(query), (error) => error.status === 400);
  for (const body of [
    null,
    { ...input, candidateUserId: '' },
    { ...input, candidateUserId: 2 },
    { ...input, candidateUserId: 'PM-FIXTURE-1' },
    { ...input, versionNo: 1 },
  ])
    await assert.rejects(api.recruitProjectManager(body), (error) => error.status === 400);
  assert.equal(calls.length, 0);
});
