import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  gradePaper,
  normalizeGradingItems,
  decideGradingResult,
} from '../src/modules/entrance-exams/exam-grading-rules.js';
import { ExamGradingCommandService } from '../src/modules/entrance-exams/exam-grading-command.service.js';
import {
  manualGradingSchema,
  manualGradingExample,
  gradingSubmitExample,
} from '../src/modules/entrance-exams/exam-grading-command.schema.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'reviewer',
  role: 'EXPERT',
  sessionId: 'test-session',
  clientType: 'desktop',
};
const rounds = [
  { id: 1, gradingMode: 'AUTO' },
  { id: 2, gradingMode: 'MANUAL' },
];
const records = [
  { gradingRoundId: 1, status: 'COMPLETED', roundResult: 'ADMITTED' },
  { gradingRoundId: 2, status: 'COMPLETED', roundResult: 'ELIMINATED' },
];
afterEach(() => vi.restoreAllMocks());
test('manual score uses exact decimal question weights and bound pass score, preserving zero and rejecting missing/foreign items', () => {
  const questions = [
    { id: 1, score: new Prisma.Decimal('0.1') },
    { id: 2, score: new Prisma.Decimal('0.2') },
  ];
  const items = normalizeGradingItems([
    { questionId: 1, correctness: 'CORRECT' },
    { questionId: 2, correctness: 'CORRECT', gradingOpinion: '  合格  ' },
  ]);
  expect(items.get(2)?.gradingOpinion).toBe('合格');
  expect(gradePaper(questions, items, new Prisma.Decimal('0.3'))).toMatchObject({
    roundResult: 'ADMITTED',
  });
  expect(gradePaper(questions, items, new Prisma.Decimal('0.3')).score.toString()).toBe('0.3');
  const wrong = normalizeGradingItems([
    { questionId: 1, correctness: 'INCORRECT' },
    { questionId: 2, correctness: 'INCORRECT' },
  ]);
  expect(gradePaper(questions, wrong, new Prisma.Decimal('0.3')).score.toNumber()).toBe(0);
  expect(() =>
    gradePaper(
      questions,
      new Map([
        [3, items.get(1)!],
        [2, items.get(2)!],
      ]),
      new Prisma.Decimal(0),
    ),
  ).toThrow();
  expect(() =>
    gradePaper(questions, new Map([[1, items.get(1)!]]), new Prisma.Decimal(0)),
  ).toThrow();
});
test.each([
  [],
  [{ questionId: 1, correctness: 'PENDING' }],
  [
    { questionId: 1, correctness: 'CORRECT' },
    { questionId: 1, correctness: 'INCORRECT' },
  ],
  [{ questionId: 1, correctness: 'CORRECT', gradingOpinion: 'x'.repeat(5001) }],
])('manual input rejects incomplete, duplicate or invalid judgments %#', (items) => {
  expect(() => normalizeGradingItems(items as never)).toThrow();
});
test.each([
  ['MAJORITY', 'LENIENT', 'ADMITTED'],
  ['MAJORITY', 'STRICT', 'ELIMINATED'],
  ['MANUAL_PRIORITY', 'LENIENT', 'ELIMINATED'],
  ['MANUAL_PRIORITY', null, 'ELIMINATED'],
])(
  'final decision follows %s/%s and counts votes rather than adding scores',
  (decisionRule, tieBreakRule, expected) => {
    expect(
      decideGradingResult({ decisionRule: decisionRule!, tieBreakRule }, rounds, records)
        ?.finalResult,
    ).toBe(expected);
  },
);
test('manual priority still waits for every automatic round; absent and failed records never finalize', () => {
  for (const status of ['WAITING', 'PENDING', 'PROCESSING', 'FAILED'])
    expect(
      decideGradingResult({ decisionRule: 'MANUAL_PRIORITY', tieBreakRule: null }, rounds, [
        { ...records[0]!, status },
        records[1]!,
      ]),
    ).toBeNull();
  expect(
    decideGradingResult({ decisionRule: 'MAJORITY', tieBreakRule: null }, rounds, records.slice(1)),
  ).toBeNull();
  expect(() =>
    decideGradingResult(
      { decisionRule: 'MANUAL_PRIORITY', tieBreakRule: null },
      [rounds[0]!],
      [records[0]!],
    ),
  ).toThrow();
});
function setup() {
  const round = {
    id: 9001,
    examVersionId: 6001,
    roundNo: 1,
    gradingMode: 'MANUAL',
    reviewersJson: [{ userId: principal.userId }],
  };
  const record = {
    id: 10001,
    attemptId: 11001,
    gradingRoundId: round.id,
    status: 'PENDING',
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
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    projectEntranceExam: { findFirst: vi.fn().mockResolvedValue({ id: 5001, status: 'CLOSED' }) },
    entranceExamAttempt: {
      findUnique: vi.fn(async () => attempt),
      findFirst: vi.fn().mockResolvedValue(attempt),
      update: vi.fn(async ({ data }) => ({ ...attempt, ...data })),
    },
    entranceExamGradingRecord: {
      findFirst: vi.fn().mockResolvedValue(record),
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
    },
    entranceExamGradingRound: { findMany: vi.fn().mockResolvedValue([round]) },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue(null) },
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
    projectMember: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
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
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { tx, db, record, round, attempt, service: new ExamGradingCommandService(db) };
}
test('actual round membership permits an authenticated EXPERT, saves exact historical score and pending member on a closed exam', async () => {
  const { tx, service } = setup();
  expect(await service.manual(manualGradingExample as never, principal)).toEqual(
    gradingSubmitExample,
  );
  expect(tx.projectMember.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      admissionAttemptId: 11001,
      status: 'PENDING_CONFIRM',
      expertAssignmentId: 1,
      userId: principal.userId,
    }),
  });
  expect(tx.entranceExamGradingRecord.update).toHaveBeenCalledWith({
    where: { id: 10001 },
    data: expect.objectContaining({
      reviewerUserId: principal.userId,
      conclusionSummary: manualGradingExample.conclusionSummary,
      status: 'COMPLETED',
    }),
  });
  expect(tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ eventType: 'EXAM_RESULT_DECIDED' }),
  });
});
test('project management access never substitutes for selected-round membership, and completed/waiting/unsubmitted records cannot mutate items', async () => {
  for (const scenario of [
    'foreign-reviewer',
    'COMPLETED',
    'WAITING',
    'unsubmitted',
    'bad-answer',
  ]) {
    const { tx, service, round, record, attempt } = setup();
    if (scenario === 'foreign-reviewer') round.reviewersJson = [];
    else if (scenario === 'unsubmitted') attempt.submittedAt = null as never;
    else if (scenario === 'bad-answer')
      tx.entranceExamGradingItem.findMany.mockResolvedValueOnce([]);
    else record.status = scenario;
    await expect(
      service.manual(manualGradingExample as never, { ...principal, role: 'PM' }),
    ).rejects.toMatchObject({
      status: scenario === 'foreign-reviewer' ? 403 : scenario === 'COMPLETED' ? 409 : 400,
    });
    expect(tx.entranceExamGradingItem.update).not.toHaveBeenCalled();
  }
});
test('invalid admission source fails inside the transaction, while replaced assignments preserve the verdict without granting a seat', async () => {
  const { tx, service } = setup();
  tx.projectExpertAssignment.findFirst.mockResolvedValueOnce(null);
  await expect(service.manual(manualGradingExample as never, principal)).rejects.toMatchObject({
    status: 500,
  });
  expect(tx.projectMember.create).not.toHaveBeenCalled();
  tx.projectExpertAssignment.findFirst.mockResolvedValueOnce({
    id: 1,
    status: 'REPLACED',
  } as never);
  expect((await service.manual(manualGradingExample as never, principal)).finalResult).toBe(
    'ADMITTED',
  );
  expect(tx.projectMember.create).not.toHaveBeenCalled();
});
test('manual HTTP contract validates nested examples, exposes Chinese field descriptions, and preserves all result fields', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const manual = vi
    .spyOn(ExamGradingCommandService.prototype, 'manual')
    .mockResolvedValue(gradingSubmitExample);
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
  const url = '/api/v1/entrance-exams/grading/manual',
    headers = { authorization: 'Bearer token' };
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[url].post.operationId).toBe('submitEntranceExamManualGrading');
    const walk = (schema: Record<string, unknown>) => {
      expect(schema.description).toMatch(/[\u3400-\u9fff]/u);
      for (const value of Object.values(schema.properties ?? {}))
        walk(value as Record<string, unknown>);
      if (schema.items) walk(schema.items as Record<string, unknown>);
    };
    for (const schema of [
      manualGradingSchema.body,
      ...Object.values(manualGradingSchema.response!),
    ] as (Record<string, unknown> & { examples: unknown[] })[]) {
      walk(schema);
      const validate = app.validatorCompiler!({ schema, method: 'POST', url, httpPart: 'body' });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: manualGradingExample })).json()
        .data,
    ).toEqual(gradingSubmitExample);
    for (const payload of [
      { ...manualGradingExample, items: [] },
      { ...manualGradingExample, items: [{ questionId: 1, correctness: 'PENDING' }] },
      { ...manualGradingExample, gradingRecordId: '10001' },
    ])
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    expect(manual).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
