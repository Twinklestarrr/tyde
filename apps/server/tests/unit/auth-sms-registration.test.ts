import type { PrismaClient } from '@prisma/client';
import { expect, test, vi } from 'vitest';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { codeDigest, digest } from '../../src/modules/auth/security.js';

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
});
function fixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    authRateLimit: { upsert: vi.fn().mockResolvedValue({ count: 1 }) },
    verificationChallenge: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'challenge',
        expiresAt: new Date(Date.now() + 300_000),
        consumedAt: null,
        invalidatedAt: null,
        failedAttempts: 0,
        codeDigest: codeDigest(config.codeSecret, 'challenge', '+8613812345678', '095270', 'login'),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    session: { create: vi.fn() },
    userOrgRel: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    registrationGrant: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaClient;
  return { tx, service: new AuthService(db, config) };
}
test.each(['web', 'desktop'] as const)(
  'new phone on %s gets a registration grant without an account or session',
  async (client) => {
    const { tx, service } = fixture();
    const before = Date.now();
    const result = await service.loginBySms(
      { phone: '13812345678', code: '095270' },
      '127.0.0.1',
      client,
    );
    expect('status' in result).toBe(true);
    if (!('status' in result)) throw new Error('expected registration');
    expect(result.status).toBe('registration_required');
    expect(result.registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(before + 600_000);
    expect(tx.registrationGrant.create).toHaveBeenCalledWith({
      data: {
        tokenDigest: digest(`sms-registration:${result.registrationToken}`),
        phoneE164: '+8613812345678',
        phoneRegion: 'CN',
        expiresAt: new Date(result.expiresAt),
      },
    });
    expect(tx.registrationGrant.updateMany).toHaveBeenCalledWith({
      where: { phoneE164: '+8613812345678', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.session.create).not.toHaveBeenCalled();
    expect(tx.verificationChallenge.update).toHaveBeenCalledWith({
      where: { id: 'challenge' },
      data: { consumedAt: expect.any(Date) },
    });
  },
);
test('wrong login code does not issue a registration credential', async () => {
  const { tx, service } = fixture();
  await expect(
    service.loginBySms({ phone: '13812345678', code: '000000' }, '127.0.0.1', 'web'),
  ).rejects.toThrow('验证码错误或已过期');
  expect(tx.registrationGrant.create).not.toHaveBeenCalled();
  expect(tx.user.findUnique).not.toHaveBeenCalled();
});
test('existing account logs in without issuing a registration credential', async () => {
  const { tx, service } = fixture();
  tx.user.findUnique.mockResolvedValue({ id: 'user', status: 'ACTIVE' });
  const result = await service.loginBySms(
    { phone: '13812345678', code: '095270' },
    '127.0.0.1',
    'web',
  );
  expect(result).toMatchObject({ tokenType: 'Bearer', accessToken: expect.any(String) });
  expect(tx.session.create).toHaveBeenCalledOnce();
  expect(tx.registrationGrant.create).not.toHaveBeenCalled();
});
test('invalid registration credential cannot create a user or consume a registration SMS', async () => {
  const { tx, service } = fixture();
  tx.registrationGrant.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    service.register(
      {
        accountType: 'INDIVIDUAL',
        phone: '13812345678',
        registrationToken: 'g'.repeat(43),
        realName: '小明',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
      '127.0.0.1',
    ),
  ).rejects.toThrow('注册凭证无效或已过期');
  expect(tx.user.create).not.toHaveBeenCalled();
  expect(tx.verificationChallenge.findFirst).not.toHaveBeenCalled();
});

test('valid registration grant creates the submitted profile without a second SMS or session', async () => {
  const { tx, service } = fixture();
  tx.user.create.mockImplementation(async ({ data }) => ({
    ...data,
    id: 'new-user',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    lastLoginIp: null,
    status: 'ACTIVE',
  }));
  const result = await service.register(
    {
      accountType: 'INDIVIDUAL',
      phone: '13812345678',
      registrationToken: 'g'.repeat(43),
      realName: '小明',
      password: 'Password123',
      confirmPassword: 'Password123',
    },
    '127.0.0.1',
  );
  expect(result).toMatchObject({ id: 'new-user', realName: '小明', role: 'EXPERT' });
  expect(tx.registrationGrant.updateMany).toHaveBeenCalledWith({
    where: {
      tokenDigest: digest(`sms-registration:${'g'.repeat(43)}`),
      phoneE164: '+8613812345678',
      consumedAt: null,
      expiresAt: { gt: expect.any(Date) },
    },
    data: { consumedAt: expect.any(Date) },
  });
  expect(tx.user.create).toHaveBeenCalledOnce();
  expect(tx.verificationChallenge.findFirst).not.toHaveBeenCalled();
  expect(tx.session.create).not.toHaveBeenCalled();
});

test('pending membership activation failure prevents session issuance', async () => {
  const { tx, service } = fixture();
  tx.user.findUnique.mockResolvedValue({ id: 'user', uid: 'uid', status: 'ACTIVE' });
  tx.userOrgRel.findMany.mockResolvedValue([
    { orgId: '00000000-0000-4000-8000-000000000002' },
  ] as never);
  tx.userOrgRel.updateMany.mockRejectedValue(new Error('activation failed'));
  await expect(
    service.loginBySms({ phone: '13812345678', code: '095270' }, '127.0.0.1', 'desktop'),
  ).rejects.toThrow('activation failed');
  expect(tx.session.create).not.toHaveBeenCalled();
  expect(tx.user.update).not.toHaveBeenCalled();
});
