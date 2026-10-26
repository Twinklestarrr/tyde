import type { Prisma, PrismaClient, UploadedFile } from '@prisma/client';
import { expect, test, vi } from 'vitest';
import { FileRegistryService, tokenHash } from '../src/modules/files/file-registry.service.js';
import { readFileConfig } from '../src/modules/files/file.config.js';
import type { ObjectStorage } from '../src/modules/files/object-storage.js';

const key = 'org-logo/2026/10/23/test.png';
const token = 'a'.repeat(43);
const orgId = '00000000-0000-4000-8000-000000000002';
function setup(changes: Partial<UploadedFile> = {}) {
  const record = {
    id: 'file-id',
    objectKey: key,
    bizType: 'ORG_LOGO',
    status: 'UPLOADED',
    ownerUid: 'owner',
    claimTokenHash: tokenHash(token),
    fileSize: 12,
    expiresAt: new Date(Date.now() + 60_000),
    ...changes,
  } as UploadedFile;
  const update = vi.fn().mockResolvedValue(record);
  const release = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([record]),
    uploadedFile: { update, updateMany: release },
  } as unknown as Prisma.TransactionClient;
  const storage = {
    head: vi.fn().mockResolvedValue({ size: 12 }),
    accessUrl: vi.fn((objectKey: string) => `https://storage.example/${objectKey}`),
  } as unknown as ObjectStorage;
  const registry = new FileRegistryService({} as PrismaClient, storage, readFileConfig({}));
  return { record, tx, update, release, storage, registry };
}

test('organization logo claims an owned upload and releases only other logos belonging to the organization', async () => {
  const { registry, tx, update, release } = setup();
  expect(await registry.syncOrganizationLogo(tx, orgId, 'owner', key, token)).toBe(
    `https://storage.example/${key}`,
  );
  expect(update).toHaveBeenCalledWith({
    where: { id: 'file-id' },
    data: expect.objectContaining({
      status: 'CLAIMED',
      claimedBizType: 'ORGANIZATION_LOGO',
      claimedBizId: orgId,
      expiresAt: null,
    }),
  });
  expect(release).toHaveBeenCalledWith({
    where: {
      status: 'CLAIMED',
      claimedBizType: 'ORGANIZATION_LOGO',
      claimedBizId: orgId,
      objectKey: { not: key },
    },
    data: { status: 'RELEASED', expiresAt: expect.any(Date) },
  });
});

test.each([
  [{ ownerUid: 'other' }, token, 403],
  [{ ownerUid: null }, token, 403],
  [{ bizType: 'AVATAR' }, token, 400],
  [{}, 'wrong', 403],
  [{}, undefined, 400],
  [{ expiresAt: new Date(0) }, token, 409],
  [{ status: 'CLAIMED', claimedBizType: 'ORGANIZATION_LOGO', claimedBizId: 'other' }, token, 409],
] as const)(
  'invalid logo claim %# cannot release existing organization images',
  async (changes, rawToken, status) => {
    const { registry, tx, update, release, storage } = setup(changes);
    await expect(
      registry.syncOrganizationLogo(tx, orgId, 'owner', key, rawToken),
    ).rejects.toMatchObject({ status });
    expect(update).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(storage.head).not.toHaveBeenCalled();
  },
);

test('same organization image can be saved by a new owner without consuming the token again', async () => {
  const { registry, tx, update, storage } = setup({
    status: 'CLAIMED',
    claimedBizType: 'ORGANIZATION_LOGO',
    claimedBizId: orgId,
  });
  expect(
    await registry.syncOrganizationLogo(tx, orgId, 'new-owner', `https://storage.example/${key}`),
  ).toBe(`https://storage.example/${key}`);
  expect(update).not.toHaveBeenCalled();
  expect(storage.head).not.toHaveBeenCalled();
});

test.each(['', 'https://external.example/logo.png', `https://external.example/${key}`])(
  'external URLs and clear release the previous logo without treating another host as storage: %s',
  async (value) => {
    const { registry, tx, update, release } = setup();
    expect(await registry.syncOrganizationLogo(tx, orgId, 'owner', value)).toBe(value);
    expect(update).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({
      where: { status: 'CLAIMED', claimedBizType: 'ORGANIZATION_LOGO', claimedBizId: orgId },
      data: { status: 'RELEASED', expiresAt: expect.any(Date) },
    });
    release.mockClear();
    await expect(
      registry.syncOrganizationLogo(tx, orgId, 'owner', value, token),
    ).rejects.toMatchObject({ status: 400 });
    expect(release).not.toHaveBeenCalled();
  },
);

test('missing image objects fail without releasing the previous logo', async () => {
  const { registry, tx, release, storage } = setup();
  vi.mocked(storage.head).mockResolvedValue(null);
  await expect(registry.syncOrganizationLogo(tx, orgId, 'owner', key, token)).rejects.toMatchObject(
    { status: 400 },
  );
  expect(release).not.toHaveBeenCalled();
});
