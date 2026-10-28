import { beforeEach, expect, test, vi } from 'vitest';
import { collectExpertCardCandidates } from '../src/modules/projects/project-expert-card-candidates.js';
import { managementBranchWinners } from '../src/modules/projects/project-management-card-snapshot.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  context: vi.fn(),
  approvers: vi.fn(),
  transferExam: vi.fn(),
}));
vi.mock('../src/modules/expert/expert-transfer-exam.js', () => ({
  hasTransferExamTask: mocks.transferExam,
}));
vi.mock('../src/modules/production/output-report-access.js', () => ({ outputScope: mocks.access }));
vi.mock('../src/modules/entrance-exams/exam-candidate.service.js', () => ({
  candidateContext: mocks.context,
}));
vi.mock('../src/modules/personnel/personnel-transfer.js', () => ({
  currentApprovers: mocks.approvers,
  transferInclude: {},
}));
const early = new Date('2026-10-01'),
  later = new Date('2026-10-02');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    reviewer: true,
    organizationIds: ['a', 'b'],
    correctionIds: [],
  });
  mocks.context.mockResolvedValue({ movement: null });
  mocks.transferExam.mockResolvedValue(true);
  mocks.approvers.mockResolvedValue([{ id: 'same' }]);
});
function fixture() {
  const a = {
    id: 1,
    organizationId: 'a',
    subjectType: 'ORGANIZATION',
    status: 'ACCEPTED',
    projectId: 1,
    organization: { deleted: false },
    owners: [{ userId: 'other', status: 'ACTIVE' }],
    memberResponses: [],
  };
  const b = { ...a, id: 2, organizationId: 'b', owners: [{ userId: 'same', status: 'ACTIVE' }] };
  const member = (id: number, organizationId: string | null, userId = 'worker') => {
    const relation = { id: `rel-${id}`, orgId: organizationId, userId, joinStatus: 'ACTIVE' };
    return {
      id,
      userId,
      organizationId,
      userOrgRelId: organizationId ? relation.id : null,
      projectId: 1,
      user: { status: 'ACTIVE' },
      status: 'PENDING_ENTRY',
      entryDecision: null,
      plannedEntryDate: null,
      admittedAt: early,
      createdAt: early,
      joinedAt: null as Date | null,
      leftAt: null as Date | null,
      standardTrainingConfirmedAt: null as Date | null,
      organization: organizationId ? { deleted: false } : null,
      organizationMembership: organizationId ? relation : null,
      expertAssignment: organizationId
        ? {
            ...(organizationId === 'a' ? a : b),
            memberResponses: [{ userId, userOrgRelId: relation.id, status: 'ACCEPTED' }],
          }
        : {
            id: 3,
            status: 'ACCEPTED',
            projectId: 1,
            subjectType: 'INDIVIDUAL',
            expertUserId: userId,
          },
    };
  };
  const tx = {
    projectExpertAssignment: { findMany: vi.fn(async () => [a, b]) },
    userOrgRel: {
      findMany: vi.fn(async () => [
        { id: 'ra', orgId: 'a', userId: 'same', position: 'OWNER' },
        { id: 'rb', orgId: 'b', userId: 'same', position: 'MEMBER' },
      ]),
    },
    projectMember: { findMany: vi.fn(async () => [member(2, 'b'), member(1, 'a')]) },
    projectProductionPlan: { findUnique: vi.fn(async () => ({ needWrittenExam: false })) },
    projectOutputReport: {
      findMany: vi.fn(async () => [
        {
          id: 20,
          memberId: 1,
          member: { organizationId: 'a' as string | null },
          reviewStatus: 'PENDING',
          createdAt: early,
          returnedAt: null as Date | null,
        },
        {
          id: 21,
          memberId: 2,
          member: { organizationId: 'b' as string | null },
          reviewStatus: 'PENDING',
          createdAt: later,
          returnedAt: null as Date | null,
        },
      ]),
    },
    projectMemberMovement: {
      findMany: vi.fn(
        async () =>
          [] as {
            id: number;
            sourceProjectId: number;
            targetProjectId: number;
            createdAt: Date;
            flow: { currentNodeCode: string };
          }[],
      ),
    },
    entranceExamAttempt: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    projectEntranceExam: {
      findFirst: vi.fn(async () => ({ id: 9, createdAt: early, currentVersion: { examId: 9 } })),
    },
  };
  return { tx, member, run: () => collectExpertCardCandidates(tx as never, 1, later) };
}
test('owner of organization A and project owner of B retain separate report ranges and recover entry', async () => {
  const f = fixture();
  const rows = await f.run();
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: 'same', perspective: 'EXPERT_ORG_OWNER', sourceBizId: 20 }),
      expect.objectContaining({
        userId: 'same',
        perspective: 'EXPERT_PROJECT_OWNER',
        sourceBizId: 21,
      }),
      expect.objectContaining({
        perspective: 'EXPERT_PROJECT_OWNER',
        branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
        sourceBizId: 2,
      }),
    ]),
  );
  expect(rows.some((r) => r.perspective === 'EXPERT_ORG_OWNER' && r.sourceBizId === 21)).toBe(
    false,
  );
  expect(rows.some((r) => r.perspective === 'EXPERT_PROJECT_OWNER' && r.sourceBizId === 20)).toBe(
    false,
  );
  f.tx.projectOutputReport.findMany.mockResolvedValue([]);
  expect([...managementBranchWinners(await f.run()).values()]).toContainEqual(
    expect.objectContaining({
      perspective: 'EXPERT_PROJECT_OWNER',
      branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
      sourceBizId: 2,
    }),
  );
});
test('latest personal membership restores training and production; departed latest relationship cannot revive an older one', async () => {
  const f = fixture(),
    m = { ...f.member(4, null, 'same'), status: 'ACTIVE', joinedAt: early };
  f.tx.projectMember.findMany.mockResolvedValue([m]);
  expect(await f.run()).toContainEqual(
    expect.objectContaining({
      perspective: 'EXPERT_INDIVIDUAL',
      branchNodeCode: 'STANDARD_TRAINING',
      sourceBizId: 4,
    }),
  );
  const confirmed = { ...m, standardTrainingConfirmedAt: later };
  f.tx.projectMember.findMany.mockResolvedValue([confirmed]);
  expect(await f.run()).toContainEqual(
    expect.objectContaining({
      perspective: 'EXPERT_INDIVIDUAL',
      branchNodeCode: 'PRODUCTION_TASK',
      sourceEventAt: later,
    }),
  );
  f.tx.projectMember.findMany.mockResolvedValue([
    { ...confirmed, id: 5, status: 'LEFT', leftAt: later },
    confirmed,
  ]);
  expect((await f.run()).some((r) => r.perspective === 'EXPERT_INDIVIDUAL')).toBe(false);
});
test('removed owners do not revive legacy ownership and leaving an organization revokes its management candidates', async () => {
  const f = fixture(),
    assignments = await f.tx.projectExpertAssignment.findMany();
  assignments[1]!.owners[0]!.status = 'REMOVED';
  Object.assign(assignments[1]!, { projectOwnerUserId: 'same' });
  f.tx.projectExpertAssignment.findMany.mockResolvedValue(assignments);
  expect((await f.run()).some((r) => r.perspective === 'EXPERT_PROJECT_OWNER')).toBe(false);
  f.tx.userOrgRel.findMany.mockResolvedValue([]);
  expect(
    (await f.run()).some((r) =>
      ['EXPERT_PROJECT_OWNER', 'EXPERT_ORG_OWNER'].includes(r.perspective),
    ),
  ).toBe(false);
});
test('current transfer approver wins over other domains using real movement facts', async () => {
  const f = fixture();
  f.tx.projectMemberMovement.findMany.mockResolvedValue([
    {
      id: 8,
      sourceProjectId: 1,
      targetProjectId: 2,
      createdAt: early,
      flow: { currentNodeCode: 'SOURCE_ORG_OWNER' },
    },
  ]);
  expect([...managementBranchWinners(await f.run()).values()]).toContainEqual(
    expect.objectContaining({
      userId: 'same',
      perspective: 'EXPERT_PROJECT_OWNER',
      branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
      sourceBizId: 8,
    }),
  );
});
test('returned correction preserves production branch contract and the actual return time', async () => {
  const f = fixture();
  f.tx.projectMember.findMany.mockResolvedValue([
    { ...f.member(4, null, 'same'), status: 'ACTIVE', joinedAt: early },
  ]);
  mocks.access.mockResolvedValue({ reviewer: false, organizationIds: [], correctionIds: [4] });
  f.tx.projectOutputReport.findMany.mockResolvedValue([
    {
      id: 30,
      memberId: 4,
      member: { organizationId: null },
      reviewStatus: 'RETURNED',
      createdAt: early,
      returnedAt: later,
    },
  ]);
  const rows = await f.run();
  expect(
    rows.some(
      (r) =>
        r.sourceBizId === 30 &&
        ['EXPERT_ORG_OWNER', 'EXPERT_PROJECT_OWNER'].includes(r.perspective),
    ),
  ).toBe(false);
  expect(rows).toContainEqual(
    expect.objectContaining({
      perspective: 'EXPERT_INDIVIDUAL',
      branchNodeCode: 'PRODUCTION_TASK',
      sourceBizType: 'OUTPUT_REPORT',
      sourceEventAt: later,
    }),
  );
});
test('owner exam requires current candidate access and a live exam; submitted or cancelled attempts clear it', async () => {
  const f = fixture();
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  expect(await f.run()).toContainEqual(
    expect.objectContaining({
      perspective: 'EXPERT_PROJECT_OWNER',
      branchNodeCode: 'ENTRANCE_EXAM',
      sourceBizType: 'ENTRANCE_EXAM',
      sourceBizId: 9,
    }),
  );
  f.tx.entranceExamAttempt.count.mockResolvedValue(1);
  expect((await f.run()).some((r) => r.branchNodeCode === 'ENTRANCE_EXAM')).toBe(false);
  f.tx.entranceExamAttempt.count.mockResolvedValue(0);
  mocks.context.mockRejectedValue(new AuthError(403, 'FORBIDDEN', 'identity lost'));
  expect((await f.run()).some((r) => r.branchNodeCode === 'ENTRANCE_EXAM')).toBe(false);
});
test('source failures propagate instead of persisting an incomplete candidate set', async () => {
  const f = fixture();
  mocks.access.mockRejectedValue(new Error('database unavailable'));
  await expect(f.run()).rejects.toThrow('database unavailable');
});

test('transfer exam source exists without ordinary assignment and retains its movement identity in the target only', async () => {
  const f = fixture();
  f.tx.projectExpertAssignment.findMany.mockResolvedValue([]);
  f.tx.projectMember.findMany.mockResolvedValue([]);
  f.tx.userOrgRel.findMany.mockResolvedValue([]);
  const movement = {
    id: 8,
    sourceProjectId: 2,
    targetProjectId: 1,
    createdAt: early,
    flow: { currentNodeCode: 'TARGET_ENTRANCE_EXAM' },
    userId: 'transfer-worker',
    member: { organizationId: null },
  };
  f.tx.projectMemberMovement.findMany.mockResolvedValue([movement]);
  expect(await f.run()).toEqual([
    {
      userId: 'transfer-worker',
      perspective: 'EXPERT_INDIVIDUAL',
      branchNodeCode: 'ENTRANCE_EXAM',
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: 8,
      sourceEventAt: early,
    },
  ]);
  movement.member.organizationId = 'a' as never;
  expect(await f.run()).toMatchObject([{ perspective: 'EXPERT_MEMBER' }]);
  mocks.transferExam.mockResolvedValue(false);
  expect(await f.run()).toEqual([]);
  mocks.transferExam.mockRejectedValue(new Error('transfer unavailable'));
  await expect(f.run()).rejects.toThrow('transfer unavailable');
  movement.targetProjectId = 3;
  expect(await f.run()).toEqual([]);
});
test('ordinary owner exam scope cannot revive transfer confirmation or submitted waiting stages', async () => {
  const f = fixture();
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  mocks.context.mockResolvedValue({ movement: { id: 8 } });
  expect((await f.run()).some((r) => r.branchNodeCode === 'ENTRANCE_EXAM')).toBe(false);
});

test('entered ordinary exam retains its bound source after closure and edit, but expired or mismatched identity clears it', async () => {
  const f = fixture();
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  mocks.context.mockResolvedValue({
    movement: null,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: 2,
    organizationId: 'b',
    relation: { id: 'rb' },
  });
  const attempt = {
    examVersionId: 80,
    paperId: 81,
    version: { id: 80, examId: 8 },
    paper: { id: 81, examVersionId: 80, questions: [{ id: 82 }] },
    examId: 8,
    exam: { createdAt: early },
    enteredAt: early,
    finalResult: 'PENDING',
    sourceBizId: 2,
    organizationId: 'b',
    userOrgRelId: 'rb',
    answerDeadlineAt: new Date('2099-01-01'),
  };
  f.tx.entranceExamAttempt.findFirst.mockResolvedValue(attempt as never);
  f.tx.projectEntranceExam.findFirst.mockResolvedValue(null as never);
  expect(await f.run()).toContainEqual(
    expect.objectContaining({
      branchNodeCode: 'ENTRANCE_EXAM',
      sourceBizId: 8,
      sourceEventAt: early,
    }),
  );
  attempt.answerDeadlineAt = later;
  expect((await f.run()).some((c) => c.branchNodeCode === 'ENTRANCE_EXAM')).toBe(false);
  attempt.answerDeadlineAt = new Date('2099-01-01');
  attempt.sourceBizId = 3;
  expect((await f.run()).some((c) => c.branchNodeCode === 'ENTRANCE_EXAM')).toBe(false);
});
