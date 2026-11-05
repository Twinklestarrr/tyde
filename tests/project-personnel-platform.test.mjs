import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { rosterExample, entryBody } from '../apps/server/src/modules/personnel/personnel.schema.ts';
import {
  attendanceExample,
  performanceExample,
  performanceCreateBody,
} from '../apps/server/src/modules/personnel/personnel-records.schema.ts';
import {
  movementCreateBody,
  movementProcessBody,
  movementWithdrawBody,
  transferTargetExample,
} from '../apps/server/src/modules/personnel/personnel-movement.schema.ts';
import {
  movementListExample,
  movementItemExample,
  movementDetailResponse,
} from '../apps/server/src/modules/personnel/personnel-movement-query.schema.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const entry = { ...entryBody.examples[0], memberIds: [1, 1, 2] };
const performance = performanceCreateBody.examples[0];
const movement = movementCreateBody.examples[0];
const processInput = movementProcessBody.examples[0];
const withdraw = movementWithdrawBody.examples[0];
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
      data:
        options.body instanceof FormData
          ? options.body
          : options.body
            ? JSON.parse(options.body)
            : undefined,
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
  () => api.saveProjectPersonnelEntry(entry),
  () => api.createProjectMemberPerformance(performance),
  () => api.createPersonnelMovement(movement),
  () => api.withdrawPersonnelMovement(withdraw),
  () => api.processPersonnelMovement(processInput),
];

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} personnel reads preserve database paging, nullable filters, real allowed actions and millisecond attendance`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(
        path.includes('/roster/')
          ? rosterExample
          : path.includes('/attendance/')
            ? attendanceExample
            : performanceExample,
      ),
    );
    const rosterInput = {
      projectId: 1,
      keyword: '成员',
      accountTypes: ['INDIVIDUAL'],
      organizationIds: null,
      responsibleUserIds: [],
      statuses: ['PENDING_CONFIRM'],
      current: 1,
      size: 20,
    };
    const attendanceInput = { projectId: 1, month: '2026-10', attendanceStatuses: ['LATE_EARLY'] };
    const performanceQuery = {
      projectId: 1,
      memberId: 1,
      recordDateStart: '2026-10-01',
      recordDateEnd: '2026-10-23',
    };
    assert.deepEqual(await api.listProjectPersonnelRoster(rosterInput), rosterExample);
    assert.deepEqual(await api.listProjectPersonnelAttendance(attendanceInput), attendanceExample);
    assert.deepEqual(await api.listProjectMemberPerformance(performanceQuery), performanceExample);
    assert.deepEqual(
      calls.map(({ path, data }) => [path, data]),
      [
        ['/api/v1/project-personnel/roster/list', rosterInput],
        ['/api/v1/project-personnel/attendance/list', attendanceInput],
        ['/api/v1/project-personnel/performance/list', performanceQuery],
      ],
    );
    for (const call of calls) {
      assert.equal(call.method, 'POST');
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], 'web');
    }
  });

  test(`${mode} movement queries distinguish latest member detail from exact movement filtering and target-project visibility`, async (t) => {
    const transfer = movementDetailResponse.examples[1];
    const target = { projectId: 1, memberIds: [1], keyword: null };
    const { api, calls } = adapter(t, desktop, ({ path, data }) =>
      wrap(
        path.endsWith('/target-projects')
          ? transferTargetExample
          : path.endsWith('/detail')
            ? movementItemExample
            : {
                ...movementListExample,
                records: [data.projectId === 2 ? transfer : movementItemExample],
              },
      ),
    );
    assert.deepEqual(await api.listPersonnelTransferTargets(target), transferTargetExample);
    assert.deepEqual(
      await api.listPersonnelMovements({ projectId: 1, movementId: 1, memberId: 1 }),
      movementListExample,
    );
    assert.deepEqual(
      await api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 }),
      movementItemExample,
    );
    assert.equal(
      (await api.listPersonnelMovements({ projectId: 2, movementId: 1 })).records[0]
        .targetProjectId,
      2,
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/project-personnel/movements/target-projects',
        '/api/v1/project-personnel/movements/list',
        '/api/v1/project-personnel/movements/detail',
        '/api/v1/project-personnel/movements/list',
      ],
    );
    assert.deepEqual(calls[2].data, { projectId: 1, memberId: 1 });
  });

  test(`${mode} entry, performance and movement writes retain exact payloads, dual approval versions and null success`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(null));
    for (const write of writes(api)) assert.equal(await write(), undefined);
    assert.deepEqual(
      calls.map(({ data }) => data),
      [entry, performance, movement, withdraw, processInput],
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/project-personnel/roster/entry/save',
        '/api/v1/project-personnel/performance/create',
        '/api/v1/project-personnel/movements/create',
        '/api/v1/project-personnel/movements/withdraw',
        '/api/v1/project-personnel/movements/process',
      ],
    );
    for (const call of calls) {
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.method, 'POST');
    }
    // 个人显式目标不要求先从组织目标列表选中；后端独立校验真实资格。
    await api.createPersonnelMovement({ ...movement, targetProjectId: 999 });
    assert.equal(calls.at(-1).data.targetProjectId, 999);
  });

  test(`${mode} uncertain writes and real refusal statuses never cause automatic replay`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 404, 409, 413, 500, 503, 0]) {
      const before = calls.length;
      for (const write of writes(api))
        await assert.rejects(write, (error) => error.status === status);
      assert.equal(calls.length - before, 5);
    }
  });

  test(`${mode} only explicit unauthenticated replies refresh and retry the same command once`, async (t) => {
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
    const commands = calls.filter(({ path }) => path.startsWith('/api/v1/project-personnel/'));
    assert.equal(commands.length, 10);
    for (let index = 0; index < commands.length; index += 2)
      assert.deepEqual(commands[index].data, commands[index + 1].data);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 5);
  });

  test(`${mode} performance attachments upload in their exclusive scope and use the authenticated byte proxy`, async (t) => {
    const file = new File(['%PDF'], '表现.pdf', { type: 'application/pdf' });
    const key = 'member-performance/2026/11/03/0123456789abcdef0123456789abcdef.pdf';
    const receipt = {
      fileId: uuid,
      objectKey: key,
      uploadToken: 'u'.repeat(43),
      url: null,
      sensitive: true,
      fileName: file.name,
      extension: 'pdf',
      size: file.size,
      contentType: file.type,
      fileHash: 'a'.repeat(64),
    };
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      path.includes('/files/view?')
        ? new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } })
        : wrap(receipt),
    );
    assert.deepEqual(await api.uploadMemberPerformanceAttachment(file), receipt);
    assert.equal(calls[0].data.get('bizType'), 'MEMBER_PERFORMANCE_ATTACHMENT');
    assert.equal(calls[0].data.get('category'), 'PROJECT_ATTACHMENT');
    assert.equal(calls[0].headers['Content-Type'], undefined);
    assert.equal(await (await api.readMemberPerformanceAttachment(key)).text(), '%PDF');
    const before = calls.length;
    for (const bad of [
      'project-attachment/file.pdf',
      'https://files.example/file.pdf',
      'member-performance/../secret.pdf',
    ])
      await assert.rejects(
        () => api.readMemberPerformanceAttachment(bad),
        (error) => error.status === 400,
      );
    assert.equal(calls.length, before);
  });
}

test('personnel trust boundaries reject invalid paging, dates, filters, entry conditions and unsafe performance credentials', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const patch of [
    { projectId: 0 },
    { current: 0 },
    { size: 101 },
    { keyword: 'x'.repeat(101) },
    { statuses: ['PENDING'] },
    { organizationIds: ['1'] },
    { orgPositions: ['OPS'] },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.listProjectPersonnelRoster({ projectId: 1, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { memberIds: [] },
    { memberIds: [0] },
    { memberIds: Array(101).fill(1) },
    { plannedEntryDate: '2026-02-30' },
    { plannedEntryDate: null },
    { entryDecision: 'NO', declineReason: ' ' },
    { declineReason: 'x'.repeat(501) },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.saveProjectPersonnelEntry({ ...entry, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { month: '1899-01' },
    { month: '2026-13' },
    { attendanceStatuses: ['PENDING'] },
  ])
    await assert.rejects(
      () => api.listProjectPersonnelAttendance({ projectId: 1, month: '2026-10', ...patch }),
      (error) => error.status === 400,
    );
  await assert.rejects(
    () =>
      api.listProjectMemberPerformance({
        projectId: 1,
        memberId: 1,
        recordDateStart: '2026-10-22',
        recordDateEnd: '2026-10-01',
      }),
    (error) => error.status === 400,
  );
  for (const patch of [
    { memberId: '1' },
    { recordDate: '2026-02-30' },
    { content: ' ' },
    { content: 'x'.repeat(2001) },
    { attachmentIds: ['1'] },
    { attachmentIds: [uuid], attachmentUploadTokens: {} },
    { attachmentUploadTokens: { [uuid]: 'unused' } },
    { attachmentIds: [uuid], attachmentUploadTokens: { [uuid]: 'x'.repeat(201) } },
  ])
    await assert.rejects(
      () => api.createProjectMemberPerformance({ ...performance, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('movement boundaries require precise member IDs, source/target distinction and current dual versions', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const patch of [
    { memberIds: [] },
    { memberIds: ['1'] },
    { keyword: 'x'.repeat(129) },
    { size: 101 },
  ])
    await assert.rejects(
      () => api.listPersonnelTransferTargets({ projectId: 1, memberIds: [1], ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { targetProjectId: 1 },
    { targetProjectId: null },
    { movementType: 'REMOVAL' },
    { reason: ' ' },
    { plannedEffectiveDate: '2026-02-30' },
    { memberIds: [] },
    { movementType: 'EXIT' },
  ])
    await assert.rejects(
      () => api.createPersonnelMovement({ ...movement, ...patch }),
      (error) => error.status === 400,
    );
  for (const patch of [
    { statuses: ['ACTIVE'] },
    { movementTypes: ['EXIT'] },
    { createdStartAt: '2026-02-30 09:00:00' },
    { createdStartAt: '2026-11-03 09:00:00', createdEndAt: '2026-11-01 09:00:00' },
    { movementId: 0 },
  ])
    await assert.rejects(
      () => api.listPersonnelMovements({ projectId: 1, ...patch }),
      (error) => error.status === 400,
    );
  await assert.rejects(
    () => api.getPersonnelMovementDetail({ projectId: 1, movementId: 1 }),
    (error) => error.status === 400,
  );
  for (const patch of [
    { flowNo: ' ' },
    { nodeId: '1' },
    { nodeVersionNo: -1 },
    { flowVersionNo: 2147483648 },
    { action: 'ACCEPT_TRANSFER' },
    { action: 'REJECT', actionComment: ' ' },
    { actionComment: 'x'.repeat(501) },
    { versionNo: 1 },
  ])
    await assert.rejects(
      () => api.processPersonnelMovement({ ...processInput, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});

test('performance payload preserves one-use UUID tokens and historical member records without pretending idempotency', async (t) => {
  let data = null;
  const { api, calls } = adapter(t, false, () => wrap(data));
  const input = {
    ...performance,
    attachmentIds: [uuid],
    attachmentUploadTokens: { [uuid]: 'u'.repeat(43) },
  };
  await api.createProjectMemberPerformance(input);
  assert.deepEqual(calls[0].data, input);
  data = {
    ...performanceExample,
    records: [
      {
        ...performanceExample.records[0],
        attachmentIds: [uuid],
        attachments: [
          {
            fileId: uuid,
            objectKey: 'member-performance/2026/11/03/0123456789abcdef0123456789abcdef.pdf',
            fileName: '表现.pdf',
          },
        ],
      },
    ],
  };
  assert.deepEqual(await api.listProjectMemberPerformance({ projectId: 1, memberId: 1 }), data);
  data = {
    ...rosterExample,
    records: [{ ...rosterExample.records[0], status: 'LEFT', allowedActions: [] }],
  };
  assert.deepEqual(await api.listProjectPersonnelRoster({ projectId: 1 }), data);
});

test('personnel response decoders reject malformed state, unrelated movement identities and fake write successes', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  for (const patch of [
    { memberId: 0 },
    { userId: '1' },
    { allowedActions: ['TRANSFER'] },
    { joinedAt: '2026-02-30 09:00:00' },
    { projectOwners: [{ userId: uuid, name: '负责人' }] },
  ]) {
    data = { ...rosterExample, records: [{ ...rosterExample.records[0], ...patch }] };
    await assert.rejects(
      () => api.listProjectPersonnelRoster({ projectId: 1 }),
      (error) => error.status === 502,
    );
  }
  data = { ...rosterExample, current: 2 };
  await assert.rejects(
    () => api.listProjectPersonnelRoster({ projectId: 1 }),
    (error) => error.status === 502,
  );
  for (const patch of [
    { finalAttendanceStatus: 'PENDING' },
    { firstClockInAt: '2026-10-22 09:00:00' },
    { date: '2026-11-01' },
  ]) {
    data = {
      ...attendanceExample,
      records: [
        {
          ...attendanceExample.records[0],
          days: [{ ...attendanceExample.records[0].days[0], ...patch }],
        },
      ],
    };
    await assert.rejects(
      () => api.listProjectPersonnelAttendance({ projectId: 1, month: '2026-10' }),
      (error) => error.status === 502,
    );
  }
  data = { ...movementItemExample, sourceProjectId: 99 };
  await assert.rejects(
    () => api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 }),
    (error) => error.status === 502,
  );
  data = { ...movementListExample, records: [{ ...movementItemExample, movementId: 2 }] };
  await assert.rejects(
    () => api.listPersonnelMovements({ projectId: 1, movementId: 1 }),
    (error) => error.status === 502,
  );
  data = {
    ...movementDetailResponse.examples[1],
    approvalSteps: [{ ...movementDetailResponse.examples[1].approvalSteps[0], nodeVersionNo: -1 }],
  };
  await assert.rejects(
    () => api.getPersonnelMovementDetail({ projectId: 1, memberId: 1 }),
    (error) => error.status === 502,
  );
  for (data of [{ success: true }, undefined, []])
    for (const write of writes(api)) await assert.rejects(write, (error) => error.status === 502);
});
