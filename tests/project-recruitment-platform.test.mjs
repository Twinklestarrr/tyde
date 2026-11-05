import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  recruitmentBody,
  recruitmentDetailExample,
  recruitmentPageExample,
} from '../apps/server/src/modules/projects/project-recruitment.schema.ts';
import { handlerExample } from '../apps/server/src/modules/projects/project-recruitment-handler.schema.ts';

const change = { projectId: 3001, handlerUserId: handlerExample.userId };
const submit = recruitmentBody.examples[0];
const individual = recruitmentPageExample.records[0];
const organization = {
  ...individual,
  subjectType: 'ORGANIZATION',
  organizationName: '生产团队',
  nickname: null,
};
const assignment = {
  assignmentId: 17,
  status: 'REJECTED',
  productionRequirement: null,
  operatorHeadcount: null,
  inspectorHeadcount: null,
};
const wrap = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '后端明确失败', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
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
  test(`${mode} recruitment reads preserve server role, handler candidates, filtering and paging contracts`, async (t) => {
    const filtered = { records: [organization], total: 21, current: 2, size: 20, pages: 2 };
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/handler-candidates?')) return wrap([handlerExample]);
      if (path.includes('/detail?')) return wrap(recruitmentDetailExample);
      return wrap(filtered);
    });
    assert.deepEqual(await api.listExpertRecruitmentHandlerCandidates(3001), [handlerExample]);
    assert.deepEqual(await api.getExpertRecruitmentDetail(3001), recruitmentDetailExample);
    assert.deepEqual(
      await api.listExpertRecruitmentCandidates({
        projectId: 3001,
        subjectType: 'ORGANIZATION',
        keyword: '团队 %_',
        current: 2,
        size: 20,
      }),
      filtered,
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/projects/expert-recruitments/handler-candidates?projectId=3001',
        '/api/v1/projects/expert-recruitments/detail?projectId=3001',
        '/api/v1/projects/expert-recruitments/candidates?projectId=3001&subjectType=ORGANIZATION&keyword=%E5%9B%A2%E9%98%9F+%25_&current=2&size=20',
      ],
    );
    for (const call of calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.body, undefined);
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], undefined);
    }
  });

  test(`${mode} explicit handler changes and ordinary or cross-subject replacement submissions use null success`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    const replacement = recruitmentBody.examples[1];
    assert.equal(await api.changeExpertRecruitmentHandler(change), undefined);
    assert.equal(await api.changeExpertRecruitmentHandler(change), undefined);
    assert.equal(await api.submitExpertRecruitment(submit), undefined);
    assert.equal(await api.submitExpertRecruitment(replacement), undefined);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/projects/expert-recruitment-handler/change',
        '/api/v1/projects/expert-recruitment-handler/change',
        '/api/v1/projects/expert-recruitments/submit',
        '/api/v1/projects/expert-recruitments/submit',
      ],
    );
    assert.deepEqual(calls[0].data, change);
    assert.deepEqual(calls[2].data, submit);
    assert.deepEqual(calls[3].data, replacement);
    for (const call of calls) {
      assert.equal(call.method, 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.headers['Content-Type'], 'application/json');
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers.Authorization, undefined);
    }
  });

  test(`${mode} recruitment writes retain real refusal statuses and never replay unknown outcomes`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 404, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.changeExpertRecruitmentHandler(change),
        (error) => error.status === status,
      );
      await assert.rejects(
        () => api.submitExpertRecruitment(submit),
        (error) => error.status === status,
      );
      assert.equal(calls.length - before, 2);
    }
  });

  test(`${mode} explicit 401 refresh retries each unchanged write only once`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    const attempted = new Set();
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return wrap(tokens);
      if (!attempted.has(path)) {
        attempted.add(path);
        return wrap(null, 401);
      }
      return wrap(null);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'PM' });
    await api.changeExpertRecruitmentHandler(change);
    await api.submitExpertRecruitment(submit);
    const writes = calls.filter(({ path }) => path.includes('/change') || path.includes('/submit'));
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[0].data, writes[1].data);
    assert.deepEqual(writes[2].data, writes[3].data);
    assert.equal(calls.filter(({ path }) => path === '/api/v1/auth/refresh').length, 2);
  });
}

test('candidate identities use subject type plus UUID and retain all recent-assignment action variants', async (t) => {
  let records = [individual, organization];
  const { api } = adapter(t, false, () =>
    wrap({ records, total: records.length, current: 1, size: 20, pages: 1 }),
  );
  assert.equal((await api.listExpertRecruitmentCandidates({ projectId: 3001 })).records.length, 2);
  for (const status of ['PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED', 'REPLACED']) {
    records = [
      {
        ...individual,
        assignment: { ...assignment, status },
        availableAction: status === 'REJECTED' ? 'RECRUIT_AGAIN' : 'NONE',
      },
    ];
    assert.deepEqual(
      (await api.listExpertRecruitmentCandidates({ projectId: 3001 })).records,
      records,
    );
  }
});

test('recruitment accepts the existing full number range and both subject types without a project-total cap', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(null));
  const make = (productionRequirement) => ({ ...submit.assignments[0], productionRequirement });
  for (const amount of [0.0001, 1.2345, 100000, 9007199254740992, 9999999999999998]) {
    await api.submitExpertRecruitment({ projectId: 3001, assignments: [make(amount)] });
    assert.equal(calls.at(-1).data.assignments[0].productionRequirement, amount);
  }
  await api.submitExpertRecruitment({
    projectId: 3001,
    assignments: [
      make(10),
      { ...make(20), subjectType: 'ORGANIZATION', sourceRejectedAssignmentId: 17 },
    ],
  });
  assert.equal(calls.at(-1).data.assignments.length, 2);
});

test('invalid recruitment requests fail before HTTP, including duplicate subjects and reused replacement sources', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const id of [0, -1, 1.5, 2147483648, '3001']) {
    await assert.rejects(
      () => api.listExpertRecruitmentHandlerCandidates(id),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => api.getExpertRecruitmentDetail(id),
      (error) => error.status === 400,
    );
  }
  for (const patch of [
    { projectId: 0 },
    { subjectType: 'USER' },
    { keyword: 'x'.repeat(101) },
    { current: 0 },
    { current: 2147483648 },
    { size: 101 },
    { keyword: null },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.listExpertRecruitmentCandidates({ projectId: 3001, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [{ handlerUserId: '1' }, { handlerUserId: null }, { versionNo: 1 }])
    await assert.rejects(
      () => api.changeExpertRecruitmentHandler({ ...change, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { subjectType: 'USER' },
    { subjectId: '123' },
    { productionRequirement: 0 },
    { productionRequirement: 0.00001 },
    { productionRequirement: 1.23456 },
    { productionRequirement: 1e16 },
    { productionRequirement: '10.1234' },
    { productionRequirement: Infinity },
    { productionRequirement: NaN },
    { operatorHeadcount: 0 },
    { inspectorHeadcount: 0 },
    { operatorHeadcount: 2147483648 },
    { sourceRejectedAssignmentId: 0 },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () =>
        api.submitExpertRecruitment({
          ...submit,
          assignments: [{ ...submit.assignments[0], ...patch }],
        }),
      (error) => error.status === 400,
    );
  const item = { ...submit.assignments[0], subjectId: 'abcdef00-0000-4000-8000-000000000003' };
  for (const assignments of [
    [],
    Array.from({ length: 101 }, () => item),
    [item, { ...item, subjectId: item.subjectId.toUpperCase() }],
    [
      { ...item, sourceRejectedAssignmentId: 17 },
      { ...item, subjectType: 'ORGANIZATION', sourceRejectedAssignmentId: 17 },
    ],
  ])
    await assert.rejects(
      () => api.submitExpertRecruitment({ ...submit, assignments }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('recruitment response decoders reject mismatched projects, impossible permissions, malformed candidates and fake write success', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  for (const patch of [
    { projectId: 3002 },
    { handler: undefined },
    { primaryManager: { userId: 1 } },
    { currentOperatorRole: 'ADMIN' },
    { canChangeHandler: false },
    { summary: null },
  ]) {
    data = { ...recruitmentDetailExample, ...patch };
    await assert.rejects(
      () => api.getExpertRecruitmentDetail(3001),
      (error) => error.status === 502,
    );
  }
  data = {
    ...recruitmentDetailExample,
    currentOperatorRole: 'EXPERT_RECRUITMENT_HANDLER',
    canChangeHandler: false,
  };
  assert.deepEqual(await api.getExpertRecruitmentDetail(3001), data);
  for (data of [[{ ...handlerExample, currentHandler: 'true' }], [handlerExample, handlerExample]])
    await assert.rejects(
      () => api.listExpertRecruitmentHandlerCandidates(3001),
      (error) => error.status === 502,
    );
  for (const patch of [
    { current: 2 },
    { size: 101 },
    { pages: 0 },
    { records: [individual, individual] },
    { records: [{ ...individual, subjectType: 'USER' }] },
    { records: [{ ...individual, availableAction: 'RECRUIT_AGAIN' }] },
    {
      records: [
        {
          ...individual,
          assignment: { ...assignment, operatorHeadcount: '2' },
          availableAction: 'RECRUIT_AGAIN',
        },
      ],
    },
  ]) {
    data = { ...recruitmentPageExample, ...patch };
    await assert.rejects(
      () => api.listExpertRecruitmentCandidates({ projectId: 3001 }),
      (error) => error.status === 502,
    );
  }
  data = { ...recruitmentPageExample, records: [individual] };
  await assert.rejects(
    () => api.listExpertRecruitmentCandidates({ projectId: 3001, subjectType: 'ORGANIZATION' }),
    (error) => error.status === 502,
  );
  for (data of [{ success: true }, undefined, []]) {
    await assert.rejects(
      () => api.changeExpertRecruitmentHandler(change),
      (error) => error.status === 502,
    );
    await assert.rejects(
      () => api.submitExpertRecruitment(submit),
      (error) => error.status === 502,
    );
  }
});
