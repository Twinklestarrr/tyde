import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { PersonnelMovementService } from '../src/modules/personnel/personnel-movement.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import {
  transferTargetBody,
  transferTargetResponse,
  transferTargetExample,
} from '../src/modules/personnel/personnel-movement.schema.js';

const p: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'test',
  role: 'PM',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const tx = {
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: 1 }),
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 2,
          projectNo: 'PJ2',
          projectName: '目标项目',
          requesterType: 'INDIVIDUAL',
          requesterName: '旧名',
          requester: { displayName: ' 新名 ', realName: ' 姓名 ', uid: 'requester' },
          productionPlan: null,
        },
        {
          id: 3,
          projectNo: 'PJ3',
          projectName: null,
          requesterType: 'ORGANIZATION',
          requesterName: '组织快照',
          requester: { displayName: '个人名', realName: null, uid: 'requester' },
          productionPlan: { needWrittenExam: false },
        },
      ]),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: p.userId }),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([
        { id: 1, organizationId: 'org-a', userId: 'a' },
        { id: 2, organizationId: 'org-b', userId: 'b' },
      ]),
    },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-a', position: 'OWNER' }]) },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([{ organizationId: 'org-a', owners: [] }]),
    },
  };
  const db = { $transaction: vi.fn().mockImplementation((fn) => fn(tx)) };
  return { tx, db, service: new PersonnelMovementService(db as never) };
}
test('transfer targets requires valid concrete active source members and never treats an empty batch as all projects', async () => {
  const f = fixture();
  for (const memberIds of [[], [0], [1.1], Array(101).fill(1)])
    await expect(f.service.targets({ projectId: 1, memberIds }, p)).rejects.toMatchObject({
      status: 400,
    });
  expect(f.db.$transaction).not.toHaveBeenCalled();
  f.tx.projectMember.findMany.mockResolvedValue([]);
  await expect(f.service.targets({ projectId: 1, memberIds: [1] }, p)).rejects.toMatchObject({
    status: 400,
  });
  expect(f.tx.project.count).not.toHaveBeenCalled();
});
test('transfer target query intersects all source organizations, excludes any open user identity, and paginates in one snapshot', async () => {
  const f = fixture();
  const result = await f.service.targets(
    { projectId: 1, memberIds: [1, 2, 1], keyword: ' PJ ', current: 2, size: 1 },
    p,
  );
  expect(f.tx.projectMember.findMany.mock.calls[0][0].where).toEqual({
    projectId: 1,
    id: { in: [1, 2] },
    status: 'ACTIVE',
  });
  const where = f.tx.project.count.mock.calls[0][0].where;
  expect(where).toMatchObject({
    deleted: false,
    status: 'PUBLISHED',
    id: { not: 1 },
    OR: [{ projectName: { contains: 'PJ' } }, { projectNo: { contains: 'PJ' } }],
    AND: ['org-a', 'org-b'].map((organizationId) => ({
      expertAssignments: {
        some: { organizationId, subjectType: 'ORGANIZATION', status: 'ACCEPTED' },
      },
    })),
    members: {
      none: {
        userId: { in: ['a', 'b'] },
        status: {
          in: ['PENDING_CONFIRM', 'PENDING_ENTRY', 'ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER'],
        },
      },
    },
  });
  expect(f.tx.project.findMany.mock.calls[0][0]).toMatchObject({
    where,
    skip: 1,
    take: 1,
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
  });
  expect(f.db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  expect(result).toMatchObject({
    total: 2,
    current: 2,
    size: 1,
    pages: 2,
    records: [
      { requesterName: '新名(姓名)', examRequired: true },
      { requesterName: '组织快照', examRequired: false, projectName: null },
    ],
  });
});
test('transfer targets rejects handler, wrong role and foreign organization; personal identity never borrows another membership', async () => {
  const f = fixture();
  f.tx.projectManagerRecruitment.findFirst.mockResolvedValue({
    candidateUserId: 'other',
    expertRecruitmentHandlerUserId: p.userId,
  } as never);
  await expect(f.service.targets({ projectId: 1, memberIds: [1, 2] }, p)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.service.targets({ projectId: 1, memberIds: [1, 2] }, { ...p, role: 'NAVIGATOR' }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.service.targets({ projectId: 1, memberIds: [1, 2] }, { ...p, role: 'EXPERT' }),
  ).rejects.toMatchObject({ status: 403 });
  f.tx.projectMember.findMany.mockResolvedValue([
    { id: 1, userId: 'a', organizationId: null },
  ] as never);
  f.tx.projectManagerRecruitment.findFirst.mockResolvedValue({ candidateUserId: p.userId });
  expect(await f.service.targets({ projectId: 1, memberIds: [1] }, p)).toEqual({
    total: 0,
    current: 1,
    size: 20,
    pages: 0,
    records: [],
  });
  expect(f.tx.project.count).not.toHaveBeenCalled();
  expect(f.tx.userOrgRel.findMany).toHaveBeenCalledTimes(1);
});
test('transfer target Swagger nested fields, examples and real HTTP serialization enforce the contract', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const targets = vi.spyOn(PersonnelMovementService.prototype, 'targets').mockResolvedValue({
    ...transferTargetExample,
    records: [{ ...transferTargetExample.records[0], internal: 'hidden' }],
  } as never);
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
    const descriptions = (schema: Record<string, unknown>) => {
      expect(schema.description).toEqual(expect.any(String));
      for (const property of Object.values(schema.properties ?? {}))
        descriptions(property as Record<string, unknown>);
      if (schema.items) descriptions(schema.items as Record<string, unknown>);
    };
    for (const schema of [transferTargetBody, transferTargetResponse]) {
      descriptions(schema);
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/movements/target-projects',
      headers: { authorization: 'Bearer token' },
      payload: { projectId: 1, memberIds: [1] },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      code: 200,
      message: '操作成功',
      data: transferTargetExample,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    for (const payload of [
      { projectId: 1, memberIds: [] },
      { projectId: 1, memberIds: [0] },
      { projectId: 1, memberIds: [1], size: 101 },
      { projectId: '1', memberIds: [1] },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/project-personnel/movements/target-projects',
            headers: { authorization: 'Bearer token' },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(targets).toHaveBeenCalledTimes(1);
    const spec = app.swagger() as { paths: Record<string, unknown> };
    expect(spec.paths['/api/v1/project-personnel/movements/target-projects']).toBeDefined();
  } finally {
    await app.close();
  }
});

test('movement validation uses Shanghai date, strict date and exact target/type combinations before any transaction', async () => {
  const { validateMovement } =
    await import('../src/modules/personnel/personnel-movement.domain.js');
  const now = new Date('2026-10-26T16:00:00Z');
  const base = {
    projectId: 1,
    memberIds: [2, 1, 2],
    movementType: 'REMOVAL' as const,
    reason: '调整',
    plannedEffectiveDate: '2026-10-27',
  };
  expect(validateMovement(base, now)).toEqual([1, 2]);
  for (const change of [
    { plannedEffectiveDate: '2026-10-26' },
    { plannedEffectiveDate: '2027-02-29' },
    { plannedEffectiveDate: '2026-11-31' },
    { movementType: 'TRANSFER' },
    { movementType: 'TRANSFER', targetProjectId: 1 },
    { targetProjectId: 2 },
    { memberIds: [] },
    { memberIds: [1.5] },
    { reason: '   ' },
    { reason: '字'.repeat(501) },
  ])
    expect(() => validateMovement({ ...base, ...change } as never, now)).toThrow();
  expect(validateMovement({ ...base, movementType: 'TRANSFER', targetProjectId: 2 }, now)).toEqual([
    1, 2,
  ]);
});

test('movement create Swagger validates examples, rejects malformed requests and returns legacy null data', async () => {
  const { movementCreateBody, movementCreateResponse } =
    await import('../src/modules/personnel/personnel-movement.schema.js');
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const create = vi.spyOn(PersonnelMovementService.prototype, 'create').mockResolvedValue(null);
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
    const descriptions = (schema: Record<string, unknown>) => {
      expect(schema.description).toEqual(expect.any(String));
      for (const child of Object.values(schema.properties ?? {}))
        descriptions(child as Record<string, unknown>);
      if (schema.items) descriptions(schema.items as Record<string, unknown>);
    };
    for (const schema of [movementCreateBody, movementCreateResponse]) {
      descriptions(schema);
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const request = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/project-personnel/movements/create',
        headers: { authorization: 'Bearer token' },
        payload,
      });
    const good = movementCreateBody.examples[0]!;
    const result = await request(good);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ code: 200, message: '操作成功', data: null });
    expect(result.headers['cache-control']).toBe('no-store');
    for (const change of [
      { projectId: '1' },
      { memberIds: [] },
      { reason: '   ' },
      { movementType: 'DELETE' },
      { plannedEffectiveDate: 'bad' },
      { targetProjectId: 0 },
    ])
      expect((await request({ ...good, ...change })).statusCode).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
    const spec = app.swagger() as { paths: Record<string, unknown> };
    expect(spec.paths['/api/v1/project-personnel/movements/create']).toBeDefined();
  } finally {
    await app.close();
  }
});

function createFixture(organization = false) {
  const user = {
    id: 'member',
    uid: 'member-uid',
    displayName: '成员',
    realName: null,
    status: 'ACTIVE',
  };
  const member = {
    id: 1,
    projectId: 1,
    userId: user.id,
    user,
    status: 'ACTIVE',
    organizationId: organization ? 'org' : null,
    userOrgRelId: organization ? 'rel' : null,
    organization: organization ? { name: '来源组织', deleted: false } : null,
    organizationMembership: organization
      ? { orgId: 'org', userId: user.id, joinStatus: 'ACTIVE' }
      : null,
    expertAssignment: {
      id: 1,
      projectId: 1,
      status: 'ACCEPTED',
      subjectType: organization ? 'ORGANIZATION' : 'INDIVIDUAL',
      organizationId: organization ? 'org' : null,
      expertUserId: organization ? null : user.id,
      owners: [],
      projectOwnerUserId: null,
    },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...user, id: p.userId }),
      findMany: vi.fn().mockResolvedValue([{ ...user, id: 'owner' }]),
    },
    project: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve({
            id: where.id,
            status: 'PUBLISHED',
            projectNo: `PJ${where.id}`,
            currentNodeCode: 'PRODUCTION_TASK',
          }),
        ),
    },
    projectManagerRecruitment: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve({
            candidateUserId: p.userId,
            candidate: { ...user, id: p.userId },
            projectId: where.projectId,
          }),
        ),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([member]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ owners: [{ status: 'ACTIVE', userId: 'owner' }] }),
    },
    projectMemberMovement: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 10, movementNo: 'MV10' }),
      update: vi.fn().mockResolvedValue({}),
    },
    approvalFlow: { create: vi.fn().mockResolvedValue({ id: 'flow' }) },
    projectTaskRound: { findMany: vi.fn().mockResolvedValue([]) },
    projectEventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const db = { $transaction: vi.fn().mockImplementation((fn) => fn(tx)) };
  const service = new PersonnelMovementService(db as never);
  const input = {
    projectId: 1,
    memberIds: [1, 1],
    movementType: 'TRANSFER' as const,
    targetProjectId: 2,
    reason: ' 调整 ',
    plannedEffectiveDate: '2099-01-01',
  };
  return { tx, db, service, input, member };
}
test('movement creation persists personal wait nodes and organization five-step approvers without fabricating acceptance, exam or entry', async () => {
  for (const organization of [false, true]) {
    const f = createFixture(organization);
    expect(await f.service.create(f.input, p)).toBe(null);
    expect(f.tx.projectMemberMovement.create).toHaveBeenCalledTimes(1);
    expect(f.tx.projectMemberMovement.create.mock.calls[0]![0].data).toMatchObject({
      memberId: 1,
      sourceProjectId: 1,
      targetProjectId: 2,
      status: 'PROCESSING',
      reason: '调整',
    });
    const flow = f.tx.approvalFlow.create.mock.calls[0]![0].data;
    expect(flow.currentNodeCode).toBe(organization ? 'SOURCE_ORG_OWNER' : 'MEMBER_CONFIRM');
    expect(flow.nodes.create.map((n: { nodeCode: string }) => n.nodeCode)).toEqual(
      organization
        ? [
            'SOURCE_ORG_OWNER',
            'MEMBER_CONFIRM',
            'TARGET_ENTRANCE_EXAM',
            'TARGET_MANAGER',
            'TARGET_ORG_OWNER',
          ]
        : ['MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM', 'TARGET_MANAGER'],
    );
    expect(
      flow.nodes.create.filter((n: { nodeStatus: string }) => n.nodeStatus === 'PENDING'),
    ).toHaveLength(1);
    expect(
      flow.nodes.create.find((n: { nodeCode: string }) => n.nodeCode === 'MEMBER_CONFIRM')
        .approverId,
    ).toBe(f.member.userId);
    expect(f.tx.projectMember.update.mock.calls[0]![0].data).toMatchObject({
      status: 'PENDING_TRANSFER',
      plannedLeaveDate: null,
    });
    expect(f.tx.projectEventOutbox.create).toHaveBeenCalledTimes(2);
    expect(f.db.$transaction.mock.calls[0]![1]).toEqual({ timeout: 30_000 });
  }
});
test('removal has no transfer flow and registers a due date while invalid source state, open movement, owner and target identities block writes', async () => {
  const removal = createFixture();
  await removal.service.create(
    { ...removal.input, movementType: 'REMOVAL', targetProjectId: null },
    p,
  );
  expect(removal.tx.approvalFlow.create).not.toHaveBeenCalled();
  expect(removal.tx.projectMember.update.mock.calls[0]![0].data).toMatchObject({
    status: 'PENDING_EXIT',
    plannedLeaveDate: new Date('2099-01-01'),
  });
  for (const kind of [
    'source',
    'existing',
    'owner',
    'target',
    'target-manager',
    'target-owner',
    'membership',
  ]) {
    const f = createFixture(kind === 'membership' || kind === 'target-owner');
    if (kind === 'source') f.member.status = 'PENDING_TRANSFER';
    if (kind === 'existing')
      f.tx.projectMemberMovement.findFirst.mockResolvedValue({ id: 5 } as never);
    if (kind === 'owner') f.member.expertAssignment.projectOwnerUserId = f.member.userId as never;
    if (kind === 'target') f.tx.projectMember.findFirst.mockResolvedValue({ id: 5 } as never);
    if (kind === 'target-manager')
      f.tx.projectManagerRecruitment.findFirst.mockImplementation(
        ({ where }) =>
          Promise.resolve(where.projectId === 1 ? { candidateUserId: p.userId } : null) as never,
      );
    if (kind === 'target-owner') f.tx.user.findMany.mockResolvedValue([]);
    if (kind === 'membership') f.member.organizationMembership!.joinStatus = 'LEFT';
    await expect(f.service.create(f.input, p), kind).rejects.toBeInstanceOf(Error);
    expect(f.tx.projectMemberMovement.create, kind).not.toHaveBeenCalled();
  }
});
