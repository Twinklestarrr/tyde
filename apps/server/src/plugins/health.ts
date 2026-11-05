import type { PrismaClient } from '@prisma/client';
import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance, db: PrismaClient) {
  app.get(
    `${API_PREFIX}/health/live`,
    {
      schema: {
        operationId: 'healthLive',
        tags: ['Health'],
        summary: '存活检查',
        response: {
          200: {
            type: 'object',
            required: ['status', 'application'],
            properties: {
              status: {
                type: 'string',
                enum: ['ok'],
                description: '进程存活状态，ok=服务进程正常；不检查数据库。',
                examples: ['ok'],
              },
              application: { type: 'string', description: '服务应用名称。', examples: ['tyde'] },
            },
          },
        },
      },
    },
    async () => ({ status: 'ok', application: 'tyde' }),
  );
  app.get(
    `${API_PREFIX}/health/ready`,
    {
      schema: {
        operationId: 'healthReady',
        tags: ['Health'],
        summary: '数据库就绪检查',
        response: Object.fromEntries(
          [
            [200, 'ready'],
            [503, 'unavailable'],
          ].map(([code, status]) => [
            code,
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: {
                  type: 'string',
                  enum: [status],
                  description:
                    '数据库就绪状态：ready=数据库可连接，unavailable=数据库不可用；不可用时 HTTP 503。',
                  examples: [status],
                },
              },
            },
          ]),
        ),
      },
    },
    async (_req, reply) => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
}
