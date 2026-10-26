import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ExamCandidateCommandService } from '../src/modules/entrance-exams/exam-candidate-command.service.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
vi.mock('../src/modules/entrance-exams/exam-grading-tasks.js', () => ({
  collectGradingTasks: vi.fn(async () => ({ sources: [], scopes: [] })),
  reviewerIds: (value: { userId: string }[]) => value.map((v) => v.userId),
}));
vi.mock('../src/modules/entrance-exams/exam-grading-command.service.js', () => ({
  syncGradingTasks: vi.fn(async () => {}),
}));
const p = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'candidate',
  role: 'EXPERT',
} as AuthPrincipal;
function fixture() {
  const attempt = {
    id: 1,
    examId: 2,
    examVersionId: 3,
    paperId: 4,
    candidateUserId: p.userId,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: 5,
    organizationId: null,
    userOrgRelId: null,
    enteredAt: new Date(),
    cancelledAt: null,
    submittedAt: null,
    answerDeadlineAt: null,
    finalResult: 'PENDING',
  };
  const questions = [
    { id: 6, sequenceNo: 1, requiredFlag: true },
    { id: 7, sequenceNo: 2, requiredFlag: false },
  ];
  const rounds = [
    { id: 8, gradingMode: 'MANUAL', reviewersJson: [{ userId: 'reviewer' }] },
    { id: 9, gradingMode: 'AUTO', reviewersJson: [] },
  ];
  const tx = {
    projectMemberMovement: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
    project: { findFirst: vi.fn(async () => ({ id: 1, currentNodeCode: 'PERSONNEL_MANAGEMENT' })) },
    userOrgRel: { findMany: vi.fn(async () => []) },
    projectExpertAssignment: {
      findMany: vi.fn(async () => [
        { id: 5, subjectType: 'INDIVIDUAL', organizationId: null, owners: [], memberResponses: [] },
      ]),
    },
    entranceExamAttempt: {
      findUnique: vi.fn(async () => attempt),
      findFirst: vi.fn(async () => attempt),
      update: vi.fn(async ({ data }) => ({ ...attempt, ...data })),
    },
    entranceExamPaper: { findFirst: vi.fn(async () => ({ questions })) },
    entranceExamGradingRound: { findMany: vi.fn(async () => rounds) },
    entranceExamAnswer: {
      create: vi.fn(async ({ data }) => ({ id: data.questionId + 10, ...data })),
    },
    entranceExamGradingRecord: {
      create: vi.fn(async ({ data }) => ({ id: data.gradingRoundId + 10, ...data })),
    },
    entranceExamGradingItem: { createMany: vi.fn(async ({ data }) => ({ count: data.length })) },
    projectTaskRound: { updateMany: vi.fn(async () => ({ count: 1 })) },
    projectRoleNodeSnapshot: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    projectEventOutbox: { create: vi.fn(async ({ data }) => data) },
  };
  const files = {
    claimForEntranceExam: vi.fn(async () => ({
      id: 'file',
      objectKey: 'answer',
      fileName: '可信文件',
      extension: 'txt',
      contentType: 'text/plain',
      fileSize: 3,
      fileHash: null,
    })),
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return {
    service: new ExamCandidateCommandService(db, files as unknown as FileRegistryService),
    tx,
    files,
    attempt,
    rounds,
    questions,
    input: {
      projectId: 1,
      attemptId: 1,
      integritySigned: true,
      answers: [{ questionId: 6, answerContent: '  答案  ' }],
    },
  };
}
afterEach(() => vi.clearAllMocks());
test('candidate submission persists full paper including omitted optional answer and original version independent round items', async () => {
  const f = fixture();
  const result = await f.service.submit(f.input, p);
  expect(result).toMatchObject({
    attemptId: 1,
    answerCount: 2,
    gradingRoundCount: 2,
    gradingStatus: 'PENDING',
  });
  expect(f.tx.entranceExamAnswer.create.mock.calls.map(([v]) => v.data)).toEqual([
    {
      attemptId: 1,
      paperId: 4,
      questionId: 6,
      answerContent: '答案',
      answerFilesJson: Prisma.DbNull,
      answeredFlag: true,
      createdBy: p.uid,
    },
    {
      attemptId: 1,
      paperId: 4,
      questionId: 7,
      answerContent: null,
      answerFilesJson: Prisma.DbNull,
      answeredFlag: false,
      createdBy: p.uid,
    },
  ]);
  expect(f.tx.entranceExamGradingRecord.create.mock.calls.map(([v]) => v.data)).toEqual(
    f.rounds.map((r, i) => ({
      attemptId: 1,
      examVersionId: 3,
      gradingRoundId: r.id,
      status: i === 0 ? 'PENDING' : 'WAITING',
      createdBy: 'SYSTEM',
    })),
  );
  expect(f.tx.entranceExamGradingItem.createMany.mock.calls.map(([v]) => v.data)).toEqual(
    f.rounds.map((r) =>
      [6, 7].map((q) => ({
        gradingRecordId: r.id + 10,
        attemptId: 1,
        questionId: q,
        answerId: q + 10,
        correctness: 'PENDING',
        createdBy: 'SYSTEM',
      })),
    ),
  );
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventType: 'EXAM_REVIEW_QUEUE_CHANGED',
      payload: expect.objectContaining({ reviewerUserIds: ['reviewer'] }),
    }),
  });
  expect(f.tx.projectTaskRound.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED', participated: true }),
    }),
  );
});
test('candidate AUTO first round persists mock dispatch without executing any service', async () => {
  const f = fixture();
  f.rounds[0]!.gradingMode = 'AUTO';
  await f.service.submit(f.input, p);
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventType: 'EXAM_AUTO_DISPATCH_REQUESTED',
      payload: { gradingRecordId: 18, provider: 'mock', executionStatus: 'NOT_EXECUTED' },
    }),
  });
});
test('candidate attachment-only answer claims own fresh file using trusted metadata', async () => {
  const f = fixture();
  await f.service.submit(
    {
      ...f.input,
      answers: [
        {
          questionId: 6,
          answerFiles: [{ objectKey: 'answer', uploadToken: 'token', fileName: '伪造文件' }],
        },
      ],
    },
    p,
  );
  expect(f.files.claimForEntranceExam).toHaveBeenCalledWith(f.tx, 'answer', 'token', p.uid, '2');
  expect(f.tx.entranceExamAnswer.create.mock.calls[0]![0].data).toMatchObject({
    answerContent: null,
    answeredFlag: true,
    answerFilesJson: [{ fileName: '可信文件' }],
  });
});
test.each([
  ['missing required', []],
  ['blank required', [{ questionId: 6, answerContent: '   ' }]],
  ['foreign question', [{ questionId: 999 }]],
  ['duplicate question', [{ questionId: 6 }, { questionId: 6 }]],
  ['too long', [{ questionId: 6, answerContent: 'x'.repeat(100001) }]],
  [
    'reused attachment',
    [
      {
        questionId: 6,
        answerFiles: [{ objectKey: 'key', uploadedFileId: 'file', uploadToken: 'token' }],
      },
    ],
  ],
  ['missing token', [{ questionId: 6, answerFiles: [{ objectKey: 'key' }] }]],
  [
    'duplicate attachment',
    [
      {
        questionId: 6,
        answerFiles: [
          { objectKey: 'key', uploadToken: 'token' },
          { objectKey: 'key', uploadToken: 'token' },
        ],
      },
    ],
  ],
])('candidate submission rejects %s', async (_, answers) => {
  const f = fixture();
  await expect(
    f.service.submit({ ...f.input, answers: answers as never }, p),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.tx.entranceExamGradingRecord.create).not.toHaveBeenCalled();
  expect(f.tx.entranceExamAttempt.update).not.toHaveBeenCalled();
});
test.each([
  ['cancelledAt', new Date(), 400],
  ['submittedAt', new Date(), 409],
  ['answerDeadlineAt', new Date(0), 400],
  ['finalResult', 'ADMITTED', 400],
  ['enteredAt', null, 400],
  ['paperId', null, 400],
  ['sourceBizId', 99, 403],
  ['organizationId', 'other', 403],
  ['sourceBizType', 'PROJECT_MEMBER_TRANSFER', 403],
])('candidate submission rejects terminal or invalid source %s', async (field, value, status) => {
  const f = fixture();
  Object.assign(f.attempt, { [field]: value });
  await expect(f.service.submit(f.input, p)).rejects.toMatchObject({ status });
  expect(f.tx.entranceExamAnswer.create).not.toHaveBeenCalled();
});
test('candidate command requires current EXPERT, promise, owned attempt and complete round source', async () => {
  const f = fixture();
  await expect(f.service.submit(f.input, { ...p, role: 'PM' })).rejects.toMatchObject({
    status: 403,
  });
  await expect(f.service.submit({ ...f.input, integritySigned: false }, p)).rejects.toMatchObject({
    status: 400,
  });
  f.tx.entranceExamAttempt.findFirst.mockResolvedValueOnce(null as never);
  await expect(f.service.submit(f.input, p)).rejects.toMatchObject({ status: 404 });
  f.rounds.length = 0;
  await expect(f.service.submit(f.input, p)).rejects.toMatchObject({ status: 500 });
  expect(f.tx.entranceExamAnswer.create).not.toHaveBeenCalled();
});
test('candidate cancellation after timeout writes only cancellation fact, event and revoked exam task', async () => {
  const f = fixture();
  f.attempt.answerDeadlineAt = new Date(0) as never;
  const result = await f.service.cancel({ projectId: 1, attemptId: 1 }, p);
  expect(result).toMatchObject({ attemptId: 1, cancelledAt: expect.any(String) });
  expect(f.tx.entranceExamAnswer.create).not.toHaveBeenCalled();
  expect(f.tx.entranceExamGradingRecord.create).not.toHaveBeenCalled();
  expect(f.tx.entranceExamAttempt.update).toHaveBeenCalledWith({
    where: { id: 1 },
    data: { cancelledAt: expect.any(Date), updatedBy: p.uid },
  });
  expect(f.tx.projectTaskRound.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED', participated: false }),
    }),
  );
});
