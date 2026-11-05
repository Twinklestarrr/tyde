import {
  PrismaClient,
  type ApprovalFlow,
  type OrgMemberSchedule,
  type Prisma,
} from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import {
  assertDailySnapshot,
  newDailyAutoStatus,
  readAttendanceForm,
  validateApplication,
  validateLeaveSchedule,
  type AttendanceApplyInput,
} from '../../src/modules/attendance/attendance-application.domain.js';
import {
  attendanceApplicationBody,
  attendanceApplicationExample,
  attendanceApplicationResponse,
  attendanceProcessExample,
  attendanceWithdrawBody,
} from '../../src/modules/attendance/attendance-application.schema.js';
import { AttendanceApplicationService } from '../../src/modules/attendance/attendance-application.service.js';
import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { pendingResponse } from '../../src/modules/organizations/approval.schema.js';
import { OrganizationApprovalService } from '../../src/modules/organizations/organization-approval.service.js';
const orgId = '00000000-0000-4000-8000-000000000002';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'test-user',
  sessionId: 'session',
  role: 'EXPERT',
  clientType: 'desktop',
};
const input: AttendanceApplyInput = {
  orgId,
  attendanceDate: '2020-01-01',
  applicationType: 'CORRECTION',
  finalStatus: 'PRESENT',
  reason: '正常出勤补充说明',
  versionNo: null,
};
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});
afterEach(() => vi.restoreAllMocks());
test('application rejects future correction, invalid types/statuses, missing versions and invalid leave periods', () => {
  expect(() => validateApplication(input, '2026-10-21')).not.toThrow();
  for (const change of [
    { attendanceDate: '2026-02-30' },
    { attendanceDate: '2099-01-01' },
    { reason: '  ' },
    { versionNo: undefined },
    { versionNo: -1 },
    { applicationType: 'UNKNOWN' },
    { finalStatus: 'LEAVE' },
    { finalStatus: 'UNSCHEDULED' },
    { leaveStartAt: '2020-01-01 09:00:00' },
  ])
    expect(() =>
      validateApplication({ ...input, ...change } as AttendanceApplyInput, '2026-10-21'),
    ).toThrow();
  const leave = {
    ...input,
    applicationType: 'LEAVE' as const,
    finalStatus: 'LEAVE',
    leaveStartAt: '2020-01-01 09:00:00',
    leaveEndAt: '2020-01-01 12:00:00',
  };
  expect(() => validateApplication(leave, '2026-10-21')).not.toThrow();
  for (const change of [
    { finalStatus: 'PRESENT' },
    { leaveEndAt: undefined },
    { leaveEndAt: '2020-01-02 12:00:00' },
    { leaveEndAt: '2020-01-01 08:00:00' },
    { leaveStartAt: '2020-01-01 25:00:00' },
  ])
    expect(() => validateApplication({ ...leave, ...change }, '2026-10-21')).toThrow();
});
test('leave uses active work shift bounds and never fabricates a future automatic absence', () => {
  const schedule = {
    id: 1,
    status: 'ACTIVE',
    dayType: 'WORK',
    shiftStartAt: new Date('2099-01-01T09:00:00Z'),
    shiftEndAt: new Date('2099-01-01T18:00:00Z'),
  } as OrgMemberSchedule;
  const leave: AttendanceApplyInput = {
    ...input,
    applicationType: 'LEAVE',
    finalStatus: 'LEAVE',
    attendanceDate: '2099-01-01',
    leaveStartAt: '2099-01-01 09:00:00',
    leaveEndAt: '2099-01-01 18:00:00',
  };
  expect(() => validateLeaveSchedule(leave, schedule)).not.toThrow();
  for (const bad of [null, { ...schedule, dayType: 'REST' }, { ...schedule, status: 'CANCELED' }])
    expect(() => validateLeaveSchedule(leave, bad)).toThrow();
  expect(() =>
    validateLeaveSchedule({ ...leave, leaveStartAt: '2099-01-01 08:00:00' }, schedule),
  ).toThrow();
  expect(newDailyAutoStatus('2099-01-01', '2026-10-21', schedule)).toBeNull();
  expect(newDailyAutoStatus('2099-01-01', '2099-01-02', schedule)).toBe('ABSENT');
});
function fixture() {
  const user = {
    id: principal.userId,
    displayName: '成员',
    realName: '小明',
    uid: principal.uid,
    status: 'ACTIVE',
  };
  const rel = {
    id: '00000000-0000-4000-8000-000000000005',
    orgId,
    userId: user.id,
    position: 'MEMBER',
    joinStatus: 'ACTIVE',
    user,
  };
  const schedule = {
    id: 7,
    versionNo: 2,
    status: 'ACTIVE',
    dayType: 'WORK',
    timezone: 'Asia/Shanghai',
    shiftStartAt: new Date('2020-01-01T09:00:00Z'),
    shiftEndAt: new Date('2020-01-01T18:00:00Z'),
  };
  const tx = {
    $queryRaw: vi.fn(),
    organization: { findFirst: vi.fn().mockResolvedValue({ id: orgId, name: '组织' }) },
    userOrgRel: {
      findUnique: vi.fn().mockResolvedValue(rel),
      findFirst: vi.fn().mockResolvedValue({
        ...rel,
        userId: 'owner-id',
        uid: 'owner',
        user: { displayName: '主管', realName: '李四', uid: 'owner' },
      }),
    },
    orgMemberSchedule: { findUnique: vi.fn().mockResolvedValue(schedule) },
    orgAttendanceDaily: { findUnique: vi.fn().mockResolvedValue(null) },
    approvalFlow: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: attendanceApplicationExample.applicationId,
        versionNo: 0,
        finishedAt: null,
        ...data,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approvalNode: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approvalActionLog: { create: vi.fn() },
  };
  const db = {
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { tx, rel, schedule, service: new AttendanceApplicationService(db) };
}
test('apply captures server membership/shift versions, creates real owner node/log, and never modifies attendance', async () => {
  const f = fixture();
  const result = await f.service.apply(input, principal);
  expect(result).toMatchObject({
    status: 'PENDING',
    versionNo: null,
    flowVersionNo: 0,
    applicationType: 'CORRECTION',
  });
  expect(f.tx.approvalFlow.create.mock.calls[0]![0].data.formData).toMatchObject({
    scheduleId: 7,
    scheduleVersionNo: 2,
    targetMemberId: f.rel.id,
    dailyId: null,
  });
  expect(f.tx.approvalNode.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ approverId: 'owner-id', nodeStatus: 'PENDING' }),
  });
  expect(f.tx.approvalActionLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ actionType: 'SUBMIT' }),
  });
  expect(f.tx.orgAttendanceDaily.findUnique).toHaveBeenCalledTimes(1);
  const queries = f.tx.$queryRaw.mock.calls.map((args) => args[0].join('?'));
  expect(queries[0]).toContain('Organization');
  expect(queries[1]).toContain('OrgMemberSchedule');
  expect(queries[2]).toContain('OrgAttendanceDaily');
});
test('pending duplicate, supervisor self-submit, stale day and no approver cannot create flows', async () => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) =>
      f.tx.approvalFlow.findFirst.mockResolvedValue({ id: 'existing' }),
    (f: ReturnType<typeof fixture>) =>
      f.tx.userOrgRel.findUnique.mockResolvedValue({ ...f.rel, position: 'OWNER' }),
    (f: ReturnType<typeof fixture>) =>
      f.tx.orgAttendanceDaily.findUnique.mockResolvedValue({ id: 1, versionNo: 0 }),
    (f: ReturnType<typeof fixture>) => f.tx.userOrgRel.findFirst.mockResolvedValue(null),
  ]) {
    const f = fixture();
    setup(f);
    await expect(f.service.apply(input, principal)).rejects.toMatchObject({
      status: expect.any(Number),
    });
    expect(f.tx.approvalFlow.create).not.toHaveBeenCalled();
  }
});
test('withdraw only owns pending attendance flows, checks node state, and rejects other business types', async () => {
  const f = fixture();
  await f.service.apply(input, principal);
  const flow = {
    id: attendanceApplicationExample.applicationId,
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    versionNo: 0,
    finishedAt: null,
  };
  f.tx.approvalFlow.findUnique.mockResolvedValue(flow);
  f.tx.approvalNode.findMany.mockResolvedValue([
    { id: 'node', versionNo: 0, nodeStatus: 'PENDING' },
  ]);
  const value = { applicationId: flow.id, flowVersionNo: 0 };
  expect(await f.service.withdraw(value, principal)).toMatchObject({
    status: 'WITHDRAWN',
    flowVersionNo: 1,
  });
  expect(f.tx.approvalNode.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ nodeStatus: 'CANCELED' }) }),
  );
  for (const changes of [
    { applicantId: 'other-user' },
    { status: 'APPROVED' },
    { businessType: 'ORG_MEMBER_EXIT' },
    { versionNo: 1 },
  ]) {
    f.tx.approvalFlow.findUnique.mockResolvedValue({ ...flow, ...changes });
    await expect(f.service.withdraw(value, principal)).rejects.toMatchObject({
      status: expect.any(Number),
    });
  }
});
test('persisted forms cannot redirect the target date, applicant, business type or snapshot relation', async () => {
  const f = fixture();
  await f.service.apply(input, principal);
  const flow = {
    id: attendanceApplicationExample.applicationId,
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    versionNo: 0,
    finishedAt: null,
  } as ApprovalFlow;
  expect(readAttendanceForm(flow).attendanceDate).toBe('2020-01-01');
  for (const change of [
    { attendanceDate: '2020-01-02' },
    { targetMemberId: 'injected' },
    { schemaVersion: 2 },
    { applicationType: 'LEAVE' },
    { reason: 'different' },
    { versionNo: 0 },
  ])
    await expect(async () =>
      readAttendanceForm({
        ...flow,
        formData: { ...(flow.formData as Prisma.JsonObject), ...change },
      }),
    ).rejects.toMatchObject({ status: 500 });
  expect(() =>
    assertDailySnapshot({ id: 1, versionNo: 1 } as never, { ...input, dailyId: 1, versionNo: 0 }),
  ).toThrow();
});
test('approval handler denies self-approval before writing daily facts', async () => {
  const f = fixture();
  await f.service.apply(input, principal);
  const flow = {
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    applicantId: principal.userId,
  } as ApprovalFlow;
  await expect(
    f.service.process({} as Prisma.TransactionClient, flow, {} as never, {} as never, principal),
  ).rejects.toMatchObject({ status: 403 });
});
test('new schemas/examples and HTTP preserve claim/withdraw/version fields and existing approval envelope', async () => {
  const app = await createApp(config, new PrismaClient());
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const apply = vi
    .spyOn(AttendanceApplicationService.prototype, 'apply')
    .mockResolvedValue(attendanceApplicationExample as never);
  vi.spyOn(AttendanceApplicationService.prototype, 'withdraw').mockResolvedValue({
    ...attendanceApplicationExample,
    status: 'WITHDRAWN',
    flowVersionNo: 1,
  } as never);
  vi.spyOn(OrganizationApprovalService.prototype, 'process').mockResolvedValue(
    attendanceProcessExample as never,
  );
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    vi.spyOn(OrganizationApprovalService.prototype, 'pending').mockResolvedValue(
      (pendingResponse.examples as unknown[])[1] as never,
    );
    for (const schema of [
      attendanceApplicationBody,
      attendanceWithdrawBody,
      attendanceApplicationResponse,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples) expect(validate(example)).toBe(true);
    }
    const body = attendanceApplicationBody.examples[0]!;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/attendance/apply',
      payload: body,
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(attendanceApplicationExample);
    const withdrawn = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/attendance/withdraw',
      payload: attendanceWithdrawBody.examples[0],
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    expect(withdrawn.json().data).toMatchObject({
      applicationId: attendanceApplicationExample.applicationId,
      status: 'WITHDRAWN',
      flowVersionNo: 1,
    });
    const processed = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/approvals/process',
      payload: {
        orgId,
        flowNo: attendanceProcessExample.flowNo,
        nodeId: attendanceProcessExample.nodeId,
        flowVersionNo: 0,
        nodeVersionNo: 0,
        action: 'APPROVE',
      },
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    expect(processed.statusCode).toBe(200);
    expect(processed.json().data).toEqual(attendanceProcessExample);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/attendance/apply',
      payload: { ...body, applicantId: 'other' },
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    expect(unknown.statusCode).toBe(400);
    expect(apply).toHaveBeenCalledTimes(1);
    const pending = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/approvals/pending',
      payload: { orgId, businessType: 'ATTENDANCE_CORRECTION' },
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().data.records[0].formData).toMatchObject({
      attendanceDate: '2020-01-01',
      applicationType: 'CORRECTION',
      versionNo: null,
    });
    expect(pending.json().data.records[0].formData).not.toHaveProperty('plannedLeaveDate');
    expect(spec.paths['/api/v1/organizations/attendance/apply'].post.security).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test('month exposes pending IDs and live per-day apply/withdraw capabilities', async () => {
  const form = { applicationType: 'CORRECTION', finalStatus: 'PRESENT' };
  const tx = {
    organization: { findFirst: vi.fn().mockResolvedValue({ id: orgId }) },
    userOrgRel: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'rel', position: 'MEMBER', joinStatus: 'ACTIVE' }),
    },
    user: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: principal.userId, realName: '小明', displayName: '成员' }),
    },
    orgMemberSchedule: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 1, scheduleDate: new Date('2020-01-01'), status: 'ACTIVE', dayType: 'WORK' },
        ]),
    },
    orgAttendanceDaily: { findMany: vi.fn().mockResolvedValue([]) },
    approvalFlow: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: attendanceApplicationExample.applicationId,
          businessId: `${principal.userId}:2020-01-01`,
          formData: form,
          versionNo: 0,
          status: 'PENDING',
          flowNo: 'ATAEXAMPLE',
        },
      ]),
    },
  };
  const service = new AttendanceService({
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient);
  const result = await service.month('2020-01', orgId, principal);
  expect(result.permissions).toMatchObject({
    canApply: true,
    canWithdraw: true,
    canDirectUpdate: false,
  });
  expect(result.days[0]).toMatchObject({
    application: { applicationId: attendanceApplicationExample.applicationId, canWithdraw: true },
    permissions: { canApplyCorrection: false, canApplyLeave: false, canWithdraw: true },
  });
});

test('approved future leave creates null-auto daily facts and audited after-snapshot before completing the flow', async () => {
  const f = fixture();
  const owner = { ...principal, userId: '00000000-0000-4000-8000-000000000009', uid: 'owner' };
  f.tx.orgMemberSchedule.findUnique.mockResolvedValue({
    ...f.schedule,
    shiftStartAt: new Date('2099-01-01T09:00:00Z'),
    shiftEndAt: new Date('2099-01-01T18:00:00Z'),
  });
  await f.service.apply(
    {
      ...input,
      attendanceDate: '2099-01-01',
      applicationType: 'LEAVE',
      finalStatus: 'LEAVE',
      leaveStartAt: '2099-01-01 09:00:00',
      leaveEndAt: '2099-01-01 12:00:00',
    },
    principal,
  );
  const flow = {
    id: attendanceApplicationExample.applicationId,
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    versionNo: 0,
    finishedAt: null,
  } as ApprovalFlow;
  const createDaily = vi.fn().mockResolvedValue({ id: 99, versionNo: 0 }),
    audit = vi.fn().mockResolvedValue({ id: 77 }),
    after = vi.fn();
  const tx = {
    ...f.tx,
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ displayName: '主管', realName: '李四' }),
    },
    orgAttendanceDaily: { ...f.tx.orgAttendanceDaily, create: createDaily },
    orgAttendanceAdjustment: { create: audit },
    approvalFlow: { ...f.tx.approvalFlow, update: after },
  };
  const value = await f.service.process(
    tx as unknown as Prisma.TransactionClient,
    flow,
    { id: 'node', approverName: '主管' } as never,
    {
      orgId,
      flowNo: flow.flowNo,
      nodeId: 'node',
      flowVersionNo: 0,
      nodeVersionNo: 0,
      action: 'APPROVE',
    },
    owner,
  );
  expect(value).toMatchObject({
    flowStatus: 'APPROVED',
    flowVersionNo: 1,
    dailyId: 99,
    dailyVersionNo: 0,
    adjustmentId: 77,
    finalStatus: 'LEAVE',
  });
  expect(createDaily).toHaveBeenCalledWith({
    data: expect.objectContaining({
      autoStatus: null,
      finalStatus: 'LEAVE',
      manualOverride: true,
      userId: principal.userId,
      userOrgRelId: f.rel.id,
    }),
  });
  expect(audit).toHaveBeenCalledWith({
    data: expect.objectContaining({
      beforeStatus: null,
      afterStatus: 'LEAVE',
      operatorUserId: owner.userId,
    }),
  });
  expect(after).toHaveBeenCalledWith({
    where: { id: flow.id },
    data: { afterData: { dailyId: 99, dailyVersionNo: 0, finalStatus: 'LEAVE', adjustmentId: 77 } },
  });
  expect(f.tx.approvalFlow.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: flow.id, status: 'PENDING', versionNo: 0 },
      data: expect.objectContaining({ status: 'APPROVED', versionNo: { increment: 1 } }),
    }),
  );
});

test('stale approval day or schedule stops before node completion; rejection can close stale requests without day writes', async () => {
  const f = fixture();
  await f.service.apply(input, principal);
  const flow = {
    id: attendanceApplicationExample.applicationId,
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    versionNo: 0,
    finishedAt: null,
  } as ApprovalFlow;
  const owner = { ...principal, userId: 'owner', uid: 'owner' };
  const request = {
    orgId,
    flowNo: flow.flowNo,
    nodeId: 'node',
    flowVersionNo: 0,
    nodeVersionNo: 0,
    action: 'APPROVE' as const,
  };
  f.tx.orgAttendanceDaily.findUnique.mockResolvedValue({ id: 1, versionNo: 1 });
  await expect(
    f.service.process(
      f.tx as unknown as Prisma.TransactionClient,
      flow,
      { id: 'node' } as never,
      request,
      owner,
    ),
  ).rejects.toMatchObject({ status: 409 });
  f.tx.orgAttendanceDaily.findUnique.mockResolvedValue(null);
  f.tx.orgMemberSchedule.findUnique.mockResolvedValue({ ...f.schedule, versionNo: 3 });
  await expect(
    f.service.process(
      f.tx as unknown as Prisma.TransactionClient,
      flow,
      { id: 'node' } as never,
      request,
      owner,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.tx.approvalNode.updateMany).not.toHaveBeenCalled();
  expect(f.tx.approvalFlow.updateMany).not.toHaveBeenCalled();
  expect(
    await f.service.process(
      f.tx as unknown as Prisma.TransactionClient,
      flow,
      { id: 'node', approverName: '主管' } as never,
      { ...request, action: 'REJECT', actionComment: '重新提交' },
      owner,
    ),
  ).toMatchObject({ flowStatus: 'REJECTED', dailyId: null, adjustmentId: null, finalStatus: null });
  expect(f.tx.approvalFlow.updateMany).toHaveBeenCalledTimes(1);
});

test('organizational approval dispatch retains actual owner/node/version checks for attendance flows', async () => {
  const f = fixture();
  await f.service.apply(input, principal);
  const owner = { ...principal, userId: '00000000-0000-4000-8000-000000000009' };
  const flow = {
    id: attendanceApplicationExample.applicationId,
    ...f.tx.approvalFlow.create.mock.calls[0]![0].data,
    versionNo: 0,
    finishedAt: null,
  };
  const node = {
    id: 'node',
    flowId: flow.id,
    flowNo: flow.flowNo,
    approverId: owner.userId,
    nodeStatus: 'PENDING',
    versionNo: 0,
    nodeSeq: 1,
  };
  f.tx.userOrgRel.findUnique.mockResolvedValue({
    ...f.rel,
    userId: owner.userId,
    position: 'OWNER',
  });
  f.tx.approvalFlow.findUnique.mockResolvedValue(flow);
  const tx = {
    ...f.tx,
    approvalNode: { ...f.tx.approvalNode, findUnique: vi.fn().mockResolvedValue(node) },
  };
  const db = {
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  const process = vi
    .spyOn(AttendanceApplicationService.prototype, 'process')
    .mockResolvedValue(attendanceProcessExample as never);
  const service = new OrganizationApprovalService(db);
  const request = {
    orgId,
    flowNo: flow.flowNo,
    nodeId: 'node',
    flowVersionNo: 0,
    nodeVersionNo: 0,
    action: 'APPROVE' as const,
  };
  await service.process(request, owner);
  expect(process).toHaveBeenCalledWith(tx, flow, node, request, owner);
  f.tx.userOrgRel.findUnique.mockResolvedValue({ ...f.rel, position: 'ADMIN' });
  await expect(service.process(request, owner)).rejects.toMatchObject({ status: 403 });
  f.tx.userOrgRel.findUnique.mockResolvedValue({ ...f.rel, position: 'OWNER' });
  tx.approvalNode.findUnique.mockResolvedValue({ ...node, approverId: 'other-owner' });
  await expect(service.process(request, owner)).rejects.toMatchObject({ status: 403 });
  expect(process).toHaveBeenCalledTimes(1);
});
