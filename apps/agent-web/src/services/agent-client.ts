import { Value } from '@sinclair/typebox/value';
import { AGENT_HEALTH_PATH, agentHealthSchema, type AgentHealth } from '@tyde/shared/agent';

type Fetch = typeof globalThis.fetch;

/** 只查询服务存活状态，不启动任务，也不将健康状态当成模型可用性。 */
export async function getAgentHealth(
  options: { signal?: AbortSignal; fetch?: Fetch } = {},
): Promise<AgentHealth> {
  const response = await (options.fetch ?? globalThis.fetch)(`/agent-api${AGENT_HEALTH_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Agent 服务返回 HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('Agent 服务响应不是 JSON');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Agent 服务返回了无效 JSON');
  }
  if (!Value.Check(agentHealthSchema, data)) throw new Error('Agent 服务响应不符合健康契约');
  return data;
}
