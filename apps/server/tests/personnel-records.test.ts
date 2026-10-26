import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import {
  PersonnelRecordsService,
  attendanceSummary,
  performanceDates,
} from '../src/modules/personnel/personnel-records.service.js';
import {
  attendanceBody,
  performanceBody,
  performanceCreateBody,
  attendanceResponse,
  performanceResponse,
  attendanceExample,
  performanceExample,
} from '../src/modules/personnel/personnel-records.schema.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'tester',
  role: 'PM',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
test('performance date range and creation reject invalid dates, blank body and Shanghai future date before writes', async () => {
  for (const query of [
    { recordDateStart: '2026-02-30' },
    { recordDateStart: '2026-10-24', recordDateEnd: '2026-10-23' },
  ])
    expect(() => performanceDates(query)).toThrow();
  const service = new PersonnelRecordsService({} as never);
  for (const change of [
    { recordDate: '2026-10-25' },
    { content: '   ' },
    { attachmentIds: Array(11).fill('id') },
    { attachmentUploadTokens: { extra: 'token' } },
  ])
    await expect(
      service.createPerformance(
        { projectId: 1, memberId: 1, recordDate: '2026-10-24', content: 'ok', ...change },
        principal,
        new Date('2026-10-23T16:00:00Z'),
      ),
    ).rejects.toMatchObject({ status: 400 });
});
test('attendance summaries count late-early in both totals and preserve pending/rest schedule rows', () => {
  expect(
    attendanceSummary(
      ['LATE_EARLY', 'PRESENT', 'LEAVE', 'ABSENT', 'REST', null].map((finalAttendanceStatus) => ({
        finalAttendanceStatus,
      })),
    ),
  ).toEqual({
    scheduledCount: 6,
    presentCount: 1,
    lateCount: 1,
    earlyLeaveCount: 1,
    leaveCount: 1,
    absentCount: 1,
  });
});
test('personnel records Swagger examples and real route serialization preserve day precision, attachments and reject malformed requests', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  vi.spyOn(PersonnelRecordsService.prototype, 'attendance').mockResolvedValue({
    ...attendanceExample,
    secret: 'hidden',
  } as never);
  vi.spyOn(PersonnelRecordsService.prototype, 'performance').mockResolvedValue(performanceExample);
  vi.spyOn(PersonnelRecordsService.prototype, 'createPerformance').mockResolvedValue(null);
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    await app.ready();
    for (const schema of [
      attendanceBody,
      performanceBody,
      performanceCreateBody,
      attendanceResponse,
      performanceResponse,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [path, payload, expected] of [
      ['attendance/list', attendanceBody.examples[0], attendanceExample],
      ['performance/list', performanceBody.examples[0], performanceExample],
      ['performance/create', performanceCreateBody.examples[0], null],
    ] as const) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/project-personnel/' + path,
        payload,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().data).toEqual(expected);
      expect(result.headers['cache-control']).toBe('no-store');
    }
    for (const [path, payload] of [
      ['attendance/list', { projectId: 1, month: '2026-13' }],
      ['attendance/list', { projectId: 1, month: '2026-10', size: 101 }],
      ['attendance/list', { projectId: 1, month: '2026-10', attendanceStatuses: ['bad'] }],
      ['performance/list', { projectId: 1, memberId: '1' }],
      ['performance/list', { projectId: 1, memberId: 1, recordDateStart: '2026-02-30' }],
      [
        'performance/create',
        { projectId: 1, memberId: 1, recordDate: '2026-10-22', content: 'ok', attachmentIds: [1] },
      ],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/project-personnel/' + path,
        payload,
      });
      expect(r.statusCode, r.body).toBe(400);
    }
  } finally {
    await app.close();
  }
});
