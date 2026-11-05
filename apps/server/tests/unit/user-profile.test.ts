import { PrismaClient } from '@prisma/client';
import { nicknameCheckSchema, userProfileUpdateSchema } from '@tyde/shared';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { nicknameCheckResponse, userResponse } from '../../src/modules/auth/auth.schema.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://127.0.0.1:3000',
  LOG_LEVEL: 'silent',
});
afterEach(() => vi.restoreAllMocks());

test('nickname suggestions skip occupied suffixes, trim, fit registration and never reserve names', async () => {
  const occupied = new Set(['小明', '小明1', 'a'.repeat(64)]);
  const findUnique = vi.fn(async ({ where }) =>
    occupied.has(where.displayName) ? { id: 'occupied' } : null,
  );
  const service = new AuthService({ user: { findUnique } } as unknown as PrismaClient, config);
  expect(await service.checkNickname(' 小明 ')).toMatchObject({
    nickname: '小明',
    available: false,
    suggestion: '小明2',
  });
  expect(await service.checkNickname(' 可用 ')).toMatchObject({
    nickname: '可用',
    available: true,
    suggestion: '可用',
  });
  expect((await service.checkNickname('a'.repeat(64))).suggestion).toBe('a'.repeat(63) + '1');
  await expect(service.checkNickname('   ')).rejects.toMatchObject({ status: 400 });
  await expect(service.checkNickname('a'.repeat(65))).rejects.toMatchObject({ status: 400 });
  findUnique.mockResolvedValue({ id: 'occupied' });
  await expect(service.checkNickname('全占用')).rejects.toMatchObject({ status: 409 });
});

function profileService(verified = false, revokedInside = false) {
  const user = {
    ...userResponse.examples[0],
    phoneE164: '+8613812345678',
    status: 'ACTIVE',
    idVerified: verified ? 1 : 0,
    idCardNo: verified ? '11010119900101001X' : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };
  const session = {
    id: 'session',
    userId: user.id,
    user,
    clientType: 'desktop',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60000),
  };
  const update = vi.fn(async ({ data }) => ({ ...user, ...data }));
  const revoke = vi.fn();
  const tx = {
    $queryRaw: vi.fn(),
    session: {
      findUnique: vi.fn(async () => ({ ...session, revokedAt: revokedInside ? new Date() : null })),
      updateMany: revoke,
    },
    user: { update },
    uploadedFile: { updateMany: vi.fn() },
  };
  const db = {
    session: { findUnique: vi.fn(async () => session) },
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  };
  return { service: new AuthService(db as unknown as PrismaClient, config), tx, update, revoke };
}
test('profile rechecks revoked sessions under the authentication lock before writing', async () => {
  const { service, update } = profileService(false, true);
  await expect(
    service.updateCurrentUser('a'.repeat(43), 'desktop', { bio: 'stale' }),
  ).rejects.toMatchObject({ status: 401 });
  expect(update).not.toHaveBeenCalled();
});
test('verified identity blocks changes, null keeps fields and roles never grant authority', async () => {
  const { service, update, revoke } = profileService(true);
  await expect(
    service.updateCurrentUser('a'.repeat(43), 'desktop', { idCardNo: '' }),
  ).rejects.toMatchObject({ status: 403 });
  expect(update).not.toHaveBeenCalled();
  const result = await service.updateCurrentUser('a'.repeat(43), 'desktop', {
    bio: ' 简介 ',
    avatarUrl: null,
    idCardNo: '11010119900101001x',
    roles: ['OPS', 'PM'],
  });
  expect(result).toMatchObject({
    bio: '简介',
    idVerified: 1,
    role: 'EXPERT',
    roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  });
  const data = update.mock.calls[0]![0].data;
  expect(data).toMatchObject({ bio: '简介', idCardNo: '11010119900101001X' });
  expect(data).not.toHaveProperty('avatarUrl');
  expect(data).not.toHaveProperty('role');
  expect(revoke).not.toHaveBeenCalled();
});
test('profile password confirmation is required and successful change revokes all user sessions', async () => {
  const { service, update, revoke } = profileService();
  for (const input of [
    { newPassword: 'Changed123!' },
    { confirmNewPassword: 'Changed123!' },
    { newPassword: 'Changed123!', confirmNewPassword: 'Wrong123!' },
  ])
    await expect(service.updateCurrentUser('a'.repeat(43), 'desktop', input)).rejects.toMatchObject(
      { status: 400 },
    );
  expect(update).not.toHaveBeenCalled();
  await service.updateCurrentUser('a'.repeat(43), 'desktop', {
    newPassword: 'Changed123!',
    confirmNewPassword: 'Changed123!',
  });
  expect(update.mock.calls[0]![0].data.passwordHash).not.toBe('Changed123!');
  expect(revoke).toHaveBeenCalledWith({
    where: { userId: userResponse.examples[0].id, revokedAt: null },
    data: { revokedAt: expect.any(Date) },
  });
});
test('profile OpenAPI, examples, response serialization and transport use the legacy contract', async () => {
  const app = await createApp(config, new PrismaClient());
  const profile = vi.spyOn(AuthService.prototype, 'updateCurrentUser').mockResolvedValue({
    ...userResponse.examples[0],
    accountType: 'INDIVIDUAL',
    role: 'EXPERT',
    roles: ['NAVIGATOR', 'PM', 'EXPERT'],
    selectedRole: null,
    avatarUrl: 'common/avatar.png',
    bio: '简介',
  });
  const check = vi
    .spyOn(AuthService.prototype, 'checkNickname')
    .mockResolvedValue(nicknameCheckResponse.examples[0]);
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/users/nickname/check'].get.security).toEqual([]);
    expect(spec.paths['/api/v1/users/nickname/check'].get.parameters[0].description).toMatch(
      /昵称/,
    );
    const operation = spec.paths['/api/v1/users/me/update'].post;
    expect(operation.security).toHaveLength(2);
    expect(operation.description).toContain('全部会话');
    const validate = (schema: object, value: unknown) =>
      app.validatorCompiler!({ schema, method: 'POST', url: '/example', httpPart: 'body' })(value);
    for (const schema of [
      nicknameCheckSchema,
      userProfileUpdateSchema,
      nicknameCheckResponse,
      userResponse,
    ])
      for (const example of schema.examples!) expect(validate(schema, example)).toBe(true);
    const response = await app.inject('/api/v1/users/nickname/check?nickname=小明');
    expect(response.json().data).toEqual(nicknameCheckResponse.examples[0]);
    expect(check).toHaveBeenCalledWith('小明');
    for (const input of userProfileUpdateSchema.examples!) {
      const updated = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/update',
        payload: input,
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data).toMatchObject({ avatarUrl: 'common/avatar.png', bio: '简介' });
      expect(updated.headers['cache-control']).toBe('no-store');
    }
    expect(profile).toHaveBeenCalledWith('a'.repeat(43), 'desktop', expect.any(Object));
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/update',
      payload: { newPassword: 'Changed123!', confirmNewPassword: 'Changed123!' },
      headers: { origin: config.webOrigins[0]!, cookie: `tyde_session=${'a'.repeat(43)}` },
    });
    expect(changed.cookies[0]?.value).toBe('');
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/update',
      payload: {},
      headers: { origin: 'https://evil.test' },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json()).toMatchObject({ code: 403, data: null });
    for (const payload of [
      { userId: 'other' },
      { idVerified: 1 },
      { nickname: '改名' },
      { roles: [] },
      { roles: ['UNKNOWN'] },
      { newPassword: 'bad' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/users/me/update', payload })).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
  }
});
