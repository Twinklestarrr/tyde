import { beforeEach, expect, test, vi } from 'vitest';
import { AuthError } from '../src/modules/auth/auth.error.js';
import { hasTransferExamTask } from '../src/modules/expert/expert-transfer-exam.js';
const eligibility = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/personnel/personnel-transfer.js', () => ({
  requireTransferEligibility: eligibility,
}));
beforeEach(() => eligibility.mockReset().mockResolvedValue(undefined));
const now = new Date('2026-10-27T10:00:00Z');
function fixture() {
  const movement = {
    id: 7,
    userId: 'worker',
    movementType: 'TRANSFER',
    status: 'PROCESSING',
    targetProjectId: 2,
    targetProject: { deleted: false, status: 'PUBLISHED', currentNodeCode: 'PRODUCTION_TASK' },
    member: { organizationId: null, userOrgRelId: null },
    targetExamAttemptId: null,
    targetExamAttempt: null,
    flow: {
      status: 'PENDING',
      currentNode: 2,
      currentNodeCode: 'TARGET_ENTRANCE_EXAM',
      nodes: [
        {
          nodeSeq: 2,
          nodeCode: 'TARGET_ENTRANCE_EXAM',
          nodeStatus: 'PENDING',
          approverId: 'worker',
        },
      ],
    },
  };
  const tx = {
    entranceExamAttempt: { findMany: vi.fn().mockResolvedValue([{ examId: 3 }]) },
    projectEntranceExam: {
      findFirst: vi.fn().mockResolvedValue({ id: 4, currentVersion: { examId: 4 } }),
    },
  };
  const run = (patch = {}) =>
    hasTransferExamTask(tx as never, { ...movement, ...patch } as never, now);
  const attempt = {
    id: 9,
    examId: 4,
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    sourceBizId: 7,
    candidateUserId: 'worker',
    organizationId: null,
    userOrgRelId: null,
    exam: { projectId: 2, deleted: false },
    finalResult: 'PENDING',
    enteredAt: new Date('2026-10-27T09:30:00Z'),
    answerDeadlineAt: new Date('2026-10-27T10:30:00Z'),
    submittedAt: null,
    cancelledAt: null,
  };
  return { movement, tx, run, attempt };
}
test('unentered transfer requires an unused live exam and never invents ordinary acceptance', async () => {
  const f = fixture();
  expect(await f.run()).toBe(true);
  expect(f.tx.projectEntranceExam.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        projectId: 2,
        id: { notIn: [3] },
        currentVersion: { registrationDeadline: { gt: now } },
      }),
    }),
  );
  f.tx.projectEntranceExam.findFirst.mockResolvedValue(null);
  expect(await f.run()).toBe(false);
});
test('waiting confirmation, future effectiveness, wrong current node and terminal target never create an exam task', async () => {
  const f = fixture();
  for (const status of ['WAITING_EFFECTIVE', 'EFFECTIVE', 'REJECTED'])
    expect(await f.run({ status })).toBe(false);
  for (const code of ['MEMBER_CONFIRM', 'TARGET_MANAGER', 'TARGET_ORG_OWNER']) {
    expect(await f.run({ flow: { ...f.movement.flow, currentNodeCode: code } })).toBe(false);
  }
  f.movement.flow.nodes[0]!.approverId = 'other';
  expect(await f.run()).toBe(false);
  expect(
    await f.run({ targetProject: { ...f.movement.targetProject, currentNodeCode: 'COMPLETED' } }),
  ).toBe(false);
  expect(eligibility).not.toHaveBeenCalled();
});
test('bound historical exam survives publication close within answer window but exact source, deadline and terminal attempts revoke it', async () => {
  const f = fixture();
  const run = (patch = {}) =>
    f.run({ targetExamAttemptId: 9, targetExamAttempt: { ...f.attempt, ...patch } });
  expect(await run()).toBe(true);
  expect(f.tx.projectEntranceExam.findFirst).not.toHaveBeenCalled();
  for (const patch of [
    { sourceBizId: 8 },
    { sourceBizType: 'EXPERT_ASSIGNMENT' },
    { candidateUserId: 'other' },
    { organizationId: 'other' },
    { userOrgRelId: 'other' },
    { id: 10 },
    { exam: { projectId: 3 } },
    { exam: { projectId: 2, deleted: true } },
    { submittedAt: now },
    { cancelledAt: now },
    { finalResult: 'ADMITTED' },
    { answerDeadlineAt: now },
  ])
    expect(await run(patch)).toBe(false);
});
test('lost eligibility clears the source while infrastructure failures propagate', async () => {
  const f = fixture();
  for (const status of [403, 409]) {
    eligibility.mockRejectedValueOnce(new AuthError(status, 'FORBIDDEN', 'lost'));
    expect(await f.run()).toBe(false);
  }
  eligibility.mockRejectedValueOnce(new Error('source unavailable'));
  await expect(f.run()).rejects.toThrow('source unavailable');
  f.tx.projectEntranceExam.findFirst.mockRejectedValueOnce(new Error('exam unavailable'));
  await expect(f.run()).rejects.toThrow('exam unavailable');
});
