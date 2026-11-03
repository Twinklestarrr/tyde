import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ExamQueryService } from '../src/modules/entrance-exams/exam-query.service.js';
import {
  examGradingDetailExample,
  examGradingDetailSchema,
} from '../src/modules/entrance-exams/exam-grading-query.schema.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'test-uid',
  role: 'PM',
  sessionId: 'test-session',
  clientType: 'desktop',
};
const locator = { projectId: 3001, examId: 5001, attemptId: 11001 };
function setup() {
  const question = {
    id: 8001,
    sequenceNo: 1,
    questionContent: null,
    questionFilesJson: [{ objectKey: 'old-key', fileSize: 10, custom: { retained: true } }],
    score: new Prisma.Decimal(20),
    referenceAnswer: '旧参考答案',
    referenceFilesJson: null,
  };
  const attempt = {
    id: 11001,
    examVersionId: 6001,
    paperId: 7001,
    candidateUid: 'old-uid',
    candidateName: '快照姓名',
    candidate: { displayName: '实时昵称', realName: '实时姓名' },
    gradingStatus: 'NOT_STARTED',
    finalResult: 'PENDING',
  };
  const rounds = [
    { id: 9001, roundNo: 1, gradingMode: 'MANUAL' },
    { id: 9002, roundNo: 2, gradingMode: 'AUTO' },
  ];
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 3001, status: 'PUBLISHED' }) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: principal.userId }),
    },
    entranceExamGradingRound: { findFirst: vi.fn().mockResolvedValue({ id: 9001 }) },
    projectEntranceExam: {
      findFirst: vi.fn().mockResolvedValue({ id: 5001, currentVersionId: 6002, status: 'CLOSED' }),
    },
    entranceExamAttempt: { findFirst: vi.fn().mockResolvedValue(attempt) },
    entranceExamVersion: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 6001, passScore: new Prisma.Decimal(12), gradingRounds: rounds }),
    },
    entranceExamPaper: {
      findFirst: vi.fn().mockResolvedValue({
        id: 7001,
        questions: [question, { ...question, id: 8002, sequenceNo: 2 }],
      }),
    },
    entranceExamGradingRecord: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 10001,
          gradingRoundId: 9001,
          status: 'COMPLETED',
          score: new Prisma.Decimal(0),
          roundResult: 'ELIMINATED',
          conclusionSummary: '第一轮',
          errorMessage: null,
        },
        {
          id: 10002,
          gradingRoundId: 9002,
          status: 'FAILED',
          score: null,
          roundResult: null,
          conclusionSummary: null,
          errorMessage: '工具失败',
        },
      ]),
    },
    entranceExamAnswer: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 12001,
          questionId: 8001,
          answerContent: '答案',
          answerFilesJson: [{ objectKey: 'answer-key', custom: '保留' }],
          answeredFlag: false,
        },
      ]),
    },
    entranceExamGradingItem: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { questionId: 8001, correctness: 'INCORRECT', gradingOpinion: '本轮意见' },
        ]),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { tx, db, attempt, question, service: new ExamQueryService(db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  principal.role = 'PM';
});
test('grading detail uses only the actual historical version/paper on a closed exam, with nullable missing answers, zero score and untouched file JSON', async () => {
  const { tx, service, db, question } = setup();
  const files = structuredClone(question.questionFilesJson);
  const result = await service.gradingDetail(locator, principal);
  expect(tx.entranceExamAttempt.findFirst.mock.calls[0]![0].where).toEqual({
    id: 11001,
    examId: 5001,
  });
  expect(tx.entranceExamVersion.findFirst.mock.calls[0]![0].where).toEqual({
    id: 6001,
    examId: 5001,
  });
  expect(tx.entranceExamPaper.findFirst.mock.calls[0]![0]).toEqual({
    where: { id: 7001, examVersionId: 6001 },
    include: { questions: { orderBy: { sequenceNo: 'asc' } } },
  });
  expect(result).toMatchObject({
    candidateUid: 'old-uid',
    candidateName: '实时昵称(实时姓名)',
    passScore: 12,
    gradingStatus: 'NOT_STARTED',
    finalResult: 'PENDING',
    rounds: [{ score: 0 }, { status: 'FAILED', errorMessage: '工具失败' }],
    selectedRound: { gradingRoundId: 9001, gradingRecordId: 10001, score: 0 },
    questions: [
      { answerId: 12001, answeredFlag: false, correctness: 'INCORRECT', questionFiles: files },
      {
        answerId: null,
        answerContent: null,
        answerFiles: null,
        answeredFlag: false,
        correctness: null,
        gradingOpinion: null,
      },
    ],
  });
  (result.questions[0]!.questionFiles as Prisma.JsonArray).push('response-only');
  expect(question.questionFilesJson).toEqual(files);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
test('round selection uses only the selected record items; absent records stay null and skip item reads without inventing pending tasks', async () => {
  const { tx, service } = setup();
  tx.entranceExamGradingItem.findMany.mockResolvedValueOnce([
    { questionId: 8001, correctness: 'CORRECT', gradingOpinion: '另一轮' },
  ]);
  expect(
    (await service.gradingDetail({ ...locator, roundNo: 2 }, principal)).questions[0],
  ).toMatchObject({ correctness: 'CORRECT', gradingOpinion: '另一轮' });
  expect(tx.entranceExamGradingItem.findMany).toHaveBeenCalledWith({
    where: { gradingRecordId: 10002 },
  });
  tx.entranceExamGradingRecord.findMany.mockResolvedValueOnce([]);
  const empty = await service.gradingDetail({ ...locator, roundNo: null }, principal);
  expect(empty.selectedRound).toEqual({
    gradingRoundId: 9001,
    gradingRecordId: null,
    roundNo: 1,
    gradingMode: 'MANUAL',
    status: null,
    score: null,
    roundResult: null,
    conclusionSummary: null,
    errorMessage: null,
  });
  expect(empty.questions[0]!.correctness).toBeNull();
  expect(tx.entranceExamGradingItem.findMany).toHaveBeenCalledTimes(1);
});
test('foreign/missing attempt and exam, unbound versions and invalid rounds are distinct errors; broken version or paper is never an empty successful result', async () => {
  const { tx, service, attempt } = setup();
  tx.projectEntranceExam.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 404 });
  tx.entranceExamAttempt.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 404 });
  tx.entranceExamAttempt.findFirst.mockResolvedValueOnce({
    ...attempt,
    examVersionId: null,
    paperId: null,
  });
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 400 });
  await expect(service.gradingDetail({ ...locator, roundNo: 3 }, principal)).rejects.toMatchObject({
    status: 400,
  });
  tx.entranceExamVersion.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 500 });
  tx.entranceExamPaper.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 500 });
  expect(tx.entranceExamAnswer.findMany).not.toHaveBeenCalled();
});
test('current-role project/reviewer qualifications guard answer access; neither expert ownership nor navigator/PM identity alone grants access', async () => {
  const { tx, service } = setup();
  principal.role = 'EXPERT';
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 403 });
  principal.role = 'PM';
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 403 });
  principal.role = 'NAVIGATOR';
  tx.entranceExamGradingRound.findFirst.mockResolvedValueOnce(null);
  await expect(service.gradingDetail(locator, principal)).rejects.toMatchObject({ status: 403 });
  expect(tx.entranceExamAttempt.findFirst).not.toHaveBeenCalled();
  await service.gradingDetail(locator, principal);
  expect(tx.entranceExamGradingRound.findFirst).toHaveBeenCalledWith({
    where: {
      gradingMode: 'MANUAL',
      version: { exam: { projectId: 3001, deleted: false } },
      reviewersJson: { array_contains: [{ userId: principal.userId }] },
    },
    select: { id: true },
  });
});
test('HTTP/OpenAPI documents the full nested grading contract and serializes nullable scores/results and legacy files without dropping fields', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const mock = vi
    .spyOn(ExamQueryService.prototype, 'gradingDetail')
    .mockResolvedValue(examGradingDetailExample as never);
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
  const url = '/api/v1/entrance-exams/grading/detail',
    headers = { authorization: 'Bearer token' };
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[url].post.operationId).toBe('getEntranceExamGradingDetail');
    const walk = (schema: Record<string, unknown>) => {
      for (const value of Object.values(schema.properties ?? {}) as Record<string, unknown>[]) {
        expect(value.description).toMatch(/[\u3400-\u9fff]/u);
        walk(value);
      }
      if (schema.items) {
        expect((schema.items as Record<string, unknown>).description).toMatch(/[\u3400-\u9fff]/u);
        walk(schema.items as Record<string, unknown>);
      }
      for (const choice of (schema.anyOf ?? []) as Record<string, unknown>[]) walk(choice);
    };
    for (const schema of [
      examGradingDetailSchema.body,
      ...Object.values(examGradingDetailSchema.response!),
    ] as (Record<string, unknown> & { examples?: unknown[] })[]) {
      walk(schema);
      const validate = app.validatorCompiler!({ schema, method: 'POST', url, httpPart: 'body' });
      for (const example of schema.examples ?? [])
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...locator, roundNo: null },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(examGradingDetailExample);
    expect(mock).toHaveBeenCalledWith({ ...locator, roundNo: null }, principal);
    const legacy = structuredClone(examGradingDetailExample);
    legacy.questions[0]!.questionFiles = { legacy: ['保留'] } as never;
    legacy.questions[0]!.answerFiles = [{ custom: { retained: true } }] as never;
    mock.mockResolvedValueOnce(legacy as never);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: locator })).json().data,
    ).toEqual(legacy);
    for (const payload of [
      { projectId: 3001, examId: 5001 },
      { ...locator, attemptId: '11001' },
      { ...locator, roundNo: 0 },
      { ...locator, roundNo: 1.5 },
      { ...locator, projectId: 2147483648 },
    ])
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=test' },
          payload: locator,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
