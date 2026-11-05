import type { Prisma, PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import {
  projectCardExample,
  projectCardsResponse,
} from '../../src/modules/projects/project-list.schema.js';
import {
  cardMainNode,
  ProjectListService,
  visibleCard,
  type ProjectCardRow,
} from '../../src/modules/projects/project-list.service.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'PM',
  sessionId: 'session',
  clientType: 'desktop',
};
const row: ProjectCardRow = {
  id: 3001,
  projectNo: 'P1',
  projectName: '项目',
  projectDescription: null,
  currentNodeCode: 'PRODUCTION_PLAN',
  branchNodeCode: null,
  requesterName: '需求人',
  creatorId: principal.userId,
  creatorName: '创建人',
  projectManagerId: principal.userId,
  projectManagerName: '策略官',
  activeExpertCount: 2n,
  requiredHeadcount: 20,
  deadline: null,
  createdAt: new Date('2026-10-21T02:00:00Z'),
  updatedAt: new Date('2026-10-21T03:00:00Z'),
  primaryProjectManager: true,
  expertRecruitmentHandler: false,
  needAssistGrading: false,
};
afterEach(() => vi.restoreAllMocks());
function setup(rows: ProjectCardRow[] = [row]) {
  const tx = {
    managementGrant: { findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }) },
    $queryRaw: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
    projectCategoryRelation: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const db = {
    $disconnect: vi.fn(),
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { tx, db, service: new ProjectListService(db as unknown as PrismaClient) };
}
test('card visibility distinguishes navigator, primary and handler and completed is a hard terminal', () => {
  for (const currentNodeCode of [
    'RECRUIT_PROJECT_MANAGER',
    'PRODUCTION_PLAN',
    'ENTRANCE_EXAM',
    'STANDARD_TRAINING',
    'RECRUIT_EXECUTION_EXPERT',
    'PERSONNEL_MANAGEMENT',
    'PRODUCTION_TASK',
    'COMPLETED',
  ]) {
    const source = { ...row, currentNodeCode };
    expect(visibleCard(source, 'NAVIGATOR')).toBe(currentNodeCode === 'RECRUIT_PROJECT_MANAGER');
    expect(visibleCard(source, 'PM')).toBe(
      [
        'PRODUCTION_PLAN',
        'ENTRANCE_EXAM',
        'STANDARD_TRAINING',
        'RECRUIT_EXECUTION_EXPERT',
      ].includes(currentNodeCode),
    );
    expect(
      visibleCard(
        { ...source, primaryProjectManager: false, expertRecruitmentHandler: true },
        'PM',
      ),
    ).toBe(currentNodeCode === 'RECRUIT_EXECUTION_EXPERT');
    expect(visibleCard({ ...source, branchNodeCode: 'SUBTASK_ACCEPTANCE' }, 'NAVIGATOR')).toBe(
      currentNodeCode !== 'COMPLETED',
    );
    expect(
      visibleCard(
        {
          ...source,
          primaryProjectManager: false,
          expertRecruitmentHandler: true,
          branchNodeCode: 'EXPERT_RECRUITMENT_RETRY',
        },
        'PM',
      ),
    ).toBe(currentNodeCode !== 'COMPLETED');
  }
});
test('historical null nodes fall back without changing source records', () => {
  const source = { ...row, currentNodeCode: null };
  expect(cardMainNode(source)).toBe('PRODUCTION_PLAN');
  expect(cardMainNode({ ...source, projectManagerId: null })).toBe('RECRUIT_PROJECT_MANAGER');
  expect(source.currentNodeCode).toBeNull();
});
test('grant failure and actual empty candidates avoid all enrichment; no login role grants management', async () => {
  const { tx, service } = setup([]);
  tx.managementGrant.findFirst.mockResolvedValueOnce(null as never);
  await expect(service.list('PM', { ...principal, role: 'EXPERT' })).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  expect(await service.list('NAVIGATOR', { ...principal, role: 'NAVIGATOR' })).toEqual([]);
  expect(tx.projectCategoryRelation.findMany).not.toHaveBeenCalled();
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
});
test('list SQL binds identity, scopes snapshot by perspective, and reads actual reviewer sources', async () => {
  const { tx, service } = setup([]);
  await service.list('NAVIGATOR', { ...principal, role: 'NAVIGATOR', uid: "creator' OR true--" });
  const sql = tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql;
  expect(sql.text).not.toContain("creator' OR true--");
  expect(sql.values).toContain("creator' OR true--");
  expect(sql.text).toContain('"ProjectRoleNodeSnapshot"');
  expect(sql.text).toContain('"EntranceExamGradingRound"');
  expect(sql.text).toContain('"currentVersionId"');
  expect(sql.text).toContain('"gradingMode"=\'MANUAL\'');
  expect(sql.text).toContain('"reviewersJson" @>');
  expect(sql.text).toContain('ORDER BY p."updatedAt" DESC,p."id" DESC');
});
test('batch enrichment preserves categories and owner records, omits internal keys and uses active row counts', async () => {
  const { tx, db, service } = setup();
  tx.projectCategoryRelation.findMany.mockResolvedValue([
    { projectId: 3001, categoryLevel: 3, categoryNameSnapshot: '图片' },
    { projectId: 3001, categoryLevel: 3, categoryNameSnapshot: '商品' },
  ] as never);
  tx.$queryRaw.mockResolvedValueOnce([
    { projectId: 3001, userId: principal.userId, name: '负责人', avatarUrl: null },
  ] as never);
  const result = await service.list('PM', principal);
  expect(result[0]).toMatchObject({
    categoryLevel3Names: ['图片', '商品'],
    categoryDisplayName: '图片、商品',
    activeExpertCount: 2,
    primaryProjectManager: true,
    expertRecruitmentHandler: false,
    createdAt: '2026-10-21 10:00:00',
    updatedAt: '2026-10-21 11:00:00',
    projectOwners: [{ userId: principal.userId, name: '负责人', avatarUrl: null }],
  });
  expect(result[0]!.projectOwners[0]).not.toHaveProperty('projectId');
  expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  expect(tx.projectCategoryRelation.findMany).toHaveBeenCalledTimes(1);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
test('owner query retains any-row suppression of legacy fallback and query errors propagate rather than hiding projects', async () => {
  const { tx, service } = setup();
  tx.$queryRaw.mockRejectedValueOnce(new Error('owner source failed'));
  await expect(service.list('PM', principal)).rejects.toThrow('owner source failed');
  const sql = tx.$queryRaw.mock.calls[1]![0] as Prisma.Sql;
  expect(sql.text).toContain('NOT EXISTS');
  expect(sql.text).toContain('UNION ALL');
  expect(sql.text).toContain('"subjectType"=\'ORGANIZATION\'');
});
test('navigator presentation omits manager flags and recruitment handler never inherits a recruit button from a legacy node', async () => {
  const { service } = setup([{ ...row, currentNodeCode: null, projectManagerId: null }]);
  const result = await service.list('NAVIGATOR', { ...principal, role: 'NAVIGATOR' });
  expect(result[0]).toMatchObject({
    workbenchStatus: 'PENDING',
    currentAction: 'RECRUIT_PROJECT_MANAGER',
    categoryDisplayName: '未分类项目',
  });
  expect(result[0]).not.toHaveProperty('primaryProjectManager');
  const handler = setup([
    {
      ...row,
      currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
      branchNodeCode: 'EXPERT_RECRUITMENT_RETRY',
      primaryProjectManager: false,
      expertRecruitmentHandler: true,
    },
  ]);
  expect((await handler.service.list('PM', principal))[0]!.currentAction).toBe('VIEW_DETAIL');
});
test('list HTTP and OpenAPI preserve paths, roles, full examples and nested serialization without numeric-path capture', async () => {
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
  const list = vi
    .spyOn(ProjectListService.prototype, 'list')
    .mockImplementation(
      async (role) =>
        (role === 'PM' ? projectCardsResponse.examples[1] : [projectCardExample]) as never,
    );
  const app = await createApp(config, db as unknown as PrismaClient);
  try {
    await app.ready();
    const validate = app.validatorCompiler!({
      schema: projectCardsResponse,
      method: 'GET',
      url: '/example',
      httpPart: 'body',
    });
    for (const example of projectCardsResponse.examples)
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    const headers = { authorization: 'Bearer token' };
    for (const [url, role] of [
      ['/api/v1/projects/list', 'NAVIGATOR'],
      ['/api/v1/projects/manager/list', 'PM'],
    ] as const) {
      const response = await app.inject({ url, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(
        role === 'PM' ? projectCardsResponse.examples[1] : [projectCardExample],
      );
      expect(list).toHaveBeenLastCalledWith(role, principal);
    }
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/projects/list'].get.operationId).toBe('listOwnedProjects');
    expect(spec.paths['/api/v1/projects/manager/list'].get.operationId).toBe('listManagedProjects');
  } finally {
    await app.close();
  }
});
