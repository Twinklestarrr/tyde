import { scrypt as derive, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const [, salt, value] = encoded?.split(':') ?? [];
  // Unknown accounts still perform the same expensive derivation.
  const hash = (await scrypt(password, salt ?? '00000000000000000000000000000000', 64)) as Buffer;
  const expected = Buffer.from(value ?? '00'.repeat(64), 'hex');
  return Boolean(
    encoded?.startsWith('scrypt:') &&
    expected.length === hash.length &&
    timingSafeEqual(hash, expected),
  );
}
