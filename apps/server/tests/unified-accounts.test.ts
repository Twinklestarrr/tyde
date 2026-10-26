import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  BUSINESS_ROLES,
  organizationCreateSchema,
  smsRegisterSchema,
  switchRoleSchema,
} from '@tyde/shared';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import { readConfig } from '../src/config/index.js';
import { createApp } from '../src/application.js';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:3001',
  LOG_LEVEL: 'silent',
});
const token = 'a'.repeat(43);
function setup() {
  const now = new Date();
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    uid: 'uid',
    phoneE164: '+8613812345678',
    displayName: '昵称',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    memberships: [],
  };
  const session = {
    id: 'session',
    userId: user.id,
    user,
    selectedRole: 'EXPERT',
    clientType: 'desktop',
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    session: {
      findUnique: vi.fn(async () => session),
      findUniqueOrThrow: vi.fn(async () => session),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          session.revokedAt ||
          session.expiresAt <= new Date() ||
          user.status !== 'ACTIVE' ||
          (where.clientType && where.clientType !== session.clientType)
        )
          return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
      }),
      create: vi.fn(),
    },
    user: { findUniqueOrThrow: vi.fn(async () => user) },
    organization: {
      create: vi.fn(async ({ data }) => ({
        id: '00000000-0000-4000-8000-000000000002',
        businessLicenseKey: null,
        createdAt: now,
        ...data,
      })),
      update: vi.fn(),
    },
    userOrgRel: { create: vi.fn() },
  };
  const db = {
    ...tx,
    $disconnect: vi.fn(),
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  return { tx, db, user, session, service: new AuthService(db, config) };
}
afterEach(() => vi.restoreAllMocks());
test('switch updates only the authenticated session without rotating credentials; me and principal reflect role', async () => {
  const { service, tx } = setup();
  expect(await service.switchRole(token, 'desktop', 'PM')).toEqual({
    selectedRole: 'PM',
    roles: [...BUSINESS_ROLES],
  });
  expect(tx.session.updateMany).toHaveBeenCalledWith({
    where: expect.objectContaining({ id: 'session', revokedAt: null, user: { status: 'ACTIVE' } }),
    data: { selectedRole: 'PM' },
  });
  expect(tx.session.create).not.toHaveBeenCalled();
  expect(await service.authenticate(token, 'desktop')).toMatchObject({
    role: 'PM',
    sessionId: 'session',
  });
  expect(await service.me(token, 'desktop')).toMatchObject({
    roles: [...BUSINESS_ROLES],
    selectedRole: 'PM',
    accountType: 'INDIVIDUAL',
    organizations: [],
  });
});
test.each(['NAVIGATOR', 'PM', 'EXPERT'] as const)(
  'refresh retains %s while rotating credentials',
  async (role) => {
    const { service, session, tx } = setup();
    session.selectedRole = role;
    const result = await service.refresh('r'.repeat(43), 'desktop');
    expect(result.accessToken).not.toBe(token);
    expect(tx.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ selectedRole: role, clientType: 'desktop' }),
    });
    expect(session.revokedAt).toBeInstanceOf(Date);
  },
);
test.each(['OPS', 'INVALID'])('switch rejects %s without writes', async (role) => {
  const { service, tx } = setup();
  await expect(service.switchRole(token, 'desktop', role as never)).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.session.updateMany).not.toHaveBeenCalled();
});
test.each(['NAVIGATOR', 'PM'])('organization creation refuses %s before writes', async (role) => {
  const { service, session, tx } = setup();
  session.selectedRole = role;
  await expect(
    service.createOrganization(token, 'desktop', { name: '团队' }),
  ).rejects.toMatchObject({ status: 403 });
  expect(tx.organization.create).not.toHaveBeenCalled();
});
test('create immediately enables organization and OWNER relationship; another organization is allowed', async () => {
  const { service, tx } = setup();
  for (const name of ['  团队甲  ', '团队乙'])
    expect(
      await service.createOrganization(token, 'desktop', { name, expertiseTags: ['标注'] }),
    ).toMatchObject({
      name: name.trim(),
      status: 'ACTIVE',
      verifyStatus: 'APPROVED',
      position: 'OWNER',
    });
  expect(tx.userOrgRel.create).toHaveBeenCalledTimes(2);
  expect(tx.userOrgRel.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      userId: '00000000-0000-4000-8000-000000000001',
      position: 'OWNER',
      joinStatus: 'ACTIVE',
    }),
  });
});
test('license failure propagates within business transaction before member creation', async () => {
  const { service, tx } = setup();
  const claim = vi
    .spyOn(FileRegistryService.prototype, 'claimForOrganizationRegistration')
    .mockRejectedValue(new Error('claim failure'));
  await expect(
    service.createOrganization(token, 'desktop', {
      name: '团队',
      businessLicense: { objectKey: 'business-license/a.png', uploadToken: 'bad' },
    }),
  ).rejects.toThrow('claim failure');
  expect(claim).toHaveBeenCalledWith(
    tx,
    'business-license/a.png',
    'bad',
    '00000000-0000-4000-8000-000000000002',
  );
  expect(tx.userOrgRel.create).not.toHaveBeenCalled();
});
test('organization creation saves a claimed logo URL before completing the owner relationship', async () => {
  const { service, tx, user } = setup();
  const logoUrl = 'https://storage.example/org-logo/new.png';
  const claim = vi
    .spyOn(FileRegistryService.prototype, 'syncOrganizationLogo')
    .mockResolvedValue(logoUrl);
  const result = await service.createOrganization(token, 'desktop', {
    name: '图片组织',
    logoUrl: 'org-logo/new.png',
    logoUploadToken: 'image-token',
  });
  expect(claim).toHaveBeenCalledWith(tx, result.id, user.uid, 'org-logo/new.png', 'image-token');
  expect(tx.organization.update).toHaveBeenCalledWith({
    where: { id: result.id },
    data: { logoUrl },
  });
  expect(result.logoUrl).toBe(logoUrl);
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
    tx.userOrgRel.create.mock.invocationCallOrder[0]!,
  );
});
test('invalid or failed organization logo claims stop creation and propagate through the transaction', async () => {
  const { service, tx } = setup();
  const claim = vi
    .spyOn(FileRegistryService.prototype, 'syncOrganizationLogo')
    .mockRejectedValue(new Error('logo claim failure'));
  await expect(
    service.createOrganization(token, 'desktop', {
      name: '图片组织',
      logoUploadToken: 'image-token',
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.organization.create).not.toHaveBeenCalled();
  await expect(
    service.createOrganization(token, 'desktop', {
      name: '图片组织',
      logoUrl: 'org-logo/new.png',
      logoUploadToken: 'image-token',
    }),
  ).rejects.toThrow('logo claim failure');
  expect(claim).toHaveBeenCalledOnce();
  expect(tx.organization.update).not.toHaveBeenCalled();
  expect(tx.userOrgRel.create).not.toHaveBeenCalled();
});
test('revoked sessions and frozen accounts cannot create or switch', async () => {
  for (const mode of ['revoked', 'frozen']) {
    const { service, session, user, tx } = setup();
    if (mode === 'revoked') session.revokedAt = new Date();
    else user.status = 'FROZEN';
    await expect(
      service.createOrganization(token, 'desktop', { name: '团队' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(service.switchRole(token, 'desktop', 'PM')).rejects.toMatchObject({ status: 401 });
    expect(tx.organization.create).not.toHaveBeenCalled();
  }
});
test('HTTP routes validate and serialize schemas, reject owner injection and untrusted browser writes', async () => {
  const { db } = setup();
  const app = await createApp(config, db);
  try {
    await app.ready();
    for (const schema of [organizationCreateSchema, switchRoleSchema, smsRegisterSchema]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples ?? [])
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/switch-role',
          headers,
          payload: { role: 'PM' },
        })
      ).json().data,
    ).toEqual({ selectedRole: 'PM', roles: [...BUSINESS_ROLES] });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-role',
      headers,
      payload: { role: 'EXPERT' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers,
      payload: { name: '团队' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toMatchObject({
      name: '团队',
      position: 'OWNER',
      verifyStatus: 'APPROVED',
      status: 'ACTIVE',
    });
    for (const payload of [
      { name: ' ' },
      { name: '团队', orgPosition: 'ADMIN' },
      { name: '团队', ownerUid: 'other' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/organizations', headers, payload }))
          .statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/switch-role',
          headers,
          payload: { role: 'OPS' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: {
            origin: 'https://evil.example',
            cookie: `tyde_session=${token}`,
            'x-tyde-client': 'web',
          },
          payload: { name: '团队' },
        })
      ).statusCode,
    ).toBe(403);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/organizations'].post.operationId).toBe('createOrganization');
    expect(spec.paths['/api/v1/auth/switch-role'].post.security).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test('expert management display follows accepted owner organizations and selected session role', async () => {
  const f = setup();
  Object.assign(f.user, {
    memberships: [
      {
        orgId: 'org',
        position: 'MEMBER',
        joinStatus: 'ACTIVE',
        joinedAt: new Date(),
        id: 'rel',
        organization: { id: 'org', deleted: false, expertiseTags: [], createdAt: new Date() },
      },
    ],
    assignmentOwners: [{ assignment: { organizationId: 'org' } }],
  });
  expect((await f.service.me(token, 'desktop')).hasExpertManagementRole).toBe(true);
  f.session.selectedRole = 'PM';
  expect((await f.service.me(token, 'desktop')).hasExpertManagementRole).toBe(false);
  f.session.selectedRole = 'EXPERT';
  Object.assign(f.user, { assignmentOwners: [{ assignment: { organizationId: 'another-org' } }] });
  expect((await f.service.me(token, 'desktop')).hasExpertManagementRole).toBe(false);
  Object.assign(f.user, {
    assignmentOwners: [],
    legacyOwnerAssignments: [{ organizationId: 'org' }],
  });
  expect((await f.service.me(token, 'desktop')).hasExpertManagementRole).toBe(true);
  Object.assign(f.user, { memberships: [] });
  expect((await f.service.me(token, 'desktop')).hasExpertManagementRole).toBe(false);
});
