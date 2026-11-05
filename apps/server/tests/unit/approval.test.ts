import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { ApprovalService } from '../../src/modules/approval/approval.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import {
  exitBody,
  exitExample,
  exitResponse,
  pendingBody,
  pendingResponse,
  processBody,
  processExample,
  processResponse,
  recordsBody,
  recordsResponse,
} from '../../src/modules/organizations/approval.schema.js';
import {
  OrganizationApprovalService,
  exitFlowNo,
} from '../../src/modules/organizations/organization-approval.service.js';
const orgId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000003';
const principal: AuthPrincipal = {
  userId,
  uid: 'actor-uid',
  sessionId: 'session',
  role: 'EXPERT',
  clientType: 'desktop',
};
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
afterEach(() => vi.restoreAllMocks());
test('flow numbers preserve legacy namespace, normalize the key, and isolate applicant and organization', () => {
  expect(exitFlowNo(orgId, userId, ' key ')).toMatch(/^OMX[A-F0-9]{40}$/);
  expect(exitFlowNo(orgId, userId, ' key ')).toBe(exitFlowNo(orgId, userId, 'key'));
  expect(exitFlowNo(orgId, memberId, 'key')).not.toBe(exitFlowNo(orgId, userId, 'key'));
  expect(exitFlowNo(memberId, userId, 'key')).not.toBe(exitFlowNo(orgId, userId, 'key'));
});
test('approval kernel blank or null lookups are side effect free and empty', async () => {
  const service = new ApprovalService({} as PrismaClient);
  expect(await service.enabledProcess(' ')).toBeNull();
  expect(await service.flow(null)).toBeNull();
  expect(await service.activeBusiness('', 'id')).toBeNull();
  for (const result of [
    await service.configs(null),
    await service.pendingNodes(null),
    await service.nodes(null, 1),
    await service.actions(null),
  ])
    expect(result).toEqual([]);
});
function fixture(position = 'MEMBER', state = 'ACTIVE', self = true) {
  const actor = { id: memberId, orgId, userId, position, joinStatus: state };
  const target = {
    id: self ? actor.id : '00000000-0000-4000-8000-000000000006',
    userId,
    orgId,
    position: 'MEMBER',
    joinStatus: 'ACTIVE',
    user: { displayName: '昵称', realName: '姓名', uid: 'uid' },
  };
  const tx = {
    $queryRaw: vi.fn(),
    userOrgRel: {
      findUnique: vi.fn().mockResolvedValue(actor),
      findFirst: vi.fn().mockResolvedValue(target),
      update: vi.fn().mockResolvedValue({}),
    },
    organization: { findFirst: vi.fn().mockResolvedValue({ id: orgId, name: '组织' }) },
    approvalFlow: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  };
  const db = {
    $transaction: async (fn: (tx: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { tx, target, service: new OrganizationApprovalService(db) };
}
test.each(['LEFT', 'REMOVED', 'PENDING', 'PENDING_ACTIVATION'])(
  'inactive membership %s cannot create a new exit flow',
  async (state) => {
    const { service, tx } = fixture('MEMBER', state);
    await expect(
      service.exit('key', { orgId, reason: '离职', plannedLeaveDate: '2099-01-01' }, principal),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.approvalFlow.create).not.toHaveBeenCalled();
  },
);
test('exit checks input before writing and never treats a new request as replay', async () => {
  const { service, tx } = fixture();
  for (const [key, payload] of [
    [' ', { reason: '离职', plannedLeaveDate: '2099-01-01' }],
    ['key', { reason: ' ', plannedLeaveDate: '2099-01-01' }],
    ['key', { reason: '离职', plannedLeaveDate: '2099-02-30' }],
    ['key', { reason: '离职', plannedLeaveDate: '2000-01-01' }],
  ] as const)
    await expect(service.exit(key, { orgId, ...payload }, principal)).rejects.toMatchObject({
      status: 400,
    });
  expect(tx.approvalFlow.create).not.toHaveBeenCalled();
});
test('ordinary member cannot submit another member exit, owner cannot exit before transfer', async () => {
  const other = fixture('MEMBER', 'ACTIVE', false);
  await expect(
    other.service.exit(
      'key',
      { orgId, memberId: other.target.id, reason: '离职', plannedLeaveDate: '2099-01-01' },
      principal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  const owner = fixture('OWNER');
  owner.target.position = 'OWNER';
  await expect(
    owner.service.exit('key', { orgId, reason: '离职', plannedLeaveDate: '2099-01-01' }, principal),
  ).rejects.toMatchObject({ status: 400 });
});
test('replay returns only the scoped original flow even when applicant already left', async () => {
  const { service, tx } = fixture('MEMBER', 'LEFT');
  tx.approvalFlow.findUnique.mockResolvedValue({
    ...exitExample,
    businessType: 'ORG_MEMBER_EXIT',
    businessId: memberId,
    status: 'PENDING',
    appliedAt: new Date('2026-10-19T06:00:00Z'),
    formData: {
      targetMemberId: memberId,
      joinStatus: 'EXIT_APPROVING',
      plannedLeaveDate: '2099-01-01',
    },
  });
  expect(
    await service.exit(
      'key',
      { orgId, reason: 'changed payload', plannedLeaveDate: '2099-01-02' },
      principal,
    ),
  ).toMatchObject({ memberId, plannedLeaveDate: '2099-01-01', joinStatus: 'EXIT_APPROVING' });
  expect(tx.userOrgRel.findUnique).not.toHaveBeenCalled();
});
test('approval HTTP validates all complete examples and documents conditional rejection and compensation', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const exit = vi
    .spyOn(OrganizationApprovalService.prototype, 'exit')
    .mockResolvedValue(exitExample as never);
  vi.spyOn(OrganizationApprovalService.prototype, 'process').mockResolvedValue(processExample);
  const app = await createApp(config, new PrismaClient());
  const headers = { authorization: 'Bearer token' };
  await app.ready();
  try {
    for (const schema of [
      exitBody,
      pendingBody,
      recordsBody,
      processBody,
      exitResponse,
      pendingResponse,
      recordsResponse,
      processResponse,
    ]) {
      const validator = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/examples',
        httpPart: 'body',
      });
      for (const example of schema.examples as unknown[])
        expect(validator(example), JSON.stringify(validator.errors)).toBe(true);
    }
    const valid = { orgId, reason: '离职', plannedLeaveDate: '2099-01-01' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/members/exit-requests',
          headers,
          payload: valid,
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/members/exit-requests',
      headers: { ...headers, 'idempotency-key': 'key' },
      payload: valid,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(exitExample);
    expect(exit).toHaveBeenCalledOnce();
    const processed = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/approvals/process',
      headers,
      payload: (processBody.examples as unknown[])[0],
    });
    expect(processed.json().data).toEqual(processExample);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/organizations/members/exit-requests'].post.description).toContain(
      '补偿',
    );
    expect(
      spec.paths['/api/v1/organizations/approvals/process'].post.responses['409'],
    ).toBeDefined();
    for (const payload of [
      { orgId, size: 101 },
      { orgId, approverId: userId },
      { orgId, current: 0 },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/organizations/approvals/pending',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
  }
});
