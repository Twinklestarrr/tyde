import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => undefined),
}));
import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ProjectRecruitmentHandlerService } from '../src/modules/projects/project-recruitment-handler.service.js';
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({ cardChangedRecipients: [] })),
}));
import {
  handlerBody,
  handlerCandidates,
  handlerExample,
} from '../src/modules/projects/project-recruitment-handler.schema.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'primary',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function setup() {
  const relation = {
    id: 12,
    candidateUserId: principal.userId,
    expertRecruitmentHandlerUserId: 'old',
  };
  const project = {
    id: 3001,
    status: 'PUBLISHED',
    deleted: false,
    createdBy: 'creator',
    currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
    versionNo: 7,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: handlerExample.userId }]),
    project: { findFirst: vi.fn().mockResolvedValue(project) },
    projectManagerRecruitment: {
      findFirst: vi.fn(async () => ({ ...relation })),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(relation, data);
        return { count: 1 };
      }),
    },
    projectExpertAssignment: { findMany: vi.fn(async () => []) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'creator' }),
      findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({ id }))),
    },
    projectTaskRound: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => ({ id: 1, ...data })),
      update: vi.fn(async ({ data }) => data),
    },
    projectEventOutbox: { create: vi.fn() },
  };
  const db = {
    ...tx,
    $disconnect: vi.fn(),
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return {
    tx,
    db,
    project,
    relation,
    service: new ProjectRecruitmentHandlerService(db as unknown as PrismaClient),
  };
}
test('only current primary PM can query or change; creator and handler do not inherit permissions', async () => {
  const { service, tx } = setup();
  for (const p of [
    { ...principal, role: 'NAVIGATOR' as const },
    { ...principal, role: 'EXPERT' as const },
    { ...principal, userId: 'old' },
    { ...principal, userId: 'replaced' },
  ]) {
    await expect(service.candidates(3001, p)).rejects.toMatchObject({ status: 403 });
    await expect(service.change(handlerBody.examples[0]!, p)).rejects.toMatchObject({
      status: 403,
    });
  }
  expect(tx.projectManagerRecruitment.updateMany).not.toHaveBeenCalled();
});
test('candidate query uses consistent snapshot, active unified accounts and real current handler', async () => {
  const { service, tx, db } = setup();
  tx.$queryRaw.mockResolvedValue([handlerExample]);
  expect(await service.candidates(3001, principal)).toEqual([handlerExample]);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  const sql = tx.$queryRaw.mock.calls[0]!;
  expect(sql[0].join(' ')).toContain('WHERE u."status"=');
  expect(sql[0].join(' ')).not.toContain('u."role"');
  expect(sql.slice(1)).toContain('old');
});
test('missing project, missing relation and inactive candidate fail before writing', async () => {
  const { service, tx } = setup();
  tx.project.findFirst.mockResolvedValueOnce(null);
  await expect(service.candidates(3001, principal)).rejects.toMatchObject({ status: 404 });
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce(null as never);
  await expect(service.candidates(3001, principal)).rejects.toMatchObject({ status: 403 });
  tx.$queryRaw.mockResolvedValue([]);
  await expect(service.change(handlerBody.examples[0]!, principal)).rejects.toMatchObject({
    status: 400,
  });
  expect(tx.projectManagerRecruitment.updateMany).not.toHaveBeenCalled();
});
test('handoff reconciles pending work and outbox without completing recruitment or changing project', async () => {
  const { service, tx, relation, project } = setup();
  expect(await service.change(handlerBody.examples[0]!, principal)).toBeNull();
  expect(relation.expertRecruitmentHandlerUserId).toBe(handlerExample.userId);
  expect(project).toMatchObject({ currentNodeCode: 'RECRUIT_EXECUTION_EXPERT', versionNo: 7 });
  expect(tx.projectEventOutbox.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          taskChangedRecipients: expect.arrayContaining([
            { userId: 'old', role: 'PM' },
            { userId: handlerExample.userId, role: 'PM' },
          ]),
        }),
      }),
    }),
  );
  expect(
    tx.projectTaskRound.update.mock.calls.every(([arg]) => arg.data.status !== 'COMPLETED'),
  ).toBe(true);
  expect(
    await service.change({ projectId: 3001, handlerUserId: principal.userId }, principal),
  ).toBeNull();
  expect(
    await service.change({ projectId: 3001, handlerUserId: principal.userId }, principal),
  ).toBeNull();
});
test('conditional relation conflict stops reconciliation and outbox', async () => {
  const { service, tx } = setup();
  tx.projectManagerRecruitment.updateMany.mockResolvedValue({ count: 0 });
  await expect(service.change(handlerBody.examples[0]!, principal)).rejects.toMatchObject({
    status: 409,
  });
  expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
  expect(refreshManagementCardSnapshots).not.toHaveBeenCalled();
});
test('handoff publishes real card recipients after relation and rounds; snapshot failure aborts outbox', async () => {
  const { service, tx, relation } = setup();
  const cardChanges = { cardChangedRecipients: [{ userId: 'old', role: 'PM' as const }] };
  vi.mocked(refreshManagementCardSnapshots).mockImplementationOnce(async (transaction, id) => {
    expect(transaction).toBe(tx);
    expect(id).toBe(3001);
    expect(relation.expertRecruitmentHandlerUserId).toBe(handlerExample.userId);
    expect(tx.projectTaskRound.create).toHaveBeenCalled();
    expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
    return cardChanges;
  });
  await service.change(handlerBody.examples[0]!, principal);
  expect(tx.projectEventOutbox.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      data: expect.objectContaining({ payload: expect.objectContaining(cardChanges) }),
    }),
  );
  tx.projectEventOutbox.create.mockClear();
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(new Error('handler card fault'));
  await expect(service.change(handlerBody.examples[0]!, principal)).rejects.toThrow(
    'handler card fault',
  );
  expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('retry handoff cancels old pending round and opens the new one without completing work', async () => {
  const { service, tx } = setup();
  tx.projectExpertAssignment.findMany.mockResolvedValue([{ id: 91 }] as never);
  tx.projectTaskRound.findMany.mockResolvedValue([
    {
      id: 61,
      userId: 'old',
      role: 'PM',
      taskType: 'EXPERT_RECRUITMENT_RETRY',
      status: 'OPEN',
      participated: true,
    },
  ] as never);
  await service.change(handlerBody.examples[0]!, principal);
  expect(tx.projectTaskRound.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        taskType: { in: expect.arrayContaining(['EXPERT_RECRUITMENT_RETRY']) },
      }),
    }),
  );
  expect(tx.projectTaskRound.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 61 },
      data: expect.objectContaining({ status: 'CANCELLED', participated: true }),
    }),
  );
  expect(tx.projectTaskRound.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        userId: handlerExample.userId,
        taskType: 'EXPERT_RECRUITMENT_RETRY',
        status: 'OPEN',
        participated: false,
      }),
    }),
  );
  expect(
    tx.projectTaskRound.update.mock.calls.every(([arg]) => arg.data.status !== 'COMPLETED'),
  ).toBe(true);
});
test('HTTP exact paths, body validation, full examples, serialization and generated Swagger', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  vi.spyOn(ProjectRecruitmentHandlerService.prototype, 'candidates').mockResolvedValue([
    handlerExample,
  ]);
  const change = vi
    .spyOn(ProjectRecruitmentHandlerService.prototype, 'change')
    .mockResolvedValue(null);
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    }),
    db as unknown as PrismaClient,
  );
  try {
    await app.ready();
    for (const schema of [handlerBody, handlerCandidates]) {
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
    const get = '/api/v1/projects/expert-recruitments/handler-candidates';
    const post = '/api/v1/projects/expert-recruitment-handler/change';
    expect((await app.inject({ url: `${get}?projectId=3001`, headers })).json().data).toEqual([
      handlerExample,
    ]);
    expect(
      (
        await app.inject({ method: 'POST', url: post, headers, payload: handlerBody.examples[0] })
      ).json(),
    ).toEqual({ code: 200, message: '操作成功', data: null });
    expect(change).toHaveBeenCalledWith(handlerBody.examples[0], principal);
    for (const id of ['0', '-1', 'abc', '2147483648', '1.5'])
      expect((await app.inject({ url: `${get}?projectId=${id}`, headers })).statusCode).toBe(400);
    for (const payload of [
      { projectId: 3001 },
      { projectId: 3001, handlerUserId: 1 },
      { projectId: 3001, handlerUserId: 'invalid' },
    ])
      expect((await app.inject({ method: 'POST', url: post, headers, payload })).statusCode).toBe(
        400,
      );
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[get].get.summary).toContain('候选人');
    expect(
      spec.paths[post].post.requestBody.content['application/json'].schema.properties.handlerUserId
        .description,
    ).toContain('UUID');
  } finally {
    await app.close();
  }
});

test('independent progress refresh runs after business rounds and aborts cards and outbox on failure', async () => {
  const { service, tx } = setup();
  const cardsBefore = vi.mocked(refreshManagementCardSnapshots).mock.calls.length;
  vi.mocked(refreshOwnerProgress).mockImplementationOnce(async (transaction, id, ids) => {
    expect(transaction).toBe(tx);
    expect(id).toBe(3001);
    expect(ids).toBeNull();
    expect(tx.projectTaskRound.findMany).toHaveBeenCalled();
    expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
    throw new Error('recruit independent progress fault');
  });
  await expect(service.change(handlerBody.examples[0]!, principal)).rejects.toThrow(
    'recruit independent progress fault',
  );
  expect(vi.mocked(refreshManagementCardSnapshots).mock.calls).toHaveLength(cardsBefore);
  expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
