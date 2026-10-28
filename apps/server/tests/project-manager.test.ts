import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => undefined),
}));
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({
    cardChangedRecipients: [{ userId: 'card-user', role: 'EXPERT' }],
  })),
}));
import type { PrismaClient, Prisma, ProjectTaskRound } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { FileService } from '../src/modules/files/file.service.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import {
  ProjectManagerService,
  type ManagerCandidate,
} from '../src/modules/projects/project-manager.service.js';
import {
  managerCandidatesQuery,
  managerRecruitBody,
  managerCandidate,
  managerCandidates,
  managerRecruitResult,
} from '../src/modules/projects/project-manager.schema.js';
import {
  reconcileTaskRounds,
  taskEventFacts,
  managementTaskTypes,
  type TaskSnapshot,
} from '../src/modules/projects/project-task-rounds.js';
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
  uid: 'creator-uid',
  sessionId: 'session',
  role: 'NAVIGATOR',
  clientType: 'desktop',
};
const candidate = managerCandidate.examples[0] as ManagerCandidate;
const base = {
  id: 3001,
  createdBy: principal.uid,
  status: 'PUBLISHED',
  deleted: false,
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  projectName: '原项目名称',
  versionNo: 7,
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  let assigned: Record<string, unknown> | null = null;
  let project = { ...base };
  const rounds: ProjectTaskRound[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql | TemplateStringsArray) =>
      Array.isArray(sql)
        ? []
        : [
            {
              ...candidate,
              status:
                (sql as Prisma.Sql).values[0] === candidate.userId ? 'CURRENT' : 'RECOMMENDED',
              currentProjectCount: assigned ? 1 : 0,
            },
          ],
    ),
    managementGrant: {
      findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }),
      findMany: vi.fn().mockResolvedValue([
        { userId: principal.userId, role: 'NAVIGATOR' },
        { userId: candidate.userId, role: 'PM' },
      ]),
    },
    user: {
      findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({ id }))),
      findUnique: vi.fn().mockResolvedValue({ id: principal.userId }),
    },
    project: {
      findFirst: vi.fn(async () => project),
      updateMany: vi.fn(async ({ data }) => {
        project = { ...project, ...data };
        return { count: 1 };
      }),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn(async () => assigned),
      create: vi.fn(async ({ data }) => {
        assigned = { id: 5001, ...data };
        return assigned;
      }),
      updateMany: vi.fn(async () => {
        assigned = null;
        return { count: 1 };
      }),
    },
    projectTaskRound: {
      findMany: vi.fn(async () => rounds.filter((r) => r.status === 'OPEN')),
      create: vi.fn(async ({ data }) => {
        const round = { id: rounds.length + 1, finishedAt: null, ...data } as ProjectTaskRound;
        rounds.push(round);
        return round;
      }),
      update: vi.fn(async ({ where, data }) => {
        const index = rounds.findIndex((r) => r.id === where.id);
        rounds[index] = { ...rounds[index]!, ...data };
        return rounds[index]!;
      }),
    },
    projectMemberMovement: { findMany: vi.fn(async () => []) },
    projectEventOutbox: {
      create: vi.fn().mockResolvedValue({ id: 'event-id', status: 'PENDING' }),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return {
    service: new ProjectManagerService(db),
    db,
    tx,
    rounds,
    setAssigned: (row: Record<string, unknown>) => {
      assigned = row;
    },
    setProject: (row: Record<string, unknown>) => {
      project = { ...project, ...row };
    },
  };
}
test('candidate query requires independent NAVIGATOR and own published nondeleted project', async () => {
  const { service, tx, setProject } = setup();
  expect(await service.listCandidates(base.id, ' 小明 ', principal)).toHaveLength(1);
  const sql = tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql;
  expect(sql.sql).not.toContain('"ManagementGrant"');
  expect(sql.sql).toContain('NULLS LAST');
  expect(sql.sql).not.toContain('u."role"');
  expect(sql.values).toContain('%小明%');
  setProject({ createdBy: 'other' });
  await expect(service.listCandidates(base.id, undefined, principal)).rejects.toMatchObject({
    status: 403,
  });
  setProject({ createdBy: principal.uid, status: 'DRAFT' });
  await expect(service.listCandidates(base.id, undefined, principal)).rejects.toMatchObject({
    status: 400,
  });
  tx.project.findFirst.mockResolvedValueOnce(null as never);
  await expect(service.listCandidates(base.id, undefined, principal)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    service.listCandidates(base.id, undefined, { ...principal, role: 'EXPERT' }),
  ).rejects.toMatchObject({
    status: 403,
  });
});
test('first recruit writes assignment, only node fields, completed/open rounds and event facts in one transaction', async () => {
  const { service, db, tx, rounds } = setup();
  const result = await service.recruit(
    { projectId: base.id, candidateUserId: candidate.userId },
    principal,
  );
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect((tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('')).toContain('FOR UPDATE');
  expect(result).toMatchObject({
    recruitmentType: 'INITIAL',
    assignmentMode: 'DIRECT',
    status: 'ASSIGNED',
    currentNodeCode: 'PRODUCTION_PLAN',
    manager: { status: 'CURRENT', currentProjectCount: 1 },
  });
  expect(tx.project.updateMany).toHaveBeenCalledWith({
    where: {
      id: base.id,
      deleted: false,
      status: 'PUBLISHED',
      OR: [{ currentNodeCode: 'RECRUIT_PROJECT_MANAGER' }, { currentNodeCode: null }],
    },
    data: { currentNodeCode: 'PRODUCTION_PLAN', updatedBy: principal.uid },
  });
  expect(rounds).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        userId: principal.userId,
        role: 'NAVIGATOR',
        taskType: 'MAIN_RECRUIT_PROJECT_MANAGER',
        status: 'COMPLETED',
        participated: true,
      }),
      expect.objectContaining({
        userId: candidate.userId,
        role: 'PM',
        taskType: 'MAIN_PRODUCTION_PLAN',
        status: 'OPEN',
        participated: false,
      }),
    ]),
  );
  expect(tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      projectId: base.id,
      eventType: 'PROJECT_TASKS_RECONCILED',
      actorUserId: principal.userId,
      payload: expect.objectContaining({
        schemaVersion: 1,
        cardChangedRecipients: [{ userId: 'card-user', role: 'EXPERT' }],
        projectAudience: expect.arrayContaining([{ userId: candidate.userId, role: 'PM' }]),
      }),
    }),
  });
});
test('replacement preserves later project nodes and keeps the old manager in cancellation audiences', async () => {
  const { service, tx, setAssigned, setProject } = setup();
  const previousUser = '00000000-0000-4000-8000-000000000003';
  setAssigned({ id: 4001, candidateUserId: previousUser, projectId: base.id });
  setProject({ currentNodeCode: 'ENTRANCE_EXAM' });
  tx.managementGrant.findMany.mockResolvedValue([
    { userId: principal.userId, role: 'NAVIGATOR' },
    { userId: previousUser, role: 'PM' },
    { userId: candidate.userId, role: 'PM' },
  ]);
  const result = await service.recruit(
    { projectId: base.id, candidateUserId: candidate.userId },
    principal,
  );
  expect(result).toMatchObject({
    recruitmentType: 'REPLACEMENT',
    currentNodeCode: 'ENTRANCE_EXAM',
    nextStage: 'ENTRANCE_EXAM',
  });
  expect(tx.project.updateMany).not.toHaveBeenCalled();
  expect(tx.projectManagerRecruitment.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ previousManagerUserId: previousUser }),
  });
  const facts = tx.projectEventOutbox.create.mock.calls[0]![0].data.payload;
  expect(facts.projectAudience).toEqual(
    expect.arrayContaining([
      { userId: previousUser, role: 'PM' },
      { userId: candidate.userId, role: 'PM' },
    ]),
  );
  expect(facts.taskChangedRecipients).toEqual(
    expect.arrayContaining([
      { userId: previousUser, role: 'PM' },
      { userId: candidate.userId, role: 'PM' },
    ]),
  );
});
test('reselecting the current manager and a stale first-assignment node are rejected', async () => {
  const { service, tx, setAssigned } = setup();
  setAssigned({ id: 4001, candidateUserId: candidate.userId, projectId: base.id });
  await expect(
    service.recruit({ projectId: base.id, candidateUserId: candidate.userId }, principal),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.projectManagerRecruitment.create).not.toHaveBeenCalled();
  const fresh = setup();
  fresh.tx.project.updateMany.mockResolvedValueOnce({ count: 0 });
  await expect(
    fresh.service.recruit({ projectId: base.id, candidateUserId: candidate.userId }, principal),
  ).rejects.toMatchObject({ status: 409 });
  expect(fresh.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('outbox persistence failure is not swallowed or returned as a successful assignment', async () => {
  const { service, tx } = setup();
  tx.projectEventOutbox.create.mockRejectedValue(new Error('outbox failure'));
  await expect(
    service.recruit({ projectId: base.id, candidateUserId: candidate.userId }, principal),
  ).rejects.toThrow('outbox failure');
});
const scope = (userId: string, role: 'NAVIGATOR' | 'PM', node: string) => ({
  userId,
  role,
  perspective: role === 'NAVIGATOR' ? 'NAVIGATOR' : 'PROJECT_MANAGER',
  currentNodeCode: node,
  mainEligible: true,
  boardVisible: true,
});
test('task reconciliation cancels lost access, preserves participation and leaves uncaptured branch types alone', async () => {
  const { tx, rounds } = setup();
  const old: ProjectTaskRound = {
    id: 1,
    projectId: base.id,
    userId: candidate.userId,
    role: 'PM',
    taskType: 'MAIN_PRODUCTION_PLAN',
    status: 'OPEN',
    participated: true,
    openedAt: new Date(),
    finishedAt: null,
  };
  rounds.push(old);
  const before: TaskSnapshot = {
    scopes: [scope(candidate.userId, 'PM', 'PRODUCTION_PLAN')],
    sources: [
      {
        userId: candidate.userId,
        role: 'PM',
        taskType: 'MAIN_PRODUCTION_PLAN',
        sources: ['PROJECT:3001'],
      },
    ],
  };
  await reconcileTaskRounds(
    tx as unknown as Prisma.TransactionClient,
    base.id,
    before,
    { scopes: [], sources: [] },
    null,
    [],
    [],
    managementTaskTypes,
  );
  expect(rounds[0]).toMatchObject({ status: 'CANCELLED', participated: true });
  expect(tx.projectTaskRound.findMany).toHaveBeenCalledWith({
    where: { projectId: base.id, status: 'OPEN', taskType: { in: managementTaskTypes } },
  });
});
test('source-less explicit completion requires retained role scope and never turns revoked access into completion', async () => {
  const { tx, rounds } = setup();
  const after: TaskSnapshot = {
    scopes: [scope(principal.userId, 'NAVIGATOR', 'PRODUCTION_PLAN')],
    sources: [],
  };
  await reconcileTaskRounds(
    tx as unknown as Prisma.TransactionClient,
    base.id,
    { scopes: [], sources: [] },
    after,
    { userId: principal.userId, role: 'NAVIGATOR' },
    ['MAIN_RECRUIT_PROJECT_MANAGER'],
    ['MAIN_RECRUIT_PROJECT_MANAGER'],
    managementTaskTypes,
  );
  expect(rounds).toHaveLength(1);
  expect(rounds[0]).toMatchObject({ status: 'COMPLETED', participated: true });
  const empty = setup();
  await reconcileTaskRounds(
    empty.tx as unknown as Prisma.TransactionClient,
    base.id,
    { scopes: [], sources: [] },
    { scopes: [], sources: [] },
    { userId: principal.userId, role: 'NAVIGATOR' },
    ['MAIN_RECRUIT_PROJECT_MANAGER'],
    ['MAIN_RECRUIT_PROJECT_MANAGER'],
    managementTaskTypes,
  );
  expect(empty.rounds).toHaveLength(0);
});
test('event audience facts distinguish project access from actual task changes and preserve roles', () => {
  const stable = scope(principal.userId, 'NAVIGATOR', 'PRODUCTION_PLAN');
  const changed = scope(candidate.userId, 'PM', 'PRODUCTION_PLAN');
  expect(
    taskEventFacts({ scopes: [stable, changed], sources: [] }, { scopes: [stable], sources: [] }),
  ).toEqual({
    projectAudience: [
      { userId: principal.userId, role: 'NAVIGATOR' },
      { userId: candidate.userId, role: 'PM' },
    ],
    taskChangedRecipients: [{ userId: candidate.userId, role: 'PM' }],
  });
});
test('manager HTTP and generated OpenAPI preserve strict IDs, field descriptions, examples and Result serialization', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const candidates = vi
    .spyOn(ProjectManagerService.prototype, 'listCandidates')
    .mockResolvedValue(managerCandidate.examples as ManagerCandidate[]);
  vi.spyOn(ProjectManagerService.prototype, 'recruit').mockResolvedValue(
    managerRecruitResult.examples[0] as never,
  );
  const app = await createApp(config, db);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    const get = spec.paths['/api/v1/projects/manager-candidates'].get;
    expect(get.operationId).toBe('getProjectManagerCandidates');
    for (const p of get.parameters) expect(p.description).toMatch(/[\u3400-\u9fff]/u);
    for (const schema of [
      managerCandidatesQuery,
      managerRecruitBody,
      managerCandidate,
      managerCandidates,
      managerRecruitResult,
    ]) {
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
    expect(
      (
        await app.inject({
          url: '/api/v1/projects/manager-candidates?projectId=3001&keyword=小明',
          headers,
        })
      ).json(),
    ).toEqual({ code: 200, message: '操作成功', data: managerCandidate.examples });
    expect(candidates).toHaveBeenCalledWith(3001, '小明', principal);
    for (const value of ['0', '-1', '2147483648', '1.5', 'abc'])
      expect(
        (
          await app.inject({
            url: `/api/v1/projects/manager-candidates?projectId=${value}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/manager-recruitments',
          headers,
          payload: managerRecruitBody.examples[0],
        })
      ).json(),
    ).toEqual({ code: 200, message: '操作成功', data: managerRecruitResult.examples[0] });
    for (const payload of [
      { projectId: 3001, candidateUserId: 2 },
      { projectId: 0, candidateUserId: candidate.userId },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/projects/manager-recruitments',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/manager-recruitments',
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=token' },
          payload: managerRecruitBody.examples[0],
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

test('claimed project attachments allow only independently authorized current PM or handler and lose access after replacement', async () => {
  const db = {
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: false }]),
    uploadedFile: {
      findMany: vi.fn().mockResolvedValue([{ id: principal.userId }, { id: candidate.userId }]),
      findUnique: vi.fn().mockResolvedValue({
        status: 'CLAIMED',
        bizType: 'PROJECT_ATTACHMENT',
        claimedBizType: 'PROJECT_ATTACHMENT',
        claimedBizId: '3001',
        objectKey: 'project-attachment/example.pdf',
      }),
    },
    projectAttachment: {
      findFirst: vi.fn().mockResolvedValue({ id: 501, project: { createdBy: 'other-creator' } }),
    },
    managementGrant: { findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }) },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue({ id: 5001 }) },
  };
  const storage = { open: vi.fn().mockResolvedValue({ marker: 'stream' }) };
  const service = new FileService({ db, storage } as unknown as FileRegistryService);
  expect(
    await service.open('project-attachment/example.pdf', { ...principal, role: 'PM' }),
  ).toEqual({
    marker: 'stream',
  });
  expect(db.projectManagerRecruitment.findFirst).toHaveBeenCalledWith({
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
  db.projectManagerRecruitment.findFirst.mockResolvedValueOnce(null as never);
  await expect(
    service.open('project-attachment/example.pdf', { ...principal, role: 'PM' }),
  ).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    service.open('project-attachment/example.pdf', { ...principal, role: 'EXPERT' }),
  ).rejects.toMatchObject({
    status: 403,
  });
  expect(storage.open).toHaveBeenCalledTimes(1);
});

test('manager card collection failure aborts before recording assignment event', async () => {
  const f = setup();
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(new Error('cards unavailable'));
  await expect(
    f.service.recruit({ projectId: base.id, candidateUserId: candidate.userId }, principal),
  ).rejects.toThrow('cards unavailable');
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});

test('independent progress refresh runs after business rounds and aborts cards and outbox on failure', async () => {
  const { service, tx } = setup();
  const cardsBefore = vi.mocked(refreshManagementCardSnapshots).mock.calls.length;
  vi.mocked(refreshOwnerProgress).mockImplementationOnce(async (transaction, id, ids) => {
    expect(transaction).toBe(tx);
    expect(id).toBe(base.id);
    expect(ids).toBeNull();
    expect(tx.projectTaskRound.findMany).toHaveBeenCalled();
    expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
    throw new Error('recruit independent progress fault');
  });
  await expect(
    service.recruit({ projectId: base.id, candidateUserId: candidate.userId }, principal),
  ).rejects.toThrow('recruit independent progress fault');
  expect(vi.mocked(refreshManagementCardSnapshots).mock.calls).toHaveLength(cardsBefore);
  expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
