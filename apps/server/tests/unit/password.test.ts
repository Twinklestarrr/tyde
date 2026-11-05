import { expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/infrastructure/security/password.js';
import { codeDigest } from '../../src/modules/auth/security.js';
test('salted password storage verifies exact password and rejects unknown/corrupt credentials', async () => {
  const a = await hashPassword('Password123');
  const b = await hashPassword('Password123');
  expect(a).not.toBe(b);
  expect(a).not.toContain('Password123');
  expect(await verifyPassword('Password123', a)).toBe(true);
  expect(await verifyPassword('password123', a)).toBe(false);
  expect(await verifyPassword('Password123', null)).toBe(false);
  expect(await verifyPassword('Password123', 'corrupt')).toBe(false);
});
test('verification digest binds business scene as well as phone and challenge', () => {
  const hash = (scene: string) =>
    codeDigest('x'.repeat(32), 'challenge', '+8613812345678', '095270', scene);
  expect(new Set(['login', 'register', 'reset_password'].map(hash)).size).toBe(3);
});
