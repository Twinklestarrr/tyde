import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AGENT_HEALTH_PATH, agentHealthSchema, type AgentHealth } from '@tyde/shared/agent';
import type { AgentConfig } from './config.js';
import {
  createAgentAccess,
  type AgentAccess,
  type PlatformIdentityAdapter,
} from './auth/access.js';
import { AgentMemoryRuntime } from './runtime/memory-runtime.js';
import { readDirectModelConfig } from './maas/direct-model.js';
import { createPiDirectModelSession } from './pi/session.js';
import { registerAgentRoutes } from './api/routes.js';
import { transformAgentOpenApi } from './api/documentation.js';
import type { AgentRuntime } from './api/routes.js';
import { AgentPostgresRuntime } from './runtime/postgres-runtime.js';
import { createAgentDatabase } from './storage/database.js';
import { modelExecutionConfig, requireExecutionSnapshot } from './storage/execution-config.js';
import { checkAgentDatabase } from './storage/migrations.js';

declare module 'fastify' {
  interface FastifyInstance {
    agentAccess: AgentAccess;
  }
}

export async function createApp(
  config: AgentConfig,
  options: { identityAdapter?: PlatformIdentityAdapter; runtime?: AgentRuntime } = {},
) {
  const agentAccess = createAgentAccess(config, options.identityAdapter);
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    disableRequestLogging: true,
  });
  app.decorate('agentAccess', agentAccess);

  // 动态 OpenAPI 收集器必须先于接口注册。
  await app.register(swagger, {
    transformObject: (document) =>
      'openapiObject' in document
        ? (transformAgentOpenApi(document.openapiObject) as typeof document.openapiObject)
        : document.swaggerObject,
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'tyde Agent API',
        version: '0.1.0',
        description:
          'W5 私有聊天、持久命令裁决、完整 Pi 原生版本、预算授权和产品 SSE。PostgreSQL 模式重启只恢复展示；完成目标可显式发送后续问题。继续、重试和补充尚未公开。开发内存模式必须显式选择，数据库故障不会回退。',
      },
      components: {
        securitySchemes: {
          AgentBearer: {
            type: 'http',
            scheme: 'bearer',
            description:
              '服务端验证的产品身份凭据；本机可显式启用受控开发身份。不是模型 API Key，不接受客户端自报用户。',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Agent 服务进程存活检查，不代表模型或数据库就绪。' },
        {
          name: 'Agent',
          description: '私有聊天、任务与可靠产品事件。存储模式由运行信息接口确认。',
        },
      ],
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

  let modelConfig: ReturnType<typeof readDirectModelConfig> | undefined;
  let runtime = options.runtime;
  const mode = config.storage?.mode ?? 'memory';
  if (!runtime && mode === 'postgres') {
    if (config.storage?.mode !== 'postgres' || !config.storage.databaseUrl)
      throw new Error('PostgreSQL 模式需要独立 AGENT_DATABASE_URL；不读取业务 DATABASE_URL');
    const database = createAgentDatabase({ connectionString: config.storage.databaseUrl });
    try {
      await checkAgentDatabase(database.pool);
      modelConfig = readDirectModelConfig();
      const executionConfig = modelExecutionConfig(modelConfig);
      await requireExecutionSnapshot(database.pool, executionConfig);
      const persistent = new AgentPostgresRuntime({
        pool: database.pool,
        executionConfig,
        createSession: async (_id, barriers, nativeState) =>
          createPiDirectModelSession({ config: modelConfig!, barriers, nativeState }),
      });
      await persistent.initialize();
      runtime = persistent;
      app.addHook('onClose', () => database.close());
    } catch (error) {
      await database.close();
      throw error;
    }
  }
  runtime ??= new AgentMemoryRuntime({
    createSession: async (_conversationId, barriers) => {
      modelConfig ??= readDirectModelConfig();
      return createPiDirectModelSession({ config: modelConfig, barriers });
    },
  });
  app.get(
    '/api/agent/v1/runtime',
    {
      schema: {
        operationId: 'agentRuntimeStorage',
        tags: ['Agent'],
        summary: '读取当前服务存储模式',
        description: '认证后的只读部署信息；不会启动或恢复尝试。PostgreSQL 故障不会自动切换内存。',
        security: [{ AgentBearer: [] }],
        response: {
          200: {
            type: 'object',
            description: '当前服务经过身份核验后的存储模式；不会透露数据库地址或凭据',
            additionalProperties: false,
            required: ['storage_mode'],
            properties: {
              storage_mode: {
                type: 'string',
                enum: ['postgres', 'memory'],
                description: '当前服务实际存储模式；postgres 持久保存，memory 重启清空',
                example: 'postgres',
              },
            },
            example: { storage_mode: 'postgres' },
          },
          401: {
            type: 'object',
            description: '缺少或无效的 Agent 身份凭据；重新认证后再读取模式',
            required: ['statusCode', 'error', 'message'],
            properties: {
              statusCode: { type: 'integer', const: 401, description: 'HTTP 状态码', example: 401 },
              code: { type: 'string', description: '身份错误分类', example: 'UNAUTHENTICATED' },
              error: { type: 'string', description: 'HTTP 错误名称', example: 'Unauthorized' },
              message: {
                type: 'string',
                description: '可展示的脱敏说明',
                example: '请重新验证身份',
              },
            },
            example: {
              statusCode: 401,
              code: 'UNAUTHENTICATED',
              error: 'Unauthorized',
              message: '请重新验证身份',
            },
          },
          503: {
            type: 'object',
            description: '可信身份适配不可用；模式保持未确认，不能回退为内存或持久成功',
            required: ['statusCode', 'error', 'message'],
            properties: {
              statusCode: { type: 'integer', const: 503, description: 'HTTP 状态码', example: 503 },
              code: { type: 'string', description: '服务错误分类', example: 'SERVICE_UNAVAILABLE' },
              error: {
                type: 'string',
                description: 'HTTP 错误名称',
                example: 'Service Unavailable',
              },
              message: {
                type: 'string',
                description: '可展示的脱敏说明',
                example: '身份验证暂不可用',
              },
            },
            example: {
              statusCode: 503,
              code: 'SERVICE_UNAVAILABLE',
              error: 'Service Unavailable',
              message: '身份验证暂不可用',
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      await app.agentAccess.authenticate(request);
      return { storage_mode: mode };
    },
  );
  await registerAgentRoutes(app, runtime);

  return app;
}
