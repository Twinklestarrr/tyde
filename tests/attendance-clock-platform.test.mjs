import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  clockContextResponse,
  clockResponse,
} from '../apps/server/src/modules/attendance/attendance-clock.schema.ts';

const orgId = 'abcdefab-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const context = clockContextResponse.examples[0];
const result = clockResponse.examples[0];
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
  test(`${mode} clock context uses exact optional query scope, never a body or client time`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap({ ...context, orgId: path.includes('orgId=') ? orgId : null }),
    );
    assert.deepEqual(await api.getAttendanceClockContext(), context);
    assert.deepEqual(await api.getAttendanceClockContext({ orgId: null, timezone: null }), context);
    const query = { orgId: orgId.toUpperCase(), timezone: ' Asia/Shanghai ' };
    assert.deepEqual(await api.getAttendanceClockContext(query), { ...context, orgId });
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/organizations/attendance/clock-context',
        '/api/v1/organizations/attendance/clock-context',
        `/api/v1/organizations/attendance/clock-context?${new URLSearchParams(query)}`,
      ],
    );
    for (const call of calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.body, undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.headers['Content-Type'], undefined);
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
    }
  });

  test(`${mode} clock posts only the real body with the caller's stable header key and preserves personal or organization identity`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ data }) =>
      wrap({ ...result, orgId: data.orgId ?? null, memberId: data.orgId ? memberId : null }),
    );
    const input = {
      orgId,
      timezone: 'Asia/Shanghai',
      idempotencyKey: 'clock-click-1',
      clockType: 'CLOCK_IN',
      sourceRef: 'workbench-1',
      extJson: { device: 'desktop', nested: [null, false, 1] },
    };
    assert.deepEqual(await api.clockAttendance(input), { ...result, orgId, memberId });
    assert.deepEqual(await api.clockAttendance({ idempotencyKey: 'personal-1' }), result);
    const { idempotencyKey, ...body } = input;
    assert.deepEqual(calls[0].data, body);
    assert.deepEqual(calls[1].data, {});
    for (const call of calls) {
      assert.equal(call.path, '/api/v1/organizations/attendance/clock');
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.headers['Content-Type'], 'application/json');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(Object.hasOwn(call.data, 'idempotencyKey'), false);
    }
    assert.equal(calls[0].headers['Idempotency-Key'], idempotencyKey);
    assert.equal(calls[1].headers['Idempotency-Key'], 'personal-1');
  });

  test(`${mode} explicit same-key recovery accepts the original prior-day event and its latest daily state`, async (t) => {
    const current = {
      ...context,
      attendanceDate: '2026-11-04',
      serverTime: '2026-11-04 18:00:00',
      scheduleId: 1,
      dayType: 'WORK',
      shiftStartAt: '2026-11-04 09:00:00',
      shiftEndAt: '2026-11-04 18:00:00',
      nextClockType: 'CLOCK_OUT',
      buttonText: '下班打卡',
    };
    const old = {
      ...result,
      dailyAttendance: {
        ...result.dailyAttendance,
        firstClockInAt: '2026-10-23 08:50:00.000',
        lastClockOutAt: '2026-10-23 18:00:00.000',
        finalStatus: 'LEAVE',
        versionNo: 17,
      },
    };
    let lost = true;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/clock-context')) return wrap(current);
      if (lost) throw new TypeError('response lost');
      return wrap(old);
    });
    assert.deepEqual(await api.getAttendanceClockContext({ timezone: 'UTC' }), current);
    const input = { idempotencyKey: 'original-key', timezone: 'UTC', sourceRef: 'same-click' };
    await assert.rejects(
      () => api.clockAttendance(input),
      (error) => error.status === 0,
    );
    assert.equal(calls.length, 2);
    lost = false;
    assert.deepEqual(await api.clockAttendance(input), old);
    assert.deepEqual(calls[1].data, calls[2].data);
    assert.equal(calls[1].headers['Idempotency-Key'], calls[2].headers['Idempotency-Key']);
    assert.equal(calls.length, 3);
  });

  test(`${mode} refusal, rate limit, network and 5xx clock results never cause retries or replacement keys`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('offline');
      return wrap(null, status);
    });
    for (status of [400, 401, 403, 404, 409, 413, 429, 500, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.clockAttendance({ idempotencyKey: 'retry-original' }),
        (error) => error.status === status,
      );
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).headers['Idempotency-Key'], 'retry-original');
    }
  });

  test(`${mode} explicit 401 refresh retries the same body and key once, including when the second reply is 401`, async (t) => {
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 1800,
    };
    let clockCalls = 0;
    let alwaysUnauthorized = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) return wrap(tokens);
      clockCalls++;
      return clockCalls === 1 || alwaysUnauthorized ? wrap(null, 401) : wrap(result);
    });
    await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'EXPERT' });
    const input = { idempotencyKey: 'stable-key', timezone: 'Asia/Shanghai', clockType: null };
    assert.deepEqual(await api.clockAttendance(input), result);
    const writes = calls.filter(({ path }) => path.endsWith('/attendance/clock'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].data, writes[1].data);
    assert.equal(writes[0].headers['Idempotency-Key'], writes[1].headers['Idempotency-Key']);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
    alwaysUnauthorized = true;
    await assert.rejects(
      () => api.clockAttendance(input),
      (error) => error.status === 401,
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/attendance/clock')).length, 4);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 2);
  });
}

test('clock boundaries reject client identity/date/time, malformed scope, headers, extensions and oversized UTF8 metadata before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => wrap(result));
  const cycle = {};
  cycle.self = cycle;
  for (const patch of [
    { orgId: '' },
    { orgId: 1 },
    { timezone: 'Not/A_Timezone' },
    { timezone: 'x'.repeat(65) },
    { userId: result.userId },
    { memberId },
    { attendanceDate: '2026-11-04' },
    { clockAt: '2026-11-04 09:00:00.000' },
    { date: '2026-11-04' },
    { serverTime: '2026-11-04 09:00:00' },
    { idempotencyKey: '' },
    { idempotencyKey: ' ' },
    { idempotencyKey: 'x'.repeat(129) },
    { idempotencyKey: 'bad\r\nheader' },
    { idempotencyKey: '中文' },
    { clockType: 'CLOCK_IN_OUT' },
    { sourceRef: 'x'.repeat(129) },
    { extJson: NaN },
    { extJson: new Date() },
    { extJson: cycle },
    { extJson: { secret: undefined } },
  ])
    await assert.rejects(
      () => api.clockAttendance({ idempotencyKey: 'valid-key', ...patch }),
      (error) => error.status === 400,
    );
  for (const input of [
    null,
    { userId: result.userId },
    { memberId },
    { attendanceDate: '2026-11-04' },
    { clockType: 'CLOCK_IN' },
    { timezone: 'Not/A_Timezone' },
    { orgId: '' },
  ])
    await assert.rejects(
      () => api.getAttendanceClockContext(input),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
  await assert.rejects(
    () => api.clockAttendance({ idempotencyKey: 'valid-key', extJson: '中'.repeat(6000) }),
    (error) => error.status === 413,
  );
  assert.equal(calls.length, 0);
  await api.clockAttendance({ idempotencyKey: 'valid-key', extJson: '中'.repeat(5000) });
  assert.equal(calls.length, 1);
});

test('clock context validates server day, scope, schedule and button/type semantics without rejecting disabled cross-day schedules', async (t) => {
  let data;
  const { api, calls } = adapter(t, false, () => wrap(data));
  for (const patch of [
    { orgId },
    { attendanceDate: '2026-02-30' },
    { attendanceDate: '2026-10-22' },
    { serverTime: '2026-10-23T09:00:00Z' },
    { dayType: 'WORK' },
    { firstClockInAt: '2026-10-23 08:00:00' },
    { firstClockInAt: '2026-10-22 08:00:00' },
    { nextClockType: 'UNKNOWN' },
    { canClock: false },
    { canClock: 'true' },
    { nextClockType: null },
    { buttonText: '下班打卡' },
    { warning: false },
  ]) {
    data = { ...context, ...patch };
    const before = calls.length;
    await assert.rejects(
      () => api.getAttendanceClockContext(),
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
    assert.equal(calls.length, before + 1);
  }
  data = {
    ...context,
    scheduleId: 1,
    dayType: 'WORK',
    shiftStartAt: '2026-10-23 21:00:00',
    shiftEndAt: '2026-10-24 06:00:00',
    nextClockType: null,
    canClock: false,
    buttonText: '暂不可打卡',
    warning: '跨天班次不支持打卡',
  };
  assert.deepEqual(await api.getAttendanceClockContext(), data);
});

test('clock response validates event scope, raw event time and daily fields while preserving manual final status and repeat lower versions', async (t) => {
  let data;
  const { api, calls } = adapter(t, false, () => wrap(data));
  for (const patch of [
    { eventId: 0 },
    { eventNo: 'CLKwrong' },
    { userId: 'other' },
    { orgId },
    { memberId },
    { clockType: 'OTHER' },
    { clockAt: '2026-02-30 09:00:00.000' },
    { clockAt: '2026-10-23 09:00:00' },
    { timezone: 'bad/timezone' },
    { sourceType: 'CLIENT_OVERRIDE' },
    { dailyAttendance: { ...result.dailyAttendance, attendanceDate: '2026-10-24' } },
    { dailyAttendance: { ...result.dailyAttendance, firstClockInAt: null } },
    { dailyAttendance: { ...result.dailyAttendance, firstClockInAt: '2026-10-23 10:00:00.000' } },
    { dailyAttendance: { ...result.dailyAttendance, finalStatus: 'APPROVED' } },
    { dailyAttendance: { ...result.dailyAttendance, lateMinutes: -1 } },
    { dailyAttendance: { ...result.dailyAttendance, versionNo: 1.5 } },
    { dailyAttendance: { ...result.dailyAttendance, reviewRequired: 'false' } },
  ]) {
    data = { ...result, ...patch };
    const before = calls.length;
    await assert.rejects(
      () => api.clockAttendance({ idempotencyKey: 'same-key' }),
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
    assert.equal(calls.length, before + 1);
  }
  data = result;
  await assert.rejects(
    () => api.clockAttendance({ idempotencyKey: 'same-key', clockType: 'CLOCK_OUT' }),
    (error) => error.status === 502,
  );
  data = { ...result, orgId, memberId: null };
  await assert.rejects(
    () => api.clockAttendance({ idempotencyKey: 'same-key', orgId }),
    (error) => error.status === 502,
  );
  data = {
    ...result,
    clockType: 'CLOCK_OUT',
    dailyAttendance: {
      ...result.dailyAttendance,
      lastClockOutAt: result.clockAt,
      finalStatus: 'LEAVE',
    },
  };
  assert.deepEqual(await api.clockAttendance({ idempotencyKey: 'same-key' }), data);
  data = result;
  assert.deepEqual(await api.clockAttendance({ idempotencyKey: 'same-key' }), result);
});
