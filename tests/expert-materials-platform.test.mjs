import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { materialsExample } from '../apps/server/src/modules/projects/project-materials.schema.ts';

const confirmed = {
  ...materialsExample,
  canConfirmRead: false,
  confirmedReadAt: '2026-11-03 09:00:00',
  readConfirmationTransitioned: true,
  stateTransitioned: false,
};
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '服务端明确拒绝', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = { ...options, path: String(url).slice(origin.length) };
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
  test(`${mode} expert read confirmation uses POST query without JSON or version and retains repeat-confirmation facts`, async (t) => {
    let first = true;
    const { api, calls } = adapter(t, desktop, () => {
      const data = { ...confirmed, readConfirmationTransitioned: first };
      first = false;
      return result(data);
    });
    assert.deepEqual(await api.confirmProjectStandardMaterialsRead(3001), confirmed);
    assert.deepEqual(await api.confirmProjectStandardMaterialsRead(3001), {
      ...confirmed,
      readConfirmationTransitioned: false,
    });
    for (const call of calls) {
      assert.equal(call.path, '/api/v1/projects/standard-materials/confirm-read?projectId=3001');
      assert.equal(call.method, 'POST');
      assert.equal(call.body, undefined);
      assert.equal(call.headers['Content-Type'], undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
    }
    assert.equal(calls.length, 2);
  });

  test(`${mode} expert read confirmation never replays uncertain writes and preserves real refusal statuses`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return result(null, status);
    });
    for (status of [400, 403, 404, 409, 500, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.confirmProjectStandardMaterialsRead(3001),
        (error) => error.status === status,
      );
      assert.equal(calls.length - before, 1);
    }
  });

  test(`${mode} an explicit 401 refreshes exactly once and retries the same body-free confirmation`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    let attempts = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return result(tokens);
      return ++attempts === 1 ? result(null, 401) : result(confirmed);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'EXPERT' });
    assert.deepEqual(await api.confirmProjectStandardMaterialsRead(3001), confirmed);
    const confirmations = calls.filter(({ path }) => path.includes('/confirm-read?'));
    assert.equal(confirmations.length, 2);
    assert.ok(confirmations.every(({ body }) => body === undefined));
    assert.equal(confirmations[0].path, confirmations[1].path);
    assert.equal(calls.filter(({ path }) => path === '/api/v1/auth/refresh').length, 1);
  });

  test(`${mode} confirmation rejects mismatched projects, incomplete metadata and unconfirmed success responses`, async (t) => {
    let data = confirmed;
    const { api, calls } = adapter(t, desktop, () => result(data));
    for (const patch of [
      { projectId: 3002 },
      { confirmedReadAt: null },
      { confirmedReadAt: '2026-02-30 09:00:00' },
      { canConfirmRead: true },
      { stateTransitioned: true },
      { readConfirmationTransitioned: undefined },
      { versionNo: -1 },
      { attachments: [{ ...confirmed.attachments[0], status: 'DELETED' }] },
    ]) {
      data = { ...confirmed, ...patch };
      const before = calls.length;
      await assert.rejects(
        () => api.confirmProjectStandardMaterialsRead(3001),
        (error) => error.status === 502,
      );
      assert.equal(calls.length - before, 1);
    }
  });
}

test('expert material confirmation rejects invalid project IDs before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => result(confirmed));
  for (const projectId of [0, -1, 1.5, 2147483648, '3001', undefined])
    await assert.rejects(
      () => api.confirmProjectStandardMaterialsRead(projectId),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});
