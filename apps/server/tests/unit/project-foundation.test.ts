import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { AppError } from '../../src/common/errors.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { ManagementService } from '../../src/modules/management/management.service.js';
import {
  categoriesResponse,
  categoryItem,
  categoryQuery,
  requesterParams,
  requesterResponse,
} from '../../src/modules/projects/project-foundation.schema.js';
import { ProjectFoundationService } from '../../src/modules/projects/project-foundation.service.js';

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
const principal: AuthPrincipal = {
  userId: requesterParams.examples[0]!.requesterId,
  uid: 'uid',
  sessionId: 'session',
  role: 'NAVIGATOR',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup(granted = true) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: principal.userId, status: 'ACTIVE' }]),
    managementGrant: {
      findFirst: vi.fn().mockResolvedValue(granted ? { userId: principal.userId } : null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    managementGrantAudit: { create: vi.fn() },
    projectCategory: { findMany: vi.fn().mockResolvedValue(categoryItem.examples) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: principal.userId,
        accountType: 'INDIVIDUAL',
        displayName: ' 小明 ',
        realName: ' 王小明 ',
        memberships: [],
      }),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return {
    db,
    tx,
    service: new ProjectFoundationService(db),
    management: new ManagementService(db),
  };
}
test('NAVIGATOR uses categories without independent grants; EXPERT cannot impersonate NAVIGATOR', async () => {
  const { service, tx } = setup(false);
  await expect(service.categories({}, principal)).resolves.toEqual(categoryItem.examples);
  expect(tx.managementGrant.findFirst).not.toHaveBeenCalled();
  await expect(service.categories({}, { ...principal, role: 'EXPERT' })).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    service.requester(requesterParams.examples[0]!, { ...principal, role: 'EXPERT' }),
  ).rejects.toMatchObject({ status: 403 });
});
test('category query filters only enabled independent levels, trims search and projects public fields', async () => {
  const { service, tx } = setup();
  await service.categories({ categoryLevel: 2, keyword: ' 图像 ' }, principal);
  expect(tx.projectCategory.findMany.mock.calls[0]![0]).toEqual({
    where: {
      status: 'ENABLED',
      categoryLevel: 2,
      OR: [
        { categoryName: { contains: '图像' } },
        { categoryCode: { contains: '图像' } },
        { searchKeywords: { contains: '图像' } },
      ],
    },
    orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }],
    select: { id: true, categoryCode: true, categoryName: true, categoryLevel: true, sortNo: true },
  });
  await service.categories({ keyword: '  ' }, principal);
  expect(tx.projectCategory.findMany.mock.calls[1]![0].where).toEqual({ status: 'ENABLED' });
  await expect(service.categories({ categoryLevel: 0 }, principal)).rejects.toMatchObject({
    status: 400,
  });
});
test('requester rejects other users before reading their profile and preserves personal null fields', async () => {
  const { service, tx } = setup();
  await expect(
    service.requester(
      { requesterType: 'INDIVIDUAL', requesterId: '00000000-0000-4000-8000-000000000099' },
      principal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(tx.user.findUnique).not.toHaveBeenCalled();
  expect(await service.requester(requesterParams.examples[0]!, principal)).toEqual(
    requesterResponse.examples[0],
  );
  await expect(
    service.requester({ requesterType: 'ORGANIZATION', requesterId: principal.userId }, principal),
  ).rejects.toMatchObject({ status: 400 });
});
test('organization memberships do not change unified requester identity; organization selection is explicit unsupported', async () => {
  const { service, tx } = setup();
  const value = await service.requester(
    { requesterType: 'INDIVIDUAL', requesterId: principal.userId },
    principal,
  );
  expect(value).toMatchObject({ requesterType: 'INDIVIDUAL', orgId: null });
  await expect(
    service.requester({ requesterType: 'ORGANIZATION', requesterId: principal.userId }, principal),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.managementGrant.findFirst).not.toHaveBeenCalled();
});
test('incomplete organization profile cannot become a fabricated requester', async () => {
  const { service, tx } = setup();
  tx.user.findUnique.mockResolvedValue({
    id: principal.userId,
    accountType: 'ORGANIZATION',
    displayName: '',
    realName: '',
    memberships: [],
  });
  await expect(
    service.requester({ requesterType: 'ORGANIZATION', requesterId: principal.userId }, principal),
  ).rejects.toMatchObject({ status: 400 });
});
const grantInput: GrantChange = {
  uid: 'uid',
  role: 'NAVIGATOR',
  action: 'GRANT',
  actor: 'test-operator',
  reason: '测试授权维护',
};
test('legacy grant maintenance is disabled without mutating grants or user roles', async () => {
  const { management, db } = setup();
  for (const action of ['GRANT', 'REVOKE'] as const)
    await expect(management.change({ ...grantInput, action })).rejects.toMatchObject({
      status: 409,
    });
  expect(db.$transaction).not.toHaveBeenCalled();
});
test('project routes preserve authenticated transport, integer query behavior and response serialization', async () => {
  const { db } = setup();
  const authenticate = vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const app = await createApp(config, db);
  try {
    const headers = { authorization: 'Bearer demo' };
    const result = await app.inject({
      url: '/api/v1/project-categories?categoryLevel=1&keyword=图片',
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ code: 200, message: '操作成功', data: categoryItem.examples });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(authenticate).toHaveBeenCalledWith('demo', 'desktop');
    for (const query of [
      'categoryLevel=0',
      'categoryLevel=4',
      'categoryLevel=1.5',
      'categoryLevel=x',
      'unknown=1',
    ])
      expect(
        (await app.inject({ url: `/api/v1/project-categories?${query}`, headers })).statusCode,
      ).toBe(400);
    const backfill = await app.inject({
      url: `/api/v1/project-requesters/INDIVIDUAL/${principal.userId}/backfill`,
      headers,
    });
    expect(backfill.json()).toEqual({
      code: 200,
      message: '操作成功',
      data: requesterResponse.examples[0],
    });
    expect(
      (await app.inject({ url: '/api/v1/project-requesters/INDIVIDUAL/123/backfill', headers }))
        .statusCode,
    ).toBe(400);
    for (const badHeaders of [
      { 'x-tyde-client': 'desktop', origin: 'https://evil.test' },
      { authorization: 'Bearer demo', cookie: 'tyde_session=demo' },
      { 'x-tyde-client': 'desktop', origin: config.webOrigins[0]! },
    ])
      expect(
        (await app.inject({ url: '/api/v1/project-categories', headers: badHeaders })).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/project-categories',
          headers: { origin: config.webOrigins[0], cookie: 'tyde_session=demo' },
        })
      ).statusCode,
    ).toBe(200);
    expect(authenticate).toHaveBeenLastCalledWith('demo', 'web');
    authenticate.mockResolvedValue({ ...principal, role: 'EXPERT' });
    expect(
      (
        await app.inject({
          url: '/api/v1/project-categories',
          headers: { ...headers, 'x-management-role': 'NAVIGATOR' },
        })
      ).json(),
    ).toEqual({ code: 403, message: '请切换到对应业务角色', data: null });
    authenticate.mockRejectedValue(new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录'));
    expect((await app.inject('/api/v1/project-categories')).json()).toEqual({
      code: 401,
      message: '登录已过期，请重新登录',
      data: null,
    });
  } finally {
    await app.close();
  }
});
test('project OpenAPI documents every parameter and complete examples validate and serialize', async () => {
  const { db } = setup();
  const app = await createApp(config, db);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    for (const path of [
      '/api/v1/project-categories',
      '/api/v1/project-requesters/{requesterType}/{requesterId}/backfill',
    ]) {
      const operation = spec.paths[path].get;
      expect(operation.description).toContain('当前NAVIGATOR');
      expect(operation.security).toEqual([{ webSession: [] }, { desktopSession: [] }]);
      for (const parameter of operation.parameters)
        expect(parameter.description).toMatch(/[\u3400-\u9fff]/u);
    }
    for (const schema of [
      categoryQuery,
      categoryItem,
      categoriesResponse,
      requesterParams,
      requesterResponse,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples) expect(validate(example)).toBe(true);
    }
    const media =
      spec.paths['/api/v1/project-requesters/{requesterType}/{requesterId}/backfill'].get.responses[
        '200'
      ].content['application/json'];
    const example =
      media.example ?? Object.values(media.examples).map((v) => (v as { value: unknown }).value)[0];
    expect(example).toEqual({
      code: 200,
      message: '操作成功',
      data: requesterResponse.examples[0],
    });
  } finally {
    await app.close();
  }
});
