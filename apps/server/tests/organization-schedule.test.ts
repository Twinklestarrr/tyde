import { calendarDay, summarize } from '../src/modules/attendance/attendance-domain.js';
import { afterEach, expect, test, vi } from 'vitest';
import {
  PrismaClient,
  type Prisma,
  type OrgMemberSchedule,
  type OrgAttendanceDaily,
} from '@prisma/client';
import {
  expandBatch,
  normalizeDetails,
  type OrganizationScheduleBatch,
} from '../src/modules/attendance/organization-schedule.domain.js';
import {
  OrganizationScheduleService,
  recalculateScheduledDaily,
} from '../src/modules/attendance/organization-schedule.service.js';
import { HolidayCalendarService } from '../src/modules/attendance/holiday-calendar.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import * as schemas from '../src/modules/attendance/organization-schedule.schema.js';
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const principal: AuthPrincipal = {
  userId: id,
  uid: 'tester',
  role: 'EXPERT',
  clientType: 'desktop',
  sessionId: 'session',
};
const batch: OrganizationScheduleBatch = {
  orgId: id,
  memberIds: [id],
  startDate: '2026-10-01',
  endDate: '2026-10-12',
  dayType: 'WORK',
  startTime: '09:00',
  endTime: '18:00',
  overwrite: false,
};
const details = {
  orgId: id,
  schedules: [{ memberId: id, scheduleDate: '2026-10-01', dayType: 'REST' as const }],
  overwrite: false,
};
afterEach(() => vi.restoreAllMocks());
test('organization batch expands weekdays and excludes statutory days; makeup days still obey weekdays', async () => {
  const holiday = {
    month: vi.fn().mockResolvedValue({
      days: [
        { date: '2026-10-01', calendarDayType: 'PUBLIC_HOLIDAY' },
        { date: '2026-10-10', calendarDayType: 'MAKEUP_WORKDAY' },
      ],
    }),
  } as unknown as HolidayCalendarService;
  expect(
    (await expandBatch({ ...batch, memberIds: [id, id] }, holiday)).map((s) => s.scheduleDate),
  ).toEqual([
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-12',
  ]);
  expect(
    (await expandBatch({ ...batch, weekdays: [6] }, holiday)).map((s) => s.scheduleDate),
  ).toEqual(['2026-10-03', '2026-10-10']);
  await expect(expandBatch({ ...batch, endDate: '2028-01-01' }, holiday)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    expandBatch({ ...batch, startDate: batch.endDate, endDate: batch.startDate }, holiday),
  ).rejects.toMatchObject({ status: 400 });
  await expect(expandBatch({ ...batch, weekdays: [0] }, holiday)).rejects.toMatchObject({
    status: 400,
  });
});
test('details allow holiday overrides and per-item zones but reject duplicate pairs, invalid dates, shifts and zones', () => {
  expect(
    normalizeDetails({
      ...details,
      timezone: 'Asia/Shanghai',
      schedules: [{ ...details.schedules[0]!, timezone: 'America/New_York' }],
    })[0],
  ).toMatchObject({ timezone: 'America/New_York', startTime: null });
  for (const schedules of [
    [details.schedules[0]!, details.schedules[0]!],
    [{ ...details.schedules[0]!, scheduleDate: '2026-02-30' }],
    [{ ...details.schedules[0]!, startTime: '09:00' }],
    [{ ...details.schedules[0]!, timezone: 'bad' }],
    [{ ...details.schedules[0]!, dayType: 'WORK' as const, startTime: '18:00', endTime: '09:00' }],
  ])
    expect(() => normalizeDetails({ ...details, schedules })).toThrow();
});
test.each([
  [null, null, false, 'ABSENT'],
  ['09:01', null, false, 'LATE'],
  [null, '17:00', false, 'EARLY_LEAVE'],
  ['09:01', '17:00', false, 'LATE_EARLY'],
  ['09:00', '18:00', false, 'PRESENT'],
  ['09:01', '17:00', true, 'LATE_EARLY'],
])(
  'recalculation uses persisted clocks %s %s and preserves manual=%s',
  (first, last, manual, expected) => {
    const at = (time: string | null) => (time ? new Date(`2026-10-01T${time}:00Z`) : null);
    const schedule = {
      id: 1,
      status: 'ACTIVE',
      dayType: 'WORK',
      shiftStartAt: at('09:00'),
      shiftEndAt: at('18:00'),
    } as OrgMemberSchedule;
    const daily = {
      attendanceDate: new Date('2026-10-01'),
      firstClockInAt: at(first as string | null),
      lastClockOutAt: at(last as string | null),
      manualOverride: manual,
      finalStatus: 'LEAVE',
    } as OrgAttendanceDaily;
    expect(recalculateScheduledDaily(schedule, daily, '2026-10-02')).toMatchObject({
      autoStatus: expected,
      finalStatus: manual ? 'LEAVE' : expected,
      reviewRequired: false,
    });
    expect(
      recalculateScheduledDaily({ ...schedule, dayType: 'REST' }, daily, '2026-10-02').autoStatus,
    ).toBe('REST');
  },
);
test('writes authorize target organization before receipts or calendar access; PM and ordinary member cannot replay', async () => {
  const tx = {
    $queryRaw: vi.fn(),
    organization: { findFirst: vi.fn().mockResolvedValue({ id }) },
    userOrgRel: {
      findUnique: vi.fn().mockResolvedValue({ joinStatus: 'ACTIVE', position: 'MEMBER' }),
    },
    organizationScheduleReceipt: { findUnique: vi.fn() },
  };
  const db = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
  const service = new OrganizationScheduleService(db);
  for (const role of ['EXPERT', 'PM', 'NAVIGATOR'] as const)
    await expect(service.details('key', details, { ...principal, role })).rejects.toMatchObject({
      status: 403,
    });
  expect(tx.organizationScheduleReceipt.findUnique).not.toHaveBeenCalled();
  tx.userOrgRel.findUnique.mockResolvedValue({ joinStatus: 'ACTIVE', position: 'OWNER' });
  tx.organizationScheduleReceipt.findUnique.mockResolvedValue({
    requestHash: 'different',
  } as never);
  await expect(service.details('key', details, principal)).rejects.toMatchObject({ status: 409 });
  expect(tx.organizationScheduleReceipt.findUnique).toHaveBeenCalledWith({
    where: { orgId_userId_kind_key: { orgId: id, userId: id, kind: 'DETAIL', key: 'key' } },
  });
});
test('Swagger examples validate and HTTP serializes nested month and conflict memberId without leaking fields', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const result = (schemas.organizationScheduleResult.examples as unknown[])[0];
  vi.spyOn(OrganizationScheduleService.prototype, 'details').mockResolvedValue(
    result as Prisma.JsonValue,
  );
  vi.spyOn(OrganizationScheduleService.prototype, 'batch').mockResolvedValue(
    result as Prisma.JsonValue,
  );
  const days = Array.from({ length: 31 }, (_, i) =>
    calendarDay(`2026-10-${String(i + 1).padStart(2, '0')}`, '2026-10-23'),
  );
  const month = {
    month: '2026-10',
    total: 1,
    pages: 1,
    current: 1,
    size: 20,
    members: [
      {
        memberId: id,
        userId: id,
        realName: '测试',
        nickname: '排班测试',
        joinStatus: 'ACTIVE',
        canSchedule: true,
        days,
        summary: summarize(days),
      },
    ],
  };
  vi.spyOn(OrganizationScheduleService.prototype, 'list').mockResolvedValue(month);
  const app = await createApp(config, new PrismaClient());
  try {
    await app.ready();
    for (const schema of [
      schemas.organizationScheduleQuery,
      schemas.organizationBatchBody,
      schemas.organizationDetailsBody,
      schemas.organizationSchedulesResponse,
      schemas.organizationScheduleResult,
    ] as Record<string, unknown>[]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples as unknown[])
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [method, url, payload] of [
      ['POST', '/organizations/schedules', { orgId: id, month: '2026-10' }],
      ['PUT', '/organizations/schedules/batch', batch],
      ['PUT', '/organizations/schedules/details/batch', details],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1${url}`,
        payload,
        headers: { authorization: 'Bearer token', 'idempotency-key': 'key' },
      });
      expect(response.statusCode, response.body).toBe(200);
      if (method === 'PUT') expect(response.json().data).toEqual(result);
      else expect(response.json().data).toEqual(month);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const payload of [
      { orgId: id, month: '2026-10', current: '1' },
      { orgId: id, month: '2026-10', size: 101 },
      { orgId: id, month: 'bad' },
      { orgId: other, month: '2026-10', userId: id },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/organizations/schedules', payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/organizations/schedules/details/batch',
          payload: details,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
