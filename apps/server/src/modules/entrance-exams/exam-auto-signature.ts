import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../common/errors.js';
export const autoCallbackPath = '/api/v1/integrations/agents/entrance-exam-grading/callback';
export function signAutoCallback(secret: string, timestamp: string, body: string | Buffer) {
  if (secret.length < 32)
    throw new AppError(503, 'SERVICE_UNAVAILABLE', '请配置专用自动阅卷HMAC密钥');
  const digest = createHash('sha256').update(body).digest('base64');
  return createHmac('sha256', secret)
    .update(`POST\n${autoCallbackPath}\n${timestamp}\n${digest}`)
    .digest('base64');
}
export function verifyAutoCallback(
  secret: string,
  timestamp: unknown,
  signature: unknown,
  body: Buffer,
  now = Date.now(),
) {
  if (!secret) throw new AppError(503, 'SERVICE_UNAVAILABLE', '自动阅卷回调未启用');
  if (
    typeof timestamp !== 'string' ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature)
  )
    throw new AppError(401, 'UNAUTHORIZED', 'Agent签名无效或时间超出300秒窗口');
  const expected = Buffer.from(signAutoCallback(secret, timestamp, body), 'base64');
  const actual = Buffer.from(signature, 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
    throw new AppError(401, 'UNAUTHORIZED', 'Agent签名无效');
}
