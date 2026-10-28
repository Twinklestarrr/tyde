import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({
    cardChangedRecipients: [{ userId: 'card-user', role: 'EXPERT' }],
  })),
}));
import { expect, test, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { collectExpertCardCandidates } from '../src/modules/projects/project-expert-card-candidates.js';
import {
  refreshOwnerProgress,
  ownerTargets,
  replaceProjectOwners,
} from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/projects/project-expert-card-candidates.js', () => ({
  collectExpertCardCandidates: vi.fn().mockResolvedValue([]),
}));
const id = '00000000-0000-4000-8000-000000000001';
const principal = { userId: id, uid: 'owner', role: 'EXPERT' } as AuthPrincipal;
test('owner replacement validates exclusive sources, UUIDs, IDs and distinct capacity', () => {
  expect(ownerTargets({ assignmentId: 1, projectOwnerUserId: id })).toEqual([id]);
  expect(ownerTargets({ assignmentId: 1, projectOwnerUserIds: Array(30).fill(id) })).toEqual([id]);
  expect(
    ownerTargets({ assignmentId: 1, projectOwnerUserId: id, projectOwnerUserIds: [] }),
  ).toEqual([id]);
  for (const input of [
    { assignmentId: 0, projectOwnerUserId: id },
    { assignmentId: 2147483648, projectOwnerUserId: id },
    { assignmentId: 1 },
    { assignmentId: 1, projectOwnerUserIds: [] },
    { assignmentId: 1, projectOwnerUserIds: [id], projectOwnerUserId: id },
    { assignmentId: 1, projectOwnerUserIds: [null] },
    { assignmentId: 1, projectOwnerUserIds: ['bad'] },
    {
      assignmentId: 1,
      projectOwnerUserIds: Array.from(
        { length: 21 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    },
  ])
    expect(() => ownerTargets(input as never)).toThrow();
});
function fixture() {
  const assignment = {
    id: 1,
    projectId: 2,
    organizationId: id,
    status: 'ACCEPTED',
    projectOwnerUserId: id,
    owners: [{ userId: id, status: 'ACTIVE' }],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'PUBLISHED' }) },
    user: { findMany: vi.fn().mockResolvedValue([{ id }]) },
    projectExpertAssignment: { findFirst: vi.fn().mockResolvedValue(assignment), update: vi.fn() },
    userOrgRel: {
      findMany: vi.fn().mockResolvedValue([{ id: 'rel', userId: id, position: 'OWNER' }]),
    },
    projectExpertAssignmentOwner: {
      create: vi.fn(async ({ data }) => ({ status: 'ACTIVE', ...data })),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue({ needWrittenExam: false }) },
    projectExpertAssignmentMember: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    projectMember: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    projectTaskRound: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() },
    projectRoleNodeSnapshot: { deleteMany: vi.fn() },
    projectMemberMovement: { findMany: vi.fn(async () => []) },
    projectEventOutbox: { create: vi.fn() },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return {
    tx,
    db,
    assignment,
    call: () =>
      replaceProjectOwners(
        db as unknown as PrismaClient,
        { assignmentId: 1, projectOwnerUserId: id },
        principal,
        'test',
      ),
  };
}
test('owner replacement enforces session role before opening transaction', async () => {
  const f = fixture();
  await expect(
    replaceProjectOwners(
      f.db as never,
      { assignmentId: 1, projectOwnerUserId: id },
      { ...principal, role: 'PM' },
      'test',
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
test('owner replacement requires live organization supervisor and accepted assignment', async () => {
  const f = fixture();
  f.tx.userOrgRel.findMany.mockResolvedValueOnce([]);
  await expect(f.call()).rejects.toMatchObject({ status: 403 });
  f.assignment.status = 'PENDING_ACCEPTANCE';
  await expect(f.call()).rejects.toMatchObject({ status: 400 });
  expect(f.tx.projectExpertAssignmentOwner.updateMany).not.toHaveBeenCalled();
});
test('same owner set is idempotent without participant, project or event writes', async () => {
  const f = fixture();
  expect(await f.call()).toBe(null);
  expect(f.tx.projectExpertAssignment.update).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('removed owner history prevents legacy owner resurrection on replacement', async () => {
  const f = fixture();
  f.assignment.owners[0].status = 'REMOVED';
  f.tx.projectExpertAssignmentOwner.updateMany.mockRejectedValue(new Error('stop before writes'));
  await expect(f.call()).rejects.toThrow('stop before writes');
  expect(f.tx.projectExpertAssignmentOwner.create).not.toHaveBeenCalled();
});

test('owner targets normalize UUID casing before deduplication', () => {
  const mixed = 'ABCDEF00-0000-4000-8000-000000000001';
  expect(
    ownerTargets({ assignmentId: 1, projectOwnerUserIds: [mixed, mixed.toLowerCase()] }),
  ).toEqual([mixed.toLowerCase()]);
});

test('added owner restores rejected participation and creates only exempt pending membership', async () => {
  const f = fixture();
  f.assignment.owners[0].status = 'REMOVED';
  f.tx.projectExpertAssignmentMember.findUnique.mockResolvedValueOnce({ status: 'REJECTED' });
  expect(await f.call()).toBe(null);
  expect(f.tx.projectExpertAssignmentMember.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: expect.objectContaining({
        status: 'SELECTED',
        rejectReason: null,
        userOrgRelId: 'rel',
      }),
    }),
  );
  expect(f.tx.projectMember.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        expertAssignmentId: 1,
        status: 'PENDING_CONFIRM',
        projectRole: 'MEMBER',
        userOrgRelId: 'rel',
      }),
    }),
  );
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'PROJECT_ASSIGNMENT_OWNERS_CHANGED',
        payload: expect.objectContaining({
          ownerUserIds: [id],
          previousOwnerUserIds: [],
          cardChangedRecipients: [{ userId: 'card-user', role: 'EXPERT' }],
        }),
      }),
    }),
  );
});
test('written exam does not create pending membership or rewrite accepted participation', async () => {
  const f = fixture();
  f.assignment.owners[0].status = 'REMOVED';
  f.tx.projectProductionPlan.findUnique.mockResolvedValueOnce({ needWrittenExam: true });
  f.tx.projectExpertAssignmentMember.findUnique.mockResolvedValueOnce({ status: 'ACCEPTED' });
  await f.call();
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  expect(f.tx.projectExpertAssignmentMember.upsert).not.toHaveBeenCalled();
});
test('legacy no-op initializes history once without producing membership or events', async () => {
  const f = fixture();
  f.assignment.owners = [];
  await f.call();
  expect(f.tx.projectExpertAssignmentOwner.create).toHaveBeenCalledOnce();
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});

test('owner card collection errors propagate before outbox and old cards are not deleted early', async () => {
  const f = fixture();
  f.assignment.owners[0].status = 'REMOVED';
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(
    new Error('owner cards unavailable'),
  );
  await expect(f.call()).rejects.toThrow('owner cards unavailable');
  expect(f.tx.projectRoleNodeSnapshot.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});

const progressNow = new Date('2026-10-28T00:00:00Z');
const progressCandidate = (
  branchNodeCode: 'ENTRANCE_EXAM' | 'STANDARD_TRAINING' | 'OUTPUT_DATA_REVIEW',
  perspective = 'EXPERT_MEMBER',
  userId = id,
) => ({
  userId,
  perspective,
  branchNodeCode,
  sourceBizType: 'PROJECT_MEMBER',
  sourceBizId: 1,
  sourceEventAt: progressNow,
});
test('owner progress retains independent exam and training under higher priority review and deduplicates users and perspectives', async () => {
  const f = fixture();
  const rounds = ['ENTRANCE_EXAM', 'STANDARD_TRAINING'].map((taskType, i) => ({
    id: i + 1,
    taskType,
    status: 'OPEN',
    openedAt: progressNow,
    participated: true,
  }));
  f.tx.projectTaskRound.findMany.mockResolvedValueOnce(rounds);
  vi.mocked(collectExpertCardCandidates).mockResolvedValueOnce([
    progressCandidate('OUTPUT_DATA_REVIEW'),
    progressCandidate('ENTRANCE_EXAM', 'EXPERT_PROJECT_OWNER'),
    progressCandidate('STANDARD_TRAINING'),
    progressCandidate('STANDARD_TRAINING', 'EXPERT_INDIVIDUAL'),
  ]);
  await refreshOwnerProgress(f.tx as never, 2, [id, id], progressNow);
  expect(f.tx.projectTaskRound.findMany).toHaveBeenCalledOnce();
  expect(f.tx.projectTaskRound.create).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.update).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('owner progress opens each independent source once and excludes unrelated users and task types', async () => {
  const f = fixture();
  vi.mocked(collectExpertCardCandidates).mockResolvedValueOnce([
    progressCandidate('STANDARD_TRAINING'),
    progressCandidate('STANDARD_TRAINING', 'EXPERT_INDIVIDUAL'),
    progressCandidate('ENTRANCE_EXAM', 'EXPERT_PROJECT_OWNER'),
    progressCandidate('OUTPUT_DATA_REVIEW'),
    progressCandidate('ENTRANCE_EXAM', 'EXPERT_MEMBER', 'other-user'),
  ]);
  await refreshOwnerProgress(f.tx as never, 2, [id, id], progressNow);
  expect(f.tx.projectTaskRound.create.mock.calls.map(([arg]) => arg.data)).toEqual([
    {
      projectId: 2,
      userId: id,
      role: 'EXPERT',
      taskType: 'STANDARD_TRAINING',
      openedAt: progressNow,
    },
    { projectId: 2, userId: id, role: 'EXPERT', taskType: 'ENTRANCE_EXAM', openedAt: progressNow },
  ]);
});
test.each([
  'source removed',
  'inactive account',
  'completed project',
  'deleted project',
  'unpublished project',
])('owner progress cancels lost qualification without marking completion: %s', async (reason) => {
  const f = fixture();
  f.tx.projectTaskRound.findMany.mockResolvedValueOnce([
    { id: 12, taskType: 'STANDARD_TRAINING', status: 'OPEN' },
  ]);
  vi.mocked(collectExpertCardCandidates).mockResolvedValueOnce(
    reason === 'source removed' ? [] : [progressCandidate('STANDARD_TRAINING')],
  );
  if (reason === 'inactive account') f.tx.user.findMany.mockResolvedValueOnce([]);
  if (reason === 'completed project')
    f.tx.project.findUniqueOrThrow.mockResolvedValueOnce({
      status: 'PUBLISHED',
      currentNodeCode: 'COMPLETED',
    });
  if (reason === 'deleted project')
    f.tx.project.findUniqueOrThrow.mockResolvedValueOnce({ status: 'PUBLISHED', deleted: true });
  if (reason === 'unpublished project')
    f.tx.project.findUniqueOrThrow.mockResolvedValueOnce({ status: 'DRAFT' });
  await refreshOwnerProgress(f.tx as never, 2, [id], progressNow);
  expect(f.tx.projectTaskRound.update).toHaveBeenCalledExactlyOnceWith({
    where: { id: 12 },
    data: { status: 'CANCELLED', finishedAt: progressNow },
  });
  expect(f.tx.projectTaskRound.create).not.toHaveBeenCalled();
  vi.mocked(collectExpertCardCandidates).mockReset().mockResolvedValue([]);
});
test('owner progress source lookup failure propagates before any round or event write', async () => {
  const f = fixture();
  vi.mocked(collectExpertCardCandidates).mockRejectedValueOnce(new Error('sources unavailable'));
  await expect(refreshOwnerProgress(f.tx as never, 2, [id], progressNow)).rejects.toThrow(
    'sources unavailable',
  );
  expect(f.tx.projectTaskRound.findMany).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.create).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.update).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});

test('project-wide progress discovers new candidates and cancels orphan rounds while preserving other domains', async () => {
  const f = fixture();
  vi.mocked(collectExpertCardCandidates).mockResolvedValueOnce([
    progressCandidate('ENTRANCE_EXAM'),
    progressCandidate('ENTRANCE_EXAM', 'EXPERT_PROJECT_OWNER'),
    progressCandidate('OUTPUT_DATA_REVIEW', 'EXPERT_PROJECT_OWNER', 'review-only'),
  ]);
  f.tx.projectTaskRound.findMany
    .mockResolvedValueOnce([{ userId: 'orphan' }, { userId: id }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 30, taskType: 'ENTRANCE_EXAM' }]);
  await refreshOwnerProgress(f.tx as never, 2, null, progressNow);
  expect(f.tx.projectTaskRound.findMany).toHaveBeenNthCalledWith(1, {
    where: {
      projectId: 2,
      role: 'EXPERT',
      status: 'OPEN',
      taskType: { in: ['ENTRANCE_EXAM', 'STANDARD_TRAINING'] },
    },
    select: { userId: true },
  });
  expect(f.tx.projectTaskRound.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      projectId: 2,
      userId: id,
      role: 'EXPERT',
      taskType: 'ENTRANCE_EXAM',
      openedAt: progressNow,
    },
  });
  expect(f.tx.projectTaskRound.update).toHaveBeenCalledExactlyOnceWith({
    where: { id: 30 },
    data: { status: 'CANCELLED', finishedAt: progressNow },
  });
  expect(f.tx.user.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: { in: [id, 'orphan'] }, status: 'ACTIVE' },
    }),
  );
});
