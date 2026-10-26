import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import { FileService } from '../src/modules/files/file.service.js';
import { ProjectCreationService } from '../src/modules/projects/project-creation.service.js';
import { syncProjectAttachments } from '../src/modules/projects/project-attachments.js';
import { parseProjectTime, projectTime } from '../src/modules/projects/project-time.js';
import {
  projectSaveBody,
  projectPublishExample,
  projectMutation,
  projectDraftResponse,
  projectDraftExample,
  projectAttachmentResponse,
} from '../src/modules/projects/project-creation.schema.js';
import type { ProjectSaveInput } from '../src/modules/projects/project-creation.types.js';

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
  role: 'EXPERT',
  clientType: 'desktop',
};
const published = projectPublishExample as ProjectSaveInput;
const base = {
  id: 3001,
  projectNo: 'PRJ20261019180000A1B2C3D4',
  status: 'DRAFT',
  versionNo: 0,
  createdBy: principal.uid,
  updatedBy: principal.uid,
  requesterType: 'INDIVIDUAL',
  requesterId: principal.userId,
  requesterName: '小明(王小明)',
  createdAt: parseProjectTime('2026-10-19 18:00:00'),
  updatedAt: parseProjectTime('2026-10-19 18:00:00'),
  publishedAt: null,
  currentNodeCode: null,
};
afterEach(() => vi.restoreAllMocks());
function setup(existing: Record<string, unknown> | null = null) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: principal.userId }]),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: principal.userId,
        accountType: 'INDIVIDUAL',
        displayName: '小明',
        realName: '王小明',
        memberships: [],
      }),
    },
    project: {
      findFirst: vi.fn(async ({ where }) => (where.status === 'DRAFT' ? existing : null)),
      create: vi.fn(async ({ data }) => ({ ...base, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...base, versionNo: 1 }),
    },
    projectCategory: {
      findUnique: vi.fn(async ({ where: { id } }) => ({
        id,
        categoryName: `分类${id}`,
        categoryLevel: Math.floor(id / 10),
        status: 'ENABLED',
      })),
    },
    projectCategoryRelation: { deleteMany: vi.fn(), create: vi.fn() },
    projectAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      create: vi.fn(),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  const files = {
    claimForProject: vi.fn().mockResolvedValue({
      objectKey: 'project-attachment/example.pdf',
      fileName: 'example.pdf',
      extension: 'pdf',
      contentType: 'application/pdf',
      fileSize: 123,
      fileHash: 'a'.repeat(64),
    }),
    releaseProjectAttachment: vi.fn(),
  } as unknown as FileRegistryService;
  return { db, tx, files, service: new ProjectCreationService(db, files) };
}
test('first EXPERT draft locks its user and stores a full snapshot without granting management', async () => {
  const { service, tx } = setup();
  const result = await service.save({ operation: 'SAVE_DRAFT', projectName: ' 草稿 ' }, principal);
  expect(result).toMatchObject({
    id: base.id,
    status: 'DRAFT',
    versionNo: 0,
    currentNodeCode: null,
    publishedAt: null,
  });
  expect(tx.$queryRaw.mock.calls[0]![0].join('')).toContain('FOR UPDATE');
  expect(tx.project.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      projectName: '草稿',
      projectDescription: null,
      educationRequirement: 'BACHELOR',
      requesterId: principal.userId,
      requesterName: '小明(王小明)',
      status: 'DRAFT',
      createdBy: principal.uid,
      projectNo: expect.stringMatching(/^PRJ\d{14}[A-F0-9]{8}$/),
    }),
  });
});
test('existing draft requires matching version, then clears omitted values and resets education default', async () => {
  const { service, tx } = setup(base);
  await expect(service.save({ operation: 'SAVE_DRAFT' }, principal)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    service.save({ operation: 'SAVE_DRAFT', versionNo: 9 }, principal),
  ).rejects.toMatchObject({ status: 409 });
  await service.save({ operation: 'SAVE_DRAFT', versionNo: 0 }, principal);
  expect(tx.project.updateMany).toHaveBeenCalledWith({
    where: { id: base.id, createdBy: principal.uid, status: 'DRAFT', deleted: false, versionNo: 0 },
    data: expect.objectContaining({
      projectName: null,
      standardContent: null,
      educationRequirement: 'BACHELOR',
      versionNo: { increment: 1 },
    }),
  });
});
test('write refuses a stale version even after reading the draft', async () => {
  const { service, tx } = setup(base);
  tx.project.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    service.save({ operation: 'SAVE_DRAFT', versionNo: 0 }, principal),
  ).rejects.toMatchObject({ status: 409 });
  expect(tx.projectCategoryRelation.deleteMany).not.toHaveBeenCalled();
});
test('publishing uses actual required fields, not the inconsistent old prose', async () => {
  const { service, tx } = setup();
  await expect(
    service.save(
      { ...published, standardContent: null, standardLink: 'https://example.com/standard' },
      principal,
    ),
  ).rejects.toMatchObject({ status: 400, message: '必填信息未填写' });
  await expect(
    service.save({ ...published, mandatoryRequirement: null }, principal),
  ).rejects.toMatchObject({ status: 400 });
  const result = await service.save(
    { ...published, projectDescription: null, workSummary: null },
    principal,
  );
  expect(result.status).toBe('PUBLISHED');
  expect(result.currentNodeCode).toBe('RECRUIT_PROJECT_MANAGER');
  expect(tx.projectCategoryRelation.create).toHaveBeenCalledTimes(3);
});
test.each([
  { projectQuantity: 0 },
  { projectQuantity: -1 },
  { requiredHeadcount: 0 },
  { deadline: '2000-01-01 00:00:00' },
  { categoryLevel3Ids: [31, 31] },
  { categoryLevel1Id: 21 },
])('draft rejects supplied invalid values: %j', async (changes) => {
  const { service, tx } = setup();
  await expect(
    service.save({ operation: 'SAVE_DRAFT', ...changes }, principal),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.project.create).not.toHaveBeenCalled();
});
test('existing draft cutoff is its creation time rather than the current time', async () => {
  const { service, tx } = setup({ ...base, createdAt: new Date('2000-01-01T00:00:00Z') });
  await service.save(
    { operation: 'SAVE_DRAFT', versionNo: 0, deadline: '2000-01-02 00:00:00' },
    principal,
  );
  expect(tx.project.updateMany).toHaveBeenCalled();
});
test('ownership, account type, disabled category and same-requester duplicate name reject writes', async () => {
  const { service, tx } = setup();
  await expect(
    service.save(
      { operation: 'SAVE_DRAFT', requesterId: '00000000-0000-4000-8000-000000000099' },
      principal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service.save({ operation: 'SAVE_DRAFT', requesterType: 'ORGANIZATION' }, principal),
  ).rejects.toMatchObject({ status: 400 });
  tx.projectCategory.findUnique.mockResolvedValueOnce({
    id: 11,
    categoryName: '禁用分类',
    categoryLevel: 1,
    status: 'DISABLED',
  });
  await expect(
    service.save({ operation: 'SAVE_DRAFT', categoryLevel1Id: 11 }, principal),
  ).rejects.toMatchObject({ status: 400 });
  tx.project.findFirst.mockImplementation(async ({ where }) =>
    where.status === 'PUBLISHED' ? { id: 1 } : null,
  );
  await expect(service.save(published, principal)).rejects.toMatchObject({
    status: 409,
    message: '已有同名项目，请确认或修改名称',
  });
});
test('empty draft query is isolated to the authenticated creator', async () => {
  const { service, db, tx } = setup();
  expect(await service.currentDraft(principal)).toEqual({ hasDraft: false, draft: null });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(tx.project.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { createdBy: principal.uid, status: 'DRAFT', deleted: false },
    }),
  );
});
test('attachment null preserves, empty list deletes/releases, retain ignores client metadata', async () => {
  const { files, tx } = setup();
  const transaction = tx as unknown as Prisma.TransactionClient;
  await syncProjectAttachments(transaction, files, 3001, null, principal.uid, '小明');
  expect(tx.projectAttachment.findMany).not.toHaveBeenCalled();
  tx.projectAttachment.findMany.mockResolvedValue([
    { id: 501, objectKey: 'project-attachment/old.pdf', attachmentType: 'CASE' },
  ] as never);
  await syncProjectAttachments(
    transaction,
    files,
    3001,
    [{ id: 501, objectKey: 'forged', attachmentType: 'OTHER', sortNo: 7 }],
    principal.uid,
    '小明',
  );
  expect(tx.projectAttachment.update).toHaveBeenCalledWith({
    where: { id: 501 },
    data: { sortNo: 7, updatedBy: principal.uid },
  });
  expect(files.claimForProject).not.toHaveBeenCalled();
  await syncProjectAttachments(transaction, files, 3001, [], principal.uid, '小明');
  expect(files.releaseProjectAttachment).toHaveBeenCalledWith(
    transaction,
    'project-attachment/old.pdf',
    '3001',
  );
});
test('attachment claim uses server metadata and refuses duplicates and foreign attachment IDs', async () => {
  const { files, tx } = setup();
  const transaction = tx as unknown as Prisma.TransactionClient;
  const fresh = {
    attachmentType: 'CASE' as const,
    objectKey: 'project-attachment/example.pdf',
    uploadToken: 'token',
  };
  await syncProjectAttachments(transaction, files, 3001, [fresh], principal.uid, '小明');
  expect(files.claimForProject).toHaveBeenCalledWith(
    transaction,
    fresh.objectKey,
    'token',
    principal.uid,
    '3001',
  );
  expect(tx.projectAttachment.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ fileName: 'example.pdf', fileSize: 123, sortNo: 0 }),
  });
  await expect(
    syncProjectAttachments(transaction, files, 3001, [fresh, fresh], principal.uid, '小明'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    syncProjectAttachments(transaction, files, 3001, [{ id: 99 }], principal.uid, '小明'),
  ).rejects.toMatchObject({ status: 400 });
});
test('Shanghai project timestamps round trip and impossible dates cannot normalize silently', () => {
  expect(projectTime(new Date('2026-10-19T10:00:00Z'))).toBe('2026-10-19 18:00:00');
  expect(parseProjectTime('2026-10-19 18:00:00').toISOString()).toBe('2026-10-19T10:00:00.000Z');
  for (const date of [
    '2026-02-30 18:00:00',
    '2026-13-01 18:00:00',
    '2026-01-01T00:00:00Z',
    '2026-01-01 24:00:00',
  ])
    expect(() => parseProjectTime(date)).toThrow();
});
test('creation HTTP and OpenAPI preserve full schemas, examples, nulls and existing authentication transport', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const save = vi
    .spyOn(ProjectCreationService.prototype, 'save')
    .mockResolvedValue(projectMutation.examples[0] as never);
  const current = vi
    .spyOn(ProjectCreationService.prototype, 'currentDraft')
    .mockResolvedValue({ hasDraft: true, draft: projectDraftExample } as never);
  const app = await createApp(config, db);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/projects/create'].post.description).toContain('不额外要求NAVIGATOR');
    for (const schema of [
      projectSaveBody,
      projectMutation,
      projectDraftResponse,
      projectAttachmentResponse,
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
    const headers = { authorization: 'Bearer demo' };
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/create',
      headers,
      payload: projectSaveBody.examples[0],
    });
    expect(result.json()).toEqual({
      code: 200,
      message: '操作成功',
      data: projectMutation.examples[0],
    });
    const draft = await app.inject({ url: '/api/v1/projects/draft/current', headers });
    expect(draft.json()).toEqual({
      code: 200,
      message: '操作成功',
      data: { hasDraft: true, draft: projectDraftExample },
    });
    expect(draft.headers['cache-control']).toBe('no-store');
    current.mockResolvedValueOnce({ hasDraft: false, draft: null });
    expect(
      (await app.inject({ url: '/api/v1/projects/draft/current', headers })).json().data,
    ).toEqual({ hasDraft: false, draft: null });
    const before = save.mock.calls.length;
    for (const payload of [
      {},
      { operation: 'DELETE' },
      { operation: 'SAVE_DRAFT', categoryLevel3Ids: [null] },
      { operation: 'SAVE_DRAFT', attachments: [{ fileName: 'forged' }] },
      { operation: 'SAVE_DRAFT', deadline: '2026-01-01T00:00:00Z' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/projects/create', headers, payload }))
          .statusCode,
      ).toBe(400);
    expect(save).toHaveBeenCalledTimes(before);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects/create',
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=demo' },
          payload: projectSaveBody.examples[0],
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

test('claimed project attachment reads require active business relationship plus independent creator grant', async () => {
  const db = {
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: false }]),
    uploadedFile: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'CLAIMED',
        bizType: 'PROJECT_ATTACHMENT',
        claimedBizType: 'PROJECT_ATTACHMENT',
        claimedBizId: '3001',
        objectKey: 'project-attachment/example.pdf',
        ownerUid: principal.uid,
        sensitiveFlag: true,
      }),
    },
    projectAttachment: {
      findFirst: vi.fn().mockResolvedValue({ id: 501, project: { createdBy: principal.uid } }),
    },
    projectManagerRecruitment: { findFirst: vi.fn().mockResolvedValue(null) },
    managementGrant: { findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }) },
  };
  const storage = { open: vi.fn().mockResolvedValue({ marker: 'stream' }) };
  const service = new FileService({ db, storage } as unknown as FileRegistryService);
  expect(
    await service.open('project-attachment/example.pdf', { ...principal, role: 'NAVIGATOR' }),
  ).toEqual({
    marker: 'stream',
  });
  expect(db.projectAttachment.findFirst).toHaveBeenCalledWith({
    where: {
      objectKey: 'project-attachment/example.pdf',
      projectId: 3001,
      status: 'ACTIVE',
      project: { deleted: false },
    },
    select: { id: true, project: { select: { createdBy: true } } },
  });
  await expect(
    service.open('project-attachment/example.pdf', { ...principal, role: 'EXPERT' }),
  ).rejects.toMatchObject({
    status: 403,
  });
  db.projectAttachment.findFirst.mockResolvedValueOnce(null as never);
  await expect(
    service.open('project-attachment/example.pdf', { ...principal, role: 'NAVIGATOR' }),
  ).rejects.toMatchObject({
    status: 403,
  });
  expect(storage.open).toHaveBeenCalledTimes(1);
});

test('malformed claimed project IDs and unsupported exam relations never reach storage or project queries', async () => {
  const record = {
    status: 'CLAIMED',
    bizType: 'PROJECT_ATTACHMENT',
    claimedBizType: 'PROJECT_ATTACHMENT',
    claimedBizId: '3001',
    objectKey: 'project-attachment/example.pdf',
  };
  const db = { uploadedFile: { findUnique: vi.fn() }, projectAttachment: { findFirst: vi.fn() } };
  const storage = { open: vi.fn() };
  const service = new FileService({ db, storage } as unknown as FileRegistryService);
  for (const claimedBizId of ['abc', '-1', '0', '2147483648', '9007199254740992']) {
    db.uploadedFile.findUnique.mockResolvedValueOnce({ ...record, claimedBizId });
    await expect(
      service.open(record.objectKey, { ...principal, role: 'NAVIGATOR' }),
    ).rejects.toMatchObject({ status: 403 });
  }
  db.uploadedFile.findUnique.mockResolvedValueOnce({
    ...record,
    bizType: 'ENTRANCE_EXAM_ATTACHMENT',
  });
  await expect(
    service.open(record.objectKey, { ...principal, role: 'NAVIGATOR' }),
  ).rejects.toMatchObject({ status: 403 });
  expect(db.projectAttachment.findFirst).not.toHaveBeenCalled();
  expect(storage.open).not.toHaveBeenCalled();
});
