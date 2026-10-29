import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
import { OrganizationService } from '../src/modules/organizations/organization.service.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import {
  organizationQuery,
  organizationUpdateBody,
  organizationDetailResponse,
  organizationUpdateResponse,
  organizationOverviewResponse,
} from '../src/modules/organizations/organization.schema.js';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
const orgId = '00000000-0000-4000-8000-000000000002';
const identity: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'test-uid',
  sessionId: 'session',
  role: 'EXPERT',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
function setup(position = 'OWNER', joinStatus = 'ACTIVE', exists = true) {
  const org = {
    ...organizationDetailResponse.examples[0],
    businessLicenseKey: 'org/license.pdf',
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date(),
    expertiseTags: ['  图像标注 ', ' '],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    userOrgRel: {
      findUnique: vi.fn().mockResolvedValue(position ? { position, joinStatus } : null),
      count: vi.fn().mockResolvedValue(21),
    },
    projectMember: { count: vi.fn().mockResolvedValue(13) },
    orgMemberSchedule: { count: vi.fn().mockResolvedValue(9) },
    orgAttendanceDaily: { count: vi.fn().mockResolvedValue(8) },
    approvalNode: { count: vi.fn().mockResolvedValue(3) },
    organization: {
      findFirst: vi.fn().mockResolvedValue(exists ? org : null),
      update: vi.fn(async ({ data }) => ({ ...org, ...data })),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  const files = {
    syncOrganizationLogo: vi.fn(async (_tx, _organizationId, _ownerUid, value: string) => value),
  };
  return {
    db,
    tx,
    files,
    service: new OrganizationService(db, files as unknown as FileRegistryService),
  };
}
test.each(['OWNER', 'ADMIN'])(
  'organization detail permits %s in each participating state',
  async (position) => {
    for (const status of ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE']) {
      const { service, tx } = setup(position, status);
      expect(await service.detail(orgId, identity)).toMatchObject({
        id: orgId,
        position,
        businessLicenseUrl: 'org/license.pdf',
        expertiseTags: ['图像标注'],
      });
      expect(tx.userOrgRel.findUnique).toHaveBeenCalledWith({
        where: { userId_orgId: { userId: identity.userId, orgId } },
      });
      expect(tx.organization.findFirst).toHaveBeenCalledWith({
        where: { id: orgId, deleted: false },
      });
    }
  },
);
test.each(['PENDING', 'PENDING_ACTIVATION', 'LEFT', 'REMOVED'])(
  'organization detail rejects %s membership',
  async (status) => {
    const { service, tx } = setup('OWNER', status);
    await expect(service.detail(orgId, identity)).rejects.toMatchObject({ status: 403 });
    expect(tx.organization.findFirst).not.toHaveBeenCalled();
  },
);
test.each(['MEMBER', ''])(
  'organization detail rejects ordinary or absent membership: %s',
  async (position) => {
    await expect(setup(position).service.detail(orgId, identity)).rejects.toMatchObject({
      status: 403,
    });
  },
);
test('organization lookup preserves 403 before 404 and excludes deleted organizations', async () => {
  await expect(
    setup('OWNER', 'ACTIVE', false).service.detail(orgId, identity),
  ).rejects.toMatchObject({ status: 404 });
  await expect(setup('', 'ACTIVE', false).service.detail(orgId, identity)).rejects.toMatchObject({
    status: 403,
  });
});
test.each([
  ['ADMIN', 'ACTIVE'],
  ['MEMBER', 'ACTIVE'],
  ['OWNER', 'EXIT_APPROVING'],
  ['OWNER', 'PENDING_LEAVE'],
  ['OWNER', 'LEFT'],
])('organization update forbids %s/%s', async (position, status) => {
  const { service, tx } = setup(position, status);
  await expect(service.update({ orgId, description: 'forbidden' }, identity)).rejects.toMatchObject(
    { status: 403 },
  );
  expect(tx.organization.update).not.toHaveBeenCalled();
});
test('organization partial updates preserve null/omitted fields, trim, clear and use audit uid under lock', async () => {
  const { service, tx } = setup();
  await service.update({ orgId, description: null, logoUrl: '   ' }, identity);
  expect(tx.$queryRaw).toHaveBeenCalledOnce();
  expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
    tx.userOrgRel.findUnique.mock.invocationCallOrder[0]!,
  );
  expect(tx.organization.update.mock.calls[0]![0].data).toMatchObject({
    logoUrl: '',
    updatedBy: identity.uid,
  });
  expect(tx.organization.update.mock.calls[0]![0].data).not.toHaveProperty('description');
  await service.update({ orgId, description: '  简介  ' }, identity);
  expect(tx.organization.update.mock.calls[1]![0].data).toMatchObject({ description: '简介' });
  expect(tx.organization.update.mock.calls[1]![0].data).not.toHaveProperty('logoUrl');
});
test('organization logo claim follows owner checks and rejects an unattached upload token', async () => {
  const { service, tx, files } = setup();
  await expect(service.update({ orgId, logoUploadToken: 'token' }, identity)).rejects.toMatchObject(
    { status: 400 },
  );
  expect(files.syncOrganizationLogo).not.toHaveBeenCalled();
  files.syncOrganizationLogo.mockResolvedValue('https://storage.example/org-logo/test.png');
  await service.update({ orgId, logoUrl: 'org-logo/test.png', logoUploadToken: 'token' }, identity);
  expect(files.syncOrganizationLogo).toHaveBeenCalledWith(
    tx,
    orgId,
    identity.uid,
    'org-logo/test.png',
    'token',
  );
  expect(tx.organization.update.mock.calls[0]![0].data.logoUrl).toBe(
    'https://storage.example/org-logo/test.png',
  );
  const forbidden = setup('ADMIN');
  await expect(
    forbidden.service.update(
      { orgId, logoUrl: 'org-logo/test.png', logoUploadToken: 'token' },
      identity,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(forbidden.files.syncOrganizationLogo).not.toHaveBeenCalled();
  files.syncOrganizationLogo.mockRejectedValue(new AuthError(409, 'DUPLICATE', '图片已过期'));
  await expect(
    service.update({ orgId, logoUrl: 'org-logo/expired.png', logoUploadToken: 'token' }, identity),
  ).rejects.toMatchObject({ status: 409 });
  expect(tx.organization.update).toHaveBeenCalledOnce();
});
test('organization HTTP enforces Bearer/cookie isolation, validation and Result serialization', async () => {
  const { service, db } = setup();
  const authenticate = vi
    .spyOn(AuthService.prototype, 'authenticate')
    .mockImplementation(async (token) => {
      if (token !== 'token') throw new AuthError(401, 'UNAUTHENTICATED', '请先登录');
      return identity;
    });
  const detailImplementation = service.detail.bind(service);
  const updateImplementation = service.update.bind(service);
  const overviewImplementation = service.overview.bind(service);
  vi.spyOn(OrganizationService.prototype, 'overview').mockImplementation(overviewImplementation);
  vi.spyOn(OrganizationService.prototype, 'detail').mockImplementation(detailImplementation);
  vi.spyOn(OrganizationService.prototype, 'update').mockImplementation(updateImplementation);
  const app = await createApp(config, db);
  const headers = { authorization: 'Bearer token' };
  try {
    expect((await app.inject(`/api/v1/organizations?orgId=${orgId}`)).statusCode).toBe(401);
    const overview = await app.inject({
      url: `/api/v1/organizations/overview?orgId=${orgId}`,
      headers,
    });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().data).toEqual(organizationOverviewResponse.examples[0]);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect((await app.inject(`/api/v1/organizations/overview?orgId=${orgId}`)).statusCode).toBe(
      401,
    );
    for (const query of ['', '?orgId=10', `?orgId=${orgId}&extra=1`])
      expect(
        (await app.inject({ url: `/api/v1/organizations/overview${query}`, headers })).statusCode,
      ).toBe(400);
    const detail = await app.inject({ url: `/api/v1/organizations?orgId=${orgId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.json()).toMatchObject({
      code: 200,
      message: '操作成功',
      data: { id: orgId, businessLicenseUrl: 'org/license.pdf', position: 'OWNER' },
    });
    expect(detail.json().data).not.toHaveProperty('businessLicenseKey');
    for (const query of ['', '?orgId=10', `?orgId=${orgId}&extra=1`])
      expect((await app.inject({ url: `/api/v1/organizations${query}`, headers })).statusCode).toBe(
        400,
      );
    for (const payload of [
      { orgId, name: 'cannot change' },
      { orgId, description: 'x'.repeat(1001) },
      { orgId, logoUrl: 'x'.repeat(501) },
      { orgId: '10' },
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations/update',
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ code: 400, data: null });
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/update',
          headers,
          payload: { orgId, description: null, logoUrl: '' },
        })
      ).statusCode,
    ).toBe(200);
    for (const badHeaders of [
      { ...headers, origin: config.webOrigins[0] },
      { ...headers, cookie: 'tyde_session=token' },
      { 'x-tyde-client': 'desktop', origin: config.webOrigins[0], ...headers },
      { origin: 'https://evil.example', cookie: 'tyde_session=token' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/organizations/update',
            headers: badHeaders,
            payload: { orgId },
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/update',
          headers: { origin: config.webOrigins[0], cookie: 'tyde_session=token' },
          payload: { orgId },
        })
      ).statusCode,
    ).toBe(200);
    expect(authenticate).toHaveBeenCalledWith('token', 'web');
  } finally {
    await app.close();
  }
});
test('generated organization OpenAPI includes Chinese parameters and valid complete examples', async () => {
  const { db } = setup();
  const app = await createApp(config, db);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    const get = spec.paths['/api/v1/organizations'].get;
    const post = spec.paths['/api/v1/organizations/update'].post;
    const overview = spec.paths['/api/v1/organizations/overview'].get;
    expect(overview.operationId).toBe('getOrganizationOverview');
    expect(overview.parameters[0].required).toBe(true);
    const data = overview.responses['200'].content['application/json'].schema.properties.data;
    expect(data.required).toHaveLength(6);
    for (const property of Object.values(data.properties) as { description: string }[])
      expect(property.description).toMatch(/[\u4e00-\u9fff]/);
    expect(get.operationId).toBe('getOrganization');
    expect(get.parameters[0].description).toContain('UUID');
    expect(
      post.requestBody.content['application/json'].schema.properties.description.description,
    ).toContain('null');
    for (const schema of [
      organizationQuery,
      organizationUpdateBody,
      organizationDetailResponse,
      organizationUpdateResponse,
      organizationOverviewResponse,
    ]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/schema-example',
        httpPart: 'body',
      });
      for (const example of schema.examples) expect(validate(example)).toBe(true);
    }
    const media = post.responses['200'].content['application/json'];
    const example = media.example ?? (Object.values(media.examples)[0] as { value: unknown }).value;
    expect(example).toEqual({
      code: 200,
      message: '操作成功',
      data: organizationUpdateResponse.examples[0],
    });
  } finally {
    await app.close();
  }
});

test('overview aggregates the old SQL scopes in one snapshot and uses the Shanghai midnight boundary', async () => {
  const { db, service, tx } = setup();
  for (const [instant, date] of [
    ['2026-10-26T15:59:59Z', '2026-10-26'],
    ['2026-10-26T16:00:00Z', '2026-10-27'],
  ]) {
    expect(await service.overview(orgId, identity, new Date(instant))).toEqual(
      organizationOverviewResponse.examples[0],
    );
    expect(tx.orgMemberSchedule.count).toHaveBeenLastCalledWith({
      where: { orgId, scheduleDate: new Date(date), status: 'ACTIVE', dayType: 'WORK' },
    });
    expect(tx.orgAttendanceDaily.count).toHaveBeenLastCalledWith({
      where: { orgId, attendanceDate: new Date(date), finalStatus: 'PRESENT' },
    });
  }
  expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(tx.userOrgRel.count).toHaveBeenCalledWith({
    where: {
      orgId,
      joinStatus: { in: ['PENDING_ACTIVATION', 'ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'] },
    },
  });
  expect(tx.projectMember.count).toHaveBeenCalledWith({
    where: { status: 'ACTIVE', organizationMembership: { orgId } },
  });
  expect(tx.approvalNode.count).toHaveBeenCalledWith({
    where: {
      approverId: identity.userId,
      nodeStatus: 'PENDING',
      flow: { applicantOrgId: orgId, status: 'PENDING' },
    },
  });
  tx.approvalNode.count.mockRejectedValue(new Error('query failed'));
  await expect(service.overview(orgId, identity)).rejects.toThrow('query failed');
});
test('overview honors participating managers across session roles, denies lost membership before aggregating, and returns zero counts', async () => {
  for (const position of ['OWNER', 'ADMIN'])
    for (const joinStatus of ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE']) {
      const { service, tx } = setup(position, joinStatus);
      for (const role of ['NAVIGATOR', 'PM', 'EXPERT'] as const)
        expect((await service.overview(orgId, { ...identity, role })).orgId).toBe(orgId);
      for (const model of [
        tx.userOrgRel,
        tx.projectMember,
        tx.orgMemberSchedule,
        tx.orgAttendanceDaily,
        tx.approvalNode,
      ])
        model.count.mockResolvedValue(0);
      expect(await service.overview(orgId, identity)).toEqual({
        orgId,
        memberTotal: 0,
        activeProjectMemberTotal: 0,
        todayScheduledTotal: 0,
        todayPresentTotal: 0,
        pendingApprovalTotal: 0,
      });
    }
  for (const [position, status] of [
    ['MEMBER', 'ACTIVE'],
    ['', 'ACTIVE'],
    ['OWNER', 'PENDING'],
    ['ADMIN', 'PENDING_ACTIVATION'],
    ['OWNER', 'LEFT'],
    ['ADMIN', 'REMOVED'],
  ]) {
    const { service, tx } = setup(position, status);
    await expect(service.overview(orgId, identity)).rejects.toMatchObject({ status: 403 });
    expect(tx.userOrgRel.count).not.toHaveBeenCalled();
  }
  const { service, tx } = setup('OWNER', 'ACTIVE', false);
  await expect(service.overview(orgId, identity)).rejects.toMatchObject({ status: 404 });
  expect(tx.userOrgRel.count).not.toHaveBeenCalled();
});
