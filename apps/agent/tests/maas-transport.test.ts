import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMaasTransport, MaasError, readMaasConfig } from '../src/maas/index.js';
import type { MaasContext, MaasTool } from '../src/maas/index.js';

const config = readMaasConfig({
  AGENT_MAAS_BASE_URL: 'http://127.0.0.1:39002/internal/agent-maas/v1',
  AGENT_MAAS_MODEL_ID: 'isolated-model',
  AGENT_MAAS_ACTUAL_MODEL_IDS: '["isolated-model-v1"]',
  AGENT_MAAS_ROUTE_VERSION: 'isolated-route-v1',
  AGENT_MAAS_SERVICE_TOKEN: 'isolated-service-credential',
  AGENT_MAAS_CONTEXT_WINDOW: '8192',
  AGENT_MAAS_MAX_TOKENS: '1024',
  AGENT_MAAS_COMPAT: JSON.stringify({
    supportsStore: false,
    supportsDeveloperRole: true,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    thinkingFormat: 'openai',
  }),
});
const context = (): MaasContext => ({
  conversationId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  executionGeneration: '1',
  executionSnapshotId: randomUUID(),
  platformSubjectRef: 'trusted-isolated-subject',
});
const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: config.modelId,
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 1024,
    ...extra,
  });
const chunk = (
  delta: Record<string, unknown> = {},
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) => ({
  id: 'isolated-completion',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'isolated-model-v1',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const frame = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const normal = (usage?: Record<string, unknown>) =>
  frame(chunk({ content: '你好🧑' })) +
  frame(chunk({}, 'stop', usage ? { usage } : {})) +
  frame('[DONE]');
const usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 1 },
};
const tools: Record<string, MaasTool> = {
  read_demo: {
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    validate: (value) => typeof value.key === 'string' && Object.keys(value).length === 1,
  },
};
const toolPayload = () =>
  payload({
    tools: [
      {
        type: 'function',
        function: { name: 'read_demo', parameters: tools.read_demo!.parameters },
      },
    ],
    parallel_tool_calls: false,
  });
const toolFrames = (args = '{"key":"value"}', name = 'read_demo') =>
  frame(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name, arguments: args.slice(0, 5) },
        },
      ],
    }),
  ) +
  frame(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] })) +
  frame(chunk({}, 'tool_calls')) +
  frame('[DONE]');
function fakeFetch(
  wire: string,
  widths = [100_000],
  inspect?: (headers: Headers) => void,
): typeof fetch {
  return async (_input, init) => {
    const requestHeaders = new Headers(init?.headers);
    inspect?.(requestHeaders);
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    let index = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + widths[index++ % widths.length]!, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-agent-model-request-id': requestHeaders.get('x-agent-model-request-id')!,
          'x-platform-request-id': 'isolated-platform-request',
          'x-maas-route-version': config.routeVersion,
        },
      },
    );
  };
}
async function run(
  wire: string,
  options: Parameters<typeof createMaasTransport>[2] = {},
  request = payload(),
) {
  const transport = createMaasTransport(config, context(), { fetch: fakeFetch(wire), ...options });
  const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: request,
  });
  return { transport, result: response.text() };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof MaasError && error.code === code,
  );
}

test('MaaS 独立服务鉴权、可信主体及每次请求关联由宿主覆盖，调用间不复用 ID', async () => {
  const ids: string[] = [];
  const transport = createMaasTransport(config, context(), {
    fetch: fakeFetch(normal(), [1, 2, 7], (headers) => {
      assert.equal(headers.get('authorization'), `Bearer ${config.serviceToken}`);
      assert.equal(headers.get('x-platform-subject-ref'), 'trusted-isolated-subject');
      assert.equal(headers.get('x-agent-maas-contract'), 'chat-sse-v1');
      ids.push(headers.get('x-agent-model-request-id')!);
    }),
  });
  for (let i = 0; i < 2; i++) {
    const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      body: payload(),
      headers: { authorization: 'Bearer hostile', 'x-platform-subject-ref': 'hostile' },
    });
    assert.match(await response.text(), /你好🧑/);
    assert.equal(transport.observation()?.state, 'complete');
  }
  assert.notEqual(ids[0], ids[1]);
  assert.throws(
    () => createMaasTransport(config, { ...context(), platformSubjectRef: '' }),
    /MAAS_SUBJECT_REQUIRED/,
  );
});

test('SSE 按完整事件解析，覆盖 UTF-8 单字节、CR、CRLF、注释与多行 data', async () => {
  const multiline =
    JSON.stringify(chunk({ content: '你好🧑' }), null, 2)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\r\n') + '\r\n\r\n';
  const variants = [
    normal(),
    normal().replace(/\n/g, '\r'),
    normal().replace(/\n/g, '\r\n'),
    ': heartbeat\r\n\r\n' + multiline + frame(chunk({}, 'stop')) + frame('[DONE]'),
  ];
  for (const wire of variants) {
    const { transport, result } = await run(wire, { fetch: fakeFetch(wire, [1]) });
    await result;
    assert.equal(transport.observation()?.state, 'complete');
  }
});

test('finish、DONE 及 EOF 均单独不足以确认成功，错误后的 DONE 不能覆盖失败', async () => {
  const cases = [
    [frame(chunk({ content: 'partial' })) + frame(chunk({}, 'stop')), 'MAAS_INCOMPLETE_STREAM'],
    [frame('[DONE]'), 'MAAS_INCOMPLETE_STREAM'],
    [normal().trimEnd(), 'MAAS_INCOMPLETE_STREAM'],
    [
      frame({ error: { message: 'private upstream detail', code: 'MAAS_UPSTREAM_ERROR' } }) +
        frame('[DONE]'),
      'MAAS_UPSTREAM_ERROR',
    ],
    [
      frame(chunk({ content: 'partial' })) +
        frame(chunk({}, 'stop')) +
        frame(chunk({ content: 'late' })) +
        frame('[DONE]'),
      'MAAS_PROTOCOL_ERROR',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'length')) + frame('[DONE]'),
      'MAAS_OUTPUT_TRUNCATED',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'content_filter')) + frame('[DONE]'),
      'MAAS_CONTENT_FILTERED',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'function_call')) + frame('[DONE]'),
      'MAAS_UNSUPPORTED_FINISH_REASON',
    ],
    [
      frame(chunk({ content: 'partial' })) + frame(chunk({}, 'future_finish')) + frame('[DONE]'),
      'MAAS_UNSUPPORTED_FINISH_REASON',
    ],
    [frame(chunk({}, 'stop')) + frame('[DONE]'), 'MAAS_EMPTY_OUTPUT'],
    [
      frame(chunk({ content: 'partial' })) +
        frame(chunk({}, 'stop', { model: 'unapproved-model' })) +
        frame('[DONE]'),
      'MAAS_PROTOCOL_ERROR',
    ],
  ];
  for (const [wire, code] of cases) {
    const { transport, result } = await run(wire!);
    await rejectsCode(result, code!);
    assert.equal(transport.observation()?.state, 'failed');
  }
});

test('接受完整 DONE 后终止读取，同一网络块的迟到数据无法打开新执行', async () => {
  const { transport, result } = await run(normal() + toolFrames('not-json', 'hostile'));
  await result;
  assert.equal(transport.observation()?.state, 'complete');
});

test('完整工具参数在 DONE 前经白名单与声明校验，多工具整轮拒绝', async () => {
  const accepted = await run(toolFrames(), { tools }, toolPayload());
  await accepted.result;
  assert.equal(accepted.transport.observation()?.finishReason, 'tool_calls');
  const cases = [
    [toolFrames('{"key":'), 'MAAS_TOOL_ARGUMENTS_INVALID'],
    [toolFrames('{"key":1}'), 'MAAS_TOOL_ARGUMENTS_INVALID'],
    [toolFrames('{"key":"v","extra":true}'), 'MAAS_TOOL_ARGUMENTS_INVALID'],
    [toolFrames('[]'), 'MAAS_TOOL_ARGUMENTS_INVALID'],
    [toolFrames('{"key":"v"}', 'unknown'), 'MAAS_TOOL_NOT_ALLOWED'],
    [
      frame(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'a',
              type: 'function',
              function: { name: 'read_demo', arguments: '{}' },
            },
            {
              index: 1,
              id: 'b',
              type: 'function',
              function: { name: 'read_demo', arguments: '{}' },
            },
          ],
        }),
      ) +
        frame(chunk({}, 'tool_calls')) +
        frame('[DONE]'),
      'MAAS_PARALLEL_TOOLS_UNSUPPORTED',
    ],
  ];
  for (const [wire, code] of cases) {
    const { result } = await run(wire!, { tools }, toolPayload());
    await rejectsCode(result, code!);
  }
});

test('wire usage 缺失保留未知，真实上报只取一次，矛盾或非法用量阻断成功', async () => {
  const missing = await run(normal());
  await missing.result;
  assert.equal(missing.transport.observation()?.usage.usageState, 'missing');
  assert.equal(missing.transport.observation()?.usage.promptTokens, null);
  const repeated =
    frame(chunk({ content: 'ok' })) +
    frame(chunk({}, 'stop', { usage })) +
    frame({ ...chunk(), choices: [], usage }) +
    frame('[DONE]');
  const reported = await run(repeated);
  await reported.result;
  assert.equal(reported.transport.observation()?.usage.totalTokens, 15);
  assert.equal(reported.transport.observation()?.usage.costAmount, null);
  for (const bad of [
    { ...usage, total_tokens: 16 },
    { ...usage, prompt_tokens: -1 },
    { ...usage, completion_tokens: 1.5 },
    { ...usage, prompt_tokens_details: { cached_tokens: 11 } },
  ]) {
    const { transport, result } = await run(normal(bad));
    await rejectsCode(result, 'MAAS_USAGE_INVALID');
    assert.equal(transport.observation()?.usage.usageState, 'invalid');
    assert.equal(transport.observation()?.usage.totalTokens, null);
  }
  const conflict = await run(
    repeated.replace(
      frame('[DONE]'),
      frame({
        ...chunk(),
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      }) + frame('[DONE]'),
    ),
  );
  await rejectsCode(conflict.result, 'MAAS_USAGE_INVALID');
});

test('最终请求拒绝 payload 覆盖、非文本消息、未知工具和旁路 URL，且不调用网络', async () => {
  let requests = 0;
  const transport = createMaasTransport(config, context(), {
    fetch: async () => {
      requests++;
      throw new Error('should not run');
    },
  });
  for (const extra of [
    { model: 'other' },
    { stream: false },
    { max_completion_tokens: 1024 },
    { temperature: 0.7 },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
    { parallel_tool_calls: true },
    { tools: [{ type: 'function', function: { name: 'unknown', parameters: {} } }] },
  ]) {
    await rejectsCode(
      transport.fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        body: payload(extra),
      }),
      'MAAS_REQUEST_INVALID',
    );
  }
  await rejectsCode(
    transport.fetch('https://unapproved.example.test/chat/completions', {
      method: 'POST',
      body: payload(),
    }),
    'MAAS_REQUEST_INVALID',
  );
  assert.equal(requests, 0);
});

test('响应头关联或路由不符、错误 HTTP 和字节超限均失败且不重试', async () => {
  for (const changed of [
    { 'x-maas-route-version': 'other' },
    { 'x-agent-model-request-id': randomUUID() },
    { 'content-type': 'text/html' },
    { 'content-encoding': 'gzip' },
    { 'cache-control': 'public' },
  ]) {
    let calls = 0;
    const transport = createMaasTransport(config, context(), {
      fetch: async (input, init) => {
        calls++;
        const result = await fakeFetch(normal())(input, init);
        const headers = new Headers(result.headers);
        Object.entries(changed).forEach(([key, value]) => headers.set(key, value));
        return new Response(result.body, { headers });
      },
    });
    await rejectsCode(
      transport.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
      'MAAS_PROTOCOL_ERROR',
    );
    assert.equal(calls, 1);
  }
  const http = createMaasTransport(config, context(), {
    fetch: async () =>
      new Response('private upstream detail', { status: 429, headers: { 'retry-after': '3' } }),
  });
  await assert.rejects(
    http.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
    (error: unknown) =>
      error instanceof MaasError &&
      error.status === 429 &&
      error.retryAfter === '3' &&
      !error.message.includes('private'),
  );
  for (const limits of [{ responseBytes: 10 }, { eventBytes: 10 }]) {
    const { result } = await run(normal(), { limits });
    await rejectsCode(result, 'MAAS_RESPONSE_LIMIT_EXCEEDED');
  }
  const limitedArgs = await run(
    toolFrames(),
    { tools, limits: { toolArgumentsBytes: 5 } },
    toolPayload(),
  );
  await rejectsCode(limitedArgs.result, 'MAAS_RESPONSE_LIMIT_EXCEEDED');
});

function hangingFetch(progressWire = ''): typeof fetch {
  return async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          if (progressWire) controller.enqueue(new TextEncoder().encode(progressWire));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), {
            once: true,
          });
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'x-agent-model-request-id': new Headers(init?.headers).get('x-agent-model-request-id')!,
          'x-platform-request-id': 'isolated-request',
          'x-maas-route-version': config.routeVersion,
        },
      },
    );
}

test('取消与分段超时有独立可信原因，心跳不能刷新有效进展预算', async () => {
  for (const scenario of [
    {
      code: 'MAAS_FIRST_PROGRESS_TIMEOUT',
      timeouts: { ...config.timeouts, firstProgressMs: 10 },
      wire: ': heartbeat\n\n',
    },
    {
      code: 'MAAS_IDLE_TIMEOUT',
      timeouts: { ...config.timeouts, idleMs: 10 },
      wire: frame(chunk({ content: 'partial' })),
    },
    {
      code: 'MAAS_TOTAL_TIMEOUT',
      timeouts: { ...config.timeouts, totalMs: 10 },
      wire: frame(chunk({ content: 'partial' })),
    },
  ]) {
    const transport = createMaasTransport({ ...config, timeouts: scenario.timeouts }, context(), {
      fetch: hangingFetch(scenario.wire),
    });
    const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      body: payload(),
    });
    await rejectsCode(response.text(), scenario.code);
    assert.equal(transport.observation()?.state, 'failed');
  }
  const stopped = new AbortController();
  const transport = createMaasTransport(config, context(), {
    fetch: hangingFetch(),
    signal: stopped.signal,
  });
  const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: payload(),
  });
  stopped.abort();
  await rejectsCode(response.text(), 'MAAS_CANCELLED');
  assert.equal(transport.observation()?.state, 'cancelled');
  let sends = 0;
  const headersTimeout = createMaasTransport(
    { ...config, timeouts: { ...config.timeouts, headersMs: 10 } },
    context(),
    {
      fetch: async (_input, init) => {
        sends++;
        return await new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          }),
        );
      },
    },
  );
  await rejectsCode(
    headersTimeout.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
    'MAAS_HEADERS_TIMEOUT',
  );
  assert.equal(sends, 1);
});

test('非 UTF-8 声明和损坏 UTF-8 按协议错误拒绝，错误响应释放流并记录 HTTP 事实', async () => {
  for (const charset of ['iso-8859-1', 'utf-16']) {
    let cancelled = false;
    const transport = createMaasTransport(config, context(), {
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              'content-type': `text/event-stream; charset=${charset}`,
              'cache-control': 'no-store',
              'x-agent-model-request-id': new Headers(init?.headers).get(
                'x-agent-model-request-id',
              )!,
              'x-platform-request-id': 'isolated-request',
              'x-maas-route-version': config.routeVersion,
            },
          },
        ),
    });
    await rejectsCode(
      transport.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
      'MAAS_PROTOCOL_ERROR',
    );
    assert.equal(cancelled, true);
  }
  const broken = createMaasTransport(config, context(), {
    fetch: async (input, init) => {
      const response = await fakeFetch(normal())(input, init);
      return new Response(new Uint8Array([0xff, 0xfe]), { headers: response.headers });
    },
  });
  const brokenResponse = await broken.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: payload(),
  });
  await rejectsCode(brokenResponse.text(), 'MAAS_PROTOCOL_ERROR');
  let cancelled = false;
  const errorTransport = createMaasTransport(config, context(), {
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503, headers: { 'retry-after': '2' } },
      ),
  });
  await rejectsCode(
    errorTransport.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
    'MAAS_HTTP_ERROR',
  );
  assert.equal(errorTransport.observation()?.httpStatus, 503);
  assert.equal(errorTransport.observation()?.retryAfter, '2');
  assert.equal(cancelled, true);
});

test('不配合 AbortSignal 的注入 fetch 也不能阻塞本地停止，迟到响应释放且不恢复执行', async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  let cancelled = false;
  const stopped = new AbortController();
  const transport = createMaasTransport(config, context(), {
    signal: stopped.signal,
    fetch: async () =>
      await new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  });
  const pending = transport.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: payload(),
  });
  stopped.abort();
  await rejectsCode(pending, 'MAAS_CANCELLED');
  resolveFetch!(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(transport.observation()?.state, 'cancelled');
});

test('重复空 delta 和已确定的工具身份不能无限延长空闲预算', async () => {
  const repeated = chunk({
    tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_demo' } }],
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  const transport = createMaasTransport(
    { ...config, timeouts: { ...config.timeouts, idleMs: 12 } },
    context(),
    {
      tools,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame(repeated)));
              interval = setInterval(
                () => controller.enqueue(new TextEncoder().encode(frame(repeated))),
                2,
              );
            },
            cancel() {
              clearInterval(interval);
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              'x-agent-model-request-id': new Headers(init?.headers).get(
                'x-agent-model-request-id',
              )!,
              'x-platform-request-id': 'isolated-request',
              'x-maas-route-version': config.routeVersion,
            },
          },
        ),
    },
  );
  const response = await transport.fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: toolPayload(),
  });
  await rejectsCode(response.text(), 'MAAS_IDLE_TIMEOUT');
  clearInterval(interval);
});

test('开流前只保留受限错误代码与 HTTP 事实，不暴露消息、HTML 或超大错误正文', async () => {
  for (const scenario of [
    {
      body: JSON.stringify({
        error: { code: 'MAAS_MODEL_UNAVAILABLE', message: 'sensitive upstream detail' },
      }),
      contentType: 'application/json',
      code: 'MAAS_MODEL_UNAVAILABLE',
    },
    {
      body: JSON.stringify({
        error: { code: 'unsafe-value-with-private-data', message: 'sensitive upstream detail' },
      }),
      contentType: 'application/json',
      code: 'MAAS_HTTP_ERROR',
    },
    {
      body: '<html>sensitive upstream detail</html>',
      contentType: 'text/html',
      code: 'MAAS_HTTP_ERROR',
    },
    {
      body: JSON.stringify({
        error: { code: 'MAAS_MODEL_UNAVAILABLE', message: 'x'.repeat(65 * 1024) },
      }),
      contentType: 'application/json',
      code: 'MAAS_HTTP_ERROR',
    },
  ]) {
    const transport = createMaasTransport(config, context(), {
      fetch: async () =>
        new Response(scenario.body, {
          status: 422,
          headers: { 'content-type': scenario.contentType },
        }),
    });
    await rejectsCode(
      transport.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload() }),
      scenario.code,
    );
    assert.equal(transport.observation()?.httpStatus, 422);
    assert.equal(transport.observation()?.errorCode, scenario.code);
  }
});
