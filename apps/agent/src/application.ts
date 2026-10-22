import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AGENT_HEALTH_PATH, agentHealthSchema, type AgentHealth } from '@tyde/shared/agent';
import type { AgentConfig } from './config.js';

export async function createApp(config: AgentConfig) {
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: 'info' },
    disableRequestLogging: true,
  });

  // 动态 OpenAPI 收集器必须先于接口注册。
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'tyde Agent API',
        version: '0.1.0',
        description: 'W1 工程骨架，仅提供进程存活检查；尚未接入模型、身份、任务和数据库。',
      },
      tags: [{ name: 'Health', description: 'Agent 服务进程存活检查，不代表模型或数据库就绪。' }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/v1/docs',
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: false },
  });

  app.get<{ Reply: AgentHealth }>(
    AGENT_HEALTH_PATH,
    {
      schema: {
        summary: 'Agent 进程存活检查',
        description:
          '匿名只读接口，无请求参数。HTTP 200 仅表示 Agent HTTP 进程可响应，不检查模型、授权、任务执行或数据库。',
        operationId: 'agentHealthLive',
        tags: ['Health'],
        response: { 200: agentHealthSchema },
      },
    },
    async () => ({ service: 'tyde-agent', status: 'ok' }),
  );

  return app;
}
