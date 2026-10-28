import { request as httpRequest } from 'node:http';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import {
  boardBasicScope,
  ProjectBoardService,
} from '../src/modules/projects/project-board.service.js';
import {
  boardBasicBody,
  boardBasicDetail,
  boardBasicExample,
} from '../src/modules/projects/project-board.schema.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'NAVIGATOR',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    ...boardBasicExample,
    id: 3001,
    requesterType: 'INDIVIDUAL',
    requesterName: '原名称',
    requester: { displayName: ' 新昵称 ', realName: ' 新姓名 ' },
    projectQuantity: new Prisma.Decimal('10.1256'),
    deadline: null,
    publishedAt: new Date('2026-10-26T02:00:00Z'),
    closedAt: null,
    categories: [
      { categoryLevel: 1, categoryId: 11, categoryNameSnapshot: '原一级' },
      { categoryLevel: 2, categoryId: 21, categoryNameSnapshot: '原二级' },
      { categoryLevel: 3, categoryId: 32, categoryNameSnapshot: '原标签乙' },
      { categoryLevel: 3, categoryId: 31, categoryNameSnapshot: '原标签甲' },
    ],
    extJson: { private: 'secret' },
    versionNo: 20,
  };
  const tx = { project: { findFirst: vi.fn().mockResolvedValue(project) } };
  const db = {
    $disconnect: vi.fn(),
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { tx, db, project, service: new ProjectBoardService(db as unknown as PrismaClient) };
}
test('board basic detail uses creator scope in one read snapshot and returns only legacy basic fields with current name and category snapshots', async () => {
  const { tx, db, service } = setup();
  const data = await service.basicDetail(3001, principal);
  expect(data).toMatchObject({
    projectId: 3001,
    requesterName: '新昵称(新姓名)',
    projectQuantity: 10.1256,
    publishedAt: '2026-10-26 10:00:00',
    closedAt: null,
    categoryLevel1Name: '原一级',
    categoryLevel2Name: '原二级',
    categoryLevel3Ids: [32, 31],
    categoryLevel3Names: ['原标签乙', '原标签甲'],
  });
  expect(Object.keys(data).sort()).toEqual(boardBasicDetail.required.slice().sort());
  expect(tx.project.findFirst.mock.calls[0]![0]).toMatchObject({
    where: { id: 3001, deleted: false, AND: [{ createdBy: principal.uid }] },
    include: {
      categories: { orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }] },
    },
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
test('board basic detail preserves organization snapshot and empty category arrays, supports blank personal name fallback and nullable dates', async () => {
  const { project, service } = setup();
  project.requesterType = 'ORGANIZATION';
  project.categories = [];
  expect(await service.basicDetail(3001, principal)).toMatchObject({
    requesterName: '原名称',
    categoryLevel1Id: null,
    categoryLevel2Name: null,
    categoryLevel3Ids: [],
    categoryLevel3Names: [],
    deadline: null,
  });
  project.requesterType = 'INDIVIDUAL';
  project.requester = { displayName: ' ', realName: '' };
  expect((await service.basicDetail(3001, principal)).requesterName).toBe('原名称');
});
test('board basic PM scope distinguishes pending candidate from assigned handler and never trusts a user supplied role', () => {
  expect(boardBasicScope({ ...principal, role: 'PM' })).toEqual({
    managerRecruitments: {
      some: {
        OR: [
          { candidateUserId: principal.userId, status: { in: ['PENDING_ACCEPTANCE', 'ASSIGNED'] } },
          { expertRecruitmentHandlerUserId: principal.userId, status: 'ASSIGNED' },
        ],
      },
    },
  });
  expect(() => boardBasicScope({ ...principal, role: 'OPS' } as unknown as AuthPrincipal)).toThrow(
    '当前角色无权',
  );
});
test('board basic expert scope binds organization membership and assignment, rejects removed-owner fallback and excludes individual assignments', () => {
  const scope = boardBasicScope({ ...principal, role: 'EXPERT' });
  expect(scope).toMatchObject({
    expertAssignments: {
      some: {
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
        organization: {
          deleted: false,
          memberships: {
            some: {
              userId: principal.userId,
              joinStatus: { in: ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'] },
            },
          },
        },
        OR: [
          {
            organization: {
              memberships: { some: { position: 'OWNER', userId: principal.userId } },
            },
          },
          { owners: { some: { userId: principal.userId, status: 'ACTIVE' } } },
          { projectOwnerUserId: principal.userId, owners: { none: {} } },
        ],
      },
    },
  });
});
test('board basic absence and logical deletion have same 403, bad IDs stop before transaction', async () => {
  const { tx, db, service } = setup();
  for (const id of [0, -1, 1.5, 2147483648, NaN])
    await expect(service.basicDetail(id, principal)).rejects.toMatchObject({ status: 400 });
  expect(db.$transaction).not.toHaveBeenCalled();
  tx.project.findFirst.mockResolvedValue(null);
  await expect(service.basicDetail(3001, principal)).rejects.toMatchObject({ status: 403 });
});
test('board basic HTTP validates examples, serializes exact legacy fields and authenticates current session and source', async () => {
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
    .spyOn(ProjectBoardService.prototype, 'basicDetail')
    .mockResolvedValue({ ...boardBasicExample, extJson: 'hidden' } as never);
  const app = await createApp(config, db as unknown as PrismaClient);
  const url = '/api/v1/projects/workbench/board/project-detail';
  const headers = { authorization: 'Bearer token' };
  try {
    await app.ready();
    for (const schema of [boardBasicBody, boardBasicDetail]) {
      const validate = app.validatorCompiler!({ schema, method: 'POST', url, httpPart: 'body' });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { projectId: 3001 },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ code: 200, message: '操作成功', data: boardBasicExample });
    expect(details).toHaveBeenCalledWith(3001, principal);
    for (const payload of [{}, { projectId: 0 }, { projectId: 1.5 }, { projectId: 2147483648 }])
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: { projectId: 3001 },
        })
      ).statusCode,
    ).toBe(403);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[url].post.operationId).toBe('getProjectBoardBasicDetail');
  } finally {
    await app.close();
  }
});

test('native HTTP desktop headers reach authentication as 401; fetch browser metadata remains 403 before authentication', async () => {
  const { db } = setup();
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  // 构造真实node:http出站头后立即销毁，不建立外部连接或发送请求。
  const outgoing = httpRequest('http://127.0.0.1:65534/', {
    method: 'POST',
    headers: { 'x-tyde-client': 'desktop', 'content-type': 'application/json' },
  });
  outgoing.on('error', () => {});
  const headers = outgoing.getHeaders();
  outgoing.destroy();
  expect(Object.keys(headers).some((key) => key.startsWith('sec-fetch-'))).toBe(false);
  const app = await createApp(config, db as unknown as PrismaClient);
  try {
    const input = {
      method: 'POST' as const,
      url: '/api/v1/projects/workbench/board/project-detail',
      payload: { projectId: 3001 },
    };
    // 使用真实认证，匿名请求不会访问数据库；不能把来源校验403当作认证401。
    const anonymous = await app.inject({ ...input, headers });
    expect(anonymous.statusCode, anonymous.body).toBe(401);
    const browser = await app.inject({
      ...input,
      headers: { ...headers, 'sec-fetch-mode': 'cors' },
    });
    expect(browser.statusCode, browser.body).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
