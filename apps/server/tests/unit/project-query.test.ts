import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import {
  projectDetailParams,
  projectProductionRequirements,
  projectPublishedDetail,
  projectPublishedExample,
} from '../../src/modules/projects/project-query.schema.js';
import { ProjectQueryService } from '../../src/modules/projects/project-query.service.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'EXPERT',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    ...projectPublishedExample,
    createdBy: 'creator',
    deleted: false,
    projectQuantity: new Prisma.Decimal(10000),
    deadline: new Date('2099-12-31T15:59:59Z'),
    createdAt: new Date('2026-10-20T04:00:00Z'),
    updatedAt: new Date('2026-10-20T04:00:00Z'),
    categories: [{ categoryLevel: 3, categoryId: 31, categoryNameSnapshot: '原标签', sortNo: 0 }],
    attachments: [],
  };
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue(project) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ displayName: ' 新昵称 ', realName: ' 新姓名 ' }),
    },
    managementGrant: { findFirst: vi.fn().mockResolvedValue(null) },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue(null) },
    projectMember: { findFirst: vi.fn().mockResolvedValue(null) },
    projectProductionPlan: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const db = {
    ...tx,
    $disconnect: vi.fn(),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx, project, service: new ProjectQueryService(db as unknown as PrismaClient) };
}
test('NAVIGATOR detail requires both creator relationship and live independent grant; reads a consistent snapshot without a plan query', async () => {
  const { tx, db, service } = setup();
  tx.managementGrant.findFirst.mockResolvedValue({ userId: principal.userId } as never);
  const result = await service.detail(3001, { ...principal, role: 'NAVIGATOR' });
  expect(result).toMatchObject({
    creatorName: '新昵称(新姓名)',
    requesterName: '新昵称(新姓名)',
    categoryLevel1Id: null,
    categoryLevel3Ids: [31],
    categoryLevel3Names: ['原标签'],
    projectQuantity: 10000,
    deadline: '2099-12-31 23:59:59',
  });
  expect(result).not.toHaveProperty('productionRequirements');
  expect(tx.projectProductionPlan.findUnique).not.toHaveBeenCalled();
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  tx.managementGrant.findFirst.mockResolvedValue(null);
  await expect(service.detail(3001, principal)).rejects.toMatchObject({ status: 403 });
});
test('current PM/handler relation plus grant permits management scope; an unrelated grant and replaced relation cannot', async () => {
  const { tx, project, service } = setup();
  project.createdBy = 'other';
  tx.managementGrant.findFirst.mockResolvedValue({ userId: principal.userId } as never);
  tx.projectManagerRecruitment.findFirst.mockResolvedValue({ id: 1 } as never);
  expect(await service.detail(3001, { ...principal, role: 'PM' })).not.toHaveProperty(
    'productionRequirements',
  );
  expect(tx.projectManagerRecruitment.findFirst).toHaveBeenCalledWith({
    where: {
      projectId: 3001,
      status: 'ASSIGNED',
      OR: [
        { candidateUserId: principal.userId },
        { expertRecruitmentHandlerUserId: principal.userId },
      ],
    },
    select: { id: true },
  });
  tx.projectManagerRecruitment.findFirst.mockResolvedValue(null);
  await expect(service.detail(3001, principal)).rejects.toMatchObject({ status: 403 });
});
test('actual ACTIVE MEMBER has expert requirements, empty-plan shape and does not inherit authorization from role or organization', async () => {
  const { tx, project, service } = setup();
  project.createdBy = 'other';
  tx.projectMember.findFirst.mockResolvedValue({ id: 1 } as never);
  const result = await service.detail(3001, principal);
  expect(result).toHaveProperty(
    'productionRequirements',
    projectProductionRequirements.examples[0],
  );
  expect(tx.projectMember.findFirst).toHaveBeenCalledWith({
    where: { projectId: 3001, userId: principal.userId, projectRole: 'MEMBER', status: 'ACTIVE' },
    select: { id: true },
  });
  tx.projectMember.findFirst.mockResolvedValue(null);
  await expect(service.detail(3001, principal)).rejects.toMatchObject({ status: 403 });
});
test('expert requirements include only plan totals and ordered stage values; no crowds, examiner flags, audit or extJson', async () => {
  const { tx, project, service } = setup();
  project.createdBy = 'other';
  tx.projectMember.findFirst.mockResolvedValue({ id: 1 } as never);
  tx.projectProductionPlan.findUnique.mockResolvedValue({
    id: 7001,
    operatorHeadcount: 20,
    operatorCpd: new Prisma.Decimal('500.25'),
    inspectorHeadcount: null,
    inspectorCpd: null,
    totalExpectedOutput: new Prisma.Decimal('50025'),
    confirmedBy: 'private',
    extJson: { secret: true },
    stages: [],
  } as never);
  const result = await service.detail(3001, principal);
  expect(result).toHaveProperty('productionRequirements', {
    hasPlan: true,
    planId: 7001,
    operatorHeadcount: 20,
    operatorCpd: 500.25,
    inspectorHeadcount: null,
    inspectorCpd: null,
    totalExpectedOutput: 50025,
    crowds: null,
    stages: [],
  });
  expect(tx.projectProductionPlan.findUnique).toHaveBeenCalledWith({
    where: { projectId: 3001 },
    include: { stages: { orderBy: { sequenceNo: 'asc' } } },
  });
});
test('management relationship takes priority for a user also holding an expert membership; creator fallback never overwrites organization snapshot', async () => {
  const { tx, project, service } = setup();
  project.requesterType = 'ORGANIZATION';
  project.requesterName = '组织快照';
  tx.managementGrant.findFirst.mockResolvedValue({ userId: principal.userId } as never);
  tx.projectMember.findFirst.mockResolvedValue({ id: 1 } as never);
  tx.user.findUnique.mockResolvedValue({ displayName: ' ', realName: null } as never);
  const result = await service.detail(3001, { ...principal, role: 'NAVIGATOR' });
  expect(result).toMatchObject({ requesterName: '组织快照', creatorName: '组织快照' });
  expect(result).not.toHaveProperty('productionRequirements');
  expect(tx.projectMember.findFirst).not.toHaveBeenCalled();
});
test('deleted/draft/nonexistent project is excluded before any relation lookup', async () => {
  const { tx, service } = setup();
  tx.project.findFirst.mockResolvedValue(null);
  await expect(service.detail(3001, principal)).rejects.toMatchObject({ status: 404 });
  expect(tx.project.findFirst.mock.calls[0]![0]).toMatchObject({
    where: { id: 3001, deleted: false, status: 'PUBLISHED' },
  });
  expect(tx.projectMember.findFirst).not.toHaveBeenCalled();
});
test('detail HTTP and OpenAPI validate full examples, retain optional expert field and preserve exact paths and source checks', async () => {
  const { db } = setup();
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const details = vi
    .spyOn(ProjectQueryService.prototype, 'detail')
    .mockResolvedValue(projectPublishedExample as never);
  const app = await createApp(config, db as unknown as PrismaClient);
  try {
    await app.ready();
    for (const schema of [
      projectPublishedDetail,
      projectProductionRequirements,
      projectDetailParams,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'GET',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const headers = { authorization: 'Bearer token' };
    expect((await app.inject({ url: '/api/v1/projects/3001', headers })).json()).toEqual({
      code: 200,
      message: '操作成功',
      data: projectPublishedExample,
    });
    expect(details).toHaveBeenCalledWith(3001, principal);
    details.mockResolvedValue({
      ...projectPublishedExample,
      productionRequirements: projectProductionRequirements.examples[0],
    } as never);
    expect(
      (await app.inject({ url: '/api/v1/projects/3001', headers })).json().data
        .productionRequirements,
    ).toEqual(projectProductionRequirements.examples[0]);
    for (const id of ['0', '-1', '1.5', '2147483648', 'abc'])
      expect((await app.inject({ url: `/api/v1/projects/${id}`, headers })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: '/api/v1/projects/3001',
          headers: { ...headers, origin: 'https://untrusted.example' },
        })
      ).statusCode,
    ).toBe(403);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/projects/{projectId}'].get.operationId).toBe(
      'getPublishedProjectDetail',
    );
  } finally {
    await app.close();
  }
});
