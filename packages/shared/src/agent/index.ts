import { Type, type Static } from '@sinclair/typebox';

export * from './contracts/index.js';

export const AGENT_HEALTH_PATH = '/health/live';
export const AGENT_API_PREFIX = '/api/agent/v1';
export const AGENT_COMMAND_BODY_LIMIT = 128 * 1024;

export const agentHealthSchema = Type.Object(
  {
    service: Type.Literal('tyde-agent', {
      description: '服务标识，固定为 tyde-agent；用于区分独立 Agent 服务与业务 API。',
      examples: ['tyde-agent'],
    }),
    status: Type.Literal('ok', {
      description: '进程存活状态：ok=HTTP 进程正常响应，不代表模型、任务或数据库就绪。',
      examples: ['ok'],
    }),
  },
  {
    additionalProperties: false,
    description: 'Agent 进程存活检查结果，无用户数据；不执行模型请求或数据库查询。',
    examples: [{ service: 'tyde-agent', status: 'ok' }],
  },
);

export type AgentHealth = Static<typeof agentHealthSchema>;
