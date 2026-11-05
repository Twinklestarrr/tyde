import type { Prisma, PrismaClient, UploadedFile } from '@prisma/client';
import { expect, test, vi } from 'vitest';
import { readFileConfig } from '../../src/config/files.js';
import type { ObjectStorage } from '../../src/infrastructure/storage/object-storage.js';
import { FileRegistryService, tokenHash } from '../../src/modules/files/file-registry.service.js';
const config = readFileConfig({});
const token = 'a'.repeat(43);
const key = 'business-license/test.png';
const orgId = '00000000-0000-4000-8000-000000000001';
function setup(changes: Partial<UploadedFile> = {}) {
  const record = {
    id: orgId,
    objectKey: key,
    claimTokenHash: tokenHash(token),
    bizType: 'BUSINESS_LICENSE',
    status: 'UPLOADED',
    fileSize: 12,
    expiresAt: new Date(Date.now() + 60_000),
    ownerUid: null,
    ...changes,
  } as UploadedFile;
  const update = vi.fn().mockResolvedValue({ ...record, status: 'CLAIMED' });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([record]),
    uploadedFile: {
      update,
      create: vi.fn().mockImplementation(async ({ data }) => data),
      findUnique: vi.fn().mockResolvedValue(record),
    },
  };
  const storage = { head: vi.fn().mockResolvedValue({ size: 12 }) } as unknown as ObjectStorage;
  const registry = new FileRegistryService(tx as unknown as PrismaClient, storage, config);
  return {
    record,
    registry,
    storage,
    tx: tx as unknown as Prisma.TransactionClient,
    update,
    query: tx.$queryRaw,
  };
}
test('register generates high entropy credential and stores only its digest and trusted metadata', async () => {
  const { registry } = setup();
  const result = await registry.register(
    {
      objectKey: key,
      fileName: 'a.png',
      extension: 'png',
      contentType: 'image/png',
      fileSize: 12,
      fileHash: 'b'.repeat(64),
    },
    'BUSINESS_LICENSE',
    'IMAGE',
    null,
  );
  expect(result.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.record.claimTokenHash).toBe(tokenHash(result.uploadToken));
  expect(result.record).toMatchObject({
    ownerUid: null,
    sensitiveFlag: true,
    bizType: 'BUSINESS_LICENSE',
  });
  expect(result.record.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
});
test('organization claim accepts anonymous or logged-in upload by one-time credential', async () => {
  for (const ownerUid of [null, 'some-owner']) {
    const { registry, tx, update, query } = setup({ ownerUid });
    await registry.claimForOrganizationRegistration(tx, key, token, orgId);
    expect(query.mock.calls[0]![0].join('?')).toContain('FOR UPDATE');
    expect(update).toHaveBeenCalledWith({
      where: { id: orgId },
      data: expect.objectContaining({
        status: 'CLAIMED',
        claimedBizType: 'ORGANIZATION_BUSINESS_LICENSE',
        claimedBizId: orgId,
        expiresAt: null,
      }),
    });
  }
});
test.each([
  [{ bizType: 'COMMON' }, token, 400],
  [{ status: 'CLAIMED' }, token, 409],
  [{ status: 'DELETED' }, token, 409],
  [{ expiresAt: null }, token, 409],
  [{ expiresAt: new Date(0) }, token, 409],
  [{}, 'incorrect', 403],
  [{}, '', 400],
  [{ claimTokenHash: 'bad-hash' }, token, 403],
] as const)(
  'rejects invalid claim %# before updating or accessing storage',
  async (changes, raw, status) => {
    const { registry, tx, storage, update } = setup(changes);
    await expect(
      registry.claimForOrganizationRegistration(tx, key, raw, orgId),
    ).rejects.toMatchObject({ status });
    expect(update).not.toHaveBeenCalled();
    expect(storage.head).not.toHaveBeenCalled();
  },
);
test.each([null, { size: 13 }])(
  'missing or changed storage object rejects claim',
  async (metadata) => {
    const { registry, tx, storage, update } = setup();
    vi.mocked(storage.head).mockResolvedValue(metadata);
    await expect(
      registry.claimForOrganizationRegistration(tx, key, token, orgId),
    ).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  },
);
test.each(['PROJECT_ATTACHMENT', 'ENTRANCE_EXAM_ATTACHMENT'] as const)(
  'business ownership is required for %s claim',
  async (bizType) => {
    for (const ownerUid of [null, 'other']) {
      const { registry, tx, storage, update } = setup({ bizType, ownerUid });
      const claim =
        bizType === 'PROJECT_ATTACHMENT'
          ? registry.claimForProject.bind(registry)
          : registry.claimForEntranceExam.bind(registry);
      await expect(claim(tx, key, token, 'owner', orgId)).rejects.toMatchObject({ status: 403 });
      expect(storage.head).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  },
);
