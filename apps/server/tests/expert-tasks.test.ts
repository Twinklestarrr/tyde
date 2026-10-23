import { expect, test, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ExpertAssignmentService } from '../src/modules/expert/expert-assignment.service.js';
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
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('ENTRANCE_EXAM');
  expect(f.tx.entranceExamAttempt.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ submittedAt: { not: null } }, { cancelledAt: { not: null } }],
      }),
    }),
  );
  f.tx.entranceExamAttempt.findMany.mockResolvedValue([
    { cancelledAt: new Date(), exam: { projectId: 10 } },
  ]);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  f.tx.entranceExamAttempt.findMany.mockResolvedValue([{ exam: { projectId: 10 } }]);
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
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe('ENTRANCE_EXAM');
  f.tx.entranceExamAttempt.findMany.mockResolvedValue([{ exam: { projectId: 10 } }]);
  expect(await f.service.myTasks({}, principal)).toEqual([]);
  f.tx.projectEntranceExam.findMany.mockResolvedValue([]);
  expect((await f.service.myTasks({}, principal))[0].branchNodeCode).toBe(null);
});
