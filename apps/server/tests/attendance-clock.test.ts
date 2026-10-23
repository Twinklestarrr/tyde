import { afterEach, expect, test, vi } from 'vitest';
import { PrismaClient, type OrgMemberSchedule, type OrgAttendanceDaily } from '@prisma/client';
import {
  clockDecision,
  clockWallTime,
  clockTimezone,
  calculateClockDaily,
  eventBounds,
} from '../src/modules/attendance/attendance-clock.domain.js';
import { AttendanceClockService } from '../src/modules/attendance/attendance-clock.service.js';
import { replayClockDaily } from '../src/modules/attendance/attendance-replay.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import * as schemas from '../src/modules/attendance/attendance-clock.schema.js';
const id = '00000000-0000-4000-8000-000000000001';
const p: AuthPrincipal = {
  userId: id,
  uid: 'tester',
  role: 'EXPERT',
  clientType: 'desktop',
  sessionId: 'session',
};
const at = (time: string) => new Date(`2026-10-23T${time}:00Z`);
const schedule = {
  id: 1,
  status: 'ACTIVE',
  scheduleDate: at('00:00'),
  dayType: 'WORK',
  shiftStartAt: at('09:00'),
  shiftEndAt: at('18:00'),
} as OrgMemberSchedule;
const daily = {
  scopeKey: id,
  userId: id,
  attendanceDate: at('00:00'),
  finalStatus: 'LEAVE',
  manualOverride: true,
  firstClockInAt: at('01:00'),
  lastClockOutAt: at('23:00'),
} as OrgAttendanceDaily;
afterEach(() => vi.restoreAllMocks());
test.each([
  ['08:59', [], 'CLOCK_IN'],
  ['13:29', [], 'CLOCK_IN'],
  ['13:30', [], 'CLOCK_OUT'],
  ['23:59', [], 'CLOCK_OUT'],
  ['09:01', [{ clockType: 'CLOCK_IN', clockAt: at('09:00') }], 'CLOCK_OUT'],
  ['09:01', [{ clockType: 'CLOCK_OUT', clockAt: at('09:00') }], 'CLOCK_OUT'],
])(
  'clock decision uses midpoint, existing events and repeated outs at %s',
  (time, events, type) => {
    expect(clockDecision(schedule, events, at(time)).nextClockType).toBe(type);
  },
);
test('clock permits unscheduled/rest but disables invalid and cross-day shifts', () => {
  expect(clockDecision(null, [], at('08:00'))).toMatchObject({
    nextClockType: 'CLOCK_IN',
    canClock: true,
  });
  expect(clockDecision({ ...schedule, dayType: 'REST' }, [], at('22:00')).nextClockType).toBe(
    'CLOCK_IN',
  );
  for (const item of [
    { ...schedule, shiftStartAt: null },
    { ...schedule, shiftEndAt: at('08:00') },
    { ...schedule, shiftEndAt: new Date('2026-10-24T01:00Z') },
  ])
    expect(clockDecision(item, [], at('09:00')).canClock).toBe(false);
});
test('clock timezone preserves milliseconds, handles date rollover and rejects invalid IANA zones', () => {
  const instant = new Date('2026-10-23T16:01:02.123Z');
  expect(clockWallTime(instant, clockTimezone()).toISOString()).toBe('2026-10-24T00:01:02.123Z');
  expect(clockWallTime(instant, 'America/New_York').toISOString()).toBe('2026-10-23T12:01:02.123Z');
  expect(clockTimezone('  ')).toBe('Asia/Shanghai');
  expect(() => clockTimezone('bad/timezone')).toThrow();
});
test('replay uses event extrema independent of order and protects manual results', () => {
  const events = [
    { clockType: 'CLOCK_OUT', clockAt: at('17:30') },
    { clockType: 'CLOCK_IN', clockAt: at('10:00') },
    { clockType: 'CLOCK_IN', clockAt: at('09:30') },
    { clockType: 'CLOCK_OUT', clockAt: at('17:00') },
  ];
  expect(eventBounds(events)).toEqual({ firstClockInAt: at('09:30'), lastClockOutAt: at('17:30') });
  expect(calculateClockDaily(schedule, daily, '2026-10-23', events)).toMatchObject({
    autoStatus: 'LATE_EARLY',
    finalStatus: 'LEAVE',
    lateMinutes: 30,
    earlyLeaveMinutes: 30,
    workedMinutes: 480,
  });
  expect(
    calculateClockDaily(schedule, { ...daily, manualOverride: false }, '2026-10-23', events)
      .finalStatus,
  ).toBe('LATE_EARLY');
});
test('replay handles missing card, no events, rest, no schedule and reversed times', () => {
  expect(calculateClockDaily(schedule, daily, '2026-10-23', []).autoStatus).toBeNull();
  expect(calculateClockDaily(schedule, daily, '2026-10-24', []).autoStatus).toBe('ABSENT');
  expect(calculateClockDaily(null, daily, '2026-10-23', []).autoStatus).toBe('UNSCHEDULED');
  expect(
    calculateClockDaily({ ...schedule, dayType: 'REST' }, daily, '2026-10-23', []).autoStatus,
  ).toBe('REST');
  expect(
    calculateClockDaily(schedule, daily, '2026-10-23', [
      { clockType: 'CLOCK_OUT', clockAt: at('17:00') },
    ]),
  ).toMatchObject({ autoStatus: 'EARLY_LEAVE', lateMinutes: 0, workedMinutes: 0 });
  expect(
    calculateClockDaily(schedule, daily, '2026-10-23', [
      { clockType: 'CLOCK_IN', clockAt: at('10:00') },
      { clockType: 'CLOCK_OUT', clockAt: at('09:00') },
    ]).workedMinutes,
  ).toBe(0);
});
test('schedule replay uses original events over stale snapshots and retains legacy snapshot without events', async () => {
  const findMany = vi.fn().mockResolvedValue([{ clockType: 'CLOCK_IN', clockAt: at('09:30') }]);
  const tx = { attendanceClockEvent: { findMany } };
  expect(await replayClockDaily(tx as never, schedule, daily, '2026-10-23')).toMatchObject({
    firstClockInAt: at('09:30'),
    lastClockOutAt: null,
  });
  expect(findMany).toHaveBeenCalledWith({
    where: { scopeKey: id, userId: id, attendanceDate: daily.attendanceDate },
  });
  findMany.mockResolvedValue([]);
  expect(await replayClockDaily(tx as never, schedule, daily, '2026-10-23')).toMatchObject({
    firstClockInAt: at('01:00'),
    lastClockOutAt: at('23:00'),
  });
});
test('clock routes validate examples, serialize responses and reject forged dates, invalid keys and types', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const context = vi
    .spyOn(AttendanceClockService.prototype, 'context')
    .mockResolvedValue(schemas.clockContextResponse.examples[0] as never);
  const clock = vi
    .spyOn(AttendanceClockService.prototype, 'clock')
    .mockResolvedValue(schemas.clockResponse.examples[0] as never);
  try {
    await app.ready();
    for (const schema of [schemas.clockBody, schemas.clockContextResponse, schemas.clockResponse]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      expect(validate(schema.examples[0]), JSON.stringify(validate.errors)).toBe(true);
    }
    const get = await app.inject('/api/v1/organizations/attendance/clock-context');
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().data).toEqual(schemas.clockContextResponse.examples[0]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/attendance/clock',
      headers: { 'idempotency-key': 'click' },
      payload: schemas.clockBody.examples[0],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(schemas.clockResponse.examples[0]);
    for (const payload of [{ clockAt: '2026-01-01' }, { userId: id }, { clockType: 'ADMIN' }]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations/attendance/clock',
        headers: { 'idempotency-key': 'bad' },
        payload,
      });
      expect(r.statusCode, r.body).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/attendance/clock',
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(context).toHaveBeenCalledTimes(1);
    expect(clock).toHaveBeenCalledTimes(1);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/organizations/attendance/clock'].post.security).toHaveLength(2);
  } finally {
    await app.close();
  }
});
