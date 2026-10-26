import {
  lockTransfer,
  respondTransferInTransaction,
} from '../src/modules/personnel/personnel-transfer.js';
import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
import { expect, test, vi } from 'vitest';
import {
  respondToAssignment,
  validateResponse,
  type RespondInput,
} from '../src/modules/expert/expert-respond-command.js';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
vi.mock('../src/modules/expert/expert-owner-command.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshOwnerProgress: vi.fn(),
}));
vi.mock('../src/modules/projects/project-recruitment-snapshot.js', () => ({
  collectRecruitmentTasks: vi.fn().mockResolvedValue({ scopes: [], sources: [] }),
  syncRecruitmentRetrySnapshot: vi.fn(),
}));
vi.mock('../src/modules/projects/project-task-rounds.js', () => ({
  reconcileTaskRounds: vi.fn(),
  taskEventFacts: vi.fn().mockReturnValue({}),
}));
vi.mock('../src/modules/personnel/personnel-transfer.js', async (original) => ({
  ...(await original<object>()),
  lockTransfer: vi.fn(),
  respondTransferInTransaction: vi.fn(),
}));
const userId = '00000000-0000-4000-8000-000000000001';
const p = { userId, uid: 'u', role: 'EXPERT' } as AuthPrincipal;
function fixture() {
  const a = {
    id: 1,
    projectId: 2,
    subjectType: 'INDIVIDUAL',
    expertUserId: userId,
    organizationId: null as string | null,
    status: 'PENDING_ACCEPTANCE',
    owners: [] as { status: string; userId: string }[],
    projectOwnerUserId: null,
    project: { currentNodeCode: 'PERSONNEL_MANAGEMENT' },
  };
  const tx = {
    projectMemberMovement: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn(),
    projectExpertAssignment: { findFirst: vi.fn().mockResolvedValue(a), update: vi.fn() },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([{ id: 'r', userId, position: 'OWNER' }]) },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue({ needWrittenExam: false }) },
    projectExpertAssignmentMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    projectExpertAssignmentOwner: { upsert: vi.fn() },
    projectMember: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    projectEventOutbox: { create: vi.fn() },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const call = (input: Partial<RespondInput> = {}, principal = p) =>
    respondToAssignment(db as never, { assignmentId: 1, decision: 'ACCEPT', ...input }, principal);
  return { a, tx, db, call };
}
test('response validates exclusive sources, decision, owners and required rejection reason', () => {
  for (const input of [
    {},
    { assignmentId: 1, movementId: 2, decision: 'ACCEPT' },
    { assignmentId: 0, decision: 'ACCEPT' },
    { movementId: 2147483648, decision: 'ACCEPT' },
    { assignmentId: 1, decision: 'BAD' },
    { assignmentId: 1, decision: 'REJECT', rejectReason: '  ' },
    { assignmentId: 1, decision: 'REJECT', rejectReason: 'a'.repeat(501) },
    { assignmentId: 1, decision: 'ACCEPT', projectOwnerUserId: 'bad' },
  ])
    expect(() => validateResponse(input as RespondInput)).toThrow();
});
test('response denies wrong session and owner parameters on movement before transaction', async () => {
  const f = fixture();
  await expect(f.call({}, { ...p, role: 'PM' })).rejects.toMatchObject({ status: 403 });
  await expect(
    f.call({ assignmentId: null, movementId: 1, projectOwnerUserId: p.userId }),
  ).rejects.toMatchObject({
    status: 400,
  });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
test('personal response creates exempt pending entry and enforces recipient and duplicate conflict', async () => {
  const f = fixture();
  expect(await f.call()).toMatchObject({
    status: 'ACCEPTED',
    memberStatus: null,
    nextAction: 'WAIT_ENTRY_CONFIRMATION',
  });
  expect(f.tx.projectMember.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        expertAssignmentId: 1,
        status: 'PENDING_CONFIRM',
        userOrgRelId: null,
      }),
    }),
  );
  f.a.expertUserId = 'other';
  await expect(f.call()).rejects.toMatchObject({ status: 403 });
  f.a.expertUserId = userId;
  f.a.status = 'ACCEPTED';
  await expect(f.call()).rejects.toMatchObject({ status: 409 });
});
test('written exam defers admission and individual owner parameters are rejected', async () => {
  const f = fixture();
  f.tx.projectProductionPlan.findUnique.mockResolvedValue({ needWrittenExam: true });
  expect(await f.call()).toMatchObject({ nextAction: 'TAKE_ENTRANCE_EXAM' });
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  await expect(f.call({ projectOwnerUserId: userId })).rejects.toMatchObject({ status: 400 });
});
test('organization first acceptance requires supervisor and live owners and initializes selected participants', async () => {
  const f = fixture();
  f.a.subjectType = 'ORGANIZATION';
  f.a.organizationId = userId;
  const otherId = '00000000-0000-4000-8000-000000000002';
  f.tx.userOrgRel.findMany.mockResolvedValue([
    { id: 'r', userId, position: 'OWNER' },
    { id: 'r2', userId: otherId, position: 'MEMBER' },
  ]);
  await expect(f.call()).rejects.toMatchObject({ status: 400 });
  expect(await f.call({ projectOwnerUserIds: [userId, userId] })).toMatchObject({
    nextAction: 'MANAGE_PROJECT_MEMBERS',
    notifiedMemberCount: 2,
  });
  expect(refreshOwnerProgress).toHaveBeenLastCalledWith(
    expect.anything(),
    2,
    [userId, otherId],
    expect.any(Date),
  );
  expect(f.tx.projectExpertAssignmentOwner.upsert).toHaveBeenCalledOnce();
  expect(f.tx.projectExpertAssignmentMember.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ create: expect.objectContaining({ status: 'SELECTED' }) }),
  );
  f.tx.userOrgRel.findMany.mockResolvedValue([{ id: 'r', userId, position: 'MEMBER' }]);
  await expect(f.call({ projectOwnerUserId: userId })).rejects.toMatchObject({ status: 403 });
});
test('members allow same decision replay, reject opposite or selected response, and exclude supervisor', async () => {
  const f = fixture();
  f.a.subjectType = 'ORGANIZATION';
  f.a.organizationId = userId;
  f.a.status = 'ACCEPTED';
  await expect(f.call()).rejects.toMatchObject({ status: 403 });
  f.tx.userOrgRel.findMany.mockResolvedValue([{ id: 'r', userId, position: 'MEMBER' }]);
  f.tx.projectExpertAssignmentMember.findUnique.mockResolvedValue({ status: 'ACCEPTED' });
  expect(await f.call()).toMatchObject({ memberStatus: 'ACCEPTED' });
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
  await expect(f.call({ decision: 'REJECT', rejectReason: 'reason' })).rejects.toMatchObject({
    status: 409,
  });
  f.tx.projectExpertAssignmentMember.findUnique.mockResolvedValue({ status: 'SELECTED' });
  await expect(f.call()).rejects.toMatchObject({ status: 409 });
  f.tx.userOrgRel.findMany.mockResolvedValue([]);
  await expect(f.call()).rejects.toMatchObject({ status: 403 });
});
test('member rejection preserves organization acceptance and does not create admission', async () => {
  const f = fixture();
  f.a.subjectType = 'ORGANIZATION';
  f.a.organizationId = userId;
  f.a.status = 'ACCEPTED';
  f.tx.userOrgRel.findMany.mockResolvedValue([{ id: 'r', userId, position: 'MEMBER' }]);
  expect(await f.call({ decision: 'REJECT', rejectReason: '  不参与  ' })).toMatchObject({
    status: 'ACCEPTED',
    memberStatus: 'REJECTED',
    nextAction: 'VIEW_RESULT',
  });
  expect(f.tx.projectExpertAssignment.update).not.toHaveBeenCalled();
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  expect(f.tx.projectExpertAssignmentMember.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ rejectReason: '不参与' }) }),
  );
});

test('legacy assignment response matches a unique concrete transfer before locks and skips exempt admission', async () => {
  const f = fixture();
  f.tx.projectMemberMovement.findMany.mockResolvedValue([{ id: 8 }]);
  expect(await f.call()).toMatchObject({
    assignmentId: 1,
    movementId: 8,
    nextAction: 'TAKE_ENTRANCE_EXAM',
  });
  expect(lockTransfer).toHaveBeenCalledWith(f.tx, 8, p.userId);
  expect(respondTransferInTransaction).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ movementId: 8 }),
    p,
  );
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  expect(f.tx.projectMemberMovement.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: p.userId,
        targetProjectId: 2,
        member: { organizationId: null },
        flow: { status: 'PENDING', currentNodeCode: 'MEMBER_CONFIRM' },
      }),
    }),
  );
});
test('legacy response rejects ambiguous transfer without writes and propagates transfer errors for whole transaction rollback', async () => {
  const f = fixture();
  f.tx.projectMemberMovement.findMany.mockResolvedValue([{ id: 8 }, { id: 9 }]);
  await expect(f.call()).rejects.toMatchObject({ status: 409 });
  expect(f.tx.projectExpertAssignment.update).not.toHaveBeenCalled();
  f.tx.projectMemberMovement.findMany.mockResolvedValue([{ id: 8 }]);
  vi.mocked(respondTransferInTransaction).mockRejectedValueOnce(new Error('transfer failure'));
  await expect(f.call()).rejects.toThrow('transfer failure');
  expect(f.tx.projectMember.create).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
