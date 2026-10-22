import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDirectModelTransport,
  createMaasTransport,
  MaasError,
  readDirectModelConfig,
  readMaasConfig,
} from '../src/maas/index.js';
import type { DirectModelConfig, MaasTool } from '../src/maas/index.js';
import { randomUUID } from 'node:crypto';

const environment = { AGENT_MODEL_API_KEY: 'isolated-direct-key' };
const config = readDirectModelConfig(environment);
const request = (config_: DirectModelConfig = config, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: config_.modelId,
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: config_.maxTokens,
    ...(config_.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    ...extra,
  });
const chunk = (
  delta: Record<string, unknown> = {},
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) => ({
  id: 'direct-completion',
  object: 'chat.completion.chunk',
  created: 10,
  model: config.modelId,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const frame = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const usage = {
  prompt_tokens: 17,
  completion_tokens: 9,
  total_tokens: 26,
  prompt_tokens_details: { cached_tokens: 2 },
  prompt_cache_hit_tokens: 2,
  prompt_cache_miss_tokens: 15,
};
const normal = () =>
  ': keep-alive\n\n' +
  frame(chunk({ role: 'assistant', content: '你好🧑' })) +
  frame(chunk({ role: null, content: '' }, 'stop', { usage })) +
  frame('[DONE]');
function fakeFetch(wire: string, inspect?: (headers: Headers) => void): typeof fetch {
  return async (_input, init) => {
    inspect?.(new Headers(init?.headers));
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) controller.close();
          else controller.enqueue(bytes.slice(offset, ++offset));
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'x-platform-request-id': 'ignored-fake-platform',
          'x-maas-route-version': 'ignored-fake-route',
        },
      },
    );
  };
}
async function run(
  wire: string,
  options: Parameters<typeof createDirectModelTransport>[1] = {},
  body = request(),
  runtime = config,
) {
  const transport = createDirectModelTransport(runtime, { fetch: fakeFetch(wire), ...options });
  const response = await transport.fetch(`${runtime.baseUrl}/chat/completions`, {
    method: 'POST',
    body,
  });
  return { transport, result: response.text() };
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof MaasError && error.code === code);

test('独立 URL/key 模式使用当前官方 DeepSeek 预设，自定义服务必须明确模型且不猜测或降级', () => {
  assert.equal(config.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(config.modelId, 'deepseek-flash');
  assert.equal(config.provider, 'deepseek');
  assert.equal(
    readDirectModelConfig({
      ...environment,
      AGENT_MODEL_BASE_URL: 'https://API.DEEPSEEK.COM:443/v1/',
    }).baseUrl,
    'https://api.deepseek.com/v1',
  );
  assert.equal(config.contextWindow, 1_048_576);
  assert.equal(readDirectModelConfig({ DEEPSEEK_API_KEY: 'isolated-key' }).apiKey, 'isolated-key');
  assert.throws(() => readDirectModelConfig({}), /AGENT_MODEL_API_KEY/);
  assert.throws(
    () =>
      readDirectModelConfig({
        ...environment,
        AGENT_MODEL_BASE_URL: 'https://models.example.test/custom/v2',
      }),
    /AGENT_MODEL_ID/,
  );
  const generic = readDirectModelConfig({
    ...environment,
    AGENT_MODEL_BASE_URL: 'https://models.example.test/custom/v2/',
    AGENT_MODEL_ID: 'explicit-model',
  });
  assert.equal(generic.baseUrl, 'https://models.example.test/custom/v2');
  assert.equal(generic.provider, 'openai-compatible');
  assert.equal(generic.modelId, 'explicit-model');
  assert.equal(generic.contextWindow, 32_768);
  for (const url of [
    'http://models.example.test/v1',
    'https://key@models.example.test/v1',
    'https://models.example.test/v1?api_key=bad',
    'https://models.example.test/v1/chat/completions',
  ])
    assert.throws(
      () =>
        readDirectModelConfig({
          ...environment,
          AGENT_MODEL_BASE_URL: url,
          AGENT_MODEL_ID: 'explicit-model',
        }),
      /AGENT_MODEL_BASE_URL/,
    );
  assert.throws(
    () =>
      readDirectModelConfig({ ...environment, AGENT_MODEL_ID: 'old-or-unknown-deepseek-model' }),
    /deepseek-flash/,
  );
  assert.equal(
    readDirectModelConfig({ ...environment, NODE_ENV: 'production' }).modelId,
    'deepseek-flash',
  );
  assert.equal(
    readDirectModelConfig({ AGENT_MODEL_API_KEY: '', DEEPSEEK_API_KEY: 'isolated-alias-key' })
      .apiKey,
    'isolated-alias-key',
  );
  assert.throws(
    () => readDirectModelConfig({ ...environment, AGENT_MODEL_MAX_TOKENS: '393217' }),
    /MAX_TOKENS/,
  );
  assert.throws(
    () => readDirectModelConfig({ ...environment, AGENT_MODEL_TOTAL_TIMEOUT_MS: '300001' }),
    /TOTAL_TIMEOUT_MS/,
  );
  assert.throws(
    () => createDirectModelTransport({ ...config, provider: 'openai-compatible' }),
    /provider/,
  );
  assert.throws(() => createDirectModelTransport({ ...config, apiKey: '' }), /API_KEY/);
});

test('DeepSeek 专属 Key 别名仅限官方 origin，自定义地址必须显式配置自己的 Key', () => {
  for (const url of [
    'https://models.example.test/v1',
    'https://api.deepseek.com.example.test/v1',
    'https://api.deepseek.com:444/v1',
    'http://127.0.0.1:39002/v1',
  ]) {
    assert.throws(
      () =>
        readDirectModelConfig({
          AGENT_MODEL_BASE_URL: url,
          AGENT_MODEL_ID: 'explicit-model',
          DEEPSEEK_API_KEY: 'isolated-deepseek-key',
        }),
      /必须显式提供 AGENT_MODEL_API_KEY/,
    );
    assert.throws(
      () =>
        readDirectModelConfig({
          AGENT_MODEL_BASE_URL: url,
          AGENT_MODEL_ID: 'explicit-model',
          AGENT_MODEL_API_KEY: '',
          DEEPSEEK_API_KEY: 'isolated-deepseek-key',
        }),
      /必须显式提供 AGENT_MODEL_API_KEY/,
    );
  }
  const custom = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'https://models.example.test/v1',
    AGENT_MODEL_ID: 'explicit-model',
    AGENT_MODEL_API_KEY: 'isolated-custom-key',
    DEEPSEEK_API_KEY: 'isolated-deepseek-key',
  });
  assert.equal(custom.apiKey, 'isolated-custom-key');
  const official = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'https://API.DEEPSEEK.COM:443/v1',
    DEEPSEEK_API_KEY: 'isolated-deepseek-key',
  });
  assert.equal(official.apiKey, 'isolated-deepseek-key');
});

test('直连只发送供应商 Bearer 和文本请求，不要求或伪造平台身份、路由及响应头', async () => {
  const transport = createDirectModelTransport(config, {
    fetch: fakeFetch(normal(), (headers) => {
      assert.equal(headers.get('authorization'), 'Bearer isolated-direct-key');
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(
        [...headers.keys()].some((name) => /^x-(agent|platform|maas)-/.test(name)),
        false,
      );
    }),
  });
  const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: request(),
    headers: {
      authorization: 'Bearer hostile',
      'x-platform-subject-ref': 'hostile',
      'x-agent-maas-contract': 'chat-sse-v1',
    },
  });
  assert.match(await response.text(), /你好🧑/);
  const observation = transport.observation()!;
  assert.equal(observation.profile, 'direct-model');
  assert.equal(observation.provider, 'deepseek');
  assert.equal(observation.state, 'complete');
  assert.equal(observation.platformRequestId, null);
  assert.equal(observation.routeVersion, null);
  assert.equal(observation.upstreamRequestId, null);
  assert.equal(observation.usage.promptTokens, 17);
  assert.equal(observation.usage.cachedTokens, 2);
  assert.equal(observation.usage.reasoningTokens, null);
  assert.equal(observation.usage.costAmount, null);
});

test('DeepSeek 显式关闭默认思考；通用 OpenAI 兼容预设不发送 DeepSeek 专用字段', async () => {
  const direct = createDirectModelTransport(config, { fetch: fakeFetch(normal()) });
  for (const thinking of [undefined, { type: 'enabled' }, { type: 'disabled', extra: true }])
    await rejects(
      direct.fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        body: request(config, { thinking }),
      }),
      'MAAS_REQUEST_INVALID',
    );
  const generic = readDirectModelConfig({
    ...environment,
    AGENT_MODEL_BASE_URL: 'https://models.example.test/chat-api',
    AGENT_MODEL_ID: 'explicit-model',
  });
  const wire = normal().replaceAll(config.modelId, generic.modelId);
  const accepted = await run(wire, {}, request(generic), generic);
  await accepted.result;
  assert.equal(accepted.transport.observation()?.state, 'complete');
  const transport = createDirectModelTransport(generic, { fetch: fakeFetch(wire) });
  await rejects(
    transport.fetch(`${generic.baseUrl}/chat/completions`, {
      method: 'POST',
      body: request(generic, { thinking: { type: 'disabled' } }),
    }),
    'MAAS_REQUEST_INVALID',
  );
});

test('直连仍要求合法 finish 加完整 DONE，断流、错误、异常终态和迟到增量不能成功', async () => {
  for (const [wire, code] of [
    [frame(chunk({ content: 'partial' })) + frame(chunk({}, 'stop')), 'MAAS_INCOMPLETE_STREAM'],
    [frame('[DONE]'), 'MAAS_INCOMPLETE_STREAM'],
    [normal().trimEnd(), 'MAAS_INCOMPLETE_STREAM'],
    [
      frame({ error: { code: 'insufficient_balance', message: 'private detail' } }) +
        frame('[DONE]'),
      'insufficient_balance',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'length')) + frame('[DONE]'),
      'MAAS_OUTPUT_TRUNCATED',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'aborted')) + frame('[DONE]'),
      'MAAS_UNSUPPORTED_FINISH_REASON',
    ],
    [
      frame(chunk({ content: 'partial' })) +
        frame(chunk({}, 'insufficient_system_resource')) +
        frame('[DONE]'),
      'MAAS_UNSUPPORTED_FINISH_REASON',
    ],
    [
      frame(chunk({ content: 'partial' })) +
        frame(chunk({}, 'stop')) +
        frame(chunk({ content: 'late' })) +
        frame('[DONE]'),
      'MAAS_PROTOCOL_ERROR',
    ],
  ]) {
    const { transport, result } = await run(wire!);
    await rejects(result, code!);
    assert.equal(transport.observation()?.state, 'failed');
  }
});

test('直连用量缺失保持未知，DeepSeek 缓存别名必须与实际计数相符', async () => {
  const missing = await run(
    frame(chunk({ content: 'ok' })) + frame(chunk({ role: null }, 'stop')) + frame('[DONE]'),
  );
  await missing.result;
  assert.equal(missing.transport.observation()?.usage.usageState, 'missing');
  assert.equal(missing.transport.observation()?.usage.totalTokens, null);
  const nullableDetails = await run(
    frame(chunk({ content: 'ok' })) +
      frame(
        chunk({ role: null }, 'stop', {
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
            prompt_tokens_details: null,
            completion_tokens_details: null,
          },
        }),
      ) +
      frame('[DONE]'),
  );
  await nullableDetails.result;
  assert.equal(nullableDetails.transport.observation()?.usage.cachedTokens, null);
  assert.equal(nullableDetails.transport.observation()?.usage.reasoningTokens, null);
  for (const reported of [
    { ...usage, total_tokens: 27 },
    { ...usage, prompt_cache_hit_tokens: 3 },
    { ...usage, prompt_cache_miss_tokens: 16 },
  ]) {
    const { transport, result } = await run(
      frame(chunk({ content: 'ok' })) +
        frame(chunk({ role: null }, 'stop', { usage: reported })) +
        frame('[DONE]'),
    );
    await rejects(result, 'MAAS_USAGE_INVALID');
    assert.equal(transport.observation()?.usage.usageState, 'invalid');
  }
});

test('直连工具同样按白名单、完整参数及单调用规则放行', async () => {
  const tools: Record<string, MaasTool> = {
    demo_read: {
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      validate: (value) => typeof value.id === 'string',
    },
  };
  const body = request(config, {
    tools: [
      {
        type: 'function',
        function: { name: 'demo_read', parameters: tools.demo_read!.parameters },
      },
    ],
  });
  const tool = (arguments_: string, name = 'demo_read') =>
    frame(
      chunk({
        tool_calls: [
          { index: 0, id: 'call-1', type: 'function', function: { name, arguments: arguments_ } },
        ],
      }),
    ) +
    frame(chunk({ role: null }, 'tool_calls')) +
    frame('[DONE]');
  const accepted = await run(tool('{"id":"demo"}'), { tools }, body);
  await accepted.result;
  assert.equal(accepted.transport.observation()?.finishReason, 'tool_calls');
  const invalid = await run(tool('{"id":'), { tools }, body);
  await rejects(invalid.result, 'MAAS_TOOL_ARGUMENTS_INVALID');
  const unknown = await run(tool('{}', 'unknown'), { tools }, body);
  await rejects(unknown.result, 'MAAS_TOOL_NOT_ALLOWED');
  const multiple = await run(
    frame(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'demo_read', arguments: '{}' },
          },
          {
            index: 1,
            id: 'call-2',
            type: 'function',
            function: { name: 'demo_read', arguments: '{}' },
          },
        ],
      }),
    ) +
      frame(chunk({}, 'tool_calls')) +
      frame('[DONE]'),
    { tools },
    body,
  );
  await rejects(multiple.result, 'MAAS_PARALLEL_TOOLS_UNSUPPORTED');
});

test('直连环境变量不能放松或自动切换旧平台 MaaS 契约', async () => {
  assert.throws(() => readMaasConfig(environment), /MaaS 配置缺失/);
  const platform = readMaasConfig({
    AGENT_MAAS_BASE_URL: 'https://platform.example.test/internal/agent-maas/v1',
    AGENT_MAAS_MODEL_ID: config.modelId,
    AGENT_MAAS_ACTUAL_MODEL_IDS: JSON.stringify([config.modelId]),
    AGENT_MAAS_ROUTE_VERSION: 'isolated-route',
    AGENT_MAAS_SERVICE_TOKEN: 'isolated-platform-token',
    AGENT_MAAS_CONTEXT_WINDOW: '8192',
    AGENT_MAAS_MAX_TOKENS: '1024',
    AGENT_MAAS_COMPAT: JSON.stringify(config.compat),
  });
  const transport = createMaasTransport(
    platform,
    {
      conversationId: randomUUID(),
      taskId: randomUUID(),
      attemptId: randomUUID(),
      executionSnapshotId: randomUUID(),
      executionGeneration: '1',
      platformSubjectRef: 'trusted-subject',
    },
    { fetch: fakeFetch(normal()) },
  );
  await rejects(
    transport.fetch(`${platform.baseUrl}/chat/completions`, {
      method: 'POST',
      body: request(config, { thinking: undefined }),
    }),
    'MAAS_PROTOCOL_ERROR',
  );
});
