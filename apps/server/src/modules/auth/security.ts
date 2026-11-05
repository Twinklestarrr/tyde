import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ClientType } from './auth.types.js';

export { MOCK_SMS_CODE as MOCK_CODE } from '@tyde/shared';

export const SESSION_DAYS = 30;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function codeDigest(
  secret: string,
  id: string,
  phone: string,
  code: string,
  purpose = 'login',
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify([id, phone, purpose, code]))
    .digest('hex');
}

export function matchesDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

export function normalizeProfile(
  username: string,
  displayName: string,
): { username: string; displayName: string } {
  const normalized = username.trim().toLowerCase();
  const name = displayName.trim().normalize('NFC');
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(normalized))
    throw new Error('用户名须为 3～32 位，以英文字母开头，仅含字母、数字或下划线');
  if ([...name].length < 1 || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new Error('姓名须为 1～80 个字符，不含控制字符');
  return { username: normalized, displayName: name };
}

export function validateTransport(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  origins: readonly string[],
): ClientType {
  const client = headers['x-tyde-client'] ?? 'web';
  if (client !== 'web' && client !== 'desktop') throw new Error('请求客户端类型无效');
  if (client === 'desktop') {
    if (
      headers.origin !== undefined ||
      headers.cookie !== undefined ||
      Object.keys(headers).some((x) => x.startsWith('sec-fetch-'))
    )
      throw new Error('浏览器请求不能使用桌面令牌传输');
  } else if (!['GET', 'HEAD'].includes(method)) {
    if (typeof headers.origin !== 'string' || !origins.includes(headers.origin))
      throw new Error('请求来源不可信');
  }
  if (headers.authorization !== undefined && headers.cookie !== undefined)
    throw new Error('不允许同时使用两种会话凭据');
  if (client === 'web' && headers.authorization !== undefined)
    throw new Error('网页请求不接受 Bearer 会话');
  return client;
}
