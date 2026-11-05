import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { Config } from '../../config/index.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { validateTransport } from '../auth/security.js';
import { personalApplicationSchema } from './personal-application.schema.js';
import {
  PersonalApplicationService,
  type PersonalApplicationQuery,
} from './personal-application.service.js';

export async function personalApplicationRoutes(
  parent: FastifyInstance,
  service: PersonalApplicationService,
  auth: AuthService,
  config: Config,
) {
  await parent.register(async (app) => {
    const identities = new WeakMap<FastifyRequest, AuthPrincipal>();
    app.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !req.headers['x-tyde-client'] &&
        !req.headers.origin &&
        !req.headers.cookie &&
        !Object.keys(req.headers).some((k) => k.startsWith('sec-fetch-'))
      )
        req.headers['x-tyde-client'] = 'desktop';
      let client;
      try {
        client = validateTransport(req.headers, req.method, [
          ...config.webOrigins,
          ...config.desktopOrigins,
        ]);
      } catch {
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '请求来源或会话凭据组合不可信');
      }
      const token =
        client === 'desktop'
          ? req.headers.authorization?.replace(/^Bearer /, '')
          : req.cookies[config.cookieSecure ? '__Host-tyde_session' : 'tyde_session'];
      identities.set(req, await auth.authenticate(token, client));
    });
    app.post<{ Body: PersonalApplicationQuery }>(
      `${API_PREFIX}/users/me/applications`,
      { schema: personalApplicationSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.list(req.body, identities.get(req)!),
      }),
    );
  });
}
