import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { businessDate } from '../../src/modules/organizations/member.domain.js';
import {
  memberListResponse,
  memberPositionBody,
  memberPositionResponse,
  memberQueryBody,
  memberUpdateBody,
  memberUpdateResponse,
} from '../../src/modules/organizations/member.schema.js';
import { MemberService } from '../../src/modules/organizations/member.service.js';
const orgId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const memberId = '00000000-0000-4000-8000-000000000004';
const identity: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'actor-uid',
  role: 'EXPERT',
  sessionId: 'session',
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
function fixture(
  actorPosition = 'OWNER',
  targetPosition = 'MEMBER',
  actorStatus = 'ACTIVE',
  targetStatus = 'ACTIVE',
  self = false,
  adminCount = 0,
) {
  const now = new Date('2026-10-01T01:00:00Z');
  const actor = {
    id: actorId,
    orgId,
    userId: identity.userId,
    uid: identity.uid,
    position: actorPosition,
    joinStatus: actorStatus,
    versionNo: 0,
    joinedAt: now,
    updatedAt: now,
  };
  const target = self
    ? actor
    : {
        ...actor,
        id: memberId,
        userId: 'target-user',
        position: targetPosition,
        joinStatus: targetStatus,
        employmentType: null,
      };
  const tx = {
    $queryRaw: vi.fn(),
    projectMember: { groupBy: vi.fn().mockResolvedValue([]) },
    organization: { findFirst: vi.fn().mockResolvedValue({ id: orgId }) },
    userOrgRel: {
      findUnique: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.userId_orgId.orgId === orgId ? actor : null,
        ),
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.position === 'OWNER'
            ? actor
            : where.orgId === orgId && where.id === target.id
              ? target
              : null,
        ),
      count: vi.fn().mockResolvedValue(adminCount),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(target, { ...data, versionNo: target.versionNo + 1 });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const rel = where.id === actor.id ? actor : target;
        Object.assign(rel, { ...data, versionNo: rel.versionNo + 1 });
        return rel;
      }),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { service: new MemberService(db), db, tx, actor, target };
}
test.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-01', '2026-1-01'])(
  'calendar validation rejects %s',
  (date) => {
    expect(() => businessDate(date, true)).toThrow();
  },
);
test('legacy date-time parsing uses Shanghai and checks time validity', () => {
  expect(businessDate('2026-10-01 09:00:00').toISOString()).toBe('2026-10-01T01:00:00.000Z');
  expect(businessDate('2024-02-29', true).toISOString()).toBe('2024-02-28T16:00:00.000Z');
  expect(() => businessDate('2026-10-01 25:00:00')).toThrow();
});
test.each(['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'])(
  'participating managers in %s can list and edit; version and audit are updated',
  async (joinStatus) => {
    const { service, tx } = fixture('ADMIN', 'MEMBER', joinStatus);
    expect(await service.list({ orgId }, identity)).toMatchObject({
      current: 1,
      size: 20,
      records: [],
      total: 0,
    });
    const result = await service.update(
      { orgId, memberId, versionNo: 0, employmentType: 'PART_TIME', joinedAt: null },
      identity,
    );
    expect(result).toMatchObject({ memberId, versionNo: 1, employmentType: 'PART_TIME' });
    expect(tx.userOrgRel.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: memberId, orgId, versionNo: 0 },
      data: { updatedBy: identity.uid },
    });
    expect(tx.userOrgRel.updateMany.mock.calls[0]![0].data).not.toHaveProperty('joinedAt');
  },
);
test.each(['LEFT', 'REMOVED', 'PENDING', 'PENDING_ACTIVATION'])(
  'nonparticipating manager %s has no write scope',
  async (status) => {
    const { service, tx } = fixture('OWNER', 'MEMBER', status);
    await expect(
      service.update({ orgId, memberId, versionNo: 0, employmentType: 'FULL_TIME' }, identity),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.userOrgRel.updateMany).not.toHaveBeenCalled();
  },
);
test.each(['OWNER', 'ADMIN'])('administrator cannot edit other %s', async (targetPosition) => {
  const { service, tx } = fixture('ADMIN', targetPosition);
  await expect(
    service.update({ orgId, memberId, versionNo: 0, employmentType: 'FULL_TIME' }, identity),
  ).rejects.toMatchObject({ status: 403 });
  expect(tx.userOrgRel.updateMany).not.toHaveBeenCalled();
});
test('self editing, malformed requests, cross organization targets and stale versions', async () => {
  const { service, tx } = fixture('ADMIN', 'ADMIN', 'ACTIVE', 'ACTIVE', true);
  expect(
    (
      await service.update(
        { orgId, memberId: actorId, versionNo: 0, joinedAt: '2026-10-01 09:00:00' },
        identity,
      )
    ).versionNo,
  ).toBe(1);
  await expect(
    service.update({ orgId, memberId: actorId, versionNo: 1 }, identity),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.update(
      { orgId, memberId: actorId, versionNo: 1, joinedAt: '2099-01-01 00:00:00' },
      identity,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.update({ orgId, memberId, versionNo: 0, employmentType: 'PART_TIME' }, identity),
  ).rejects.toMatchObject({ status: 404 });
  tx.userOrgRel.updateMany.mockResolvedValueOnce({ count: 0 });
  await expect(
    service.update(
      { orgId, memberId: actorId, versionNo: 0, employmentType: 'PART_TIME' },
      identity,
    ),
  ).rejects.toMatchObject({ status: 409 });
});
test('member date ranges cover Shanghai end dates and invalid project filter types fail explicitly', async () => {
  const { service, tx } = fixture();
  tx.userOrgRel.count.mockResolvedValue(6);
  await service.list(
    {
      orgId,
      keyword: ' 13812345678 ',
      joinedStartDate: '2026-10-01',
      joinedEndDate: '2026-10-01',
      leftStartDate: '2026-10-02',
      leftEndDate: '2026-10-03',
      position: 'MEMBER',
      joinStatus: 'LEFT',
      employmentType: 'PART_TIME',
      current: 2,
      size: 5,
    },
    identity,
  );
  const args = tx.userOrgRel.findMany.mock.calls[0]![0];
  expect(args).toMatchObject({
    skip: 5,
    take: 5,
    where: {
      orgId,
      joinStatus: 'LEFT',
      position: 'MEMBER',
      employmentType: 'PART_TIME',
      joinedAt: { gte: new Date('2026-09-30T16:00:00Z'), lt: new Date('2026-10-01T16:00:00Z') },
      user: {
        OR: [
          { realName: { contains: '13812345678' } },
          { uid: { contains: '13812345678' } },
          { phoneE164: '+8613812345678' },
        ],
      },
    },
  });
  await expect(
    service.list({ orgId, joinedStartDate: '2026-10-02', joinedEndDate: '2026-10-01' }, identity),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.list({ orgId, projectId: memberId as never }, identity),
  ).rejects.toMatchObject({
    status: 400,
  });
});
test.each([
  ['ADMIN', 'OWNER', 'MEMBER'],
  ['ADMIN', 'ADMIN', 'MEMBER'],
  ['ADMIN', 'MEMBER', 'OWNER'],
  ['OWNER', 'MEMBER', 'ADMIN', 'LEFT'],
])(
  'role permission or status rejection %s/%s/%s/%s',
  async (actor, target, desired, status = 'ACTIVE') => {
    const { service, tx } = fixture(actor, target, 'ACTIVE', status);
    await expect(
      service.position({ orgId, memberId, position: desired }, identity),
    ).rejects.toMatchObject({ status: status === 'ACTIVE' ? 403 : 400 });
    expect(tx.userOrgRel.update).not.toHaveBeenCalled();
  },
);
test('five-admin cap counts all effective states and permits transfer to existing admin without adding a slot', async () => {
  const { service, tx } = fixture('OWNER', 'MEMBER', 'ACTIVE', 'ACTIVE', false, 5);
  for (const position of ['ADMIN', 'OWNER'])
    await expect(service.position({ orgId, memberId, position }, identity)).rejects.toMatchObject({
      status: 400,
    });
  expect(tx.userOrgRel.count.mock.calls[0]![0].where.joinStatus.in).toEqual([
    'PENDING',
    'PENDING_ACTIVATION',
    'ACTIVE',
    'EXIT_APPROVING',
    'PENDING_LEAVE',
  ]);
  const next = fixture('OWNER', 'ADMIN', 'ACTIVE', 'ACTIVE', false, 5);
  expect(
    await next.service.position({ orgId, memberId, position: 'OWNER' }, identity),
  ).toMatchObject({ beforePosition: 'ADMIN', position: 'OWNER' });
  expect(next.actor).toMatchObject({ position: 'ADMIN', versionNo: 1 });
  expect(next.target).toMatchObject({ position: 'OWNER', versionNo: 1 });
});
test('role no-op preserves version, owner cannot demote self, admin can demote self', async () => {
  const { service, tx } = fixture();
  expect(await service.position({ orgId, memberId, position: 'MEMBER' }, identity)).toMatchObject({
    beforePosition: 'MEMBER',
    position: 'MEMBER',
  });
  expect(tx.userOrgRel.update).not.toHaveBeenCalled();
  const owner = fixture('OWNER', 'OWNER', 'ACTIVE', 'ACTIVE', true);
  await expect(
    owner.service.position({ orgId, memberId: actorId, position: 'ADMIN' }, identity),
  ).rejects.toMatchObject({ status: 400 });
  const admin = fixture('ADMIN', 'ADMIN', 'ACTIVE', 'ACTIVE', true);
  await admin.service.position({ orgId, memberId: actorId, position: 'MEMBER' }, identity);
  expect(admin.actor.position).toBe('MEMBER');
});
test('member HTTP schemas validate all examples, serialize records and reject unsupported fields', async () => {
  const configDb = new PrismaClient();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(identity);
  const list = vi
    .spyOn(MemberService.prototype, 'list')
    .mockResolvedValue(memberListResponse.examples[0] as never);
  vi.spyOn(MemberService.prototype, 'update').mockResolvedValue(
    memberUpdateResponse.examples[0] as never,
  );
  const app = await createApp(config, configDb);
  const headers = { authorization: 'Bearer token' };
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/members',
      headers,
      payload: { orgId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(memberListResponse.examples[0]);
    expect(response.payload).not.toContain('13812345678');
    for (const payload of [
      { orgId, size: 101 },
      { orgId, current: 0 },
      { orgId, position: 'OPS' },
      { orgId, otherUser: memberId },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/organizations/members',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(list).toHaveBeenCalledOnce();
    for (const schema of [
      memberQueryBody,
      memberUpdateBody,
      memberPositionBody,
      memberListResponse,
      memberUpdateResponse,
      memberPositionResponse,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/schema-example',
        httpPart: 'body',
      });
      for (const example of schema.examples) expect(validate(example)).toBe(true);
    }
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/organizations/members/update'].post.responses['409']).toBeDefined();
    expect(spec.paths['/api/v1/organizations/members'].post.description).toContain(
      'activeProjectCount返回该组织关系全部ACTIVE记录数',
    );
  } finally {
    await app.close();
  }
});

test('unexpected phone formats remain masked rather than falling through to raw digits', async () => {
  const { service, tx, target } = fixture();
  tx.userOrgRel.count.mockResolvedValue(1);
  tx.userOrgRel.findMany.mockResolvedValue([
    {
      ...target,
      user: {
        phoneE164: '+12025550123',
        status: 'ACTIVE',
        displayName: '测试成员',
        realName: null,
        avatarUrl: null,
      },
    },
  ] as never);
  const page = await service.list({ orgId }, identity);
  expect(page.records[0]!.phoneMasked).toBe('****');
});

test('member project counts batch only the current page, retain row count semantics and never inherit the requested project filter', async () => {
  const { tx, service, target } = fixture();
  tx.userOrgRel.count.mockResolvedValue(1);
  tx.userOrgRel.findMany.mockResolvedValue([
    {
      ...target,
      user: {
        realName: '成员',
        displayName: '昵称',
        phoneE164: '+8613812345678',
        status: 'ACTIVE',
        avatarUrl: null,
      },
    },
  ] as never);
  tx.projectMember.groupBy.mockResolvedValue([
    { userOrgRelId: target.id, _count: { _all: 3 } },
  ] as never);
  const result = await service.list({ orgId, projectId: 3001 }, identity);
  expect(result.records[0]).toMatchObject({
    memberId: target.id,
    activeProjectCount: 3,
    phoneMasked: '138****5678',
  });
  expect(tx.userOrgRel.count).toHaveBeenCalledWith({
    where: { orgId, projectMembers: { some: { projectId: 3001, status: 'ACTIVE' } } },
  });
  expect(tx.userOrgRel.findMany.mock.calls[0]![0].where).toEqual(
    tx.userOrgRel.count.mock.calls[0]![0]!.where,
  );
  expect(tx.projectMember.groupBy).toHaveBeenCalledExactlyOnceWith({
    by: ['userOrgRelId'],
    where: { userOrgRelId: { in: [target.id] }, status: 'ACTIVE' },
    _count: { _all: true },
  });
});
test('members with no ACTIVE association return a real zero; empty and out-of-range pages skip project aggregation', async () => {
  const { tx, service, target } = fixture();
  tx.userOrgRel.count.mockResolvedValue(1);
  tx.userOrgRel.findMany.mockResolvedValue([
    {
      ...target,
      user: {
        realName: null,
        displayName: '昵称',
        phoneE164: '+8613812345678',
        status: 'ACTIVE',
        avatarUrl: null,
      },
    },
  ] as never);
  expect(
    (await service.list({ orgId, projectId: null }, identity)).records[0]!.activeProjectCount,
  ).toBe(0);
  tx.projectMember.groupBy.mockClear();
  expect((await service.list({ orgId, current: 2, size: 1 }, identity)).records).toEqual([]);
  expect(tx.projectMember.groupBy).not.toHaveBeenCalled();
  tx.userOrgRel.count.mockResolvedValue(0);
  expect((await service.list({ orgId }, identity)).records).toEqual([]);
  expect(tx.projectMember.groupBy).not.toHaveBeenCalled();
});
test('zero and negative project IDs preserve exact no-match filtering while non-integer and out-of-range inputs fail', async () => {
  const { tx, service } = fixture();
  for (const projectId of [0, -1]) {
    await service.list({ orgId, projectId }, identity);
    expect(tx.userOrgRel.count).toHaveBeenLastCalledWith({
      where: { orgId, projectMembers: { some: { projectId, status: 'ACTIVE' } } },
    });
  }
  for (const projectId of [1.5, 2147483648, -2147483649, '3001', memberId])
    await expect(
      service.list({ orgId, projectId: projectId as never }, identity),
    ).rejects.toMatchObject({ status: 400 });
});
test('member HTTP accepts numeric project filters, rejects UUID placeholders and serializes nonnullable project counts', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(identity);
  const list = vi
    .spyOn(MemberService.prototype, 'list')
    .mockResolvedValue(memberListResponse.examples[0] as never);
  const app = await createApp(config, new PrismaClient());
  try {
    const headers = { authorization: 'Bearer token' };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/members',
      headers,
      payload: { orgId, projectId: 3001 },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.records[0].activeProjectCount).toBe(0);
    expect(list).toHaveBeenCalledWith({ orgId, projectId: 3001 }, identity);
    for (const projectId of [memberId, '3001', 1.5, 2147483648])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/organizations/members',
            headers,
            payload: { orgId, projectId },
          })
        ).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
  }
});
