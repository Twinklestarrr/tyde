import {
  respondBody,
  respondResponse,
  respondExample,
} from '../src/modules/expert/expert-respond.schema.js';
import {
  expertTaskExample,
  expertTasksBody,
  expertTasksResponse,
} from '../src/modules/expert/expert-task.schema.js';
import { ownerChangeBody, ownerChangeResponse } from '../src/modules/expert/expert-owner.schema.js';
import { afterEach, expect, test, vi } from 'vitest';
import {
  PrismaClient,
  type Prisma,
  type OrgMemberSchedule,
  type OrgAttendanceDaily,
} from '@prisma/client';
import { readConfig } from '../src/config/index.js';
import { createApp } from '../src/application.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { PersonalApplicationService } from '../src/modules/users/personal-application.service.js';
import {
  personalApplicationBody,
  personalApplicationResponse,
  personalApplicationExample,
} from '../src/modules/users/personal-application.schema.js';
import { FileRegistryService, tokenHash } from '../src/modules/files/file-registry.service.js';
import type { ObjectStorage } from '../src/modules/files/object-storage.js';
import { AttendanceService } from '../src/modules/attendance/attendance.service.js';
import {
  calendarDay,
  summarize,
  normalizeSchedules,
  monthDates,
} from '../src/modules/attendance/attendance-domain.js';
import { HolidayCalendarService } from '../src/modules/attendance/holiday-calendar.service.js';
import * as schemas from '../src/modules/attendance/attendance.schema.js';
import {
  ExpertAssignmentService,
  admissionStatus,
  expertProgress,
} from '../src/modules/expert/expert-assignment.service.js';
import {
  myProjectExample,
  assignmentDetailExample,
  myProjectsResponse,
  assignmentDetailResponse,
  projectOwnerCandidatesExample,
  projectOwnerCandidatesResponse,
} from '../src/modules/expert/expert-assignment.schema.js';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://127.0.0.1:3000',
  LOG_LEVEL: 'silent',
});
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'example',
  sessionId: 'session',
  role: 'EXPERT',
  clientType: 'desktop',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('avatar association checks ownership/token/head before claim; replay and release are transactional writes', async () => {
  const record = {
    id: 'upload',
    objectKey: 'avatar/test.png',
    ownerUid: principal.uid,
    claimTokenHash: tokenHash('token'),
    status: 'UPLOADED',
    bizType: 'AVATAR',
    expiresAt: new Date(Date.now() + 60000),
    fileSize: 12,
  };
  const update = vi.fn(),
    release = vi.fn();
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async () => [record]),
    uploadedFile: { update, updateMany: release },
  } as unknown as Prisma.TransactionClient;
  const storage = {
    head: vi.fn().mockResolvedValue({ size: 12 }),
    accessUrl: (key: string) => `https://storage.example/${key}`,
  } as unknown as ObjectStorage;
  const registry = new FileRegistryService({} as PrismaClient, storage, config.files);
  for (const [changes, token, status] of [
    [{ ownerUid: 'other' }, 'token', 403],
    [{ ownerUid: null }, 'token', 403],
    [{}, 'wrong', 403],
    [{}, '', 400],
    [{ status: 'RELEASED' }, 'token', 409],
    [{ expiresAt: new Date(0) }, 'token', 409],
    [{ bizType: 'COMMON' }, 'token', 400],
  ] as const) {
    vi.mocked(tx.$queryRaw).mockResolvedValueOnce([{ ...record, ...changes }]);
    await expect(
      registry.syncAvatar(tx, principal.userId, principal.uid, record.objectKey, token),
    ).rejects.toMatchObject({ status });
  }
  expect(update).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(storage.head).not.toHaveBeenCalled();
  expect(
    await registry.syncAvatar(tx, principal.userId, principal.uid, record.objectKey, 'token'),
  ).toBe('https://storage.example/avatar/test.png');
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: 'CLAIMED',
        claimedBizType: 'USER_AVATAR',
        claimedBizId: principal.userId,
        expiresAt: null,
      }),
    }),
  );
  expect(release).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        objectKey: { not: record.objectKey },
        claimedBizId: principal.userId,
      }),
    }),
  );
  vi.mocked(tx.$queryRaw).mockResolvedValueOnce([
    { ...record, status: 'CLAIMED', claimedBizType: 'USER_AVATAR', claimedBizId: principal.userId },
  ]);
  await registry.syncAvatar(
    tx,
    principal.userId,
    principal.uid,
    'https://storage.example/avatar/test.png',
  );
  expect(update).toHaveBeenCalledTimes(1);
  await registry.syncAvatar(tx, principal.userId, principal.uid, '');
  expect(release).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: { status: 'CLAIMED', claimedBizType: 'USER_AVATAR', claimedBizId: principal.userId },
    }),
  );
});

test('personal application pagination forces applicant, trims filters, uses Shanghai inclusive dates and tolerates malformed history', async () => {
  const query = vi.fn().mockResolvedValue([
    {
      id: principal.userId,
      versionNo: 3,
      businessType: 'ORG_MEMBER_EXIT',
      formData: {
        plannedLeaveDate: '2026-02-30',
        targetMemberId: 'old-invalid-id',
        targetMemberName: '历史姓名',
      },
      appliedAt: new Date('2026-10-20T16:00:00Z'),
      finishedAt: null,
    },
  ]);
  const count = vi.fn().mockResolvedValue(1);
  const tx = { approvalFlow: { count, findMany: query } };
  const service = new PersonalApplicationService({
    $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as PrismaClient);
  const result = await service.list(
    { startAt: '2026-10-01 00:00:00', endAt: '2026-10-31 23:59:59' },
    principal,
  );
  expect(count).toHaveBeenCalledWith({
    where: {
      applicantId: principal.userId,
      businessType: 'ORG_MEMBER_EXIT',
      appliedAt: { gte: new Date('2026-09-30T16:00:00Z'), lte: new Date('2026-10-31T15:59:59Z') },
    },
  });
  expect(result.records[0]).toMatchObject({
    applicationId: principal.userId,
    flowVersionNo: 3,
    appliedAt: '2026-10-21 00:00:00',
    plannedLeaveDate: null,
    targetMemberName: '历史姓名',
  });
  await service.list({ businessType: null }, principal);
  expect(count).toHaveBeenLastCalledWith({ where: { applicantId: principal.userId } });
  await expect(
    service.list({ startAt: '2026-10-02 00:00:00', endAt: '2026-10-01 00:00:00' }, principal),
  ).rejects.toMatchObject({ status: 400 });
  count.mockResolvedValue(1);
  query.mockClear();
  expect((await service.list({ current: 2147483647, size: 100 }, principal)).records).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

test('calendar fills leap months, distinguishes future and past, and counts LATE_EARLY in both counters', () => {
  expect(monthDates('2024-02').dates).toHaveLength(29);
  expect(() => monthDates('2026-13')).toThrow();
  const schedule = { id: 1, status: 'ACTIVE', dayType: 'WORK', versionNo: 0 } as OrgMemberSchedule;
  const past = calendarDay('2026-10-01', '2026-10-21', schedule);
  const future = calendarDay('2026-10-22', '2026-10-21', schedule);
  const both = calendarDay('2026-10-02', '2026-10-21', schedule, {
    finalStatus: 'LATE_EARLY',
  } as OrgAttendanceDaily);
  expect(past).toMatchObject({ calendarStatus: 'ABSENT', dailyId: null, finalStatus: null });
  expect(future.calendarStatus).toBe('PENDING_ATTENDANCE');
  expect(summarize([past, future, both])).toEqual({
    presentCount: 0,
    lateCount: 1,
    earlyLeaveCount: 1,
    leaveCount: 0,
    absentCount: 1,
  });
});

test('personal schedules validate real dates, duplicates, timezone, WORK/REST and normalized hash inputs', () => {
  const rest = { scheduleDate: '2026-10-21', dayType: 'REST' as const };
  const work = {
    scheduleDate: '2026-10-22',
    dayType: 'WORK' as const,
    startTime: '09:00',
    endTime: '18:00',
  };
  expect(normalizeSchedules({ schedules: [work, rest], overwrite: false })[0]).toMatchObject({
    ...rest,
    startTime: null,
    timezone: 'Asia/Shanghai',
  });
  for (const schedules of [
    [rest, rest],
    [{ ...rest, scheduleDate: '2026-02-30' }],
    [{ ...rest, startTime: '09:00' }],
    [{ ...work, endTime: '08:00' }],
    [{ ...work, startTime: '25:00' }],
    [{ ...work, endTime: undefined }],
  ])
    expect(() => normalizeSchedules({ schedules, overwrite: false })).toThrow();
  expect(() =>
    normalizeSchedules({ schedules: [rest], overwrite: false, timezone: 'not/timezone' }),
  ).toThrow();
});

test('batch transaction persists canonical receipt; same payload replays and changed payload conflicts; organization membership denies writes', async () => {
  const receipt = vi.fn().mockResolvedValue(null),
    insert = vi.fn(),
    saveReceipt = vi.fn();
  const tx = {
    $queryRaw: vi.fn(),
    userOrgRel: { count: vi.fn().mockResolvedValue(0) },
    personalScheduleReceipt: { findUnique: receipt, create: saveReceipt },
    orgMemberSchedule: { findMany: vi.fn().mockResolvedValue([]), createMany: insert },
  };
  const service = new AttendanceService({
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient);
  const input = {
    schedules: [{ scheduleDate: '2026-10-21', dayType: 'REST' as const }],
    overwrite: false,
  };
  const result = await service.batch('key', input, principal);
  expect(result).toMatchObject({ createdCount: 1, updatedCount: 0, skippedCount: 0 });
  const data = saveReceipt.mock.calls[0]![0].data;
  receipt.mockResolvedValue({ requestHash: data.requestHash, response: data.response });
  expect(await service.batch('key', { ...input, timezone: 'Asia/Shanghai' }, principal)).toEqual(
    result,
  );
  await expect(
    service.batch('key', { ...input, overwrite: true }, principal),
  ).rejects.toMatchObject({ status: 409 });
  tx.userOrgRel.count.mockResolvedValue(1);
  await expect(service.batch('other', input, principal)).rejects.toMatchObject({ status: 403 });
  expect(insert).toHaveBeenCalledTimes(1);
});

test('holiday source deduplicates concurrent fetches, validates dates and only returns published overrides', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        year: 2026,
        days: [
          { date: '2026-10-01', name: '国庆节', isOffDay: true },
          { date: '2026-10-10', name: '国庆节', isOffDay: false },
        ],
      }),
    ),
  );
  const service = new HolidayCalendarService('https://holiday.example/%d.json', fetcher, {});
  const [a, b] = await Promise.all([service.month('2026-10'), service.month('2026-10')]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(a).toEqual(b);
  expect(a.days).toHaveLength(2);
  expect(a.days[1]).toMatchObject({
    calendarDayType: 'MAKEUP_WORKDAY',
    defaultScheduleDayType: 'WORK',
    dayOfWeek: 6,
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 25 * 3600000);
  fetcher.mockRejectedValue(new Error('outage'));
  expect(await service.month('2026-10')).toEqual(a);
  await expect(
    new HolidayCalendarService('https://holiday.example/%d.json', fetcher, {}).month('2026-10'),
  ).rejects.toMatchObject({ status: 503 });
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ year: 2026, days: [{ date: '2026-02-30', name: '假期', isOffDay: true }] }),
    ),
  );
  await expect(
    new HolidayCalendarService('https://holiday.example/%d.json', fetcher, {}).month('2026-02'),
  ).rejects.toMatchObject({ status: 503 });
});

test('holiday outage uses the published 2026 baseline, caches it and refuses unknown years', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('network timeout'));
  const service = new HolidayCalendarService(undefined, fetcher);
  const october = await service.month('2026-10');
  expect(october.days.map((day) => day.date)).toEqual([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-10',
  ]);
  expect(october.days.at(-1)).toMatchObject({
    calendarDayType: 'MAKEUP_WORKDAY',
    defaultScheduleDayType: 'WORK',
    dayOfWeek: 6,
  });
  const february = await service.month('2026-02');
  expect(february.days).toHaveLength(11);
  expect(
    february.days.filter((day) => day.defaultScheduleDayType === 'WORK').map((day) => day.date),
  ).toEqual(['2026-02-14', '2026-02-28']);
  expect((await service.month('2026-03')).days).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const year = (
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => service.month(`2026-${String(i + 1).padStart(2, '0')}`)),
    )
  ).flatMap((month) => month.days);
  expect(year).toHaveLength(39);
  expect(new Set(year.map((day) => day.date)).size).toBe(39);
  expect(year.filter((day) => day.defaultScheduleDayType === 'REST')).toHaveLength(33);
  expect(
    year.filter((day) => day.defaultScheduleDayType === 'WORK').map((day) => day.date),
  ).toEqual(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);
  await expect(service.month('2099-01')).rejects.toMatchObject({ status: 503 });
});

test('fresh remote holidays take precedence over the bundled baseline', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        year: 2026,
        days: [{ date: '2026-10-01', name: '远程已校验数据', isOffDay: true }],
      }),
    ),
  );
  const service = new HolidayCalendarService(undefined, fetcher);
  const month = await service.month('2026-10');
  expect(month.days).toHaveLength(1);
  expect(month.days[0]?.holidayName).toBe('远程已校验数据');
});

test('expert admissions use pass/pending/fail/unentered priority and progress respects latest actual membership', () => {
  const base = {
    finalResult: 'PENDING',
    gradingStatus: 'NOT_STARTED',
    enteredAt: null,
    submittedAt: null,
    finalDecidedAt: null,
  };
  expect(admissionStatus([])).toBe('NOT_EXAMINED');
  expect(admissionStatus([{ ...base, enteredAt: new Date() }])).toBe('NOT_PASSED');
  expect(admissionStatus([{ ...base, gradingStatus: 'IN_PROGRESS' }])).toBe('PENDING');
  expect(
    admissionStatus([
      { ...base, gradingStatus: 'PENDING' },
      { ...base, finalResult: 'ADMITTED' },
    ]),
  ).toBe('PASSED');
  const member = {
    status: 'ACTIVE',
    entryDecision: 'YES',
    joinedAt: new Date(),
    standardTrainingConfirmedAt: new Date(),
  };
  expect(expertProgress(true, false, member)).toBe('ENTRANCE_EXAM');
  expect(expertProgress(false, false, member)).toBe('PRODUCTION_TASK');
  expect(expertProgress(false, false, { ...member, status: 'EXITED' })).toBe('STANDARD_TRAINING');
});

test('new routes preserve envelope, schemas/examples, credentials, malformed input rejection and response fields', async () => {
  const app = await createApp(config, new PrismaClient());
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  vi.spyOn(PersonalApplicationService.prototype, 'list').mockResolvedValue(
    personalApplicationExample as never,
  );
  vi.spyOn(AttendanceService.prototype, 'month').mockResolvedValue(
    schemas.attendanceResponse.examples[0] as never,
  );
  vi.spyOn(ExpertAssignmentService.prototype, 'myProjects').mockResolvedValue([
    myProjectExample,
  ] as never);
  vi.spyOn(ExpertAssignmentService.prototype, 'myTasks').mockResolvedValue([
    expertTaskExample,
  ] as never);
  vi.spyOn(ExpertAssignmentService.prototype, 'detail').mockResolvedValue(assignmentDetailExample);
  vi.spyOn(ExpertAssignmentService.prototype, 'projectOwnerCandidates').mockResolvedValue(
    projectOwnerCandidatesExample,
  );
  vi.spyOn(ExpertAssignmentService.prototype, 'respond').mockResolvedValue(respondExample);
  vi.spyOn(ExpertAssignmentService.prototype, 'setProjectOwners').mockResolvedValue(null);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    for (const [schema, examples] of [
      [personalApplicationBody, personalApplicationBody.examples],
      [personalApplicationResponse, personalApplicationResponse.examples],
      [schemas.scheduleBody, schemas.scheduleBody.examples],
      [schemas.attendanceUpdateBody, schemas.attendanceUpdateBody.examples],
      [schemas.attendanceResponse, schemas.attendanceResponse.examples],
      [schemas.holidayResponse, schemas.holidayResponse.examples],
      [schemas.scheduleResponse, schemas.scheduleResponse.examples],
      [schemas.attendanceUpdateResponse, schemas.attendanceUpdateResponse.examples],
      [myProjectsResponse, myProjectsResponse.examples],
      [expertTasksBody, expertTasksBody.examples],
      [expertTasksResponse, expertTasksResponse.examples],
      [assignmentDetailResponse, assignmentDetailResponse.examples],
      [projectOwnerCandidatesResponse, projectOwnerCandidatesResponse.examples],
      [respondBody, respondBody.examples],
      [respondResponse, respondResponse.examples],
      [ownerChangeBody, ownerChangeBody.examples],
      [ownerChangeResponse, ownerChangeResponse.examples],
    ] as const) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of examples) {
        const valid = validate(example);
        expect(valid, JSON.stringify(validate.errors)).toBe(true);
      }
    }
    expect(spec.paths['/api/v1/users/me/applications'].post.security).toHaveLength(2);
    for (const [method, url, payload, expected] of [
      ['POST', '/api/v1/users/me/applications', { businessType: null }, personalApplicationExample],
      [
        'GET',
        '/api/v1/organizations/attendance?month=2026-10',
        undefined,
        schemas.attendanceResponse.examples[0],
      ],
      ['GET', '/api/v1/expert-assignments/my-projects', undefined, [myProjectExample]],
      ['POST', '/api/v1/expert-assignments/my-tasks', {}, [expertTaskExample]],
      ['POST', '/api/v1/expert-assignments/respond', respondBody.examples[0], respondExample],
      ['POST', '/api/v1/expert-assignments/set-project-owners', ownerChangeBody.examples[0], null],
      [
        'POST',
        '/api/v1/expert-assignments/change-project-owner',
        ownerChangeBody.examples[1],
        null,
      ],
      [
        'GET',
        '/api/v1/expert-assignments/project-owner-candidates?assignmentId=1',
        undefined,
        projectOwnerCandidatesExample,
      ],
      [
        'GET',
        '/api/v1/expert-assignments/detail?assignmentId=1',
        undefined,
        assignmentDetailExample,
      ],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        payload,
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(expected);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/applications',
      payload: { applicantId: 'other' },
    });
    expect(invalid.statusCode).toBe(400);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/applications',
      payload: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    for (const payload of [{ userId: 'other' }, { status: 'BAD' }, { keyword: 'x'.repeat(101) }]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/expert-assignments/my-tasks', payload }))
          .statusCode,
      ).toBe(400);
    }
    const overflow = await app.inject('/api/v1/expert-assignments/detail?assignmentId=2147483648');
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json()).toMatchObject({ code: 400, data: null });
    expect(
      spec.paths['/api/v1/expert-assignments/project-owner-candidates'].get.parameters[0]
        .description,
    ).toContain('分配ID');
    for (const value of ['', '0', '-1', '1.2', '1e2', 'abc']) {
      expect(
        (
          await app.inject(
            `/api/v1/expert-assignments/project-owner-candidates?assignmentId=${value}`,
          )
        ).statusCode,
      ).toBe(400);
    }
  } finally {
    await app.close();
  }
});

test('personal transfer applications join only concrete flows and preserve applicant pagination', async () => {
  const row = {
    id: 'flow',
    businessType: 'PROJECT_MEMBER_TRANSFER',
    businessId: '7',
    versionNo: 1,
    formData: { movementId: 999, targetProjectId: 999 },
    appliedAt: new Date('2026-10-26T00:00:00Z'),
    finishedAt: null,
  };
  const movements = vi
    .fn()
    .mockResolvedValue([
      {
        id: 7,
        flowId: 'flow',
        memberId: 2,
        userId: 'target',
        sourceProjectId: 1,
        targetProjectId: 3,
        status: 'PROCESSING',
        plannedEffectiveDate: new Date('2099-01-01'),
        member: {
          organizationId: null,
          user: { uid: 'target', displayName: '当前昵称', realName: '姓名' },
        },
        targetProject: { projectName: '真实目标' },
      },
    ]);
  const service = new PersonalApplicationService({
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        approvalFlow: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([row]),
        },
        projectMemberMovement: { findMany: movements },
      }),
  } as unknown as PrismaClient);
  expect(
    (await service.list({ businessType: null }, principal)).records[0]!.transfer,
  ).toMatchObject({
    movementId: 7,
    targetProjectId: 3,
    targetProjectName: '真实目标',
    targetUserName: '当前昵称(姓名)',
  });
  expect(movements).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        flowId: { in: ['flow'] },
        initiatedBy: principal.userId,
      },
    }),
  );
  row.businessId = '999';
  expect((await service.list({ businessType: null }, principal)).records[0]!.transfer).toBe(null);
});
