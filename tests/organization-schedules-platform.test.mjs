import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';

const orgId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
const otherMember = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({
      code: status,
      message: status === 200 ? '操作成功' : '服务端拒绝',
      data,
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const fetch = globalThis.fetch;
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
    globalThis.fetch = fetch;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}
function calendar() {
  return {
    month: '2026-10',
    total: 1,
    pages: 1,
    current: 1,
    size: 20,
    members: [
      {
        memberId,
        userId,
        realName: null,
        nickname: '排班成员',
        joinStatus: 'ACTIVE',
        canSchedule: true,
        summary: {
          presentCount: 0,
          lateCount: 0,
          earlyLeaveCount: 0,
          leaveCount: 0,
          absentCount: 0,
        },
        days: Array.from({ length: 31 }, (_, index) => ({
          scheduleId: null,
          scheduleDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
          calendarStatus: 'UNSCHEDULED',
          dayType: null,
          shiftStartAt: null,
          shiftEndAt: null,
          timezone: null,
          sourceType: null,
          batchNo: null,
          status: null,
          versionNo: null,
          dailyId: null,
          autoStatus: null,
          finalStatus: null,
          firstClockInAt: null,
          lastClockOutAt: null,
          reviewRequired: null,
          reviewReason: null,
          manualOverride: null,
          dailyVersionNo: null,
        })),
      },
    ],
  };
}
const range = {
  orgId,
  memberIds: [memberId],
  startDate: '2026-10-12',
  endDate: '2026-10-16',
  weekdays: [1, 2, 3, 4, 5],
  dayType: 'WORK',
  startTime: '09:00',
  endTime: '18:00',
  timezone: 'Asia/Shanghai',
  overwrite: false,
};
const details = {
  orgId,
  overwrite: false,
  timezone: 'Asia/Shanghai',
  schedules: [
    { memberId, scheduleDate: '2026-10-01', dayType: 'REST' },
    {
      memberId: otherMember,
      scheduleDate: '2026-10-02',
      dayType: 'WORK',
      startTime: '09:00',
      endTime: '18:00',
      timezone: 'Asia/Tokyo',
    },
  ],
};
const saved = (count = 5) => ({
  batchNo: 'SCH-TEST-1',
  createdCount: count,
  updatedCount: 0,
  skippedCount: 0,
  conflicts: [],
});
const invalidInput = (error) => error.status === 400 && error.code === 'VALIDATION_ERROR';
const invalidResponse = (error) => error.status === 502 && error.code === 'INVALID_RESPONSE';

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron' : 'Web';
  test(`${mode} organization schedules preserve server pagination, explicit organization and Cookie scope`, async (t) => {
    const response = calendar();
    response.current = 2;
    response.size = 1;
    response.total = 2;
    response.pages = 2;
    const { api, calls } = adapter(t, desktop, () => result(response));
    const input = {
      orgId,
      month: '2026-10',
      keyword: '张 & 复核',
      employmentType: null,
      joinStatus: 'ACTIVE',
      position: 'ADMIN',
      projectId: 17,
      current: 2,
      size: 1,
    };
    assert.deepEqual(await api.listOrganizationSchedules(input), response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/v1/organizations/schedules');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].credentials, desktop ? 'include' : 'same-origin');
    assert.deepEqual(calls[0].data, input);
    assert.deepEqual(calls[0].headers, {
      'X-Tyde-Client': 'web',
      'Content-Type': 'application/json',
    });
    assert.equal(Object.hasOwn(response.members[0].days[0], 'permissions'), false);
    assert.equal(Object.hasOwn(response.members[0].days[0], 'application'), false);
  });

  test(`${mode} range and detail writes keep distinct endpoints, per-row timezone, idempotency and versions`, async (t) => {
    const conflict = { memberId, scheduleDate: '2026-10-01', scheduleId: 18, versionNo: 7 };
    const detailResult = { ...saved(1), skippedCount: 1, conflicts: [conflict] };
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      result(path.endsWith('/details/batch') ? detailResult : saved()),
    );
    assert.deepEqual(await api.batchOrganizationSchedules(range, 'range-key'), saved());
    assert.deepEqual(
      await api.batchOrganizationScheduleDetails(details, 'detail-key'),
      detailResult,
    );
    assert.deepEqual(
      calls.map(({ path, method, data, headers }) => ({ path, method, data, headers })),
      [
        {
          path: '/api/v1/organizations/schedules/batch',
          method: 'PUT',
          data: range,
          headers: {
            'X-Tyde-Client': 'web',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'range-key',
          },
        },
        {
          path: '/api/v1/organizations/schedules/details/batch',
          method: 'PUT',
          data: details,
          headers: {
            'X-Tyde-Client': 'web',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'detail-key',
          },
        },
      ],
    );
    assert.ok(calls.every((call) => call.credentials === (desktop ? 'include' : 'same-origin')));
  });

  test(`${mode} range result accepts server holiday exclusion without applying holiday rules to details`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => result(saved(1)));
    await api.batchOrganizationSchedules(
      { ...range, memberIds: [memberId, memberId], weekdays: null },
      'holiday-key',
    );
    assert.equal(calls.length, 1);
    await assert.rejects(
      api.batchOrganizationScheduleDetails(details, 'exact-key'),
      invalidResponse,
    );
  });

  test(`${mode} organization write errors preserve status and never automatically replay 409, 503 or network failures`, async (t) => {
    let status = 409;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new Error('offline fixture');
      return result(null, status);
    });
    await assert.rejects(
      api.batchOrganizationSchedules(range, 'stable-key'),
      (error) => error.status === 409,
    );
    status = 503;
    await assert.rejects(
      api.batchOrganizationSchedules(range, 'stable-key'),
      (error) => error.status === 503,
    );
    status = 0;
    await assert.rejects(
      api.batchOrganizationScheduleDetails(details, 'stable-key'),
      (error) => error.status === 0 && error.code === 'NETWORK_ERROR',
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.headers['Idempotency-Key']),
      ['stable-key', 'stable-key', 'stable-key'],
    );
  });

  test(`${mode} a single Cookie refresh retries the same organization schedule body and idempotency key`, async (t) => {
    let refreshed = false;
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 2592000,
    };
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login')) return result(tokens);
      if (path.endsWith('/auth/refresh')) {
        refreshed = true;
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      }
      return refreshed ? result(saved()) : result(null, 401);
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    await api.batchOrganizationSchedules(range, 'retry-key');
    const writes = calls.filter((call) => call.path.endsWith('/schedules/batch'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].data, writes[1].data);
    assert.equal(writes[0].headers['Idempotency-Key'], writes[1].headers['Idempotency-Key']);
    assert.equal(calls.filter((call) => call.path.endsWith('/auth/refresh')).length, 1);
    assert.ok(
      calls.every(
        (call) =>
          call.headers.Authorization === undefined && call.headers['X-Tyde-Role'] === undefined,
      ),
    );
  });
}

test('organization schedule reads reject invalid scope and query fields before sending', async (t) => {
  const { api, calls } = adapter(t, false, () => result(calendar()));
  for (const patch of [
    { orgId: null },
    { orgId: 'invalid' },
    { month: '1899-12' },
    { month: '2026-13' },
    { current: 0 },
    { size: 101 },
    { projectId: 2147483648 },
    { joinStatus: 'UNKNOWN' },
    { position: 'PM' },
    { employmentType: 'CONTRACT' },
    { keyword: 'x'.repeat(101) },
    { userId },
  ])
    await assert.rejects(
      api.listOrganizationSchedules({ orgId, month: '2026-10', ...patch }),
      invalidInput,
    );
  assert.equal(calls.length, 0);
});

test('organization schedule writes reject malformed dates, shifts, members and duplicate detail targets before sending', async (t) => {
  const { api, calls } = adapter(t, false, () => result(saved()));
  for (const patch of [
    { orgId: 'invalid' },
    { memberIds: [] },
    { memberIds: ['invalid'] },
    { memberIds: Array(501).fill(memberId) },
    { startDate: '2026-02-30' },
    { endDate: '2026-10-11' },
    { endDate: '2027-10-13' },
    { weekdays: [0] },
    { weekdays: [8] },
    { weekdays: Array(8).fill(1) },
    { dayType: 'REST' },
    { endTime: '08:00' },
    { endTime: '24:00' },
    { timezone: 'invalid-zone' },
    { overwrite: null },
    { userId },
  ])
    await assert.rejects(
      api.batchOrganizationSchedules({ ...range, ...patch }, 'key'),
      invalidInput,
    );
  await assert.rejects(
    api.batchOrganizationSchedules(
      { ...range, startDate: '2026-10-17', endDate: '2026-10-18' },
      'key',
    ),
    invalidInput,
  );
  for (const key of ['', ' ', 'x'.repeat(129), 'bad\r\nkey', undefined])
    await assert.rejects(api.batchOrganizationSchedules(range, key), invalidInput);
  for (const schedules of [
    [],
    Array(5001).fill(details.schedules[0]),
    [details.schedules[0], details.schedules[0]],
    [{ ...details.schedules[0], memberId: 'invalid' }],
    [{ ...details.schedules[0], scheduleDate: '2026-11-31' }],
    [{ ...details.schedules[0], startTime: '09:00' }],
    [{ ...details.schedules[1], timezone: 'invalid' }],
    [{ ...details.schedules[0], versionNo: 1 }],
  ])
    await assert.rejects(
      api.batchOrganizationScheduleDetails({ ...details, schedules }, 'key'),
      invalidInput,
    );
  assert.equal(calls.length, 0);
});

test('organization month responses reject wrong month, pagination, incomplete days, invalid versions and fabricated permissions', async (t) => {
  let response;
  const { api } = adapter(t, false, () => result(response));
  for (const mutate of [
    (value) => {
      value.month = '2026-11';
    },
    (value) => {
      value.current = 2;
    },
    (value) => {
      value.size = 100;
    },
    (value) => {
      value.pages = 2;
    },
    (value) => {
      value.members[0].days.pop();
    },
    (value) => {
      value.members[0].days.reverse();
    },
    (value) => {
      value.members[0].days[0].versionNo = -1;
    },
    (value) => {
      value.members[0].days[0].dailyVersionNo = 2147483648;
    },
    (value) => {
      delete value.members[0].days[0].manualOverride;
    },
    (value) => {
      value.members[0].canSchedule = 'true';
    },
    (value) => {
      value.members[0].joinStatus = 'PENDING_ACTIVATION';
    },
    (value) => {
      value.members[0].memberId = 'invalid';
    },
    (value) => {
      value.members[0].userId = 'invalid';
    },
    (value) => {
      value.total = 2;
      value.members.push(structuredClone(value.members[0]));
    },
  ]) {
    response = calendar();
    mutate(response);
    await assert.rejects(
      api.listOrganizationSchedules({ orgId, month: '2026-10' }),
      invalidResponse,
    );
  }
  response = calendar();
  response.members[0].joinStatus = 'PENDING_ACTIVATION';
  response.members[0].canSchedule = false;
  assert.deepEqual(await api.listOrganizationSchedules({ orgId, month: '2026-10' }), response);
});

test('organization write responses reject unrelated members, dates, counts, duplicate conflicts and invalid schedule versions', async (t) => {
  let response;
  const { api } = adapter(t, false, () => result(response));
  const conflict = { memberId, scheduleDate: '2026-10-12', scheduleId: 19, versionNo: 3 };
  const valid = { ...saved(4), skippedCount: 1, conflicts: [conflict] };
  for (const mutate of [
    (value) => {
      value.createdCount = 5;
    },
    (value) => {
      value.skippedCount = 0;
    },
    (value) => {
      value.batchNo = '';
    },
    (value) => {
      value.conflicts[0].memberId = otherMember;
    },
    (value) => {
      value.conflicts[0].scheduleDate = '2026-10-17';
    },
    (value) => {
      value.conflicts[0].scheduleId = 0;
    },
    (value) => {
      value.conflicts[0].versionNo = -1;
    },
    (value) => {
      value.conflicts[0].versionNo = 2147483648;
    },
    (value) => {
      value.createdCount = 3;
      value.skippedCount = 2;
      value.conflicts.push({ ...conflict });
    },
  ]) {
    response = structuredClone(valid);
    mutate(response);
    await assert.rejects(api.batchOrganizationSchedules(range, 'key'), invalidResponse);
  }
  response = valid;
  await assert.rejects(
    api.batchOrganizationSchedules({ ...range, overwrite: true }, 'key'),
    invalidResponse,
  );
  response = saved(3);
  await assert.rejects(
    api.batchOrganizationSchedules({ ...range, memberIds: [memberId, otherMember] }, 'key'),
    invalidResponse,
  );
  response = saved(1);
  await assert.rejects(api.batchOrganizationScheduleDetails(details, 'key'), invalidResponse);
});

test('a late organization schedule result cannot be restored after logout', async (t) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { api } = adapter(t, false, async ({ path }) => {
    if (path.endsWith('/auth/logout')) return result(null);
    started();
    await wait;
    return result(calendar());
  });
  const pending = api.listOrganizationSchedules({ orgId, month: '2026-10' });
  await ready;
  await api.logout();
  release();
  await assert.rejects(
    pending,
    (error) => error.status === 401 && error.code === 'SESSION_CHANGED',
  );
});
