import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { PersonnelMovementService } from '../src/modules/personnel/personnel-movement.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import {
  movementListBody,
  movementListResponse,
  movementDetailBody,
  movementDetailResponse,
  movementListExample,
} from '../src/modules/personnel/personnel-movement-query.schema.js';
const p: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'pm',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const user = {
    id: p.userId,
    uid: 'member',
    displayName: '成员',
    realName: null,
    status: 'ACTIVE',
  };
  const row = {
    id: 1,
    movementNo: 'MV1',
    movementType: 'REMOVAL',
    status: 'WAITING_EFFECTIVE',
    memberId: 1,
    userId: p.userId,
    sourceProjectId: 1,
    targetProjectId: null,
    reason: '调整',
    plannedEffectiveDate: new Date('2099-01-01'),
    initiatedBy: p.userId,
    createdAt: new Date('2026-10-26T04:00:00Z'),
    targetExamAttemptId: null,
    targetExamAttempt: null,
    targetProject: null,
    flow: null,
    member: { user, organizationId: null, organization: null, project: { projectName: '原项目' } },
    initiator: user,
  };
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: p.userId }),
    },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([]) },
    projectExpertAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    projectMemberMovement: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([row]),
    },
  };
  const db = { $transaction: vi.fn().mockImplementation((fn) => fn(tx)) };
  return { row, tx, db, service: new PersonnelMovementService(db as never) };
}
test('movement reads filter in database, count and paginate in one snapshot, preserving Shanghai times and latest source-member detail', async () => {
  const f = fixture();
  const result = await f.service.list(
    {
      projectId: 1,
      movementTypes: ['REMOVAL'],
      statuses: ['WAITING_EFFECTIVE'],
      keyword: ' 成员 ',
      createdStartAt: '2026-10-26 00:00:00',
      createdEndAt: '2026-10-27 00:00:00',
      current: 2,
      size: 1,
    },
    p,
  );
  expect(result.records[0]).toMatchObject({
    initiatedAt: '2026-10-26 12:00:00',
    statusName: '待生效',
    allowedActions: ['WITHDRAW'],
    approvalSteps: [],
    flowNo: null,
  });
  const where = f.tx.projectMemberMovement.count.mock.calls[0]![0].where;
  expect(where).toMatchObject({
    movementType: { in: ['REMOVAL'] },
    status: { in: ['WAITING_EFFECTIVE'] },
    createdAt: { gte: new Date('2026-10-25T16:00:00Z'), lte: new Date('2026-10-26T16:00:00Z') },
  });
  expect(where.AND).toHaveLength(1);
  expect(f.tx.projectMemberMovement.findMany.mock.calls[0]![0]).toMatchObject({
    where,
    skip: 1,
    take: 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  await f.service.detail({ projectId: 1, memberId: 3 }, p);
  expect(f.tx.projectMemberMovement.findMany.mock.calls[1]![0]).toMatchObject({
    where: { memberId: 3, sourceProjectId: 1 },
    take: 1,
  });
  expect(f.db.$transaction.mock.calls[0]![1]).toEqual({ isolationLevel: 'RepeatableRead' });
  f.tx.projectMemberMovement.findMany.mockResolvedValue([]);
  await expect(f.service.detail({ projectId: 1, memberId: 1 }, p)).rejects.toMatchObject({
    status: 404,
  });
});
test('movement viewer preserves personal scope, limits organization participants after departure and gives collaboration handler no actions', async () => {
  const f = fixture();
  await f.service.list({ projectId: 1 }, { ...p, role: 'EXPERT' });
  const where = f.tx.projectMemberMovement.count.mock.calls[0]![0].where;
  expect(where.AND[1].OR).toEqual(expect.arrayContaining([{ userId: p.userId }]));
  expect(where.AND[1].OR[1]).toMatchObject({
    member: {
      organization: {
        deleted: false,
        memberships: {
          some: {
            userId: p.userId,
            joinStatus: { in: ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'] },
          },
        },
      },
    },
  });
  expect(where.AND[1].OR).toHaveLength(2);
  f.tx.projectManagerRecruitment.findFirst.mockResolvedValue({
    candidateUserId: 'other',
    expertRecruitmentHandlerUserId: p.userId,
  } as never);
  expect((await f.service.list({ projectId: 1 }, p)).records[0]!.allowedActions).toEqual([]);
  await expect(f.service.list({ projectId: 1 }, { ...p, role: 'NAVIGATOR' })).rejects.toMatchObject(
    { status: 403 },
  );
  f.tx.project.findFirst.mockResolvedValue(null as never);
  await expect(f.service.list({ projectId: 1 }, p)).rejects.toMatchObject({ status: 404 });
});
test('movement filters reject malformed dates, reversed ranges, invalid IDs and enum arrays before opening transaction', async () => {
  const f = fixture();
  for (const patch of [
    { projectId: '1' },
    { memberId: 0 },
    { size: 101 },
    { movementTypes: ['BAD'] },
    { statuses: Array(6).fill('EFFECTIVE') },
    { keyword: '字'.repeat(101) },
    { createdStartAt: '2026-02-30 00:00:00' },
    { createdStartAt: '2026-10-27 00:00:00', createdEndAt: '2026-10-26 00:00:00' },
  ])
    await expect(f.service.list({ projectId: 1, ...patch } as never, p)).rejects.toMatchObject({
      status: 400,
    });
  await expect(f.service.detail({ projectId: 1 } as never, p)).rejects.toMatchObject({
    status: 400,
  });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
test('movement read contracts describe nested fields, validate examples, serialize only public fields and reject malformed HTTP filters', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  const list = vi
    .spyOn(PersonnelMovementService.prototype, 'list')
    .mockResolvedValue({ ...movementListExample, internal: 'secret' } as never);
  vi.spyOn(PersonnelMovementService.prototype, 'detail').mockResolvedValue({
    ...movementListExample.records[0],
    internal: 'secret',
  } as never);
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://127.0.0.1:3000',
      LOG_LEVEL: 'silent',
    }),
    new PrismaClient(),
  );
  try {
    await app.ready();
    function described(s: Record<string, unknown>) {
      expect(s.description).toEqual(expect.any(String));
      for (const child of Object.values(s.properties ?? {}))
        described(child as Record<string, unknown>);
      if (s.items) described(s.items as Record<string, unknown>);
    }
    for (const schema of [
      movementListBody,
      movementListResponse,
      movementDetailBody,
      movementDetailResponse,
    ]) {
      described(schema);
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [route, payload, expected] of [
      ['list', { projectId: 1 }, movementListExample],
      ['detail', { projectId: 1, memberId: 1 }, movementListExample.records[0]],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/project-personnel/movements/${route}`,
        headers: { authorization: 'Bearer token' },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(expected);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const payload of [
      { projectId: '1' },
      { projectId: 1, statuses: ['BAD'] },
      { projectId: 1, size: 101 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/project-personnel/movements/list',
        headers: { authorization: 'Bearer token' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
