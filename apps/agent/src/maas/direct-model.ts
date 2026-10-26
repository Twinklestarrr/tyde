import type { MaasCompat, MaasConfig } from './config.js';

export interface DirectModelConfig {
  baseUrl: string;
  modelId: string;
  actualModelIds: readonly string[];
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  compat: MaasCompat;
  timeouts: MaasConfig['timeouts'];
  provider: 'deepseek' | 'openai-compatible';
}

function positive(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = 300_000,
): number {
  const raw = source[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} 必须是 1 至 ${maximum} 的整数`);
  }
  return value;
}

export function assertDirectModelConfig(config: DirectModelConfig): void {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('AGENT_MODEL_BASE_URL 必须是绝对 URL');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/chat\/completions\/?$/.test(url.pathname)
  )
    throw new Error(
      'AGENT_MODEL_BASE_URL 必须是可信 HTTPS API 基址；HTTP 仅限回环测试，路径不包含 /chat/completions',
    );
  const official = url.origin === 'https://api.deepseek.com';
  if (config.provider !== (official ? 'deepseek' : 'openai-compatible'))
    throw new Error('模型 provider 与显式 API 基址不匹配');
  if (typeof config.apiKey !== 'string' || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(config.apiKey))
    throw new Error('AGENT_MODEL_API_KEY 必须是无空白的 Bearer 凭据');
  if (!config.modelId || config.modelId.length > 128 || /[\s\p{Cc}]/u.test(config.modelId))
    throw new Error('AGENT_MODEL_ID 必须是 1 至 128 字符的明确模型 ID');
  if (official && !['deepseek-flash', 'deepseek-v4-pro'].includes(config.modelId))
    throw new Error('DeepSeek 本地验证仅开放已核对的 deepseek-flash 或 deepseek-v4-pro');
  if (config.actualModelIds.length !== 1 || config.actualModelIds[0] !== config.modelId)
    throw new Error('本地验证只接受显式请求的模型，不允许隐藏映射或降级');
  if (
    !Number.isSafeInteger(config.contextWindow) ||
    config.contextWindow < 1 ||
    !Number.isSafeInteger(config.maxTokens) ||
    config.maxTokens < 1 ||
    config.maxTokens > config.contextWindow ||
    config.maxTokens > (official ? 393_216 : 1_048_576)
  )
    throw new Error('模型上下文或输出预算无效');
  if (
    ['connectMs', 'headersMs', 'firstProgressMs', 'idleMs', 'totalMs'].some(
      (name) => !Object.hasOwn(config.timeouts, name),
    ) ||
    Object.values(config.timeouts).some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 300_000,
    )
  )
    throw new Error('模型超时预算必须是 1 至 300000 毫秒');
  const compat = config.compat;
  if (
    compat.supportsStore !== false ||
    compat.supportsDeveloperRole !== false ||
    compat.supportsReasoningEffort !== false ||
    compat.maxTokensField !== 'max_tokens' ||
    compat.supportsUsageInStreaming !== true ||
    compat.supportsFinishReason !== true ||
    compat.thinkingFormat !== 'openai'
  )
    throw new Error('本地验证仅开放固定文字流式兼容模式');
}

/** Explicit local URL/key mode; it never reads platform MaaS credentials or changes that path. */
export function readDirectModelConfig(source: NodeJS.ProcessEnv = process.env): DirectModelConfig {
  const configuredUrl = source.AGENT_MODEL_BASE_URL || 'https://api.deepseek.com/v1';
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('AGENT_MODEL_BASE_URL 必须是绝对 URL');
  }
  const baseUrl = url.toString().replace(/\/+$/, '');
  const official = url.origin === 'https://api.deepseek.com';
  const apiKey = source.AGENT_MODEL_API_KEY || (official ? source.DEEPSEEK_API_KEY : undefined);
  if (!apiKey)
    throw new Error(
      official
        ? '模型直连配置缺失：AGENT_MODEL_API_KEY（官方 DeepSeek 也可使用 DEEPSEEK_API_KEY）'
        : '自定义模型 API 必须显式提供 AGENT_MODEL_API_KEY',
    );
  const modelId = source.AGENT_MODEL_ID || (official ? 'deepseek-flash' : '');
  if (!modelId) throw new Error('自定义模型 API 必须显式提供 AGENT_MODEL_ID');
  const config: DirectModelConfig = {
    baseUrl,
    modelId,
    actualModelIds: [modelId],
    apiKey,
    contextWindow: positive(
      source,
      'AGENT_MODEL_CONTEXT_WINDOW',
      official ? 1_048_576 : 32_768,
      1_048_576,
    ),
    maxTokens: positive(source, 'AGENT_MODEL_MAX_TOKENS', 1024, official ? 393_216 : 1_048_576),
    provider: official ? 'deepseek' : 'openai-compatible',
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      thinkingFormat: 'openai',
    },
    timeouts: {
      connectMs: positive(source, 'AGENT_MODEL_CONNECT_TIMEOUT_MS', 3000),
      headersMs: positive(source, 'AGENT_MODEL_HEADERS_TIMEOUT_MS', 15_000),
      firstProgressMs: positive(source, 'AGENT_MODEL_FIRST_PROGRESS_TIMEOUT_MS', 60_000),
      idleMs: positive(source, 'AGENT_MODEL_IDLE_TIMEOUT_MS', 45_000),
      totalMs: positive(source, 'AGENT_MODEL_TOTAL_TIMEOUT_MS', 180_000),
    },
  };
  assertDirectModelConfig(config);
  return config;
}
