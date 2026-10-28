import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import {
  ProjectMaterialsService,
  nodeAfterMaterials,
} from '../src/modules/projects/project-materials.service.js';
import {
  materialsBody,
  materialsResponse,
  materialsExample,
} from '../src/modules/projects/project-materials.schema.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({ cardChangedRecipients: [] })),
}));
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => {}),
}));
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'creator',
  role: 'NAVIGATOR',
  sessionId: 's',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  const project = {
    id: 3001,
    status: 'PUBLISHED',
    deleted: false,
    createdBy: 'creator',
    standardContent: '旧正文',
    standardLink: null,
    currentNodeCode: 'STANDARD_TRAINING',
    versionNo: 2,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: false }]),
    project: {
      findFirst: vi.fn().mockResolvedValue(project),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({
        candidateUserId: principal.userId,
        expertRecruitmentHandlerUserId: 'handler',
      }),
    },
    projectAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    projectRoleNodeSnapshot: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    projectExpertAssignment: { findUnique: vi.fn() },
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: principal.userId, displayName: '昵称', realName: '姓名' }),
      findMany: vi.fn().mockResolvedValue([{ id: principal.userId }]),
    },
    projectTaskRound: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data })),
      update: vi.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data })),
    },
  };
  const db = {
    ...tx,
    $disconnect: vi.fn(),
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const files = {
    claimForProject: vi.fn().mockRejectedValue(new Error('invalid upload')),
    releaseProjectAttachment: vi.fn(),
  };
  return {
    tx,
    db,
    files,
    project,
    service: new ProjectMaterialsService(
      db as unknown as PrismaClient,
      files as unknown as FileRegistryService,
    ),
  };
}
test('creator reads snapshot with no expert query and cannot inherit creator rights in another role', async () => {
  const { service, tx, db } = setup();
  expect(await service.get(3001, principal)).toMatchObject({
    projectId: 3001,
    canConfirmRead: false,
    versionNo: 2,
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(tx.$queryRaw).not.toHaveBeenCalled();
  await expect(service.get(3001, { ...principal, role: 'EXPERT' })).rejects.toMatchObject({
    status: 403,
  });
});
test('handler reads but cannot edit, and replaced PM loses both rights', async () => {
  const { service, tx } = setup();
  const handler = { ...principal, userId: 'handler', role: 'PM' as const };
  expect(await service.get(3001, handler)).toHaveProperty('projectId', 3001);
  await expect(
    service.update({ projectId: 3001, standardContent: '新' }, handler),
  ).rejects.toMatchObject({ status: 403 });
  tx.projectManagerRecruitment.findFirst.mockResolvedValue(null as never);
  await expect(service.get(3001, { ...principal, role: 'PM' })).rejects.toMatchObject({
    status: 403,
  });
});
test('missing or unpublished project gives 404 before any business relation', async () => {
  const { service, tx } = setup();
  tx.project.findFirst.mockResolvedValue(null as never);
  await expect(service.get(3001, principal)).rejects.toMatchObject({ status: 404 });
  expect(tx.project.findFirst).toHaveBeenCalledWith({
    where: { id: 3001, status: 'PUBLISHED', deleted: false },
  });
});
test('PM update trims fields, increments version, advances main task and creator edit does not advance', async () => {
  const { service, tx } = setup();
  expect(
    await service.update(
      { projectId: 3001, standardLink: ' https://example.com ' },
      { ...principal, role: 'PM' },
    ),
  ).toMatchObject({
    standardContent: null,
    standardLink: 'https://example.com',
    versionNo: 3,
    currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
    stateTransitioned: true,
  });
  expect(tx.projectTaskRound.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED', participated: true }),
    }),
  );
  expect(await service.update({ projectId: 3001, standardContent: '新' }, principal)).toMatchObject(
    { currentNodeCode: 'STANDARD_TRAINING', stateTransitioned: false },
  );
});
test('node advancement fills missing/earlier nodes and preserves later ones', () => {
  for (const node of [null, 'PRODUCTION_PLAN', 'STANDARD_TRAINING'])
    expect(nodeAfterMaterials(node)).toBe('RECRUIT_EXECUTION_EXPERT');
  for (const node of [
    'RECRUIT_EXECUTION_EXPERT',
    'PERSONNEL_MANAGEMENT',
    'PRODUCTION_TASK',
    'COMPLETED',
  ])
    expect(nodeAfterMaterials(node)).toBe(node);
});
test('empty content, excessive link and too many attachments reject before project mutation', async () => {
  const { service, tx } = setup();
  for (const input of [
    { projectId: 3001, standardContent: ' ' },
    { projectId: 3001, standardLink: 'x'.repeat(2001) },
    {
      projectId: 3001,
      standardContent: '新',
      attachments: Array.from({ length: 21 }, () => ({ id: 1 })),
    },
  ])
    await expect(service.update(input, principal)).rejects.toMatchObject({ status: 400 });
  expect(tx.project.updateMany).not.toHaveBeenCalled();
});
test('version conflict stops before attachment claims', async () => {
  const { service, tx, files } = setup();
  tx.project.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    service.update({ projectId: 3001, standardContent: '新', attachments: [] }, principal),
  ).rejects.toMatchObject({ status: 409 });
  expect(files.claimForProject).not.toHaveBeenCalled();
});
test('foreign attachment cannot be retained and invalid upload propagates from same transaction', async () => {
  const { service, tx, files } = setup();
  await expect(
    service.update(
      { projectId: 3001, standardContent: '新', attachments: [{ id: 999 }] },
      principal,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.update(
      {
        projectId: 3001,
        standardContent: '新',
        attachments: [{ attachmentType: 'CASE', objectKey: 'key', uploadToken: 'token' }],
      },
      principal,
    ),
  ).rejects.toThrow('invalid upload');
  expect(files.claimForProject).toHaveBeenCalledWith(tx, 'key', 'token', 'creator', '3001');
});
test('ordinary joined expert sees own confirmation state; assignment owner has no ordinary confirmation action', async () => {
  const { service, tx } = setup();
  tx.$queryRaw.mockResolvedValue([{ allowed: true }]);
  tx.projectMember.findFirst.mockResolvedValue({
    expertAssignmentId: 1,
    standardTrainingConfirmedAt: null,
  } as never);
  tx.projectExpertAssignment.findUnique.mockResolvedValue({
    owners: [],
    projectOwnerUserId: 'other',
  } as never);
  const expert = { ...principal, role: 'EXPERT' as const };
  expect(await service.get(3001, expert)).toMatchObject({
    canConfirmRead: true,
    confirmedReadAt: null,
  });
  tx.projectExpertAssignment.findUnique.mockResolvedValue({
    owners: [{ userId: principal.userId, status: 'ACTIVE' }],
  } as never);
  expect(await service.get(3001, expert)).toMatchObject({ canConfirmRead: false });
});
test('HTTP validates complete examples, source policy, exact paths and response serialization', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const get = vi
    .spyOn(ProjectMaterialsService.prototype, 'get')
    .mockResolvedValue(materialsExample as never);
  const update = vi
    .spyOn(ProjectMaterialsService.prototype, 'update')
    .mockResolvedValue(materialsExample as never);
  const confirm = vi
    .spyOn(ProjectMaterialsService.prototype, 'confirmRead')
    .mockResolvedValue({ ...materialsExample, readConfirmationTransitioned: true } as never);
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
    for (const schema of [materialsBody, materialsResponse]) {
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
    const url = '/api/v1/projects/standard-materials';
    expect(
      (await app.inject({ url: `${url}/detail?projectId=3001`, headers })).json().data,
    ).toEqual(materialsExample);
    expect(get).toHaveBeenCalledWith(3001, principal);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/update`,
          headers,
          payload: materialsBody.examples[0],
        })
      ).json().data,
    ).toEqual(materialsExample);
    expect(update).toHaveBeenCalledWith(materialsBody.examples[0], principal);
    for (const id of ['0', '-1', 'abc', '2147483648', '1.5'])
      expect((await app.inject({ url: `${url}/detail?projectId=${id}`, headers })).statusCode).toBe(
        400,
      );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/update`,
          headers,
          payload: {
            ...materialsBody.examples[0],
            attachments: Array.from({ length: 21 }, () => ({})),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `${url}/detail?projectId=3001`,
          headers: { ...headers, origin: 'https://untrusted.example' },
        })
      ).statusCode,
    ).toBe(403);
    const confirmed = await app.inject({
      method: 'POST',
      url: `${url}/confirm-read?projectId=3001`,
      headers,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.readConfirmationTransitioned).toBe(true);
    expect(confirm).toHaveBeenCalledWith(3001, principal);
    for (const suffix of ['', '?projectId=0', '?projectId=1.5', '?projectId=2147483648'])
      expect(
        (await app.inject({ method: 'POST', url: `${url}/confirm-read${suffix}`, headers }))
          .statusCode,
      ).toBe(400);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths[`${url}/confirm-read`].post.operationId).toBe(
      'confirmProjectStandardMaterialsRead',
    );
    expect(spec.paths[`${url}/detail`].get.operationId).toBe('getProjectStandardMaterials');
    expect(spec.paths[`${url}/update`].post.operationId).toBe('updateProjectStandardMaterials');
  } finally {
    await app.close();
  }
});

function confirmationSetup(confirmedAt: Date | null = null) {
  const f = setup();
  const member = {
    id: 10,
    expertAssignmentId: 1,
    joinedAt: new Date('2026-10-22T07:00:00Z'),
    standardTrainingConfirmedAt: confirmedAt,
  };
  f.tx.$queryRaw.mockImplementation(async (query) => {
    const text = (Array.isArray(query) ? query : query.strings).join('');
    if (text.includes('AS "allowed"')) return [{ allowed: true }];
    if (text.includes('FROM "ProjectMember"')) return [member];
    return [];
  });
  f.tx.projectMember.findFirst.mockImplementation(
    async () =>
      ({
        ...member,
        standardTrainingConfirmedAt: confirmedAt ?? new Date('2026-10-22T08:00:00Z'),
      }) as never,
  );
  f.tx.projectExpertAssignment.findUnique.mockResolvedValue({
    subjectType: 'INDIVIDUAL',
    owners: [],
    projectOwnerUserId: null,
  } as never);
  return { ...f, member, expert: { ...principal, role: 'EXPERT' as const } };
}
test('confirmation requires current EXPERT, accepted view access and joined member; owner exclusion honors inactive owner history', async () => {
  const f = confirmationSetup();
  await expect(f.service.confirmRead(3001, principal)).rejects.toMatchObject({ status: 403 });
  expect(f.db.$transaction).not.toHaveBeenCalled();
  f.tx.$queryRaw.mockResolvedValue([{ allowed: false }]);
  await expect(f.service.confirmRead(3001, f.expert)).rejects.toMatchObject({ status: 403 });
  f.tx.$queryRaw.mockImplementation(async (q) =>
    (Array.isArray(q) ? q : q.strings).join('').includes('AS "allowed"') ? [{ allowed: true }] : [],
  );
  await expect(f.service.confirmRead(3001, f.expert)).rejects.toMatchObject({ status: 400 });
  const g = confirmationSetup();
  g.tx.projectExpertAssignment.findUnique.mockResolvedValue({
    owners: [],
    projectOwnerUserId: principal.userId,
  } as never);
  await expect(g.service.confirmRead(3001, g.expert)).rejects.toMatchObject({ status: 403 });
  g.tx.projectExpertAssignment.findUnique.mockResolvedValue({
    owners: [{ userId: principal.userId, status: 'INACTIVE' }],
    projectOwnerUserId: principal.userId,
  } as never);
  expect(await g.service.confirmRead(3001, g.expert)).toHaveProperty(
    'readConfirmationTransitioned',
    true,
  );
});
test('first confirmation completes only own training task and refreshes source snapshot without project mutation', async () => {
  const f = confirmationSetup();
  const result = await f.service.confirmRead(3001, f.expert);
  expect(result).toMatchObject({
    readConfirmationTransitioned: true,
    canConfirmRead: false,
    stateTransitioned: false,
    versionNo: 2,
  });
  expect(f.tx.project.updateMany).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.findMany).toHaveBeenCalledWith({
    where: {
      projectId: 3001,
      userId: principal.userId,
      role: 'EXPERT',
      taskType: 'STANDARD_TRAINING',
      status: 'OPEN',
    },
  });
  expect(f.tx.projectTaskRound.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      status: 'COMPLETED',
      participated: true,
      taskType: 'STANDARD_TRAINING',
    }),
  });
  expect(refreshManagementCardSnapshots).toHaveBeenCalledWith(f.tx, 3001, expect.any(Date));
  expect(f.tx.projectRoleNodeSnapshot.upsert).not.toHaveBeenCalled();
});
test('repeat confirmation preserves time, repairs snapshot and completes stale open round without creating another', async () => {
  const f = confirmationSetup(new Date('2026-10-22T08:00:00Z'));
  f.tx.projectTaskRound.findMany.mockResolvedValue([{ id: 7 }] as never);
  expect(await f.service.confirmRead(3001, f.expert)).toMatchObject({
    confirmedReadAt: '2026-10-22 16:00:00',
    readConfirmationTransitioned: false,
  });
  expect(f.tx.projectMember.updateMany).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.create).not.toHaveBeenCalled();
  expect(f.tx.projectTaskRound.update).toHaveBeenCalledWith({
    where: { id: 7 },
    data: expect.objectContaining({ status: 'COMPLETED', participated: true }),
  });
  expect(refreshManagementCardSnapshots).toHaveBeenCalledWith(f.tx, 3001, expect.any(Date));
});
test('confirmation delegates stale and higher-priority branches to arbitration and propagates conflicts or source failure', async () => {
  const f = confirmationSetup();
  f.tx.projectRoleNodeSnapshot.findUnique.mockResolvedValue({
    branchNodeCode: 'OUTPUT_DATA_REVIEW',
  } as never);
  await f.service.confirmRead(3001, f.expert);
  expect(f.tx.projectRoleNodeSnapshot.upsert).not.toHaveBeenCalled();
  f.tx.projectMember.updateMany.mockResolvedValue({ count: 0 });
  await expect(f.service.confirmRead(3001, f.expert)).rejects.toMatchObject({ status: 409 });
  const g = confirmationSetup();
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(new Error('snapshot failed'));
  await expect(g.service.confirmRead(3001, g.expert)).rejects.toThrow('snapshot failed');
});

test('materials update refreshes complete cards after main task reconciliation and propagates arbitration failure', async () => {
  const f = setup();
  await f.service.update({ projectId: 3001, standardContent: '更新' }, principal);
  expect(refreshManagementCardSnapshots).toHaveBeenCalledWith(f.tx, 3001, expect.any(Date));
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(new Error('source failed'));
  await expect(
    f.service.update({ projectId: 3001, standardContent: '更新' }, principal),
  ).rejects.toThrow('source failed');
});

test('materials writes reconcile independent sources before cards and propagate progress failure', async () => {
  const f = setup();
  await f.service.update({ projectId: 3001, standardContent: '更新' }, principal);
  expect(refreshOwnerProgress).toHaveBeenLastCalledWith(f.tx, 3001, null, expect.any(Date));
  const progressOrder = vi.mocked(refreshOwnerProgress).mock.invocationCallOrder.at(-1)!;
  expect(progressOrder).toBeLessThan(
    vi.mocked(refreshManagementCardSnapshots).mock.invocationCallOrder.at(-1)!,
  );
  const g = confirmationSetup();
  await g.service.confirmRead(3001, g.expert);
  expect(refreshOwnerProgress).toHaveBeenLastCalledWith(
    g.tx,
    3001,
    [principal.userId],
    expect.any(Date),
  );
  expect(vi.mocked(refreshOwnerProgress).mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
    g.tx.projectTaskRound.create.mock.invocationCallOrder.at(-1)!,
  );
  for (const operation of [
    () => f.service.update({ projectId: 3001, standardContent: '更新' }, principal),
    () => confirmationSetup().service.confirmRead(3001, g.expert),
  ]) {
    vi.mocked(refreshManagementCardSnapshots).mockClear();
    vi.mocked(refreshOwnerProgress).mockRejectedValueOnce(new Error('independent progress failed'));
    await expect(operation()).rejects.toThrow('independent progress failed');
    expect(refreshManagementCardSnapshots).not.toHaveBeenCalled();
  }
});
