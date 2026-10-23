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
import type { TrustedPiResources } from './pi/resources.js';
import { registerAgentRoutes } from './api/routes.js';
import { transformAgentOpenApi } from './api/documentation.js';

declare module 'fastify' {
  interface FastifyInstance {
    agentAccess: AgentAccess;
  }
}

export async function createApp(
  config: AgentConfig,
  options: {
    identityAdapter?: PlatformIdentityAdapter;
    runtime?: AgentMemoryRuntime;
    /** Trusted host injection only. Default startup never discovers deployment/demo resources. */
    resources?: TrustedPiResources;
  } = {},
) {
  const resources = options.resources;
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
          'W4 开发内存模式：私有会话、问答任务、幂等命令、停止、独立工具过程与产品 SSE 仅在同一进程存活期间有效。工具与 Skill 仅由可信宿主显式注入，默认入口不加载演示资源；只读工具不产生业务操作。未接 PostgreSQL、重启恢复、业务写工具或正式平台授权。',
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
        { name: 'Agent', description: '开发内存模式的私有聊天、任务和事件。' },
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
  const runtime =
    options.runtime ??
    new AgentMemoryRuntime({
      createSession: async (_conversationId, barriers) => {
        modelConfig ??= readDirectModelConfig();
        return createPiDirectModelSession({ config: modelConfig, barriers, resources });
      },
    });
  await registerAgentRoutes(app, runtime);

  return app;
}
