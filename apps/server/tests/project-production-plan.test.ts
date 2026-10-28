import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => undefined),
}));
import * as taskRounds from '../src/modules/projects/project-task-rounds.js';
import {
  ProjectProductionPlanService,
  buildProductionPlan,
  nodeAfterPlan,
  type ProductionPlanInput,
} from '../src/modules/projects/project-production-plan.service.js';
import {
  productionPlanBody,
  productionPlanResponse,
  productionPlanQuery,
  productionPlanExample,
} from '../src/modules/projects/project-production-plan.schema.js';
const now = new Date('2099-01-01T16:00:00Z');
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({ cardChangedRecipients: [] })),
}));
const input = (): ProductionPlanInput =>
  structuredClone(productionPlanExample) as ProductionPlanInput;
afterEach(() => vi.restoreAllMocks());
test('plan calculates inclusive weekdays, manual days and decimal outputs without floating point multiplication', () => {
  const value = input();
  value.operatorCpd = 0.1;
  value.stages = [
    {
      stageName: ' 自动 ',
      startDate: '2099-01-05',
      endDate: '2099-01-11',
      operatorHeadcount: 3,
      workdayCountSource: 'AUTO',
      workdayCount: 99,
    },
    {
      stageName: '手工',
      startDate: '2099-01-05',
      endDate: '2099-01-05',
      operatorHeadcount: 2,
      operatorCpd: 0.2,
      workdayCountSource: 'MANUAL',
      workdayCount: 10,
    },
  ];
  const plan = buildProductionPlan(value, now);
  expect(plan.stages[0]).toMatchObject({
    sequenceNo: 1,
    stageName: '自动',
    naturalDayCount: 7,
    workdayCount: 5,
  });
  expect(plan.stages[0]!.expectedOutput.toString()).toBe('1.5');
  expect(plan.stages[1]!.expectedOutput.toString()).toBe('4');
  expect(plan.totalExpectedOutput.toString()).toBe('5.5');
  expect(plan.crowds[0]!.sequenceNo).toBe(1);
});
test('defaults include explicit null flags and null stage CPD but not missing stage headcount', () => {
  const value = input();
  value.needWrittenExam = null;
  value.maxActiveExamCount = null;
  value.needInterview = null;
  const result = buildProductionPlan(value, now);
  expect(result).toMatchObject({
    needWrittenExam: true,
    maxActiveExamCount: 1,
    needInterview: false,
  });
  expect(result.stages[0]!.operatorCpd.toString()).toBe('500.25');
  value.stages[0]!.operatorHeadcount = undefined as never;
  expect(() => buildProductionPlan(value, now)).toThrow('阶段作业人数');
});
test('Shanghai day boundary, calendar normalization and weekend-only AUTO are validated', () => {
  const value = input();
  value.stages = [
    {
      stageName: '当天',
      startDate: '2099-01-02',
      endDate: '2099-01-02',
      operatorHeadcount: 1,
      workdayCountSource: 'MANUAL',
      workdayCount: 1,
    },
  ];
  expect(() => buildProductionPlan(value, now)).not.toThrow();
  expect(() => buildProductionPlan(value, new Date('2099-01-02T16:00:00Z'))).toThrow(
    '开始日期早于',
  );
  value.stages[0]!.startDate = '2099-02-30';
  expect(() => buildProductionPlan(value, now)).toThrow('日期不合法');
  value.stages = [
    { stageName: '周末', startDate: '2099-01-03', endDate: '2099-01-04', operatorHeadcount: 1 },
  ];
  expect(() => buildProductionPlan(value, new Date('2030-01-01Z'))).toThrow('有效生产天数');
});
test.each([
  { inspectorCpd: null },
  { operatorHeadcount: 0 },
  { operatorCpd: 0.00001 },
  { operatorCpd: 1e16 },
  { maxActiveExamCount: 0 },
  { crowds: [] },
  { stages: [] },
])('invalid plan inputs cannot produce persistence data: %j', (patch) => {
  expect(() => buildProductionPlan({ ...input(), ...patch }, now)).toThrow();
});
test.each([
  { accuracyRate: 100.0001 },
  { workdayCountSource: 'MANUAL', workdayCount: null },
  { workdayCount: 0 },
  { operatorCpd: -1 },
  { stageName: ' ' },
  { endDate: '2099-01-01' },
])('invalid stage inputs are rejected: %j', (patch) => {
  const value = input();
  Object.assign(value.stages[0]!, patch);
  expect(() => buildProductionPlan(value, now)).toThrow();
});
test('late plan completion advances missing/earlier nodes and never regresses later nodes', () => {
  expect(nodeAfterPlan(null, true)).toBe('ENTRANCE_EXAM');
  expect(nodeAfterPlan('RECRUIT_PROJECT_MANAGER', false)).toBe('STANDARD_TRAINING');
  expect(nodeAfterPlan('STANDARD_TRAINING', true)).toBe('STANDARD_TRAINING');
  expect(nodeAfterPlan('COMPLETED', false)).toBe('COMPLETED');
});
test('schema examples validate and actual HTTP serialization preserves nested fields, query placement and origin rules', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  const principal: AuthPrincipal = {
    userId: '00000000-0000-4000-8000-000000000001',
    uid: '100001',
    sessionId: 'session',
    role: 'EXPERT',
    clientType: 'desktop',
  };
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const get = vi
    .spyOn(ProjectProductionPlanService.prototype, 'get')
    .mockResolvedValue(productionPlanResponse.examples[0] as never);
  const confirm = vi
    .spyOn(ProjectProductionPlanService.prototype, 'confirm')
    .mockResolvedValue(productionPlanResponse.examples[0] as never);
  const db = new PrismaClient();
  const app = await createApp(config, db);
  try {
    await app.ready();
    for (const schema of [productionPlanBody, productionPlanResponse, productionPlanQuery]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const headers = { authorization: 'Bearer token' };
    const response = await app.inject({
      url: '/api/v1/projects/production-plan?projectId=3001',
      headers,
    });
    expect(response.json()).toEqual({
      code: 200,
      message: '操作成功',
      data: productionPlanResponse.examples[0],
    });
    expect(get).toHaveBeenCalledWith(3001, principal);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/production-plan/confirm?projectId=3001',
          headers,
          payload: input(),
        })
      ).statusCode,
    ).toBe(200);
    expect(confirm).toHaveBeenCalledWith(3001, input(), principal);
    for (const id of ['0', '-1', '1.5', '2147483648', 'abc'])
      expect(
        (await app.inject({ url: `/api/v1/projects/production-plan?projectId=${id}`, headers }))
          .statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/production-plan/confirm',
          headers,
          payload: { ...input(), projectId: 3001 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/production-plan/confirm?projectId=3001',
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: input(),
        })
      ).statusCode,
    ).toBe(403);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/projects/production-plan/confirm'].post.parameters[0]).toMatchObject(
      { in: 'query', name: 'projectId', required: true },
    );
  } finally {
    await app.close();
  }
});

test('large valid decimal products retain all database digits before JSON conversion', () => {
  const value = input();
  value.operatorCpd = 1234567890123.456;
  value.stages = [
    {
      stageName: '高产能',
      startDate: '2099-01-05',
      endDate: '2099-01-05',
      operatorHeadcount: 123456789,
      workdayCountSource: 'MANUAL',
      workdayCount: 100,
    },
  ];
  expect(buildProductionPlan(value, now).totalExpectedOutput.toFixed(4)).toBe(
    '15241578751714669134278.4000',
  );
});

// 验证服务事务内的写入顺序、静默约束与仲裁异常传播。
test.each(['cards', 'rounds'])(
  'plan confirmation propagates %s failure after persisted plan and main rounds',
  async (failure) => {
    const principal = { userId: 'manager', uid: '100001', role: 'PM' } as AuthPrincipal;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      project: {
        findFirst: vi.fn(async () => ({
          id: 3001,
          status: 'PUBLISHED',
          currentNodeCode: 'PRODUCTION_PLAN',
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      projectManagerRecruitment: { findFirst: vi.fn(async () => ({ candidateUserId: 'manager' })) },
      projectProductionPlan: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          throw new Error('unexpected persistence');
        }),
      },
      projectEventOutbox: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaClient;
    const service = new ProjectProductionPlanService(db);
    vi.spyOn(service.management, 'requireRole').mockResolvedValue(undefined);
    vi.spyOn(taskRounds, 'collectManagementTasks').mockResolvedValue({ scopes: [], sources: [] });
    const reconcile = vi.spyOn(taskRounds, 'reconcileTaskRounds').mockResolvedValue(undefined);
    tx.projectProductionPlan.create.mockImplementation(
      async () =>
        ({
          ...buildProductionPlan(input()),
          id: 1,
          confirmedAt: new Date(),
          projectId: 3001,
          confirmedBy: principal.uid,
        }) as never,
    );
    const fail = failure === 'cards' ? refreshManagementCardSnapshots : refreshOwnerProgress;
    const cardCalls = vi.mocked(refreshManagementCardSnapshots).mock.calls.length;
    vi.mocked(fail).mockRejectedValueOnce(new Error('plan card source failed'));
    await expect(service.confirm(3001, input(), principal)).rejects.toThrow(
      'plan card source failed',
    );
    expect(refreshOwnerProgress).toHaveBeenLastCalledWith(tx, 3001, null, expect.any(Date));
    const refreshOrder = vi.mocked(refreshOwnerProgress).mock.invocationCallOrder.at(-1)!;
    if (failure === 'cards') {
      expect(refreshManagementCardSnapshots).toHaveBeenLastCalledWith(tx, 3001, expect.any(Date));
      expect(refreshOrder).toBeLessThan(
        vi.mocked(refreshManagementCardSnapshots).mock.invocationCallOrder.at(-1)!,
      );
    } else expect(vi.mocked(refreshManagementCardSnapshots).mock.calls).toHaveLength(cardCalls);
    expect(tx.projectProductionPlan.create.mock.invocationCallOrder[0]).toBeLessThan(refreshOrder);
    expect(tx.project.updateMany.mock.invocationCallOrder[0]).toBeLessThan(refreshOrder);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(refreshOrder);
    expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
  },
);
