import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { examAdmissionStatus } from '../../src/modules/entrance-exams/exam-admission.js';
import {
  examAdmissionExample,
  examAdmissionSchema,
} from '../../src/modules/entrance-exams/exam-admission.schema.js';
import { ExamQueryService } from '../../src/modules/entrance-exams/exam-query.service.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'test-uid',
  sessionId: 'test-session',
  role: 'PM',
  clientType: 'desktop',
};
function setup() {
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ status: 'PUBLISHED' }) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: principal.userId }),
    },
    entranceExamGradingRound: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-a' }]) },
    projectExpertAssignment: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { organizationId: 'org-a' },
          { organizationId: 'org-a' },
          { organizationId: 'org-b' },
        ]),
    },
    entranceExamAttempt: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 1,
          examId: 2,
          version: { examNameSnapshot: '旧版本' },
          exam: { examName: '新名称' },
          candidateUserId: principal.userId,
          candidateUid: 'old-uid',
          candidate: { uid: 'new-uid', displayName: '昵称', realName: '姓名' },
          organizationId: null,
          organizationName: null,
          membership: null,
          finalResult: 'ADMITTED',
          admittedMember: null,
          submittedAt: new Date('2026-10-22T01:00:00Z'),
        },
      ]),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { tx, db, service: new ExamQueryService(db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  principal.role = 'PM';
});
test('admission state follows exam outcome before declined/joined member facts, including members who later left', () => {
  for (const member of [
    null,
    { status: 'ENTRY_DECLINED', joinedAt: new Date() },
    { status: 'LEFT', joinedAt: new Date() },
  ]) {
    expect(examAdmissionStatus('PENDING', member)).toBe('PENDING');
    expect(examAdmissionStatus('ELIMINATED', member)).toBe('ELIMINATED');
  }
  expect(examAdmissionStatus('ADMITTED', null)).toBe('PENDING_ENTRY');
  expect(examAdmissionStatus('ADMITTED', { status: 'ACTIVE', joinedAt: null })).toBe(
    'PENDING_ENTRY',
  );
  expect(examAdmissionStatus('ADMITTED', { status: 'LEFT', joinedAt: new Date() })).toBe(
    'ADMITTED',
  );
  expect(examAdmissionStatus('ADMITTED', { status: 'ENTRY_DECLINED', joinedAt: new Date() })).toBe(
    'ENTRY_DECLINED',
  );
});
test('admissions use submitted cross-exam records, historical version names, live display and snapshot search with consistent count/pagination', async () => {
  const { tx, service, db } = setup();
  expect(await service.admissions({ projectId: 3, keyword: '  旧%  ' }, principal)).toMatchObject({
    current: 1,
    size: 20,
    total: 1,
    pages: 1,
    records: [
      {
        examName: '旧版本',
        candidateUid: 'old-uid',
        candidateName: '昵称(姓名)',
        employmentType: null,
        examDate: '2026-10-22 09:00:00',
        admissionStatus: 'PENDING_ENTRY',
      },
    ],
  });
  const query = tx.entranceExamAttempt.findMany.mock.calls[0]![0];
  expect(query.where).toMatchObject({
    exam: { projectId: 3, deleted: false },
    submittedAt: { not: null },
    AND: [
      {},
      {
        OR: [
          { candidateName: { contains: '旧%' } },
          { candidateUid: { contains: '旧%' } },
          { organizationName: { contains: '旧%' } },
        ],
      },
    ],
  });
  expect(query.orderBy).toEqual([{ submittedAt: 'desc' }, { id: 'desc' }]);
  expect(tx.entranceExamAttempt.count.mock.calls[0]![0].where).toEqual(query.where);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(
    (await service.admissions({ projectId: 3, current: 2147483648 }, principal)).records,
  ).toEqual([]);
  expect(tx.entranceExamAttempt.findMany).toHaveBeenCalledTimes(1);
  await expect(
    service.admissions({ projectId: 3, current: Number.MAX_SAFE_INTEGER }, principal),
  ).rejects.toMatchObject({ status: 400 });
});
test('EXPERT queries are restricted to managed organizations on accepted organization assignments with active-owner precedence over legacy owner', async () => {
  const { tx, service } = setup();
  principal.role = 'EXPERT';
  await service.admissions({ projectId: 3, admissionStatus: 'PENDING_ENTRY' }, principal);
  expect(tx.projectExpertAssignment.findMany).toHaveBeenCalledWith({
    where: {
      projectId: 3,
      subjectType: 'ORGANIZATION',
      status: 'ACCEPTED',
      OR: [
        { organizationId: { in: ['org-a'] } },
        { owners: { some: { userId: principal.userId, status: 'ACTIVE' } } },
        { projectOwnerUserId: principal.userId, owners: { none: {} } },
      ],
    },
    select: { organizationId: true },
  });
  expect(tx.userOrgRel.findMany.mock.calls[0]![0].where).toEqual({
    userId: principal.userId,
    position: 'OWNER',
    joinStatus: { in: ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'] },
  });
  expect(tx.entranceExamAttempt.count.mock.calls[0]![0].where.organizationId).toEqual({
    in: ['org-a', 'org-b'],
  });
  expect(tx.projectManagerRecruitment.findFirst).not.toHaveBeenCalled();
  tx.projectExpertAssignment.findMany.mockResolvedValueOnce([]);
  await expect(service.admissions({ projectId: 3 }, principal)).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.entranceExamAttempt.count).toHaveBeenCalledTimes(1);
  tx.project.findFirst.mockResolvedValueOnce(null);
  await expect(service.admissions({ projectId: 3 }, principal)).rejects.toMatchObject({
    status: 404,
  });
  tx.project.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
  await expect(service.admissions({ projectId: 3 }, principal)).rejects.toMatchObject({
    status: 400,
  });
});
test('PM/NAVIGATOR cannot use organization ownership as fallback when current project/reviewer qualifications fail', async () => {
  const { tx, service } = setup();
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce(null);
  await expect(service.admissions({ projectId: 3 }, principal)).rejects.toMatchObject({
    status: 403,
  });
  principal.role = 'NAVIGATOR';
  await service.admissions({ projectId: 3 }, principal);
  tx.entranceExamGradingRound.findFirst.mockResolvedValueOnce(null);
  await expect(service.admissions({ projectId: 3 }, principal)).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.projectExpertAssignment.findMany).not.toHaveBeenCalled();
});
test('GET HTTP/OpenAPI preserves nullable organization fields, validates query bounds and includes Chinese descriptions and executable examples', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const mock = vi
    .spyOn(ExamQueryService.prototype, 'admissions')
    .mockResolvedValue(examAdmissionExample as never);
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    }),
    db,
  );
  const headers = { authorization: 'Bearer token' };
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/entrance-exams/admissions'].get.operationId).toBe(
      'getEntranceExamAdmissions',
    );
    const walk = (value: Record<string, unknown>) => {
      for (const field of Object.values(value.properties ?? {}) as Record<string, unknown>[]) {
        expect(field.description).toMatch(/[\u3400-\u9fff]/u);
        walk(field);
      }
      if (value.items) {
        expect((value.items as Record<string, unknown>).description).toMatch(/[\u3400-\u9fff]/u);
        walk(value.items as Record<string, unknown>);
      }
    };
    for (const schema of [
      examAdmissionSchema.querystring,
      ...Object.values(examAdmissionSchema.response!),
    ] as (Record<string, unknown> & { examples?: unknown[] })[]) {
      walk(schema);
      const validate = app.validatorCompiler!({
        schema,
        method: 'GET',
        url: '/example',
        httpPart: 'querystring',
      });
      for (const example of schema.examples ?? [])
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const response = await app.inject({
      url: '/api/v1/entrance-exams/admissions?projectId=3001&current=2&size=10',
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(examAdmissionExample);
    expect(mock).toHaveBeenCalledWith({ projectId: 3001, current: 2, size: 10 }, principal);
    for (const suffix of [
      'projectId=0',
      'projectId=2147483648',
      'projectId=x',
      'projectId=1&current=0',
      'projectId=1&size=101',
      'projectId=1&current=1.5',
      'projectId=1&admissionStatus=PASSED',
      '',
    ])
      expect(
        (await app.inject({ url: `/api/v1/entrance-exams/admissions?${suffix}`, headers }))
          .statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          url: '/api/v1/entrance-exams/admissions?projectId=1',
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=test' },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
