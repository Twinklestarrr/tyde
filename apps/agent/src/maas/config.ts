export interface MaasCompat {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  supportsUsageInStreaming: true;
  supportsFinishReason: true;
  thinkingFormat: 'openai' | 'zai' | 'qwen';
}

export interface MaasConfig {
  baseUrl: string;
  modelId: string;
  actualModelIds: readonly string[];
  routeVersion: string;
  serviceToken: string;
  contextWindow: number;
  maxTokens: number;
  compat: MaasCompat;
  timeouts: {
    connectMs: number;
    headersMs: number;
    firstProgressMs: number;
    idleMs: number;
    totalMs: number;
  };
}

const requiredNames = [
  'AGENT_MAAS_BASE_URL',
  'AGENT_MAAS_MODEL_ID',
  'AGENT_MAAS_ACTUAL_MODEL_IDS',
  'AGENT_MAAS_ROUTE_VERSION',
  'AGENT_MAAS_SERVICE_TOKEN',
  'AGENT_MAAS_CONTEXT_WINDOW',
  'AGENT_MAAS_MAX_TOKENS',
  'AGENT_MAAS_COMPAT',
] as const;

function integer(source: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const value = source[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} 必须是正安全整数`);
  }
  return Number(value);
}

function json(source: NodeJS.ProcessEnv, name: string): unknown {
  try {
    return JSON.parse(source[name] ?? '');
  } catch {
    throw new Error(`${name} 必须是合法 JSON`);
  }
}

export function readMaasConfig(source: NodeJS.ProcessEnv = process.env): MaasConfig {
  const missing = requiredNames.filter((name) => !source[name]);
  if (missing.length) throw new Error(`MaaS 配置缺失：${missing.join(', ')}`);
  let url: URL;
  try {
    url = new URL(source.AGENT_MAAS_BASE_URL!);
  } catch {
    throw new Error('AGENT_MAAS_BASE_URL 必须是平台 MaaS 的绝对 URL');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, '') !== '/internal/agent-maas/v1'
  ) {
    throw new Error(
      'AGENT_MAAS_BASE_URL 必须使用 HTTPS 和 /internal/agent-maas/v1；HTTP 仅限回环隔离测试',
    );
  }
  const modelId = source.AGENT_MAAS_MODEL_ID!;
  const routeVersion = source.AGENT_MAAS_ROUTE_VERSION!;
  for (const [name, value] of [
    ['AGENT_MAAS_MODEL_ID', modelId],
    ['AGENT_MAAS_ROUTE_VERSION', routeVersion],
  ]) {
    if (!value || value.length > 128 || /[\s\p{Cc}]/u.test(value)) {
      throw new Error(`${name} 必须是 1 至 128 字符且不含空白的固定标识`);
    }
  }
  const actualModelIds = json(source, 'AGENT_MAAS_ACTUAL_MODEL_IDS');
  if (
    !Array.isArray(actualModelIds) ||
    !actualModelIds.length ||
    actualModelIds.some((value) => typeof value !== 'string' || !value || value.length > 128) ||
    new Set(actualModelIds).size !== actualModelIds.length
  ) {
    throw new Error('AGENT_MAAS_ACTUAL_MODEL_IDS 必须是非空、不重复的实际模型 ID JSON 数组');
  }
  const candidate = json(source, 'AGENT_MAAS_COMPAT');
  const keys = [
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'maxTokensField',
    'supportsUsageInStreaming',
    'supportsFinishReason',
    'thinkingFormat',
  ];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('AGENT_MAAS_COMPAT 必须显式配置全部兼容字段');
  }
  const compat = candidate as Record<string, unknown>;
  if (
    Object.keys(compat).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in compat)) ||
    typeof compat.supportsStore !== 'boolean' ||
    typeof compat.supportsDeveloperRole !== 'boolean' ||
    typeof compat.supportsReasoningEffort !== 'boolean' ||
    !['max_tokens', 'max_completion_tokens'].includes(String(compat.maxTokensField)) ||
    compat.supportsUsageInStreaming !== true ||
    compat.supportsFinishReason !== true ||
    !['openai', 'zai', 'qwen'].includes(String(compat.thinkingFormat))
  ) {
    throw new Error('AGENT_MAAS_COMPAT 字段缺失、不受支持或未启用流式用量与结束原因校验');
  }
  const serviceToken = source.AGENT_MAAS_SERVICE_TOKEN!;
  if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(serviceToken)) {
    throw new Error('AGENT_MAAS_SERVICE_TOKEN 必须是无空白的 Bearer 服务凭据');
  }
  const contextWindow = integer(source, 'AGENT_MAAS_CONTEXT_WINDOW');
  const maxTokens = integer(source, 'AGENT_MAAS_MAX_TOKENS');
  if (maxTokens > 1_048_576 || maxTokens > contextWindow) {
    throw new Error('AGENT_MAAS_MAX_TOKENS 不能超过上下文窗口或契约上限');
  }
  const timeouts = {
    connectMs: integer(source, 'AGENT_MAAS_CONNECT_TIMEOUT_MS', 3_000),
    headersMs: integer(source, 'AGENT_MAAS_HEADERS_TIMEOUT_MS', 15_000),
    firstProgressMs: integer(source, 'AGENT_MAAS_FIRST_PROGRESS_TIMEOUT_MS', 60_000),
    idleMs: integer(source, 'AGENT_MAAS_IDLE_TIMEOUT_MS', 45_000),
    totalMs: integer(source, 'AGENT_MAAS_TOTAL_TIMEOUT_MS', 180_000),
  };
  if (Object.values(timeouts).some((value) => value > 300_000)) {
    throw new Error('MaaS 超时配置不得超过 300000 毫秒');
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    modelId,
    actualModelIds: actualModelIds as string[],
    routeVersion,
    serviceToken,
    contextWindow,
    maxTokens,
    compat: compat as unknown as MaasCompat,
    timeouts,
  };
}
