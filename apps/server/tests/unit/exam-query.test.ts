import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { requireExamViewer } from '../../src/modules/entrance-exams/exam-access.js';
import { ExamCommandService } from '../../src/modules/entrance-exams/exam-command.service.js';
import {
  examCloseExample,
  examDetailExample,
  examManagementExample,
  examQuerySchema,
  examRosterExample,
} from '../../src/modules/entrance-exams/exam-query.schema.js';
import { ExamQueryService } from '../../src/modules/entrance-exams/exam-query.service.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'manager-uid',
  sessionId: 'session',
  role: 'PM',
  clientType: 'desktop',
};
const locator = { projectId: 3001, examId: 5001 };
const at = new Date('2026-10-21T00:00:00Z');
function setup() {
  const flags = { pm: true, navigator: false };
  const snapshot = [
    { userId: principal.userId, uid: 'old-uid', name: '旧名字', extra: { retained: true } },
    { userId: 'invalid-old-id', name: '历史快照' },
  ];
  const version = {
    id: 6001,
    examId: 5001,
    versionNo: 1,
    durationMinutes: null,
    registrationDeadline: at,
    fullScore: new Prisma.Decimal(20),
    passScore: new Prisma.Decimal(12),
    decisionRule: 'MAJORITY',
    tieBreakRule: null,
    papers: [
      {
        id: 7001,
        sequenceNo: 1,
        paperName: null,
        totalScore: new Prisma.Decimal(20),
        questions: [
          {
            id: 8001,
            sequenceNo: 1,
            questionContent: '题干',
            questionFilesJson: [{ objectKey: 'key', fileSize: 5, extra: '保留' }],
            requiredFlag: true,
            score: new Prisma.Decimal(20),
            scoreSource: 'MANUAL',
            referenceAnswer: null,
            referenceFilesJson: null,
          },
        ],
      },
    ],
    gradingRounds: [
      {
        id: 9001,
        roundNo: 1,
        gradingMode: 'MANUAL',
        toolCode: null,
        toolName: null,
        toolConfigJson: null,
        reviewersJson: snapshot,
      },
      {
        id: 9002,
        roundNo: 2,
        gradingMode: 'AUTO',
        toolCode: 'tool',
        toolName: '工具',
        toolConfigJson: { config: ['参数'], files: [{ fileName: 'tool.txt', fileSize: 5 }] },
        reviewersJson: null,
      },
    ],
  };
  const attempt = {
    id: 10001,
    attemptNo: 'ATTEMPT_TEST',
    candidateUserId: principal.userId,
    candidateUid: 'candidate-uid',
    candidateName: '快照名',
    candidate: { displayName: '当前昵称', realName: '当前姓名' },
    organizationId: null,
    organizationName: null,
    finalResult: 'ADMITTED',
    enteredAt: at,
    submittedAt: null,
  };
  const tx = {
    managementGrant: {
      findFirst: vi.fn(async ({ where }) =>
        (where.role === 'PM' ? flags.pm : flags.navigator) ? { userId: principal.userId } : null,
      ),
    },
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: 3001, status: 'PUBLISHED', deleted: false }),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({
        candidateUserId: principal.userId,
        expertRecruitmentHandlerUserId: null,
      }),
    },
    entranceExamGradingRound: { findFirst: vi.fn().mockResolvedValue({ id: 9001 }) },
    projectEntranceExam: {
      findFirst: vi.fn().mockResolvedValue({
        id: 5001,
        projectId: 3001,
        currentVersionId: 6001,
        status: 'ACTIVE',
        examName: '考试',
        examNo: 'EX_TEST',
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 5001,
          currentVersionId: 6001,
          status: 'ACTIVE',
          examName: '考试',
          examNo: 'EX_TEST',
          createdAt: at,
          closedAt: null,
        },
      ]),
    },
    entranceExamVersion: { findFirst: vi.fn().mockResolvedValue(version) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: principal.userId,
          uid: principal.uid,
          displayName: '实时昵称',
          realName: '实时姓名',
        },
      ]),
    },
    projectProductionPlan: {
      findUnique: vi.fn().mockResolvedValue({ needWrittenExam: true, maxActiveExamCount: 2 }),
    },
    entranceExamAttempt: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([attempt]),
      groupBy: vi.fn().mockResolvedValue([
        { examId: 5001, finalResult: 'ADMITTED', _count: { _all: 1 } },
        { examId: 5001, finalResult: 'ELIMINATED', _count: { _all: 2 } },
      ]),
    },
    entranceExamGradingRecord: {
      findMany: vi.fn().mockResolvedValue([
        {
          attemptId: 10001,
          score: new Prisma.Decimal(0),
          roundResult: 'ELIMINATED',
          gradingRound: { roundNo: 1, gradingMode: 'MANUAL' },
        },
      ]),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { db, tx, flags, snapshot, version, attempt, service: new ExamQueryService(db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  principal.role = 'PM';
});
test('viewer scope requires current PM/handler or a separately authorized configured navigator, never role or creator alone', async () => {
  const { tx } = setup();
  expect((await requireExamViewer(tx as never, 3001, principal)).canManage).toBe(true);
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce({
    candidateUserId: 'other',
    expertRecruitmentHandlerUserId: principal.userId,
  });
  expect((await requireExamViewer(tx as never, 3001, principal)).canManage).toBe(false);
  principal.role = 'NAVIGATOR';
  expect((await requireExamViewer(tx as never, 3001, principal)).canManage).toBe(false);
  expect(tx.entranceExamGradingRound.findFirst).toHaveBeenCalledWith({
    where: {
      gradingMode: 'MANUAL',
      version: { exam: { projectId: 3001, deleted: false } },
      reviewersJson: { array_contains: [{ userId: principal.userId }] },
    },
    select: { id: true },
  });
  tx.entranceExamGradingRound.findFirst.mockResolvedValueOnce(null);
  await expect(requireExamViewer(tx as never, 3001, principal)).rejects.toMatchObject({
    status: 403,
  });
  principal.role = 'EXPERT';
  await expect(requireExamViewer(tx as never, 3001, principal)).rejects.toMatchObject({
    status: 403,
  });
});
test('dual grants can fall back to configured NAVIGATOR, and project absence/publication remain separate errors', async () => {
  const { tx } = setup();
  principal.role = 'NAVIGATOR';
  expect((await requireExamViewer(tx as never, 3001, principal)).canManage).toBe(false);
  tx.project.findFirst.mockResolvedValueOnce(null);
  await expect(requireExamViewer(tx as never, 3001, principal)).rejects.toMatchObject({
    status: 404,
  });
  tx.project.findFirst.mockResolvedValueOnce({ id: 3001, status: 'DRAFT', deleted: false });
  await expect(requireExamViewer(tx as never, 3001, principal)).rejects.toMatchObject({
    status: 400,
  });
});
test('detail loads only the current version, splits files and refreshes display names in response copies without changing historical JSON', async () => {
  const { service, tx, snapshot, version } = setup();
  const original = structuredClone(snapshot),
    tool = structuredClone(version.gradingRounds[1]!.toolConfigJson);
  const result = await service.detail(locator, principal);
  expect(tx.entranceExamVersion.findFirst.mock.calls[0]![0].where).toEqual({
    id: 6001,
    examId: 5001,
  });
  expect(result.gradingRounds[0]!.reviewers).toEqual([
    { ...snapshot[0], name: '实时昵称(实时姓名)' },
    snapshot[1],
  ]);
  expect(result.gradingRounds[1]).toMatchObject({
    toolConfig: { config: ['参数'] },
    toolFiles: [{ fileName: 'tool.txt', fileSize: 5 }],
  });
  expect(result.papers[0]!.questions[0]!.questionFiles).toEqual([
    { objectKey: 'key', fileSize: 5, extra: '保留' },
  ]);
  expect(snapshot).toEqual(original);
  expect(version.gradingRounds[1]!.toolConfigJson).toEqual(tool);
});
test('detail refuses closed/missing/foreign exams and abnormal current configuration rather than inventing empty content', async () => {
  const { service, tx } = setup();
  tx.projectEntranceExam.findFirst.mockResolvedValueOnce(null);
  await expect(service.detail(locator, principal)).rejects.toMatchObject({ status: 404 });
  tx.projectEntranceExam.findFirst.mockResolvedValueOnce({ status: 'CLOSED' });
  await expect(service.detail(locator, principal)).rejects.toMatchObject({ status: 400 });
  tx.projectEntranceExam.findFirst.mockResolvedValueOnce({
    status: 'ACTIVE',
    currentVersionId: null,
  });
  await expect(service.detail(locator, principal)).rejects.toMatchObject({ status: 500 });
  tx.entranceExamVersion.findFirst.mockResolvedValueOnce(null);
  await expect(service.detail(locator, principal)).rejects.toMatchObject({ status: 500 });
});
test('management aggregates only submitted attempts and computes HALF_UP rates and read-only/missing-plan/full-cap reasons', async () => {
  const { service, tx } = setup();
  const result = await service.management(3001, principal);
  expect(result).toMatchObject({
    activeExamCount: 1,
    maxActiveExamCount: 2,
    canCreateExam: true,
    createDisabledReason: null,
    exams: [{ examineeCount: 3, admittedCount: 1, admissionRate: 33.33 }],
  });
  expect(tx.entranceExamAttempt.groupBy.mock.calls[0]![0].where.submittedAt).toEqual({ not: null });
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce({
    candidateUserId: 'other',
    expertRecruitmentHandlerUserId: principal.userId,
  });
  expect(await service.management(3001, principal)).toMatchObject({
    canCreateExam: false,
    createDisabledReason: '阅卷人仅可查看考试信息',
  });
  tx.projectProductionPlan.findUnique.mockResolvedValueOnce(null);
  expect(await service.management(3001, principal)).toMatchObject({
    maxActiveExamCount: 1,
    needWrittenExam: false,
    canCreateExam: false,
    createDisabledReason: '生产计划未配置准入考试',
  });
  tx.projectProductionPlan.findUnique.mockResolvedValueOnce({
    needWrittenExam: true,
    maxActiveExamCount: 1,
  });
  expect(await service.management(3001, principal)).toMatchObject({
    canCreateExam: false,
    createDisabledReason: '进行中考试数量已达项目配置上限',
  });
});
test('roster normalizes pagination, preserves zero grades, hides pre-submit final result and distinguishes snapshot search from live display', async () => {
  const { service, tx } = setup();
  const result = await service.roster(
    { ...locator, current: -2, size: 500, keyword: '  快照%  ' },
    principal,
  );
  expect(result).toMatchObject({
    current: 1,
    size: 100,
    pages: 1,
    records: [
      {
        candidateName: '当前昵称(当前姓名)',
        finalResult: null,
        roundScores: [{ score: 0, roundResult: 'ELIMINATED' }],
      },
    ],
  });
  expect(tx.entranceExamAttempt.findMany.mock.calls[0]![0].where.OR[0]).toEqual({
    candidateName: { contains: '快照%' },
  });
  await service.roster({ ...locator, finalResult: 'PENDING' }, principal);
  expect(tx.entranceExamAttempt.count.mock.calls[1]![0].where).toMatchObject({
    submittedAt: { not: null },
    finalResult: 'PENDING',
  });
  const empty = await service.roster({ ...locator, current: 2147483648 }, principal);
  expect(empty.records).toEqual([]);
  expect(empty.total).toBe(1);
  expect(tx.entranceExamAttempt.findMany).toHaveBeenCalledTimes(2);
});
test('roster empty pages do not fabricate round tasks or query grading rows; offset overflow fails clearly', async () => {
  const { service, tx } = setup();
  tx.entranceExamAttempt.count.mockResolvedValue(0);
  expect(await service.roster(locator, principal)).toEqual({
    current: 1,
    size: 20,
    total: 0,
    pages: 0,
    records: [],
  });
  expect(tx.entranceExamGradingRecord.findMany).not.toHaveBeenCalled();
  await expect(
    service.roster({ ...locator, current: Number.MAX_SAFE_INTEGER, size: 100 }, principal),
  ).rejects.toMatchObject({ status: 400 });
});
test('HTTP and OpenAPI preserve four route contracts, binary-independent snapshot JSON, nested Chinese descriptions and complete examples', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  vi.spyOn(ExamQueryService.prototype, 'detail').mockResolvedValue(examDetailExample as never);
  vi.spyOn(ExamQueryService.prototype, 'management').mockResolvedValue(
    examManagementExample as never,
  );
  vi.spyOn(ExamQueryService.prototype, 'roster').mockResolvedValue(examRosterExample as never);
  vi.spyOn(ExamCommandService.prototype, 'close').mockResolvedValue(examCloseExample);
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
    const walk = (schema: Record<string, unknown>) => {
      for (const value of Object.values(
        (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        expect(value.description).toMatch(/[\u3400-\u9fff]/u);
        walk(value);
      }
      if (schema.items) {
        expect((schema.items as Record<string, unknown>).description).toMatch(/[\u3400-\u9fff]/u);
        walk(schema.items as Record<string, unknown>);
      }
      for (const choice of (schema.anyOf ?? []) as Record<string, unknown>[]) walk(choice);
    };
    for (const kind of ['detail', 'management', 'close', 'roster'] as const) {
      const schema = examQuerySchema(kind),
        method = kind === 'management' ? 'GET' : 'POST';
      expect(spec.paths[`/api/v1/entrance-exams/${kind}`][method.toLowerCase()].operationId).toBe(
        schema.operationId,
      );
      for (const value of [
        schema.body,
        schema.querystring,
        ...Object.values(schema.response!),
      ].filter(Boolean) as { examples?: unknown[] }[]) {
        walk(value as Record<string, unknown>);
        const validate = app.validatorCompiler!({
          schema: value,
          method,
          url: '/example',
          httpPart: 'body',
        });
        for (const example of value.examples ?? [])
          expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      }
      const request =
        kind === 'management'
          ? {
              method: 'GET' as const,
              url: '/api/v1/entrance-exams/management?projectId=3001',
              headers,
            }
          : {
              method: 'POST' as const,
              url: `/api/v1/entrance-exams/${kind}`,
              headers,
              payload: locator,
            };
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        code: 200,
        message: '操作成功',
        data: {
          detail: examDetailExample,
          management: examManagementExample,
          close: examCloseExample,
          roster: examRosterExample,
        }[kind],
      });
      expect(
        (
          await app.inject({
            ...request,
            headers: { origin: 'https://evil.test', cookie: 'tyde_session=token' },
          })
        ).statusCode,
      ).toBe(403);
    }
    const legacy = structuredClone(examDetailExample);
    legacy.papers[0]!.questions[0]!.questionFiles = [
      { objectKey: 'legacy-key', fileSize: 5, extra: { preserved: true } },
    ] as never;
    legacy.gradingRounds[0]!.reviewers = [
      { userId: 'invalid-historical-id', name: '原始快照', extra: '保留' },
      'legacy-marker',
    ] as never;
    vi.mocked(ExamQueryService.prototype.detail).mockResolvedValueOnce(legacy as never);
    const legacyResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/detail',
      headers,
      payload: locator,
    });
    expect(legacyResponse.statusCode, legacyResponse.body).toBe(200);
    expect(legacyResponse.json().data).toEqual(legacy);
    for (const value of ['0', '-1', '2147483648', 'x', '1.5'])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/entrance-exams/management?projectId=${value}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/entrance-exams/close',
          headers,
          payload: { ...locator, closeReason: 'x'.repeat(501) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/entrance-exams/roster',
          headers,
          payload: { ...locator, finalResult: 'UNKNOWN' },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
