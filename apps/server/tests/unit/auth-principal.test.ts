import type { PrismaClient } from '@prisma/client';
import { expect, test, vi } from 'vitest';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { digest } from '../../src/modules/auth/security.js';

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/auth_principal_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
});
const token = 'a'.repeat(43);
function setup(overrides: Record<string, unknown> = {}) {
  const session = {
    id: 'session-id',
    userId: 'user-id',
    clientType: 'desktop',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    user: { id: 'user-id', uid: 'uid', status: 'ACTIVE', passwordHash: 'private' },
    ...overrides,
  };
  const findUnique = vi.fn().mockResolvedValue(session);
  const db = { session: { findUnique } } as unknown as PrismaClient;
  return { service: new AuthService(db, config), findUnique };
}

test('business identity comes from the active session without exposing credentials or granting management roles', async () => {
  const { service, findUnique } = setup();
  expect(await service.authenticate(token, 'desktop')).toEqual({
    userId: 'user-id',
    uid: 'uid',
    sessionId: 'session-id',
    role: 'EXPERT',
    clientType: 'desktop',
  });
  expect(findUnique.mock.calls[0]![0].where).toEqual({ tokenDigest: digest(token) });
});

test.each([undefined, '', 'invalid', 'a'.repeat(44)])(
  'invalid token %s never queries the database',
  async (value) => {
    const { service, findUnique } = setup();
    await expect(service.authenticate(value, 'desktop')).rejects.toMatchObject({ status: 401 });
    expect(findUnique).not.toHaveBeenCalled();
  },
);

test.each([
  { revokedAt: new Date() },
  { expiresAt: new Date(0) },
  { clientType: 'web' },
  { user: { status: 'FROZEN' } },
  { user: { status: 'BANNED' } },
])('identity and profile both reject inactive or mismatched sessions: %j', async (overrides) => {
  const { service } = setup(overrides);
  await expect(service.authenticate(token, 'desktop')).rejects.toMatchObject({ status: 401 });
  await expect(service.me(token, 'desktop')).rejects.toMatchObject({ status: 401 });
});

test('unknown access token cannot establish an identity', async () => {
  const { service, findUnique } = setup();
  findUnique.mockResolvedValue(null);
  await expect(service.authenticate(token, 'desktop')).rejects.toMatchObject({ status: 401 });
});
