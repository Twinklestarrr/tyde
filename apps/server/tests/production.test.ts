import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { validateTask } from '../src/modules/production/production-domain.js';
import { ProductionService } from '../src/modules/production/production.service.js';
import {
  membersBody,
  membersResponse,
  createBody,
  listBody,
  listResponse,
  memberExample,
  taskExample,
} from '../src/modules/production/production.schema.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const principal: AuthPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  uid: '123456',
  role: 'PM',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
const now = new Date('2026-10-26T16:00:00Z');
const input = {
  projectId: 1,
  subtaskName: ' 首批 ',
  expectedDeliveryDate: '2026-10-27',
  expectedQuantity: 0.0001,
  distributionMode: 'DESIGNATED' as const,
  memberIds: [3, 1, 3],
};
test('production validates Shanghai date boundary, quantity precision, mode consistency and deduplicates member IDs', () => {
  expect(
    validateTask({ ...input, expectedQuantity: '99999999999999999999999999.1234' }, now).quantity,
  ).toBe('99999999999999999999999999.1234');
  expect(validateTask({ ...input, expectedQuantity: 1e25 }, now).quantity).toBe(
    '10000000000000000000000000',
  );
  expect(validateTask(input, now)).toEqual({ name: '首批', quantity: '0.0001', ids: [1, 3] });
  for (const change of [
    { subtaskName: ' ' },
    { expectedDeliveryDate: '2026-10-26' },
    { expectedDeliveryDate: '2026-02-30' },
    { expectedQuantity: 0 },
    { expectedQuantity: 1.12345 },
    { expectedQuantity: Infinity },
    { memberIds: [] },
    { memberIds: [-1] },
    { distributionMode: 'POOL' as const },
  ])
    expect(() => validateTask({ ...input, ...change }, now)).toThrow();
  expect(validateTask({ ...input, distributionMode: 'POOL', memberIds: null }, now).ids).toEqual(
    [],
  );
});
test('production candidate endpoints enforce current PM identity and collaboration read-only', async () => {
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 1, status: 'PUBLISHED' }) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({
        candidateUserId: 'other',
        expertRecruitmentHandlerUserId: principal.userId,
      }),
    },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue(null) },
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new ProductionService({
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  } as never);
  expect(await service.members({ projectId: 1 }, principal)).toMatchObject({ total: 0 });
  for (const role of ['EXPERT', 'NAVIGATOR'] as const)
    await expect(service.members({ projectId: 1 }, { ...principal, role })).rejects.toMatchObject({
      status: 403,
    });
});
test('production Swagger examples validate and HTTP preserves nested output, null success and rejects extra scope selectors', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  vi.spyOn(ProductionService.prototype, 'members').mockResolvedValue({
    ...memberExample,
    secret: true,
  } as never);
  vi.spyOn(ProductionService.prototype, 'list').mockResolvedValue(taskExample);
  vi.spyOn(ProductionService.prototype, 'create').mockResolvedValue(null);
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
    for (const schema of [membersBody, createBody, listBody, membersResponse, listResponse]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/examples',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [path, body, data] of [
      ['members', { projectId: 1 }, memberExample],
      ['list', { projectId: 1 }, taskExample],
      ['create', createBody.examples[1], null],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/production-tasks/' + path,
        headers: { authorization: 'Bearer token' },
        payload: body,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().data).toEqual(data);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    for (const payload of [
      { projectId: '1' },
      { projectId: 1, size: 101 },
      { projectId: 1, userId: principal.userId },
      { projectId: 1, statuses: ['BAD'] },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/production-tasks/list', payload });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ code: 400, data: null });
    }
    const spec = (await app.inject('/api/v1/docs/json')).json();
    for (const path of ['members', 'create', 'list'])
      expect(spec.paths['/api/v1/production-tasks/' + path].post.operationId).toBeTruthy();
  } finally {
    await app.close();
  }
});
