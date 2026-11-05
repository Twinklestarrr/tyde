import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../common/errors.js';
import type { Config } from '../config/index.js';

export function registerBrowserTransport(app: FastifyInstance, config: Config) {
  const origins = [...config.webOrigins, ...config.desktopOrigins];
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
  const headers = ['content-type', 'x-tyde-client', 'idempotency-key'];
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(`${API_PREFIX}/`)) return;
    reply.header('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!origins.includes(origin))
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不可信');
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition');
    }
    if (req.method !== 'OPTIONS') return;
    const method = req.headers['access-control-request-method'];
    const requestedHeaders = req.headers['access-control-request-headers']
      ?.split(',')
      .map((value) => value.trim().toLowerCase());
    if (
      !origin ||
      !method ||
      !methods.includes(method) ||
      requestedHeaders?.some((value) => !headers.includes(value))
    )
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '跨源请求的方法或请求头不被允许');
    reply.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    reply.header('Access-Control-Allow-Methods', methods.join(', '));
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Tyde-Client, Idempotency-Key');
    return reply.code(204).send();
  });
  app.options(`${API_PREFIX}/*`, { schema: { hide: true } }, async (_req, reply) =>
    reply.code(204).send(),
  );
}
