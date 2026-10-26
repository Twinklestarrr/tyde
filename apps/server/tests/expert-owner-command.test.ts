import { expect, test, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ownerTargets, replaceProjectOwners } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-task-query.js', () => ({
  queryExpertTasks: vi.fn().mockResolvedValue([]),
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
        payload: expect.objectContaining({ ownerUserIds: [id], previousOwnerUserIds: [] }),
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
