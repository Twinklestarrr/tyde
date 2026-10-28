import { beforeEach, expect, test, vi } from 'vitest';
import { ordinaryExamTask } from '../src/modules/expert/expert-exam-task.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
const context = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/entrance-exams/exam-candidate.service.js', () => ({
  candidateContext: context,
}));
const now = new Date('2026-10-28T02:00:00Z');
beforeEach(() =>
  context.mockReset().mockResolvedValue({
    movement: null,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: 1,
    organizationId: 'org',
    relation: { id: 'rel' },
  }),
);
function fixture() {
  const attempt = {
    examId: 9,
    examVersionId: 10,
    paperId: 11,
    sourceBizId: 1,
    organizationId: 'org',
    userOrgRelId: 'rel',
    finalResult: 'PENDING',
    enteredAt: now,
    answerDeadlineAt: new Date('2099-01-01'),
    exam: { createdAt: now },
    version: { id: 10, examId: 9 },
    paper: { id: 11, examVersionId: 10, questions: [{ id: 12 }] },
  };
  const tx = {
    entranceExamAttempt: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    projectEntranceExam: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 9, createdAt: now, currentVersion: { examId: 9 } }),
    },
  };
  return { tx, attempt, run: () => ordinaryExamTask(tx as never, 2, 'worker', now) };
}
test('unentered ordinary task requires live registration and the current candidate identity', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ examId: 9, assignmentId: 1, sourceEventAt: now });
  expect(context).toHaveBeenCalledWith(f.tx, 2, 'worker', true);
  expect(f.tx.projectEntranceExam.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        status: 'ACTIVE',
        currentVersion: { registrationDeadline: { gt: now } },
      }),
    }),
  );
  f.tx.projectEntranceExam.findFirst.mockResolvedValue(null);
  expect(await f.run()).toBeNull();
});
test('valid bound historical paper survives closure with finite and unlimited answer windows', async () => {
  const f = fixture();
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue(f.attempt);
  f.tx.projectEntranceExam.findFirst.mockResolvedValue(null);
  expect(await f.run()).toMatchObject({ examId: 9 });
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue({ ...f.attempt, answerDeadlineAt: null });
  expect(await f.run()).toMatchObject({ examId: 9 });
  expect(f.tx.projectEntranceExam.findFirst).not.toHaveBeenCalled();
});
test.each([
  { sourceBizId: 2 },
  { organizationId: 'other' },
  { userOrgRelId: 'other' },
  { finalResult: 'ADMITTED' },
  { answerDeadlineAt: now },
  { version: null },
  { version: { id: 10, examId: 8 } },
  { version: { id: 20, examId: 9 } },
  { paper: null },
  { paper: { id: 21, examVersionId: 10, questions: [{ id: 12 }] } },
  { paper: { id: 11, examVersionId: 20, questions: [{ id: 12 }] } },
  { paper: { id: 11, examVersionId: 10, questions: [] } },
])('invalid identity, deadline or bound paper clears ordinary task: %j', async (patch) => {
  const f = fixture();
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue({ ...f.attempt, ...patch });
  expect(await f.run()).toBeNull();
  expect(f.tx.projectEntranceExam.findFirst).not.toHaveBeenCalled();
});
test('finished attempts and transfer context cannot revive ordinary tasks, source failures propagate', async () => {
  const f = fixture();
  f.tx.entranceExamAttempt.count.mockResolvedValue(1);
  expect(await f.run()).toBeNull();
  f.tx.entranceExamAttempt.count.mockResolvedValue(0);
  context.mockResolvedValue({ movement: { id: 4 } });
  expect(await f.run()).toBeNull();
  for (const status of [403, 404]) {
    context.mockRejectedValueOnce(new AuthError(status, 'FORBIDDEN', 'lost'));
    expect(await f.run()).toBeNull();
  }
  context.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(f.run()).rejects.toThrow('database unavailable');
});
