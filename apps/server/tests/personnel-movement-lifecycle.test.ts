import { syncSnapshots } from '../src/modules/personnel/personnel-movement-create.js';
import { expect, test, vi } from 'vitest';
import {
  applyMovement,
  processDueMovements,
} from '../src/modules/personnel/personnel-movement-effective.js';
import { refreshMovementApprovers } from '../src/modules/personnel/personnel-movement-approvers.js';
import type { Transfer } from '../src/modules/personnel/personnel-transfer.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => {}),
}));
vi.mock('../src/modules/personnel/personnel-movement-create.js', () => ({
  movementTasks: vi.fn(async () => ({ scopes: [], sources: [] })),
  syncSnapshots: vi.fn(async () => ({
    cardChangedRecipients: [{ userId: 'restored', role: 'EXPERT' }],
  })),
  projectOwners: vi.fn(async () => [{ id: 'new', uid: 'new', status: 'ACTIVE' }]),
}));
vi.mock('../src/modules/projects/project-task-rounds.js', () => ({
  collectManagementTasks: vi.fn(async () => ({ scopes: [], sources: [] })),
  reconcileTaskRounds: vi.fn(async () => {}),
  managementTaskTypes: [],
}));
const now = new Date('2026-10-26T16:00:00Z');
function fixture() {
  const m = {
    id: 1,
    memberId: 1,
    userId: 'member',
    sourceProjectId: 1,
    targetProjectId: 2,
    movementType: 'TRANSFER',
    status: 'WAITING_EFFECTIVE',
    plannedEffectiveDate: new Date('2026-10-27'),
    targetExamAttemptId: 10,
    flowId: 'flow',
    flow: {
      id: 'flow',
      flowNo: 'TF1',
      status: 'APPROVED',
      currentNode: 3,
      currentNodeCode: 'TARGET_MANAGER',
      nodes: [
        {
          id: 'node',
          nodeSeq: 3,
          nodeCode: 'TARGET_MANAGER',
          nodeStatus: 'PENDING',
          approverId: 'old',
          nodeName: '审批',
        },
      ],
    },
    member: {
      id: 1,
      projectId: 1,
      userId: 'member',
      projectRole: 'MEMBER',
      status: 'PENDING_TRANSFER',
      organizationId: null,
      userOrgRelId: null,
      user: { status: 'ACTIVE' },
      expertAssignment: {
        id: 1,
        projectId: 1,
        status: 'ACCEPTED',
        subjectType: 'INDIVIDUAL',
        expertUserId: 'member',
      },
    },
    targetProject: {
      id: 2,
      status: 'PUBLISHED',
      deleted: false,
      currentNodeCode: 'PERSONNEL_MANAGEMENT',
    },
    targetExamAttempt: {
      id: 10,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: 1,
      exam: { projectId: 2 },
      candidateUserId: 'member',
      organizationId: null,
      userOrgRelId: null,
      submittedAt: now,
      finalDecidedAt: now,
      finalResult: 'ADMITTED',
    },
  } as unknown as Transfer;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    project: {
      findFirst: vi.fn(async () => ({ id: 1, currentNodeCode: 'PRODUCTION_TASK' })),
      update: vi.fn(async ({ data }) => ({ ...m.targetProject, ...data })),
    },
    projectMember: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
    },
    projectExpertAssignment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: 2 })),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn(async () => ({ candidate: { id: 'new', uid: 'new', status: 'ACTIVE' } })),
    },
    projectMemberMovement: {
      findMany: vi.fn(async () => [m]),
      findUnique: vi.fn(async () => m),
      findUniqueOrThrow: vi.fn(async () => m),
      update: vi.fn(async ({ data }) => {
        Object.assign(m, data);
        return m;
      }),
    },
    approvalNode: {
      updateMany: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
    },
    approvalFlow: { update: vi.fn(async () => ({})) },
    approvalActionLog: { create: vi.fn(async () => ({})) },
    projectRoleNodeSnapshot: { deleteMany: vi.fn(async () => ({})) },
    projectEventOutbox: { create: vi.fn(async () => ({})) },
  };
  return { m, tx };
}
test('effective movement uses Shanghai midnight, retains exact admission and personal identity without inventing target acceptance', async () => {
  const { m, tx } = fixture();
  expect(await applyMovement(tx as never, m, new Date('2026-10-26T15:59:59Z'))).toBe(false);
  expect(tx.projectMember.update).not.toHaveBeenCalled();
  expect(await applyMovement(tx as never, m, now)).toBe(true);
  expect(tx.projectMember.update).toHaveBeenCalledWith({
    where: { id: 1 },
    data: {
      status: 'LEFT',
      leftAt: now,
      updatedBy: 'SYSTEM',
    },
  });
  expect(tx.projectMember.create.mock.calls[0]![0].data).toMatchObject({
    projectId: 2,
    organizationId: null,
    userOrgRelId: null,
    expertAssignmentId: null,
    admissionAttemptId: 10,
    status: 'ACTIVE',
    joinedAt: now,
  });
  expect(m).toMatchObject({ status: 'EFFECTIVE', effectiveAt: now });
  expect(await applyMovement(tx as never, m, now)).toBe(false);
  expect(tx.projectMember.create).toHaveBeenCalledTimes(1);
});
test('effective transfer rejects stale source, incomplete approval, wrong independent exam and any open target identity before member writes', async () => {
  for (const kind of ['source', 'flow', 'exam', 'target', 'manager']) {
    const { m, tx } = fixture();
    if (kind === 'source') m.member.status = 'LEFT';
    if (kind === 'flow') m.flow!.status = 'PENDING';
    if (kind === 'exam') m.targetExamAttempt!.sourceBizId = 99;
    if (kind === 'target') tx.projectMember.findFirst.mockResolvedValue({ id: 5 } as never);
    if (kind === 'manager') tx.projectManagerRecruitment.findFirst.mockResolvedValue(null as never);
    await expect(applyMovement(tx as never, m, now)).rejects.toMatchObject({ status: 409 });
    expect(tx.projectMember.update).not.toHaveBeenCalled();
    expect(tx.projectMember.create).not.toHaveBeenCalled();
  }
});
test('organization effective transfer keeps concrete relation and accepted target assignment; due organization departure blocks activation', async () => {
  for (const leaving of [false, true]) {
    const { m, tx } = fixture();
    Object.assign(m.member, {
      organizationId: 'org',
      userOrgRelId: 'rel',
      organization: { deleted: false },
      organizationMembership: {
        orgId: 'org',
        userId: 'member',
        joinStatus: leaving ? 'PENDING_LEAVE' : 'ACTIVE',
        plannedLeaveDate: new Date('2026-10-27'),
      },
      expertAssignment: {
        projectId: 1,
        status: 'ACCEPTED',
        subjectType: 'ORGANIZATION',
        organizationId: 'org',
      },
    });
    Object.assign(m.targetExamAttempt!, { organizationId: 'org', userOrgRelId: 'rel' });
    if (leaving) {
      await expect(applyMovement(tx as never, m, now)).rejects.toMatchObject({ status: 409 });
      expect(tx.projectMember.create).not.toHaveBeenCalled();
    } else {
      await applyMovement(tx as never, m, now);
      expect(tx.projectMember.create.mock.calls[0]![0].data).toMatchObject({
        organizationId: 'org',
        userOrgRelId: 'rel',
        expertAssignmentId: 2,
      });
    }
  }
});
test('removal marks only matching pending source removed and creates no target member', async () => {
  const { m, tx } = fixture();
  Object.assign(m, { movementType: 'REMOVAL', targetProjectId: null, flow: null });
  m.member.status = 'PENDING_EXIT';
  expect(await applyMovement(tx as never, m, now)).toBe(true);
  expect(tx.projectMember.update.mock.calls[0]![0].data.status).toBe('REMOVED');
  expect(tx.projectMember.create).not.toHaveBeenCalled();
});
test('approver refresh cancels only current obsolete candidate, adds current manager and versions the flow without deciding any node', async () => {
  const { m, tx } = fixture();
  m.status = 'PROCESSING';
  m.flow!.status = 'PENDING';
  expect(await refreshMovementApprovers(tx as never, 2, now)).toBe(1);
  expect(tx.approvalNode.updateMany.mock.calls[0]![0]).toMatchObject({
    where: { nodeSeq: 3, nodeStatus: 'PENDING', approverId: { notIn: ['new'] } },
    data: { nodeStatus: 'CANCELED' },
  });
  expect(tx.approvalNode.create.mock.calls[0]![0].data).toMatchObject({
    nodeSeq: 3,
    approverId: 'new',
    nodeStatus: 'PENDING',
  });
  expect(tx.approvalFlow.update.mock.calls[0]![0].data).toMatchObject({
    versionNo: { increment: 1 },
  });
  expect(tx.approvalActionLog.create.mock.calls[0]![0].data.actionType).toBe('TRANSFER');
  expect(tx.projectMember.update).not.toHaveBeenCalled();
  expect(tx.projectEventOutbox.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          cardChangedRecipients: [{ userId: 'restored', role: 'EXPERT' }],
        }),
      }),
    }),
  );
  expect(tx.projectRoleNodeSnapshot.deleteMany).not.toHaveBeenCalled();
});
test('approver refresh is a no-op for business waits, other project side and unchanged candidates', async () => {
  for (const kind of ['wait', 'side', 'unchanged']) {
    const { m, tx } = fixture();
    m.status = 'PROCESSING';
    m.flow!.status = 'PENDING';
    if (kind === 'wait') m.flow!.currentNodeCode = 'MEMBER_CONFIRM';
    if (kind === 'unchanged') m.flow!.nodes[0]!.approverId = 'new';
    expect(await refreshMovementApprovers(tx as never, kind === 'side' ? 1 : 2, now)).toBe(0);
    expect(tx.approvalNode.updateMany).not.toHaveBeenCalled();
    expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
  }
});
test('due scan isolates failures, rechecks concurrent terminal records and continues to later IDs', async () => {
  const { tx, m } = fixture();
  tx.projectMemberMovement.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
  const db = {
    ...tx,
    $transaction: vi
      .fn()
      .mockRejectedValueOnce(new Error('outbox'))
      .mockImplementationOnce(async (fn) => {
        m.status = 'WITHDRAWN';
        return fn(tx);
      })
      .mockImplementationOnce(async (fn) => {
        m.status = 'WAITING_EFFECTIVE';
        return fn(tx);
      }),
  };
  expect(await processDueMovements(db as never, now)).toEqual({
    effective: 1,
    skipped: 1,
    failed: 1,
  });
});

test('approver refresh can defer cards to enclosing owner transaction without suppressing approval event', async () => {
  const { m, tx } = fixture();
  m.status = 'PROCESSING';
  m.flow!.status = 'PENDING';
  vi.mocked(syncSnapshots).mockClear();
  expect(await refreshMovementApprovers(tx as never, 2, now, false)).toBe(1);
  expect(syncSnapshots).not.toHaveBeenCalled();
  expect(tx.projectRoleNodeSnapshot.deleteMany).not.toHaveBeenCalled();
  expect(tx.projectEventOutbox.create).toHaveBeenCalledOnce();
});
