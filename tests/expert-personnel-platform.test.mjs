import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { ownerChangeBody } from '../apps/server/src/modules/expert/expert-owner.schema.ts';
import { movementDetailResponse } from '../apps/server/src/modules/personnel/personnel-movement-query.schema.ts';

const uuid = 'abcdefab-0000-4000-8000-000000000001';
const input = ownerChangeBody.examples[0];
const wrap = (data, status = 200) =>
  new Response(JSON.stringify({ code: status, message: '服务端结果', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function adapter(t, desktop, responder) {
  const previous = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: String(url).slice(origin.length),
      data: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} project owner replacement sends the exact complete set and only accepts null success`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    const duplicateSet = { assignmentId: 2147483647, projectOwnerUserIds: Array(21).fill(uuid) };
    duplicateSet.projectOwnerUserIds[1] = uuid.toUpperCase();
    assert.equal(await api.setExpertProjectOwners(input), undefined);
    assert.equal(await api.setExpertProjectOwners(duplicateSet), undefined);
    assert.deepEqual(
      calls.map(({ data }) => data),
      [input, duplicateSet],
    );
    for (const call of calls) {
      assert.equal(call.path, '/api/v1/expert-assignments/set-project-owners');
      assert.equal(call.method, 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.headers['Content-Type'], 'application/json');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
    }
  });

  test(`${mode} owner replacement refusals and unknown results never replay`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 401, 403, 404, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.setExpertProjectOwners(input),
        (error) => error.status === status,
      );
      assert.equal(calls.length, before + 1);
    }
  });

  test(`${mode} owner replacement refreshes only after 401 and retries the exact command once`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    let commands = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) return wrap(tokens);
      commands++;
      return wrap(null, commands === 1 ? 401 : 200);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'EXPERT' });
    await api.setExpertProjectOwners(input);
    const writes = calls.filter(({ path }) => path.endsWith('/set-project-owners'));
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map(({ data }) => data),
      [input, input],
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
    commands = 0;
    await api.setExpertProjectOwners(input);
    assert.equal(commands, 2);
  });

  test(`${mode} a second 401 or rejected refresh cannot loop owner replacement`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    let rejectRefresh = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login')) return wrap(tokens);
      if (path.endsWith('/auth/refresh')) return wrap(tokens, rejectRefresh ? 403 : 200);
      return wrap(null, 401);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'EXPERT' });
    await assert.rejects(
      () => api.setExpertProjectOwners(input),
      (error) => error.status === 401,
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/set-project-owners')).length, 2);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
    rejectRefresh = true;
    await assert.rejects(
      () => api.setExpertProjectOwners(input),
      (error) => error.status === 401,
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/set-project-owners')).length, 3);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 2);
  });

  test(`${mode} malformed owner success does not replay or masquerade as saved`, async (t) => {
    let data;
    const { api, calls } = adapter(t, desktop, () => wrap(data));
    for (data of [undefined, {}, [], true, { assignmentId: 1 }]) {
      const before = calls.length;
      await assert.rejects(
        () => api.setExpertProjectOwners(input),
        (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
      );
      assert.equal(calls.length, before + 1);
    }
  });

  test(`${mode} movement reads preserve the actor's explicit node among parallel candidates and accept older deployments`, async (t) => {
    let data = structuredClone(movementDetailResponse.examples[2]);
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(
        path.endsWith('/list')
          ? { total: 1, current: 1, size: 20, pages: 1, records: [data] }
          : data,
      ),
    );
    assert.deepEqual(
      (await api.listPersonnelMovements({ projectId: 2, movementId: 1 })).records[0],
      data,
    );
    assert.equal(
      (await api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 })).actionableNodeId,
      data.approvalSteps[0].nodeId,
    );
    data.actionableNodeId = null;
    assert.equal(
      (await api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 })).actionableNodeId,
      null,
    );
    delete data.actionableNodeId;
    assert.equal(
      (await api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 })).actionableNodeId,
      undefined,
    );
    assert.equal(calls.length, 4);
  });
}

test('movement actor node rejects untrusted IDs, missing permission and mismatched current manual steps', async (t) => {
  const base = movementDetailResponse.examples[2];
  let data;
  const { api, calls } = adapter(t, false, () => wrap(data));
  const patches = [
    { actionableNodeId: 'not-a-uuid' },
    { actionableNodeId: 1 },
    { actionableNodeId: '00000000-0000-4000-8000-000000000099' },
    { allowedActions: [] },
    { currentNode: null },
    { currentNode: 2 },
    { approvalSteps: [{ ...base.approvalSteps[0], nodeStatus: 'APPROVED' }] },
    { approvalSteps: [{ ...base.approvalSteps[0], nodeCode: 'MEMBER_CONFIRM' }] },
    { approvalSteps: [base.approvalSteps[0], base.approvalSteps[0]] },
  ];
  for (const patch of patches) {
    data = { ...structuredClone(base), ...patch };
    const before = calls.length;
    await assert.rejects(
      () => api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 }),
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
    assert.equal(calls.length, before + 1);
  }
});

test('owner replacement validates its assignment, unique UUID count and exact fields before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  const many = Array.from(
    { length: 21 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  for (const value of [
    null,
    { ...input, assignmentId: 0 },
    { ...input, assignmentId: '1' },
    { ...input, assignmentId: 2147483648 },
    { ...input, assignmentId: 1.5 },
    { ...input, projectOwnerUserIds: [] },
    { ...input, projectOwnerUserIds: null },
    { ...input, projectOwnerUserIds: [null] },
    { ...input, projectOwnerUserIds: ['1'] },
    { ...input, projectOwnerUserIds: many },
    { ...input, projectOwnerUserId: uuid },
    { ...input, versionNo: 1 },
    { ...input, idempotencyKey: 'owner-change' },
    { ...input, movementId: 1 },
  ])
    await assert.rejects(
      () => api.setExpertProjectOwners(value),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('owner replacement enforces 16 KiB on the complete JSON even when duplicates count as one owner', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null));
  const value = { assignmentId: 1, projectOwnerUserIds: [uuid] };
  while (new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024)
    value.projectOwnerUserIds.push(uuid);
  await assert.rejects(
    () => api.setExpertProjectOwners(value),
    (error) => error.status === 413,
  );
  assert.equal(calls.length, 0);
  value.projectOwnerUserIds.pop();
  await api.setExpertProjectOwners(value);
  assert.equal(calls.length, 1);
});
