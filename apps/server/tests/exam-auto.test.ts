import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ExamGradingCommandService } from '../src/modules/entrance-exams/exam-grading-command.service.js';
import { ExamAutoService } from '../src/modules/entrance-exams/exam-auto.service.js';
import {
  autoCallbackPath,
  signAutoCallback,
  verifyAutoCallback,
} from '../src/modules/entrance-exams/exam-auto-signature.js';
import {
  autoCallbackSchema,
  autoCompensateSchema,
  autoRetrySchema,
  callbackExample,
  compensateExample,
} from '../src/modules/entrance-exams/exam-auto.schema.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'reviewer',
  role: 'PM',
  sessionId: 'test-session',
  clientType: 'desktop',
};
const secret = 's'.repeat(32);
afterEach(() => vi.restoreAllMocks());
function setup() {
  const round = {
    id: 9001,
    examVersionId: 6001,
    roundNo: 1,
    gradingMode: 'AUTO',
    reviewersJson: [{ userId: principal.userId }],
  };
  const record = {
    id: 10001,
    attemptId: 11001,
    gradingRoundId: round.id,
    status: 'PROCESSING',
    toolTraceId: 'mock-execution-trace',
    callbackDigest: null as string | null,
    score: null as Prisma.Decimal | null,
    roundResult: null as string | null,
    gradingRound: round,
    startedAt: null,
  };
  const attempt = {
    id: 11001,
    examId: 5001,
    examVersionId: 6001,
    paperId: 7001,
    submittedAt: new Date(),
    candidateUserId: principal.userId,
    userOrgRelId: null,
    organizationId: null,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: 1,
    gradingStatus: 'IN_PROGRESS',
    finalResult: 'PENDING',
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    project: { findFirst: vi.fn().mockResolvedValue({ id: 3001, status: 'PUBLISHED' }) },
    projectEntranceExam: { findFirst: vi.fn().mockResolvedValue({ id: 5001, status: 'CLOSED' }) },
    entranceExamAttempt: {
      findUnique: vi.fn(async () => attempt),
      findFirst: vi.fn().mockResolvedValue(attempt),
      update: vi.fn(async ({ data }) => ({ ...attempt, ...data })),
    },
    entranceExamGradingRecord: {
      findFirst: vi.fn().mockResolvedValue(record),
      findUnique: vi.fn(async () => ({ ...record, attempt })),
      findUniqueOrThrow: vi.fn(async () => ({ ...record, attempt })),
      findMany: vi.fn(async (args) => (args.include ? [] : [record])),
      update: vi.fn(async ({ data }) => ({ ...record, ...data })),
    },
    entranceExamVersion: {
      findFirst: vi.fn().mockResolvedValue({
        id: 6001,
        examId: 5001,
        gradingRounds: [round],
        passScore: new Prisma.Decimal(12),
        decisionRule: 'MAJORITY',
        tieBreakRule: null,
      }),
    },
    entranceExamPaper: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 7001, questions: [{ id: 8001, score: new Prisma.Decimal(20) }] }),
    },
    entranceExamGradingItem: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 1,
          attemptId: 11001,
          questionId: 8001,
          answer: { attemptId: 11001, paperId: 7001, questionId: 8001 },
        },
      ]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    entranceExamGradingRound: { findMany: vi.fn().mockResolvedValue([round]) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: principal.userId }),
    },
    user: { findMany: vi.fn().mockResolvedValue([{ id: principal.userId }]) },
    projectExpertAssignment: {
      findFirst: vi.fn().mockResolvedValue({
        id: 1,
        projectId: 3001,
        subjectType: 'INDIVIDUAL',
        expertUserId: principal.userId,
        status: 'ACCEPTED',
      }),
    },
    projectMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      delete: vi.fn(),
    },
    projectTaskRound: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() },
    projectEventOutbox: { create: vi.fn() },
    projectRoleNodeSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const db = {
    ...tx,
    entranceExamGradingRecord: tx.entranceExamGradingRecord,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { tx, db, record, round, attempt, service: new ExamGradingCommandService(db) };
}
test('dedicated raw HMAC rejects body changes, expired/future time, wrong key and malformed signature', () => {
  const body = Buffer.from(JSON.stringify(callbackExample)),
    timestamp = '1792656000',
    now = Number(timestamp) * 1000;
  const signed = signAutoCallback(secret, timestamp, body);
  expect(() => verifyAutoCallback(secret, timestamp, signed, body, now)).not.toThrow();
  for (const [key, time, signature, raw] of [
    [secret, timestamp, signed, Buffer.from('{}')],
    ['z'.repeat(32), timestamp, signed, body],
    [secret, String(Number(timestamp) - 301), signed, body],
    [secret, String(Number(timestamp) + 301), signed, body],
    [secret, timestamp, 'bad', body],
    [secret, undefined, signed, body],
  ])
    expect(() => verifyAutoCallback(key as string, time, signature, raw as Buffer, now)).toThrow();
  expect(() =>
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://localhost:3000',
      CODE_HMAC_SECRET: secret,
      AUTO_GRADING_HMAC_SECRET: secret,
    }),
  ).toThrow();
});
test('successful callback computes bound-paper score, persists digest, rejects changed content and accepts canonical replay without side effects', async () => {
  const { service, tx, record, attempt } = setup();
  expect(await service.callback(callbackExample as never)).toMatchObject({
    recordStatus: 'COMPLETED',
    score: 20,
    finalResult: 'ADMITTED',
  });
  const saved = tx.entranceExamGradingRecord.update.mock.calls[0]![0].data;
  Object.assign(record, saved);
  Object.assign(attempt, { gradingStatus: 'COMPLETED', finalResult: 'ADMITTED' });
  const calls = tx.projectEventOutbox.create.mock.calls.length;
  expect(
    (
      await service.callback({
        ...callbackExample,
        items: [{ correctness: 'CORRECT', questionId: 8001, gradingOpinion: '  步骤正确  ' }],
      } as never)
    ).score,
  ).toBe(20);
  expect(tx.projectEventOutbox.create).toHaveBeenCalledTimes(calls);
  await expect(
    service.callback({ ...callbackExample, summary: 'changed' } as never),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    service.callback({ ...callbackExample, toolTraceId: 'old' } as never),
  ).rejects.toMatchObject({ status: 409 });
});
test('failure remains failed without next-round activation and identical failure is idempotent while changed error is rejected', async () => {
  const { service, tx, record, attempt } = setup();
  const failed = {
    ...callbackExample,
    status: 'FAILED',
    items: null,
    errorCode: 'MOCK_FAILURE',
    errorMessage: '失败',
  };
  expect(await service.callback(failed as never)).toMatchObject({
    recordStatus: 'FAILED',
    score: null,
    gradingStatus: 'IN_PROGRESS',
  });
  expect(tx.entranceExamGradingItem.update).not.toHaveBeenCalled();
  Object.assign(record, tx.entranceExamGradingRecord.update.mock.calls[0]![0].data);
  expect((await service.callback(failed as never)).recordStatus).toBe('FAILED');
  await expect(
    service.callback({ ...failed, errorMessage: '另一次失败' } as never),
  ).rejects.toMatchObject({ status: 409 });
  expect(attempt.finalResult).toBe('PENDING');
});
test.each(['paper', 'version', 'round', 'waiting', 'unsubmitted', 'foreign-item'])(
  'callback rejects %s before item mutation',
  async (scenario) => {
    const { service, record, attempt, tx } = setup();
    const input = { ...callbackExample };
    if (scenario === 'paper') input.paperId++;
    if (scenario === 'version') input.examVersionId++;
    if (scenario === 'round') input.roundNo++;
    if (scenario === 'waiting') record.status = 'WAITING';
    if (scenario === 'unsubmitted') attempt.submittedAt = null as never;
    if (scenario === 'foreign-item') tx.entranceExamGradingItem.findMany.mockResolvedValueOnce([]);
    await expect(service.callback(input as never)).rejects.toMatchObject({
      status: scenario === 'waiting' ? 409 : 400,
    });
    expect(tx.entranceExamGradingItem.update).not.toHaveBeenCalled();
  },
);
test('compensation only allows current PM, clears trace and refuses irreversible admission or transfer reversal', async () => {
  for (const scenario of ['NAVIGATOR', 'handler', 'active-member', 'transfer', 'pending-member']) {
    const { service, tx, record, attempt } = setup();
    record.status = 'COMPLETED';
    attempt.finalResult = 'ADMITTED';
    if (scenario === 'handler')
      tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce({ candidateUserId: 'other' });
    if (scenario === 'transfer') attempt.sourceBizType = 'PROJECT_MEMBER_TRANSFER';
    if (scenario.endsWith('member'))
      tx.projectMember.findUnique.mockResolvedValueOnce({
        id: 77,
        projectId: 3001,
        status: scenario === 'pending-member' ? 'PENDING_CONFIRM' : 'ACTIVE',
        joinedAt: null,
      } as never);
    const input = { ...compensateExample, items: [{ questionId: 8001, correctness: 'INCORRECT' }] };
    const result = service.compensate(input as never, {
      ...principal,
      role: scenario === 'NAVIGATOR' ? 'NAVIGATOR' : 'PM',
    });
    if (scenario === 'pending-member') {
      expect(await result).toMatchObject({ finalResult: 'ELIMINATED' });
      expect(tx.projectMember.delete).toHaveBeenCalledWith({ where: { id: 77 } });
      expect(tx.entranceExamGradingRecord.update).toHaveBeenCalledWith({
        where: { id: 10001 },
        data: expect.objectContaining({
          toolTraceId: null,
          callbackDigest: null,
          reviewerUserId: principal.userId,
        }),
      });
    } else
      await expect(result).rejects.toMatchObject({
        status: ['NAVIGATOR', 'handler'].includes(scenario) ? 403 : 400,
      });
  }
});
test('mock executor claims once and can deliver success/failure or deliberately withhold callback', async () => {
  const service = new ExamAutoService({} as PrismaClient);
  const claimed = vi
    .spyOn(service, 'claim')
    .mockResolvedValue({ ...callbackExample, items: undefined } as never);
  const deliver = vi.fn();
  expect(await service.executeMock(1, 'failed', deliver)).toMatchObject({
    provider: 'mock',
    delivered: true,
  });
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'FAILED', errorCode: 'MOCK_FAILURE' }),
  );
  deliver.mockClear();
  expect(await service.executeMock(1, 'timeout', deliver)).toMatchObject({ callback: null });
  expect(deliver).not.toHaveBeenCalled();
  claimed.mockResolvedValueOnce(null);
  expect(await service.executeMock(1, 'failed', deliver)).toMatchObject({ claimed: false });
});
test('HTTP callback authenticates raw bytes before parsing without user login; Swagger examples serialize and management routes require login', async () => {
  const { db } = setup();
  const callback = vi.spyOn(ExamGradingCommandService.prototype, 'callback').mockResolvedValue({
    attemptId: 11001,
    gradingRecordId: 10001,
    recordStatus: 'COMPLETED',
    score: 20,
    roundResult: 'ADMITTED',
    gradingStatus: 'COMPLETED',
    finalResult: 'ADMITTED',
  });
  const auth = vi
    .spyOn(AuthService.prototype, 'authenticate')
    .mockRejectedValue(new Error('must not authenticate callback'));
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      AUTO_GRADING_HMAC_SECRET: secret,
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    }),
    db,
  );
  const raw = JSON.stringify(callbackExample, null, 2),
    timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'content-type': 'application/json',
    'x-agent-timestamp': timestamp,
    'x-agent-signature': signAutoCallback(secret, timestamp, raw),
  };
  try {
    expect(
      (await app.inject({ method: 'POST', url: autoCallbackPath, headers, payload: raw }))
        .statusCode,
    ).toBe(200);
    expect(auth).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: 'POST', url: autoCallbackPath, headers, payload: raw + ' ' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: autoCallbackPath,
          headers: { authorization: 'Bearer token' },
          payload: callbackExample,
        })
      ).statusCode,
    ).toBe(401);
    const invalid = '{';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: autoCallbackPath,
          headers: {
            ...headers,
            'x-agent-signature': signAutoCallback(secret, timestamp, invalid),
          },
          payload: invalid,
        })
      ).statusCode,
    ).toBe(400);
    expect(callback).toHaveBeenCalledTimes(1);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[autoCallbackPath].post.security).toEqual([]);
    const walk = (
      s: Record<string, unknown> & {
        description: string;
        properties?: Record<string, unknown>;
        items?: object;
        examples?: unknown[];
      },
    ) => {
      expect(s.description).toMatch(/[\u3400-\u9fff]/u);
      for (const child of Object.values(s.properties ?? {})) walk(child as never);
      if (s.items) walk(s.items);
    };
    for (const schema of [autoRetrySchema, autoCompensateSchema, autoCallbackSchema]) {
      for (const value of [schema.body, ...Object.values(schema.response!)]) {
        const s = value as Record<string, unknown> & {
          description: string;
          properties?: Record<string, unknown>;
          items?: object;
          examples?: unknown[];
        };
        walk(s);
        const validate = app.validatorCompiler!({
          schema: s,
          method: 'POST',
          url: autoCallbackPath,
          httpPart: 'body',
        });
        for (const example of s.examples ?? [])
          expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      }
    }
  } finally {
    await app.close();
  }
});
test('retry clears failure execution and question results in one transaction; NAVIGATOR scope is insufficient', async () => {
  const { tx, db, record } = setup();
  record.status = 'FAILED';
  tx.entranceExamGradingRound.findMany.mockResolvedValueOnce([]);
  const service = new ExamAutoService(db);
  expect(
    await service.retry({ projectId: 3001, examId: 5001, gradingRecordId: 10001 }, principal),
  ).toMatchObject({
    recordStatus: 'PENDING',
    score: null,
    roundResult: null,
    gradingStatus: 'PENDING',
  });
  expect(tx.entranceExamGradingRecord.update).toHaveBeenCalledWith({
    where: { id: 10001 },
    data: expect.objectContaining({
      status: 'PENDING',
      toolTraceId: null,
      callbackDigest: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    }),
  });
  expect(tx.entranceExamGradingItem.updateMany).toHaveBeenCalledWith({
    where: { gradingRecordId: 10001 },
    data: expect.objectContaining({ correctness: 'PENDING', gradingOpinion: null }),
  });
  await expect(
    service.retry(
      { projectId: 3001, examId: 5001, gradingRecordId: 10001 },
      { ...principal, role: 'NAVIGATOR' },
    ),
  ).rejects.toMatchObject({ status: 403 });
});
test('retry refuses incomplete earlier rounds before execution mutation', async () => {
  const { tx, db, round, record } = setup();
  record.status = 'FAILED';
  tx.entranceExamGradingRound.findMany.mockResolvedValueOnce([{ ...round, records: [] }] as never);
  await expect(
    new ExamAutoService(db).retry(
      { projectId: 3001, examId: 5001, gradingRecordId: 10001 },
      principal,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.entranceExamGradingRecord.update).not.toHaveBeenCalled();
});
test('mock callback transport failure attempts guarded failure persistence without overwriting an already committed result', async () => {
  const service = new ExamAutoService({} as PrismaClient);
  vi.spyOn(service, 'claim').mockResolvedValue({ ...callbackExample, items: undefined } as never);
  const persist = vi
    .spyOn(ExamGradingCommandService.prototype, 'callback')
    .mockResolvedValue({} as never);
  await expect(
    service.executeMock(1, 'failed', async () => {
      throw new Error('delivery failed');
    }),
  ).rejects.toThrow('delivery failed');
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'FAILED', items: null, errorCode: 'MOCK_DELIVERY_FAILED' }),
  );
});
