import { beforeEach, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ExpertAssignmentService } from '../src/modules/expert/expert-assignment.service.js';
const examTask = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/expert/expert-exam-task.js', () => ({ ordinaryExamTask: examTask }));
const output = vi.hoisted(() => vi.fn());
const daily = vi.hoisted(() => vi.fn());
const reporting = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/expert/expert-report-capability.js', () => ({
  canReportExpertOutput: reporting,
  hasReportedExpertOutputToday: daily,
}));
vi.mock('../src/modules/expert/expert-output-task.js', () => ({ expertOutputTask: output }));
beforeEach(() => {
  examTask.mockReset().mockResolvedValue(null);
  daily.mockReset().mockResolvedValue(false);
  output.mockReset().mockResolvedValue(null);
  reporting.mockReset().mockResolvedValue(false);
});
const principal = { userId: 'user', uid: 'uid', role: 'EXPERT' } as AuthPrincipal;
function fixture() {
  const project = {
    id: 10,
    createdBy: 'creator',
    projectName: '项目',
    projectDescription: null,
    requesterType: 'ORGANIZATION',
    requesterName: '历史需求方',
    requester: {},
    productionPlan: { needWrittenExam: false },
    categories: [],
    deadline: null,
    currentNodeCode: 'PERSONNEL_MANAGEMENT',
  };
  const row = {
    id: 1,
    projectId: 10,
    project,
    subjectType: 'INDIVIDUAL',
    status: 'PENDING_ACCEPTANCE',
    organizationId: null as string | null,
    organization: null,
    owners: [] as {
      status: string;
      user: {
        id: string;
        uid: string;
        displayName: string;
        realName: string | null;
        avatarUrl: string | null;
      };
    }[],
    legacyOwner: null as {
      id: string;
      uid: string;
      displayName: string;
      realName: string | null;
      avatarUrl: string | null;
    } | null,
    memberResponses: [] as { status: string }[],
    createdAt: new Date('2026-10-22T10:00:00Z'),
    productionRequirement: null,
    operatorHeadcount: null,
    inspectorHeadcount: null,
  };
  const delegate = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  const tx = {
    projectMemberMovement: { findMany: vi.fn().mockResolvedValue([]) },
    userOrgRel: delegate(),
    projectExpertAssignment: delegate(),
    projectMember: delegate(),
    entranceExamAttempt: delegate(),
    projectEntranceExam: delegate(),
    projectManagerRecruitment: delegate(),
    user: delegate(),
  };
  tx.projectExpertAssignment.findMany.mockResolvedValue([row]);
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  return {
    row,
    project,
    tx,
    db,
    service: new ExpertAssignmentService(db as unknown as PrismaClient),
  };
}
test('expert tasks reject wrong roles, oversized keywords, invalid enums and conflicting aliases before reading', async () => {
  const f = fixture();
  await expect(f.service.myTasks({}, { ...principal, role: 'PM' })).rejects.toMatchObject({
    status: 403,
  });
  for (const query of [
    { keyword: 'x'.repeat(101) },
    { status: 'bogus' },
    { acceptanceStatus: 'ACCEPTED', status: 'REJECTED' },
  ])
    await expect(f.service.myTasks(query, principal)).rejects.toMatchObject({ status: 400 });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
test('expert tasks retain pending main node, alias filtering and unimplemented operation boundaries', async () => {
  const f = fixture();
  const cards = await f.service.myTasks(
    { status: 'PENDING_ACCEPTANCE', keyword: ' 历史 ' },
    principal,
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    currentNodeCode: 'PERSONNEL_MANAGEMENT',
    branchNodeCode: null,
    acceptanceStatus: 'PENDING_ACCEPTANCE',
    operations: { canAccept: true, canReject: true, canReportOutput: false },
  });
  expect(f.tx.projectExpertAssignment.findMany.mock.calls[0][0].where.project.OR).toEqual([
    { projectName: { contains: '历史' } },
    { requesterName: { contains: '历史' } },
  ]);
  expect(await f.service.myTasks({ acceptanceStatus: 'ACCEPTED' }, principal)).toEqual([]);
  f.project.currentNodeCode = 'COMPLETED';
  expect(await f.service.myTasks({}, principal)).toEqual([]);
});
test('expert tasks use latest member fact and never revive prior training for exited or not joined members', async () => {
  const f = fixture();
  f.row.status = 'ACCEPTED';
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  f.project.productionPlan.needWrittenExam = true;
  examTask.mockResolvedValue({ assignmentId: 1, examId: 9 });
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('ENTRANCE_EXAM');
  examTask.mockResolvedValue(null);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  const current = {
    projectId: 10,
    status: 'ACTIVE',
    entryDecision: 'YES',
    joinedAt: new Date(),
    standardTrainingConfirmedAt: null as Date | null,
  };
  f.tx.projectMember.findMany.mockResolvedValue([current]);
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('STANDARD_TRAINING');
  current.standardTrainingConfirmedAt = new Date();
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('PRODUCTION_TASK');
  current.status = 'EXITED';
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  current.status = 'ACTIVE';
  current.entryDecision = 'NO';
  expect(await f.service.myTasks({}, principal)).toEqual([]);
});
test('expert tasks organization participation suppresses personal identity until member rejects', async () => {
  const f = fixture();
  f.tx.userOrgRel.findMany.mockResolvedValue([{ orgId: 'org', position: 'MEMBER' }]);
  const org = {
    ...f.row,
    id: 2,
    subjectType: 'ORGANIZATION',
    status: 'ACCEPTED',
    organizationId: 'org',
    memberResponses: [] as { status: string }[],
  };
  f.tx.projectExpertAssignment.findMany.mockResolvedValue([org, f.row]);
  expect((await f.service.myTasks({}, principal)).map((c) => c.assignmentId)).toEqual([2]);
  org.memberResponses = [{ status: 'REJECTED' }];
  expect((await f.service.myTasks({}, principal)).map((c) => c.assignmentId)).toEqual([1]);
});
test('expert tasks owner history blocks legacy fallback and owner exam expires without stale branch', async () => {
  const f = fixture();
  f.row.subjectType = 'ORGANIZATION';
  f.row.status = 'ACCEPTED';
  f.row.organizationId = 'org';
  f.tx.userOrgRel.findMany.mockResolvedValue([{ orgId: 'org', position: 'MEMBER' }]);
  f.row.legacyOwner = {
    id: 'user',
    uid: 'uid',
    displayName: '昵称',
    realName: null,
    avatarUrl: null,
  };
  expect((await f.service.myTasks({}, principal))[0].accessContext.projectOwner).toBe(true);
  f.row.owners = [
    {
      status: 'REMOVED',
      user: { id: 'user', uid: 'uid', displayName: '昵称', realName: null, avatarUrl: null },
    },
  ];
  expect((await f.service.myTasks({}, principal))[0]).toMatchObject({
    acceptanceStatus: 'PENDING_ACCEPTANCE',
    accessContext: { projectOwner: false },
  });
  f.row.owners[0].status = 'ACTIVE';
  f.project.productionPlan.needWrittenExam = true;
  f.tx.projectEntranceExam.findMany.mockResolvedValue([{ projectId: 10 }]);
  examTask.mockResolvedValue({ assignmentId: 1, examId: 9 });
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('ENTRANCE_EXAM');
  examTask.mockResolvedValue(null);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  f.tx.projectEntranceExam.findMany.mockResolvedValue([]);
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe(null);
});

test('expert tasks restore live report review for organization owners and keep accepted filters', async () => {
  const f = fixture();
  f.row.subjectType = 'ORGANIZATION';
  f.row.organizationId = 'org';
  f.row.status = 'ACCEPTED';
  f.tx.userOrgRel.findMany.mockResolvedValue([{ orgId: 'org', position: 'OWNER' }]);
  output.mockResolvedValue('OUTPUT_DATA_REVIEW');
  const cards = await f.service.myTasks({ status: 'ACCEPTED' }, principal);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    branchNodeCode: 'OUTPUT_DATA_REVIEW',
    accessContext: { acceptedOrganizationOwner: true, canViewOrganizationData: true },
  });
  expect(output).toHaveBeenLastCalledWith(f.tx, 10, 'org', principal, expect.any(Date));
  output.mockResolvedValue(null);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
});
test('expert tasks restore correction without an active member but never grant accept or reporting operations', async () => {
  const f = fixture();
  f.row.status = 'ACCEPTED';
  output.mockResolvedValue('PRODUCTION_TASK');
  expect((await f.service.myTasks({}, principal))[0]).toMatchObject({
    branchNodeCode: 'PRODUCTION_TASK',
    operations: { canAccept: false, canReject: false, canReportOutput: false },
  });
  f.row.status = 'PENDING_ACCEPTANCE';
  output.mockClear();
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe(null);
  expect(output).not.toHaveBeenCalled();
});

test('expert report button follows live capability only in accepted production, preserving training and review priority', async () => {
  const f = fixture();
  reporting.mockResolvedValue(true);
  f.row.status = 'ACCEPTED';
  output.mockResolvedValue('PRODUCTION_TASK');
  expect((await f.service.myTasks({}, principal))[0].operations.canReportOutput).toBe(true);
  expect(reporting).toHaveBeenLastCalledWith(f.tx, 10, null, principal, expect.any(Date));
  reporting.mockResolvedValue(false);
  expect((await f.service.myTasks({}, principal))[0].operations.canReportOutput).toBe(false);
  reporting.mockResolvedValue(true);
  for (const branch of ['OUTPUT_DATA_REVIEW', 'STANDARD_TRAINING']) {
    reporting.mockClear();
    if (branch === 'OUTPUT_DATA_REVIEW') output.mockResolvedValue(branch);
    else {
      output.mockResolvedValue('PRODUCTION_TASK');
      f.tx.projectMember.findMany.mockResolvedValue([
        {
          projectId: 10,
          status: 'ACTIVE',
          entryDecision: 'YES',
          joinedAt: new Date(),
          standardTrainingConfirmedAt: null,
        },
      ]);
    }
    expect((await f.service.myTasks({}, principal))[0].operations.canReportOutput).toBe(false);
    expect(reporting).not.toHaveBeenCalled();
  }
});

test('daily reporting hides only ordinary production cards, retaining training, review, correction and pending acceptance', async () => {
  const f = fixture();
  f.row.status = 'ACCEPTED';
  const member = {
    projectId: 10,
    status: 'ACTIVE',
    entryDecision: 'YES',
    joinedAt: new Date(),
    standardTrainingConfirmedAt: new Date() as Date | null,
  };
  f.tx.projectMember.findMany.mockResolvedValue([member]);
  daily.mockResolvedValue(true);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  expect(daily).toHaveBeenLastCalledWith(f.tx, 10, 'user', expect.any(Date));
  for (const branch of ['OUTPUT_DATA_REVIEW', 'PRODUCTION_TASK']) {
    output.mockResolvedValue(branch);
    expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe(branch);
  }
  output.mockResolvedValue(null);
  member.standardTrainingConfirmedAt = null;
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('STANDARD_TRAINING');
  f.row.status = 'PENDING_ACCEPTANCE';
  expect((await f.service.myTasks({}, principal))[0].operations.canAccept).toBe(true);
  f.row.status = 'ACCEPTED';
  member.standardTrainingConfirmedAt = new Date();
  daily.mockResolvedValue(false);
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('PRODUCTION_TASK');
  daily.mockRejectedValue(new Error('daily source unavailable'));
  await expect(f.service.myTasks({}, principal)).rejects.toThrow('daily source unavailable');
});

test('ordinary exam cards require a live source for the same assignment and preserve bound exams after closure', async () => {
  const f = fixture();
  f.row.status = 'ACCEPTED';
  f.project.productionPlan.needWrittenExam = true;
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  examTask.mockResolvedValue({ assignmentId: 2, examId: 9 });
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  examTask.mockResolvedValue({ assignmentId: 1, examId: 9 });
  expect(await f.service.myTasks({}, principal)).toMatchObject([
    { branchNodeCode: 'ENTRANCE_EXAM' },
  ]);
  expect(examTask).toHaveBeenLastCalledWith(f.tx, 10, 'user', expect.any(Date));
  expect(f.tx.projectEntranceExam.findMany).toHaveResolvedWith([]);
});
