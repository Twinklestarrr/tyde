import { beforeEach, expect, test, vi } from 'vitest';
import { queryTransferTasks } from '../src/modules/expert/expert-transfer-query.js';
import {
  qualifiedForEntry,
  type PersonnelMember,
} from '../src/modules/personnel/personnel-access.js';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
const daily = vi.hoisted(() => vi.fn());
const reporting = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/expert/expert-report-capability.js', () => ({
  canReportExpertOutput: reporting,
  hasReportedExpertOutputToday: daily,
}));
const output = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/expert/expert-output-task.js', () => ({ expertOutputTask: output }));
beforeEach(() => {
  reporting.mockReset().mockResolvedValue(false);
  daily.mockReset().mockResolvedValue(false);
  output.mockReset().mockResolvedValue(null);
});
const p = { userId: 'member', uid: 'member', role: 'EXPERT' } as AuthPrincipal;
function fixture() {
  const m = {
    id: 7,
    userId: 'member',
    sourceProjectId: 1,
    targetProjectId: 2,
    movementType: 'TRANSFER',
    status: 'PROCESSING',
    createdAt: new Date('2026-10-26T00:00:00Z'),
    targetExamAttemptId: 10,
    member: {
      status: 'PENDING_TRANSFER',
      userId: 'member',
      organizationId: null,
      userOrgRelId: null,
      user: { id: 'member', status: 'ACTIVE' },
      expertAssignment: {
        status: 'ACCEPTED',
        projectId: 1,
        subjectType: 'INDIVIDUAL',
        expertUserId: 'member',
      },
    },
    targetProject: {
      id: 2,
      status: 'PUBLISHED',
      deleted: false,
      currentNodeCode: 'PERSONNEL_MANAGEMENT',
      requesterType: 'ORGANIZATION',
      requesterName: '需求方',
      projectName: '目标',
      requester: {},
      createdBy: 'creator',
      categories: [],
      deadline: null,
    },
    targetExamAttempt: null as { submittedAt: Date } | null,
    flow: {
      status: 'PENDING',
      currentNode: 1,
      currentNodeCode: 'MEMBER_CONFIRM',
      nodes: [
        { nodeSeq: 1, nodeCode: 'MEMBER_CONFIRM', approverId: 'member', nodeStatus: 'PENDING' },
      ],
    },
  };
  const tx = {
    projectMemberMovement: { findMany: vi.fn().mockResolvedValue([m]) },
    entranceExamAttempt: { findMany: vi.fn().mockResolvedValue([]) },
    projectEntranceExam: {
      findFirst: vi.fn().mockResolvedValue({ id: 1, currentVersion: { examId: 1 } }),
    },
    project: { findFirst: vi.fn().mockResolvedValue({ currentNodeCode: 'PRODUCTION_TASK' }) },
    projectMember: { findFirst: vi.fn().mockResolvedValue(null) },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const read = (query = {}) => queryTransferTasks(tx as never, query, p);
  return { m, tx, read };
}
function admitted() {
  return {
    id: 9,
    projectId: 2,
    userId: 'member',
    expertAssignmentId: null,
    organizationId: null,
    userOrgRelId: null,
    admittedAt: new Date(),
    joinedAt: new Date(),
    status: 'ACTIVE',
    user: { status: 'ACTIVE' },
    expertAssignment: null,
    admissionAttempt: {
      id: 10,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: 7,
      candidateUserId: 'member',
      organizationId: null,
      userOrgRelId: null,
      finalResult: 'ADMITTED',
      cancelledAt: null,
      exam: { projectId: 2 },
      transferMovement: {
        id: 7,
        userId: 'member',
        targetProjectId: 2,
        targetExamAttemptId: 10,
        status: 'EFFECTIVE',
        flow: { status: 'APPROVED' },
      },
    },
  } as unknown as PersonnelMember;
}
test('transfer cards retain real movement identity and exact confirmation/exam stages, filters and submitted withdrawal', async () => {
  const f = fixture();
  expect(await f.read()).toMatchObject([
    {
      assignmentId: null,
      movementId: 7,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: 7,
      acceptanceStatus: 'PENDING_ACCEPTANCE',
      operations: { canAccept: true, canReject: true },
    },
  ]);
  expect(await f.read({ status: 'ACCEPTED' })).toEqual([]);
  f.m.flow.currentNodeCode = 'TARGET_ENTRANCE_EXAM';
  f.m.flow.nodes[0]!.nodeCode = 'TARGET_ENTRANCE_EXAM';
  expect(await f.read()).toMatchObject([
    {
      branchNodeCode: 'ENTRANCE_EXAM',
      needWrittenExam: true,
      operations: { canAccept: false, canReject: false },
    },
  ]);
  f.m.targetExamAttempt = { submittedAt: new Date() };
  expect(await f.read()).toEqual([]);
});
test('transfer reads revoke stale pending node, lost source, completed target and conflicting target member access', async () => {
  const f = fixture();
  f.m.flow.nodes[0]!.approverId = 'other';
  expect(await f.read()).toEqual([]);
  f.m.flow.nodes[0]!.approverId = 'member';
  f.m.member.user.status = 'DISABLED';
  expect(await f.read()).toEqual([]);
  f.m.member.user.status = 'ACTIVE';
  f.tx.projectMember.findFirst.mockResolvedValue({ id: 999 });
  expect(await f.read()).toEqual([]);
  f.tx.projectMember.findFirst.mockResolvedValue(null);
  f.m.targetProject.currentNodeCode = 'COMPLETED';
  expect(await f.read()).toEqual([]);
});
test('effective personal transfer grants qualification only for exact approved movement and admitted attempt', () => {
  const m = admitted();
  expect(qualifiedForEntry(m, true)).toBe(true);
  for (const patch of [
    { finalResult: 'ELIMINATED' },
    { candidateUserId: 'other' },
    { sourceBizId: 8 },
    { organizationId: 'other' },
    { cancelledAt: new Date() },
  ])
    expect(
      qualifiedForEntry({ ...m, admissionAttempt: { ...m.admissionAttempt!, ...patch } }, false),
    ).toBe(false);
  for (const patch of [
    { status: 'WAITING_EFFECTIVE' },
    { targetProjectId: 3 },
    { targetExamAttemptId: 11 },
    { flow: { status: 'PENDING' } },
  ])
    expect(
      qualifiedForEntry(
        {
          ...m,
          admissionAttempt: {
            ...m.admissionAttempt!,
            transferMovement: { ...m.admissionAttempt!.transferMovement!, ...patch },
          },
        } as PersonnelMember,
        false,
      ),
    ).toBe(false);
});
test('effective transfer card follows current target member and disappears after departure without assignment fabrication', async () => {
  const f = fixture(),
    member = admitted();
  f.m.status = 'EFFECTIVE';
  f.tx.projectMember.findFirst.mockResolvedValue(member);
  expect(await f.read()).toMatchObject([
    { assignmentId: null, movementId: 7, branchNodeCode: 'STANDARD_TRAINING' },
  ]);
  expect(reporting).not.toHaveBeenCalled();
  reporting.mockResolvedValue(true);
  member.standardTrainingConfirmedAt = new Date();
  expect(await f.read()).toMatchObject([
    { branchNodeCode: 'PRODUCTION_TASK', operations: { canReportOutput: true } },
  ]);
  reporting.mockResolvedValue(false);
  expect(await f.read()).toMatchObject([{ operations: { canReportOutput: false } }]);
  member.status = 'LEFT';
  expect(await f.read()).toEqual([]);
});

test('effective transfer hides reported production and restores it next day while keeping real review, correction and independent training', async () => {
  const f = fixture(),
    member = admitted();
  f.m.status = 'EFFECTIVE';
  member.standardTrainingConfirmedAt = new Date();
  f.tx.projectMember.findFirst.mockResolvedValue(member);
  daily.mockResolvedValue(true);
  expect(await f.read()).toEqual([]);
  expect(daily).toHaveBeenLastCalledWith(f.tx, 2, 'member', expect.any(Date));
  output.mockResolvedValue('OUTPUT_DATA_REVIEW');
  expect(await f.read()).toMatchObject([
    { branchNodeCode: 'OUTPUT_DATA_REVIEW', operations: { canReportOutput: false } },
  ]);
  expect(output).toHaveBeenLastCalledWith(f.tx, 2, null, p, expect.any(Date));
  output.mockResolvedValue('PRODUCTION_TASK');
  expect(await f.read()).toMatchObject([{ branchNodeCode: 'PRODUCTION_TASK' }]);
  member.standardTrainingConfirmedAt = null;
  expect(await f.read()).toMatchObject([{ branchNodeCode: 'STANDARD_TRAINING' }]);
  output.mockResolvedValue(null);
  member.standardTrainingConfirmedAt = new Date();
  daily.mockResolvedValue(false);
  expect(await f.read()).toMatchObject([{ branchNodeCode: 'PRODUCTION_TASK' }]);
  output.mockRejectedValue(new Error('report source unavailable'));
  await expect(f.read()).rejects.toThrow('report source unavailable');
});
