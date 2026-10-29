import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => undefined),
}));
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ProjectRecruitmentService,
  type RecruitmentInput,
} from '../src/modules/projects/project-recruitment.service.js';
import { candidateSql } from '../src/modules/projects/project-recruitment-candidates.js';
import {
  recruitmentBody,
  recruitmentDetail,
  recruitmentDetailExample,
  recruitmentPage,
  recruitmentPageExample,
} from '../src/modules/projects/project-recruitment.schema.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const primary = '00000000-0000-4000-8000-000000000001',
  handler = '00000000-0000-4000-8000-000000000002';
const p: AuthPrincipal = {
  userId: primary,
  uid: 'primary',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
};
const input = recruitmentBody.examples[0] as RecruitmentInput;
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    id: 3001,
    deleted: false,
    status: 'PUBLISHED',
    createdBy: 'creator',
    currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
    projectName: '项目',
    projectQuantity: new Prisma.Decimal('10.1'),
    quantityUnit: '条',
    versionNo: 7,
  };
  const relation = { candidateUserId: primary, expertRecruitmentHandlerUserId: handler };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ subjectId: input.assignments[0]!.subjectId }]),
    project: {
      findFirst: vi.fn(async () => ({ ...project })),
      update: vi.fn(async ({ data }) => Object.assign(project, data)),
    },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue(relation) },
    user: {
      findUnique: vi.fn(async ({ where }) => ({
        id: where.id ?? 'creator-id',
        uid: 'person',
        displayName: '小明',
        realName: null,
        avatarUrl: null,
      })),
      findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({ id }))),
    },
    projectExpertAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: 4, ...data })),
    },
    projectTaskRound: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }) => ({ id: 1, ...data })),
      update: vi.fn(async ({ data }) => data),
    },
    projectRoleNodeSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
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
    service: new ProjectRecruitmentService(db as unknown as PrismaClient),
  };
}
test('recruitment current PM project relation is required for all three operations; handler allowed', async () => {
  const { service, tx } = setup();
  for (const who of [
    { ...p, role: 'EXPERT' as const },
    { ...p, role: 'NAVIGATOR' as const },
    { ...p, userId: 'outsider' },
  ]) {
    await expect(service.detail(3001, who)).rejects.toMatchObject({ status: 403 });
    await expect(service.candidates({ projectId: 3001 }, who)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.submit(input, who)).rejects.toMatchObject({ status: 403 });
  }
  expect(tx.projectExpertAssignment.create).not.toHaveBeenCalled();
  expect(await service.detail(3001, { ...p, userId: handler })).toMatchObject({
    currentOperatorRole: 'EXPERT_RECRUITMENT_HANDLER',
    canChangeHandler: false,
  });
  tx.project.findFirst.mockResolvedValueOnce(null as never);
  await expect(service.detail(3001, p)).rejects.toMatchObject({ status: 404 });
});
test('recruitment detail sums exact decimal amounts, ignores rejected and clamps remaining', async () => {
  const { service, tx } = setup();
  tx.projectExpertAssignment.findMany.mockResolvedValue([
    { status: 'PENDING_ACCEPTANCE', productionRequirement: new Prisma.Decimal('8.1') },
    { status: 'ACCEPTED', productionRequirement: new Prisma.Decimal('4.2') },
    { status: 'REJECTED', productionRequirement: new Prisma.Decimal('100') },
  ] as never);
  expect((await service.detail(3001, p)).summary).toEqual({
    activeAssignmentCount: 2,
    pendingAcceptanceCount: 1,
    acceptedCount: 1,
    rejectedCount: 1,
    assignedProductionRequirement: 12.3,
    remainingProductionRequirement: 0,
  });
});
test('recruitment paginates database and computes action while preserving nulls', async () => {
  const { service, tx, db } = setup();
  tx.$queryRaw.mockResolvedValueOnce([{ total: 3 }] as never).mockResolvedValueOnce([
    { ...recruitmentPageExample.records[0], assignment: null },
    { ...recruitmentPageExample.records[0], assignment: { status: 'REJECTED' } },
    { ...recruitmentPageExample.records[0], assignment: { status: 'ACCEPTED' } },
  ] as never);
  const result = await service.candidates({ projectId: 3001, current: 2, size: 2 }, p);
  expect(result).toMatchObject({ total: 3, current: 2, size: 2, pages: 2 });
  expect(result.records.map((r) => r.availableAction)).toEqual([
    'RECRUIT',
    'RECRUIT_AGAIN',
    'NONE',
  ]);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  const sql = candidateSql([primary, handler], { projectId: 3001, keyword: "%_' OR 1=1" });
  expect(sql.text).not.toContain('OR 1=1');
  expect(sql.values).toContain("%_' OR 1=1");
  expect(sql.text).not.toContain('"accountType"');
  expect(sql.text).not.toContain('"role"');
});
test.each(['PERSONNEL_MANAGEMENT', 'PRODUCTION_TASK', 'COMPLETED'])(
  'recruitment continuation does not regress %s or increment version',
  async (node) => {
    const { service, tx, project } = setup();
    project.currentNodeCode = node;
    expect(await service.submit(input, p)).toBeNull();
    expect(tx.project.update).not.toHaveBeenCalled();
    expect(project.versionNo).toBe(7);
    expect(tx.projectExpertAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectType: 'INDIVIDUAL',
        expertUserId: input.assignments[0]!.subjectId,
        organizationId: null,
        status: 'PENDING_ACCEPTANCE',
        previousAssignmentId: null,
      }),
    });
    expect(tx.projectEventOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'EXPERT_ASSIGNMENTS_CREATED',
        payload: expect.objectContaining({ assignmentIds: [4] }),
      }),
    });
  },
);
test('recruitment first submit advances only node and audit and completes actor main task', async () => {
  const { service, tx } = setup();
  await service.submit(input, { ...p, userId: handler });
  expect(tx.project.update).toHaveBeenCalledWith({
    where: { id: 3001 },
    data: { currentNodeCode: 'PERSONNEL_MANAGEMENT', updatedBy: p.uid },
  });
  expect(
    tx.projectTaskRound.update.mock.calls.some(
      ([{ data }]) => data.status === 'COMPLETED' && data.participated,
    ),
  ).toBe(true);
});
test('recruitment rejects duplicate subjects/sources, invalid amounts/headcounts before transaction', async () => {
  const { service, db } = setup(),
    item = input.assignments[0]!;
  for (const assignments of [
    [],
    [item, item],
    [{ ...item, productionRequirement: 0 }],
    [{ ...item, productionRequirement: 0.00011 }],
    [{ ...item, operatorHeadcount: 0 }],
    [{ ...item, inspectorHeadcount: 0 }],
    [
      { ...item, sourceRejectedAssignmentId: 8 },
      { ...item, subjectId: handler, sourceRejectedAssignmentId: 8 },
    ],
  ])
    await expect(service.submit({ ...input, assignments }, p)).rejects.toMatchObject({
      status: 400,
    });
  expect(db.$transaction).not.toHaveBeenCalled();
});
test('recruitment rejects ineligible subject, invalid source and active assignment before insertion', async () => {
  const { service, tx } = setup();
  tx.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = args[0] as { text?: string };
    return sql.text?.startsWith('WITH candidates') ? [] : [{ id: 1 }];
  });
  await expect(service.submit(input, p)).rejects.toMatchObject({ status: 400 });
  tx.$queryRaw.mockResolvedValue([{ subjectId: handler }]);
  await expect(
    service.submit(
      { ...input, assignments: [{ ...input.assignments[0]!, sourceRejectedAssignmentId: 5 }] },
      p,
    ),
  ).rejects.toMatchObject({ status: 400 });
  tx.projectExpertAssignment.findFirst.mockResolvedValueOnce({ id: 4 } as never);
  await expect(service.submit(input, p)).rejects.toMatchObject({ status: 409 });
  expect(tx.projectExpertAssignment.create).not.toHaveBeenCalled();
});
test('recruitment HTTP paths, examples, schema validation, serialization and Swagger', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  vi.spyOn(ProjectRecruitmentService.prototype, 'detail').mockResolvedValue(
    recruitmentDetailExample as never,
  );
  vi.spyOn(ProjectRecruitmentService.prototype, 'candidates').mockResolvedValue(
    recruitmentPageExample as never,
  );
  vi.spyOn(ProjectRecruitmentService.prototype, 'submit').mockResolvedValue(null);
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
    for (const [schema, example] of [
      [recruitmentBody, input],
      [recruitmentDetail, recruitmentDetailExample],
      [recruitmentPage, recruitmentPageExample],
    ] as const) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      if (schema === recruitmentBody)
        for (const requestExample of recruitmentBody.examples)
          expect(validate(requestExample), JSON.stringify(validate.errors)).toBe(true);
    }
    const headers = { authorization: 'Bearer token' },
      base = '/api/v1/projects/expert-recruitments';
    expect(
      (await app.inject({ url: `${base}/detail?projectId=3001`, headers })).json().data,
    ).toEqual(recruitmentDetailExample);
    expect(
      (await app.inject({ url: `${base}/candidates?projectId=3001`, headers })).json().data,
    ).toEqual(recruitmentPageExample);
    expect(
      (await app.inject({ method: 'POST', url: `${base}/submit`, headers, payload: input })).json(),
    ).toEqual({ code: 200, message: '操作成功', data: null });
    const pageResponse = await app.inject({
      url: `${base}/candidates?projectId=3001&subjectType=ORGANIZATION&size=1&current=2`,
      headers,
    });
    expect(pageResponse.statusCode, pageResponse.body).toBe(200);
    expect(pageResponse.json().data).toEqual(recruitmentPageExample);
    expect(ProjectRecruitmentService.prototype.candidates).toHaveBeenLastCalledWith(
      { projectId: 3001, subjectType: 'ORGANIZATION', current: 2, size: 1 },
      p,
    );
    for (const query of [
      'projectId=0',
      'projectId=3001&size=101',
      'projectId=3001&subjectType=USER',
      'projectId=3001&current=0',
      'projectId=3001&current=2147483648',
      'projectId=3001&current=1.5',
      'projectId=3001&size=0',
    ])
      expect((await app.inject({ url: `${base}/candidates?${query}`, headers })).statusCode).toBe(
        400,
      );
    for (const payload of [
      { ...input, assignments: [] },
      { ...input, assignments: [{ ...input.assignments[0], subjectId: 1 }] },
      { ...input, assignments: [{ ...input.assignments[0], operatorHeadcount: 0 }] },
    ])
      expect(
        (await app.inject({ method: 'POST', url: `${base}/submit`, headers, payload })).statusCode,
      ).toBe(400);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(
      spec.paths[`${base}/submit`].post.requestBody.content['application/json'].schema.properties
        .assignments.items.properties.subjectId.description,
    ).toContain('UUID');
  } finally {
    await app.close();
  }
});

test('recruitment snapshot delegates to complete cross-domain arbitration', async () => {
  const { syncRecruitmentRetrySnapshot } =
    await import('../src/modules/projects/project-recruitment-snapshot.js');
  const { tx } = setup();
  vi.mocked(refreshManagementCardSnapshots).mockClear();
  await syncRecruitmentRetrySnapshot(tx as never, 3001, { scopes: [], sources: [] });
  expect(refreshManagementCardSnapshots).toHaveBeenCalledExactlyOnceWith(tx, 3001);
});

vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(),
}));

test('assignment submission preserves arbitration recipients alongside existing task facts', async () => {
  const { service, tx } = setup();
  const cardChanges = { cardChangedRecipients: [{ userId: 'entry-manager', role: 'PM' as const }] };
  vi.mocked(refreshManagementCardSnapshots).mockResolvedValueOnce(cardChanges);
  await service.submit(input, p);
  expect(tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventType: 'EXPERT_ASSIGNMENTS_CREATED',
      payload: expect.objectContaining({ ...cardChanges, assignmentIds: [4] }),
    }),
  });
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
  await expect(service.submit(input, p)).rejects.toThrow('recruit independent progress fault');
  expect(vi.mocked(refreshManagementCardSnapshots).mock.calls).toHaveLength(cardsBefore);
  expect(tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
