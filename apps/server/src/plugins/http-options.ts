import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/index.js';

export function fastifyOptions(config: Config): FastifyServerOptions {
  return {
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers["x-agent-signature"]',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.code',
        '*.registrationToken',
        '*.sessionToken',
        '*.password',
        '*.confirmPassword',
        '*.newPassword',
        '*.confirmNewPassword',
        '*.idCardNo',
        '*.accessToken',
        '*.refreshToken',
        '*.uploadToken',
        '*.avatarUploadToken',
        '*.logoUploadToken',
        '*.claimTokenHash',
      ],
    },
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  };
}
