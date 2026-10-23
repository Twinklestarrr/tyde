import { ExamCandidateCommandService } from '../src/modules/entrance-exams/exam-candidate-command.service.js';
import {
  candidateSubmitExample,
  candidateCancelExample,
} from '../src/modules/entrance-exams/exam-candidate.schema.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ExamCandidateService,
  requireCandidate,
} from '../src/modules/entrance-exams/exam-candidate.service.js';
import { candidatePaperExample } from '../src/modules/entrance-exams/exam-candidate.schema.js';
import { canReadManagedExamFile } from '../src/modules/entrance-exams/exam-file-access.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
const p = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'candidate',
  role: 'EXPERT',
  sessionId: 's',
  clientType: 'desktop',
} as AuthPrincipal;
function fixture() {
  const user = { id: p.userId, uid: p.uid, status: 'ACTIVE', displayName: '考生', realName: null };
  const project = { id: 1, status: 'PUBLISHED', currentNodeCode: 'PERSONNEL_MANAGEMENT' };
  const personal = {
    id: 1,
    subjectType: 'INDIVIDUAL',
    organizationId: null,
    owners: [],
    memberResponses: [],
    projectOwnerUserId: null,
  };
  const org = {
    ...personal,
    id: 2,
    subjectType: 'ORGANIZATION',
    organizationId: 'org',
    memberResponses: [{ status: 'ACCEPTED' }],
  };
  const relation = { id: 'rel', orgId: 'org', position: 'MEMBER', organization: { name: '组织' } };
  const version = {
    id: 1,
    examId: 1,
    examNameSnapshot: '原考试',
    durationMinutes: 60,
    registrationDeadline: new Date('2099-01-01Z'),
    fullScore: new Prisma.Decimal(20),
  };
  const exam = { id: 1, status: 'ACTIVE', currentVersion: version };
  const question = {
    id: 1,
    sequenceNo: 1,
    questionContent: '题干',
    questionFilesJson: [{ objectKey: 'stem' }],
    requiredFlag: true,
    score: new Prisma.Decimal(20),
    referenceAnswer: '秘密答案',
    referenceFilesJson: [{ objectKey: 'secret' }],
  };
  const paper = { id: 1, paperName: '原试卷', questions: [question] };
  const attempt = {
    id: 1,
    examId: 1,
    examVersionId: 1,
    paperId: 1,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: 1,
    organizationId: null,
    userOrgRelId: null,
    enteredAt: new Date(),
    answerDeadlineAt: null,
    submittedAt: null,
    cancelledAt: null,
    finalResult: 'PENDING',
    gradingStatus: 'NOT_STARTED',
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    project: { findFirst: vi.fn().mockResolvedValue(project) },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([]) },
    projectExpertAssignment: { findMany: vi.fn().mockResolvedValue([personal]) },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue({ needWrittenExam: true }) },
    projectEntranceExam: {
      findMany: vi.fn().mockResolvedValue([exam]),
      findFirst: vi.fn().mockResolvedValue({ projectId: 1, project: {} }),
    },
    entranceExamVersion: { findFirst: vi.fn().mockResolvedValue(version) },
    entranceExamPaper: {
      findMany: vi.fn().mockResolvedValue([paper]),
      findFirst: vi.fn().mockResolvedValue(paper),
    },
    entranceExamQuestion: { findMany: vi.fn().mockResolvedValue([question]) },
    entranceExamAnswer: { findMany: vi.fn().mockResolvedValue([]) },
    entranceExamAttempt: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...attempt, ...data })),
      update: vi.fn().mockImplementation(async ({ data }) => ({ ...attempt, ...data })),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return {
    db,
    tx,
    service: new ExamCandidateService(db),
    personal,
    org,
    relation,
    attempt,
    exam,
    version,
    paper,
    project,
  };
}
afterEach(() => vi.restoreAllMocks());
test('candidate entry creates only one binding and explicitly excludes reference answers', async () => {
  const f = fixture();
  const result = await f.service.enter(1, p);
  expect(result.questions[0]).toEqual({
    questionId: 1,
    sequenceNo: 1,
    questionContent: '题干',
    questionFiles: [{ objectKey: 'stem' }],
    requiredFlag: true,
    score: 20,
  });
  expect(JSON.stringify(result)).not.toContain('秘密');
  const data = f.tx.entranceExamAttempt.create.mock.calls[0]![0].data;
  expect(data).toMatchObject({
    sourceBizId: 1,
    sourceBizType: 'EXPERT_ORDER',
    examVersionId: 1,
    paperId: 1,
  });
  expect(data.answerDeadlineAt.getTime() - data.enteredAt.getTime()).toBe(3_600_000);
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue({ ...f.attempt, ...data });
  f.exam.status = 'CLOSED';
  f.version.registrationDeadline = new Date(0);
  expect(await f.service.enter(1, p)).toEqual(result);
  expect(f.tx.entranceExamAttempt.create).toHaveBeenCalledTimes(1);
});
test.each(['PENDING', 'REJECTED', 'CANCELLED', 'ACCEPTED', 'SELECTED'])(
  'candidate organization response %s respects identity precedence',
  async (status) => {
    const f = fixture();
    f.org.memberResponses = [{ status }];
    f.tx.userOrgRel.findMany.mockResolvedValue([f.relation] as never);
    f.tx.projectExpertAssignment.findMany.mockResolvedValue([f.personal, f.org] as never);
    if (status === 'PENDING')
      await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 403 });
    else {
      await f.service.enter(1, p);
      expect(f.tx.entranceExamAttempt.create.mock.calls[0]![0].data.organizationId).toBe(
        ['REJECTED', 'CANCELLED'].includes(status) ? null : 'org',
      );
    }
  },
);
test('candidate supervisor must also own project; owner history disables legacy fallback', async () => {
  const f = fixture();
  f.relation.position = 'OWNER';
  f.tx.userOrgRel.findMany.mockResolvedValue([f.relation] as never);
  f.org.projectOwnerUserId = p.userId as never;
  f.org.owners = [{ userId: p.userId, status: 'REMOVED' }] as never;
  f.tx.projectExpertAssignment.findMany.mockResolvedValue([f.personal, f.org] as never);
  await expect(requireCandidate(f.tx as never, 1, p.userId)).rejects.toMatchObject({ status: 403 });
  f.org.owners = [];
  expect((await requireCandidate(f.tx as never, 1, p.userId)).assignment.id).toBe(2);
});
test.each([
  'cancelledAt',
  'submittedAt',
  'answerDeadlineAt',
  'finalResult',
  'sourceBizType',
  'organizationId',
])('candidate refuses terminal or invalid bound source %s', async (field) => {
  const f = fixture();
  const value = {
    cancelledAt: new Date(),
    submittedAt: new Date(),
    answerDeadlineAt: new Date(0),
    finalResult: 'ELIMINATED',
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    organizationId: 'old-org',
  }[field];
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue({ ...f.attempt, [field]: value } as never);
  await expect(f.service.enter(1, p)).rejects.toBeDefined();
  expect(f.tx.entranceExamAttempt.create).not.toHaveBeenCalled();
  expect(f.tx.entranceExamAttempt.update).not.toHaveBeenCalled();
});
test('candidate first entry refuses closed, expired, missing paper, exempt and completed projects', async () => {
  const f = fixture();
  f.exam.status = 'CLOSED';
  await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 400 });
  f.exam.status = 'ACTIVE';
  f.version.registrationDeadline = new Date(0);
  await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 400 });
  f.version.registrationDeadline = new Date('2099-01-01Z');
  f.tx.entranceExamPaper.findMany.mockResolvedValue([]);
  await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 500 });
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: false });
  await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 400 });
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  f.project.currentNodeCode = 'COMPLETED';
  await expect(f.service.enter(1, p)).rejects.toMatchObject({ status: 400 });
  expect(f.tx.entranceExamAttempt.create).not.toHaveBeenCalled();
});
test('candidate current prioritizes admitted then pending then entered across all exams', async () => {
  const f = fixture();
  const a = { ...f.attempt, finalDecidedAt: null };
  for (const [rows, status] of [
    [[], 'NOT_EXAMINED'],
    [[a], 'NOT_PASSED'],
    [[{ ...a, submittedAt: new Date() }], 'PENDING'],
    [
      [
        { ...a, gradingStatus: 'PENDING' },
        { ...a, finalResult: 'ADMITTED' },
      ],
      'PASSED',
    ],
  ] as const) {
    f.tx.entranceExamAttempt.findMany.mockResolvedValue(rows as never);
    expect(await f.service.current(1, p)).toEqual({ projectId: 1, status });
  }
  await expect(f.service.current(1, { ...p, role: 'PM' })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.current(2147483648, p)).rejects.toMatchObject({ status: 400 });
});
test('candidate file access grants only bound question attachments and revokes after losing qualification', async () => {
  const f = fixture();
  f.tx.entranceExamAttempt.findMany.mockResolvedValue([{ paperId: 1 }] as never);
  expect(await canReadManagedExamFile(f.db, 1, p, 'stem')).toBe(true);
  expect(f.tx.entranceExamAttempt.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationId: null,
        userOrgRelId: null,
        sourceBizType: 'EXPERT_ORDER',
        sourceBizId: 1,
      }),
    }),
  );
  expect(await canReadManagedExamFile(f.db, 1, p, 'secret')).toBe(false);
  f.tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  expect(await canReadManagedExamFile(f.db, 1, p, 'stem')).toBe(false);
});
test('candidate HTTP routes validate numeric query, origins and serialize paper without secret fields', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:3001',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  vi.spyOn(ExamCandidateService.prototype, 'current').mockResolvedValue({
    projectId: 1,
    status: 'NOT_EXAMINED',
  });
  vi.spyOn(ExamCandidateService.prototype, 'enter').mockResolvedValue({
    ...candidatePaperExample,
    referenceAnswer: '秘密',
  } as never);
  vi.spyOn(ExamCandidateCommandService.prototype, 'submit').mockResolvedValue(
    candidateSubmitExample,
  );
  vi.spyOn(ExamCandidateCommandService.prototype, 'cancel').mockResolvedValue(
    candidateCancelExample,
  );
  const app = await createApp(config, { $disconnect: vi.fn() } as unknown as PrismaClient);
  try {
    const headers = { authorization: 'Bearer test' };
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/enter',
      headers,
      payload: { projectId: 1 },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toEqual(candidatePaperExample);
    for (const value of ['0', '-1', 'x', '1.5', '1e1', ''])
      expect(
        (await app.inject({ url: `/api/v1/entrance-exams/current?projectId=${value}`, headers }))
          .statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ url: '/api/v1/entrance-exams/current?projectId=1', headers })).json().data
        .status,
    ).toBe('NOT_EXAMINED');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/entrance-exams/enter',
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=x' },
          payload: { projectId: 1 },
        })
      ).statusCode,
    ).toBe(403);
    for (const [path, payload, example] of [
      [
        'submit',
        {
          projectId: 1,
          attemptId: 1,
          integritySigned: true,
          answers: [{ questionId: 1, answerContent: '答卷' }],
        },
        candidateSubmitExample,
      ],
      ['cancel', { projectId: 1, attemptId: 1 }, candidateCancelExample],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/entrance-exams/${path}`,
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(example);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/entrance-exams/${path}`,
            headers,
            payload: { projectId: 1 },
          })
        ).statusCode,
      ).toBe(400);
    }
    const longAnswer = {
      projectId: 1,
      attemptId: 1,
      integritySigned: true,
      answers: [{ questionId: 1, answerContent: '答'.repeat(100000) }],
    };
    const acceptedLong = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/submit',
      headers,
      payload: longAnswer,
    });
    expect(acceptedLong.statusCode, acceptedLong.body).toBe(200);
    const overField = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/submit',
      headers,
      payload: { ...longAnswer, answers: [{ questionId: 1, answerContent: '答'.repeat(100001) }] },
    });
    expect(overField.statusCode, overField.body).toBe(400);
    const overBody = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/submit',
      headers,
      payload: {
        ...longAnswer,
        answers: Array.from({ length: 8 }, (_, i) => ({
          questionId: i + 1,
          answerContent: '答'.repeat(100000),
        })),
      },
    });
    expect(overBody.statusCode, overBody.body).toBe(413);
    const swaggerResponse = await app.inject({ url: '/api/v1/docs/json' });
    expect(swaggerResponse.statusCode, swaggerResponse.body).toBe(200);
    const swagger = swaggerResponse.json();
    expect(swagger.paths['/api/v1/entrance-exams/enter'].post.operationId).toBe(
      'entranceExamCandidateEnter',
    );
    expect(swagger.paths['/api/v1/entrance-exams/current'].get.parameters[0].description).toContain(
      '项目ID',
    );
  } finally {
    await app.close();
  }
});

test('candidate answer files stay inside owned attempt or effective organization management scope', async () => {
  const f = fixture();
  f.tx.entranceExamAttempt.findMany.mockResolvedValue([{ id: 10, paperId: 1 }] as never);
  f.tx.entranceExamAnswer.findMany.mockResolvedValue([
    { answerFilesJson: [{ objectKey: 'own-answer' }] },
  ] as never);
  expect(await canReadManagedExamFile(f.db, 1, p, 'own-answer')).toBe(true);
  expect(f.tx.entranceExamAnswer.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ where: { attempt: { examId: 1, OR: [{ id: { in: [10] } }] } } }),
  );
  f.tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  expect(await canReadManagedExamFile(f.db, 1, p, 'own-answer')).toBe(false);
  const managed = { ...f.org, organization: { memberships: [{ position: 'OWNER' }] } };
  f.tx.projectExpertAssignment.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([managed] as never);
  expect(await canReadManagedExamFile(f.db, 1, p, 'own-answer')).toBe(true);
  expect(f.tx.entranceExamAnswer.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: {
        attempt: {
          examId: 1,
          OR: [
            { id: { in: [] } },
            { organizationId: 'org', sourceBizType: 'EXPERT_ORDER', sourceBizId: 2 },
          ],
        },
      },
    }),
  );
  const removed = {
    ...managed,
    organization: { memberships: [{ position: 'MEMBER' }] },
    projectOwnerUserId: p.userId,
    owners: [{ userId: p.userId, status: 'REMOVED' }],
  };
  f.tx.projectExpertAssignment.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([removed] as never);
  expect(await canReadManagedExamFile(f.db, 1, p, 'own-answer')).toBe(false);
});
