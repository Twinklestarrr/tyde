import type { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { codeDigest } from '../../src/modules/auth/security.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
});
const migration = readFileSync(
  new URL('../../prisma/migrations/20261013000000_init/migration.sql', import.meta.url),
  'utf8',
);
// 用实际迁移中的 CHECK 验证写入值，避免 Prisma schema 未包含数据库约束而漏检。
const usernamePattern = new RegExp(migration.match(/"username" ~ '([^']+)'/)![1]!);

test.each([...'0123456789abcdef'])(
  'registration respects the database username constraint when UUID starts with %s',
  async (first) => {
    const uuid = `${first}0000000-0000-4000-8000-000000000001` as ReturnType<typeof randomUUID>;
    vi.mocked(randomUUID).mockReturnValue(uuid);
    const now = new Date();
    const challenge = {
      id: 'challenge-id',
      expiresAt: new Date(now.getTime() + 300_000),
      consumedAt: null,
      invalidatedAt: null,
      failedAttempts: 0,
      codeDigest: codeDigest(
        config.codeSecret,
        'challenge-id',
        '+8613812345678',
        '095270',
        'register',
      ),
    };
    const create = vi.fn(async ({ data }: { data: Prisma.UserUncheckedCreateInput }) => {
      expect(data.username).toMatch(usernamePattern);
      expect(data.username.length).toBeLessThanOrEqual(32);
      expect(data.uid).toBe(uuid.replaceAll('-', ''));
      return {
        ...data,
        id: uuid,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        lastLoginIp: null,
      };
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      authRateLimit: { upsert: vi.fn().mockResolvedValue({ count: 1 }) },
      verificationChallenge: {
        findFirst: vi.fn().mockResolvedValue(challenge),
        update: vi.fn().mockResolvedValue({}),
      },
      user: { create },
    };
    const db = {
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const result = await new AuthService(db, config).register(
      {
        accountType: 'INDIVIDUAL',
        phone: '13812345678',
        code: '095270',
        password: 'Password123',
        confirmPassword: 'Password123',
        realName: '小明',
      },
      '127.0.0.1',
    );
    expect(create).toHaveBeenCalledOnce();
    expect(result.uid).toBe(uuid.replaceAll('-', ''));
    expect(result.role).toBe('EXPERT');
  },
);
