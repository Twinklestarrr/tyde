import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  processMovement,
  respondTransfer,
  withdrawMovement,
  consumeTransferExam,
} from '../src/modules/personnel/personnel-transfer.js';
import { transferCandidate } from '../src/modules/personnel/personnel-transfer-exam.js';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
vi.mock('../src/modules/personnel/personnel-movement-create.js', () => ({
  movementTasks: vi.fn(async () => ({ scopes: [], sources: [] })),
  syncSnapshots: vi.fn(async () => {}),
  projectOwners: vi.fn(async () => [{ id: 'owner', uid: 'owner', status: 'ACTIVE' }]),
}));
const principal = (userId = 'member', role = 'EXPERT') =>
  ({ userId, uid: userId, role }) as AuthPrincipal;
const approvalMigration = readFileSync(
  new URL('../prisma/migrations/20261019030000_approvals/migration.sql', import.meta.url),
  'utf8',
);
const nodeStatusCheck = approvalMigration.match(
  /"ApprovalNode_status_check" CHECK \("nodeStatus" IN \(([^)]+)\)\)/,
)![1]!;
const validNodeStatuses = [...nodeStatusCheck.matchAll(/'([^']+)'/g)].map((m) => m[1]);
function checkNodeWrite(data: { nodeStatus?: string }) {
  if (data.nodeStatus)
    expect(validNodeStatuses, 'ApprovalNode_status_check').toContain(data.nodeStatus);
}
function fixture(code = 'MEMBER_CONFIRM') {
  const codes = ['MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM', 'TARGET_MANAGER'];
  const nodes = codes.map((code, i) => ({
    id: `node${i}`,
    flowId: 'flow',
    flowNo: 'TF1',
    nodeSeq: i + 1,
    nodeCode: code,
    nodeName: code,
    approverId: i === 2 ? 'manager' : 'member',
    nodeStatus: i === codes.indexOf(code) ? 'PENDING' : 'WAITING',
    versionNo: 0,
  }));
  for (const n of nodes) n.nodeStatus = n.nodeCode === code ? 'PENDING' : 'WAITING';
  const m = {
    id: 1,
    memberId: 1,
    userId: 'member',
    sourceProjectId: 1,
    targetProjectId: 2,
    movementType: 'TRANSFER',
    status: 'PROCESSING',
    initiatedBy: 'manager',
    flowId: 'flow',
    plannedEffectiveDate: new Date('2099-01-01'),
    targetExamAttemptId: 10,
    member: {
      id: 1,
      userId: 'member',
      status: 'PENDING_TRANSFER',
      organizationId: null,
      userOrgRelId: null,
      user: { id: 'member', uid: 'member', status: 'ACTIVE' },
      organizationMembership: null,
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
      deleted: false,
      status: 'PUBLISHED',
      currentNodeCode: 'PERSONNEL_MANAGEMENT',
    },
    flow: {
      id: 'flow',
      flowNo: 'TF1',
      status: 'PENDING',
      versionNo: 0,
      currentNode: codes.indexOf(code) + 1,
      currentNodeCode: code,
      totalNodes: 3,
      nodes,
    },
    targetExamAttempt: {
      id: 10,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: 1,
      candidateUserId: 'member',
      organizationId: null,
      userOrgRelId: null,
      exam: { projectId: 2 },
      finalResult: 'ADMITTED',
      finalDecidedAt: new Date(),
      submittedAt: new Date(),
      cancelledAt: null as Date | null,
    },
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    projectMemberMovement: {
      findUnique: vi.fn(async () => m),
      findUniqueOrThrow: vi.fn(async () => m),
      findMany: vi.fn(async () => [m]),
      update: vi.fn(async ({ data }) => Object.assign(m, data)),
    },
    project: {
      findFirst: vi.fn(async () => ({
        id: 1,
        deleted: false,
        status: 'PUBLISHED',
        currentNodeCode: 'PRODUCTION_TASK',
      })),
    },
    projectMember: {
      findMany: vi.fn(async () => [{ ...m.member, projectId: 1 }]),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    projectExpertAssignment: { findMany: vi.fn(async () => []) },
    projectManagerRecruitment: {
      findFirst: vi.fn(async () => ({
        candidateUserId: 'manager',
        candidate: { id: 'manager', status: 'ACTIVE' },
      })),
    },
    approvalFlow: { update: vi.fn(async ({ data }) => Object.assign(m.flow, data)) },
    approvalNode: {
      updateMany: vi.fn(async ({ data }) => {
        checkNodeWrite(data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => {
        checkNodeWrite(data);
        return {};
      }),
      create: vi.fn(async ({ data }) => {
        checkNodeWrite(data);
        return {};
      }),
    },
    approvalActionLog: { create: vi.fn(async () => ({})) },
    projectTaskRound: { findMany: vi.fn(async () => []) },
    projectRoleNodeSnapshot: { deleteMany: vi.fn(async () => ({})) },
    projectEventOutbox: { create: vi.fn(async () => ({})) },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const process = (patch = {}, p = principal('manager', 'PM')) =>
    processMovement(
      db as never,
      {
        projectId: 2,
        movementId: 1,
        flowNo: 'TF1',
        nodeId: nodes[m.flow.currentNode - 1]!.id,
        flowVersionNo: 0,
        nodeVersionNo: 0,
        action: 'APPROVE',
        ...patch,
      },
      p,
    );
  return { m, tx, db, process };
}
test('transfer activation, ANY sibling closure, rejection and withdrawal honor the persisted ApprovalNode status constraint', async () => {
  expect(validNodeStatuses).toContain('CANCELED');
  expect(validNodeStatuses).not.toContain('CANCELLED');
  for (const action of ['ACCEPT', 'REJECT', 'WITHDRAW'] as const) {
    const f = fixture();
    if (action === 'WITHDRAW')
      await withdrawMovement(
        f.db as never,
        { projectId: 1, movementId: 1 },
        principal('manager', 'PM'),
      );
    else
      await respondTransfer(
        f.db as never,
        { movementId: 1, decision: action, rejectReason: '拒绝' },
        principal(),
      );
    expect(
      f.tx.approvalNode.updateMany.mock.calls.some(
        ([input]) => input.data.nodeStatus === 'CANCELED',
      ),
    ).toBe(true);
  }
});
test('transfer confirmation only accepts the concrete member in EXPERT role and activates exam without creating target acceptance or admission', async () => {
  const f = fixture();
  for (const p of [principal('other'), principal('member', 'PM')])
    await expect(
      respondTransfer(f.db as never, { movementId: 1, decision: 'ACCEPT' }, p),
    ).rejects.toMatchObject({ status: 403 });
  const response = await respondTransfer(
    f.db as never,
    { movementId: 1, decision: 'ACCEPT' },
    principal(),
  );
  expect(response).toMatchObject({
    assignmentId: null,
    movementId: 1,
    status: 'ACCEPTED',
    nextAction: 'TAKE_ENTRANCE_EXAM',
  });
  expect(f.m.flow.currentNodeCode).toBe('TARGET_ENTRANCE_EXAM');
  expect(f.tx.projectMember.updateMany).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledTimes(2);
});
test('manual approval cannot consume either business wait even when caller is snapshotted approver', async () => {
  for (const code of ['MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM']) {
    const f = fixture(code);
    await expect(f.process({}, principal())).rejects.toMatchObject({ status: 400 });
    expect(f.tx.approvalNode.updateMany).not.toHaveBeenCalled();
  }
});
test('target manual approval requires final independent exam, current manager role, exact optimistic versions and nonblank rejection reason', async () => {
  for (const kind of ['manager', 'role', 'exam', 'flow', 'node', 'comment']) {
    const f = fixture('TARGET_MANAGER');
    if (kind === 'exam') f.m.targetExamAttempt.sourceBizId = 99;
    const patch =
      kind === 'flow'
        ? { flowVersionNo: 9 }
        : kind === 'node'
          ? { nodeVersionNo: 9 }
          : kind === 'comment'
            ? { action: 'REJECT', actionComment: ' ' }
            : {};
    await expect(
      f.process(
        patch,
        kind === 'manager'
          ? principal('other', 'PM')
          : kind === 'role'
            ? principal('manager')
            : principal('manager', 'PM'),
      ),
    ).rejects.toBeDefined();
    expect(f.tx.approvalNode.updateMany).not.toHaveBeenCalled();
  }
  const f = fixture('TARGET_MANAGER');
  await f.process();
  expect(f.m.status).toBe('WAITING_EFFECTIVE');
  expect(f.m.flow.status).toBe('APPROVED');
  expect(f.tx.projectMember.updateMany).not.toHaveBeenCalled();
});
test('member rejection, exam elimination and cancellation terminate flow and restore only the still pending source member', async () => {
  for (const kind of ['response', 'eliminated', 'cancelled']) {
    const f = fixture(kind === 'response' ? 'MEMBER_CONFIRM' : 'TARGET_ENTRANCE_EXAM');
    if (kind === 'response')
      await respondTransfer(
        f.db as never,
        { movementId: 1, decision: 'REJECT', rejectReason: '拒绝' },
        principal(),
      );
    else {
      if (kind === 'eliminated') f.m.targetExamAttempt.finalResult = 'ELIMINATED';
      else f.m.targetExamAttempt.cancelledAt = new Date();
      await consumeTransferExam(f.db as never, 1);
    }
    expect(f.m.status).toBe('REJECTED');
    expect(f.tx.projectMember.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'PENDING_TRANSFER' },
      data: {
        status: 'ACTIVE',
        plannedLeaveDate: null,
        updatedBy: kind === 'response' ? 'member' : 'SYSTEM',
      },
    });
    expect(f.m.flow.status).toBe('REJECTED');
  }
});
test('exam consumer ignores partial/repeated final delivery and refuses wrong source, candidate, project or organization', async () => {
  const incomplete = fixture('TARGET_ENTRANCE_EXAM');
  incomplete.m.targetExamAttempt.finalResult = 'PENDING';
  expect(await consumeTransferExam(incomplete.db as never, 1)).toBe(false);
  for (const patch of [
    { sourceBizId: 99 },
    { candidateUserId: 'other' },
    { organizationId: 'other' },
    { exam: { projectId: 99 } },
  ]) {
    const f = fixture('TARGET_ENTRANCE_EXAM');
    Object.assign(f.m.targetExamAttempt, patch);
    await expect(consumeTransferExam(f.db as never, 1)).rejects.toMatchObject({ status: 409 });
    expect(f.tx.approvalNode.updateMany).not.toHaveBeenCalled();
  }
  const f = fixture('TARGET_ENTRANCE_EXAM');
  expect(await consumeTransferExam(f.db as never, 1)).toBe(true);
  expect(f.m.flow.currentNodeCode).toBe('TARGET_MANAGER');
  expect(await consumeTransferExam(f.db as never, 1)).toBe(false);
  expect(f.tx.approvalActionLog.create).toHaveBeenCalledTimes(1);
});
test('withdrawal requires current source management and original initiator and refuses approved transfer', async () => {
  const f = fixture();
  await withdrawMovement(
    f.db as never,
    { projectId: 1, movementId: 1 },
    principal('manager', 'PM'),
  );
  expect(f.m.status).toBe('WITHDRAWN');
  expect(f.m.flow.status).toBe('WITHDRAWN');
  const approved = fixture();
  approved.m.status = 'WAITING_EFFECTIVE';
  await expect(
    withdrawMovement(
      approved.db as never,
      { projectId: 1, movementId: 1 },
      principal('manager', 'PM'),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const wrong = fixture();
  wrong.m.initiatedBy = 'other';
  await expect(
    withdrawMovement(
      wrong.db as never,
      { projectId: 1, movementId: 1 },
      principal('manager', 'PM'),
    ),
  ).rejects.toMatchObject({ status: 403 });
});
test('removal withdrawal uses Shanghai date and only restores still pending removal', async () => {
  for (const day of ['2026-10-27', '2026-10-28']) {
    const f = fixture();
    Object.assign(f.m, {
      movementType: 'REMOVAL',
      status: 'WAITING_EFFECTIVE',
      flowId: null,
      flow: null,
      targetProjectId: null,
      plannedEffectiveDate: new Date(day),
    });
    const action = withdrawMovement(
      f.db as never,
      { projectId: 1, movementId: 1 },
      principal('manager', 'PM'),
      new Date('2026-10-26T16:00:00Z'),
    );
    if (day === '2026-10-27') await expect(action).rejects.toMatchObject({ status: 409 });
    else {
      await action;
      expect(f.m.status).toBe('WITHDRAWN');
      expect(f.tx.projectMember.updateMany).toHaveBeenCalledWith({
        where: { id: 1, status: 'PENDING_EXIT' },
        data: { status: 'ACTIVE', plannedLeaveDate: null, updatedBy: 'manager' },
      });
    }
  }
});
test('transfer candidate never borrows another organization and only resolves exact target exam stage', async () => {
  const f = fixture('TARGET_ENTRANCE_EXAM');
  expect(await transferCandidate(f.tx as never, 2, 'member')).toMatchObject({
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    sourceBizId: 1,
    organizationId: null,
  });
  f.m.flow.currentNodeCode = 'MEMBER_CONFIRM';
  await expect(transferCandidate(f.tx as never, 2, 'member')).rejects.toMatchObject({
    status: 409,
  });
  Object.assign(f.m.member, {
    organizationId: 'org',
    organization: { deleted: false },
    organizationMembership: { orgId: 'org', userId: 'member', joinStatus: 'EXIT_APPROVING' },
  });
  expect(await transferCandidate(f.tx as never, 2, 'member', true)).toMatchObject({
    organizationId: 'org',
  });
  Object.assign(f.m.member, {
    organizationMembership: { orgId: 'org', userId: 'member', joinStatus: 'LEFT' },
  });
  await expect(transferCandidate(f.tx as never, 2, 'member', true)).rejects.toMatchObject({
    status: 403,
  });
});

test('movement process and withdrawal Swagger examples validate every field and real HTTP serializes null success', async () => {
  const { createApp } = await import('../src/application.js');
  const { readConfig } = await import('../src/config/index.js');
  const { AuthService } = await import('../src/modules/auth/auth.service.js');
  const { PersonnelMovementService } =
    await import('../src/modules/personnel/personnel-movement.service.js');
  const { movementProcessBody, movementWithdrawBody, movementCommandResponse } =
    await import('../src/modules/personnel/personnel-movement.schema.js');
  const { PrismaClient } = await import('@prisma/client');
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal('manager', 'PM'));
  vi.spyOn(PersonnelMovementService.prototype, 'process').mockResolvedValue(null);
  vi.spyOn(PersonnelMovementService.prototype, 'withdraw').mockResolvedValue(null);
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    await app.ready();
    for (const schema of [movementProcessBody, movementWithdrawBody, movementCommandResponse]) {
      expect(schema.description).toEqual(expect.any(String));
      for (const property of Object.values('properties' in schema ? schema.properties : {}))
        expect(property.description).toEqual(expect.any(String));
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [name, body] of [
      ['process', movementProcessBody],
      ['withdraw', movementWithdrawBody],
    ] as const) {
      const request = (payload: unknown) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/project-personnel/movements/${name}`,
          headers: { authorization: 'Bearer token' },
          payload,
        });
      const result = await request(body.examples[0]);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ code: 200, message: '操作成功', data: null });
      expect(result.headers['cache-control']).toBe('no-store');
      expect((await request({ ...body.examples[0], projectId: '1' })).statusCode).toBe(400);
    }
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/movements/process',
      headers: { authorization: 'Bearer token' },
      payload: { ...movementProcessBody.examples[0], nodeVersionNo: -1 },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});
