import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readDirectModelConfig, type MaasConfig, type MaasContext } from '../src/maas/index.js';
import {
  createPiMemorySession,
  createPiDirectModelSession,
  type PiMemoryTool,
} from '../src/pi/index.js';

const config: MaasConfig = {
  baseUrl: 'http://127.0.0.1/internal/agent-maas/v1',
  modelId: 'isolated-model',
  actualModelIds: ['isolated-model'],
  routeVersion: 'isolated-route-v1',
  serviceToken: 'isolated-service-token',
  contextWindow: 8192,
  maxTokens: 512,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    thinkingFormat: 'openai',
  },
  timeouts: { headersMs: 2000, firstProgressMs: 2000, idleMs: 2000, totalMs: 5000 },
};
const context = (): MaasContext => ({
  conversationId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  executionGeneration: '1',
  executionSnapshotId: randomUUID(),
  platformSubjectRef: 'isolated-platform-subject',
});
const identity = async () => ({
  platformSubjectRef: 'isolated-platform-subject',
  source: 'platform' as const,
});
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'completion-isolated',
  object: 'chat.completion.chunk',
  created: 1,
  model: config.modelId,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const encode = (data: unknown) =>
  `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const answer = (text = 'hello') => [
  chunk({ role: 'assistant', content: text }),
  chunk({}, 'stop'),
  '[DONE]',
];
const toolAnswer = () => [
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call-one',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"safe"}' } }] }),
  chunk({}, 'tool_calls'),
  '[DONE]',
];
function response(init: RequestInit | undefined, data: unknown[] | ReadableStream<Uint8Array>) {
  const headers = new Headers(init?.headers);
  return new Response(Array.isArray(data) ? data.map(encode).join('') : data, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-agent-model-request-id': headers.get('x-agent-model-request-id')!,
      'x-platform-request-id': 'isolated-platform-request',
      'x-maas-route-version': config.routeVersion,
    },
  });
}
function echoTool(execute: PiMemoryTool['execute']): PiMemoryTool {
  return {
    name: 'echo',
    description: 'Return a supplied word without side effects.',
    parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    validate: (args) => typeof args.text === 'string' && Object.keys(args).length === 1,
    execute,
  };
}

test('固定 Pi 1.3.0 原生上下文连续多轮，增量与未知用量分别返回', async () => {
  const payloads: Record<string, unknown>[] = [];
  const requests: Headers[] = [];
  let resolutions = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: async () => {
      resolutions += 1;
      return identity();
    },
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      requests.push(new Headers(init?.headers));
      return response(init, answer(payloads.length === 1 ? 'remembered' : 'recalled'));
    },
  });
  try {
    const deltas: string[] = [];
    const first = await session.prompt('Remember this word.', (delta) => deltas.push(delta));
    assert.equal(first.status, 'completed');
    assert.equal(first.text, 'remembered');
    assert.equal(deltas.join(''), first.text);
    assert.equal(first.observations[0].usage.usageState, 'missing');
    assert.equal(first.observations[0].usage.totalTokens, null);
    assert.equal(first.observations[0].usage.costAmount, null);
    assert.equal((await session.prompt('Recall the word.')).status, 'completed');
    assert.equal(resolutions, 2);
    const history = payloads[1].messages as { role: string; content: unknown }[];
    assert.ok(
      history.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('Remember this word.'),
      ),
    );
    assert.ok(
      history.some((message) => message.role === 'assistant' && message.content === 'remembered'),
    );
    assert.equal(payloads[0].tools, undefined);
    assert.equal(payloads[0].max_tokens, 512);
    assert.deepEqual(payloads[0].stream_options, { include_usage: true });
    assert.notEqual(
      requests[0].get('x-agent-model-request-id'),
      requests[1].get('x-agent-model-request-id'),
    );
    assert.ok(!JSON.stringify(payloads[1].messages).includes(first.observations[0].modelRequestId));
    const captured = session.captureNativeState();
    assert.ok(captured.header);
    assert.equal(captured.leafId, captured.entries.at(-1)?.id);
    const usage = captured.entries.filter((entry) => entry.type === 'custom');
    assert.equal(usage.length, 2);
    const linked = usage[0].data as { sourceNativeEntryId: string };
    assert.ok(
      captured.entries.some(
        (entry) =>
          entry.id === linked.sourceNativeEntryId &&
          entry.type === 'message' &&
          entry.message.role === 'assistant',
      ),
    );
    captured.entries.length = 0;
    assert.ok(session.captureNativeState().entries.length > 0);
  } finally {
    session.dispose();
  }
});

test('资源目录中的扩展、凭据、提示和工具设置不会被发现或执行', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tyde-pi-resource-canary-'));
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(cwd, 'AGENTS.md'), 'RESOURCE_CANARY_MUST_NOT_APPEAR');
  await writeFile(
    join(cwd, '.pi', 'settings.json'),
    JSON.stringify({ defaultTools: ['bash', 'read'], retry: { enabled: true } }),
  );
  await writeFile(
    join(cwd, '.pi', 'extensions', 'canary.ts'),
    'throw new Error("RESOURCE_CANARY_MUST_NOT_LOAD")',
  );
  let calls = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    cwd,
    resolveIdentity: identity,
    fetch: async (_input, init) => {
      calls += 1;
      assert.ok(!String(init?.body).includes('RESOURCE_CANARY'));
      assert.equal(JSON.parse(String(init?.body)).tools, undefined);
      return response(init, answer());
    },
  });
  try {
    assert.equal((await session.prompt('Hello')).status, 'completed');
    assert.equal(calls, 1);
    assert.equal(session.captureNativeState().header?.cwd, cwd);
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('SDK 注册触发的后台刷新也只覆盖固定 MaaS Provider，不探测环境凭据', async () => {
  const refreshes: Parameters<ModelRuntime['refresh']>[0][] = [];
  const original = ModelRuntime.prototype.refresh;
  ModelRuntime.prototype.refresh = function (options) {
    refreshes.push(options);
    return original.call(this, options);
  };
  try {
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: identity,
      fetch: async (_input, init) => response(init, answer()),
    });
    try {
      assert.equal((await session.prompt('Hello')).status, 'completed');
      assert.ok(refreshes.length > 0);
      assert.ok(
        refreshes.every(
          (entry) =>
            entry?.allowNetwork === false && JSON.stringify(entry.providers) === '["tyde-maas"]',
        ),
      );
    } finally {
      session.dispose();
    }
  } finally {
    ModelRuntime.prototype.refresh = original;
  }
});

test('原生输入、assistant、工具结果屏障串行等待后才放行下一步', async () => {
  const order: string[] = [];
  let calls = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    tools: [
      echoTool(async () => {
        order.push('tool');
        return 'safe';
      }),
    ],
    barriers: {
      beforeModel: async (state) => {
        assert.ok(
          state.entries.some((entry) => entry.type === 'message' && entry.message.role === 'user'),
        );
        order.push('input');
      },
      afterAssistant: async (state) => {
        assert.equal(state.entries.at(-1)?.type, 'custom');
        order.push('assistant');
        await Promise.resolve();
      },
      beforeTool: async () => {
        order.push('before-tool');
      },
      afterTool: async (state) => {
        assert.equal(state.entries.at(-1)?.type, 'message');
        order.push('tool-result');
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      order.push('http');
      return response(init, calls === 1 ? toolAnswer() : answer('finished'));
    },
  });
  try {
    const result = await session.prompt('Use the permitted echo tool.');
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(order, [
      'input',
      'http',
      'assistant',
      'before-tool',
      'tool',
      'tool-result',
      'input',
      'http',
      'assistant',
    ]);
    assert.equal(calls, 2);
  } finally {
    session.dispose();
  }
});

for (const boundary of ['beforeModel', 'afterAssistant', 'beforeTool', 'afterTool'] as const) {
  test(`${boundary} 屏障失败后不继续模型或工具，并锁住会话`, async () => {
    let calls = 0;
    let executions = 0;
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: identity,
      tools: [
        echoTool(async () => {
          executions += 1;
          return 'safe';
        }),
      ],
      barriers: {
        [boundary]: async () => {
          throw new Error('private barrier details');
        },
      },
      fetch: async (_input, init) => {
        calls += 1;
        return response(init, toolAnswer());
      },
    });
    try {
      const result = await session.prompt('Use echo.');
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.error, { code: 'PI_NATIVE_BARRIER_FAILED' });
      assert.equal(calls, boundary === 'beforeModel' ? 0 : 1);
      assert.equal(executions, boundary === 'afterTool' ? 1 : 0);
      await assert.rejects(session.prompt('continue'), /PI_SESSION_BLOCKED/);
    } finally {
      session.dispose();
    }
  });
}

test('subject 变化或非平台身份在实际 HTTP 发送前拒绝', async () => {
  for (const invalid of [
    { platformSubjectRef: 'another-subject' },
    { platformSubjectRef: 'isolated-platform-subject', source: 'development' },
  ]) {
    let calls = 0;
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: async () => invalid as Awaited<ReturnType<typeof identity>>,
      fetch: async () => {
        calls += 1;
        throw new Error('must not call');
      },
    });
    try {
      const result = await session.prompt('Hello');
      assert.deepEqual(result.error, { code: 'PI_UNTRUSTED_MAAS_IDENTITY' });
      assert.equal(calls, 0);
    } finally {
      session.dispose();
    }
  }
});

test('不完整响应失败且不自动重试、压缩或调用工具', async () => {
  let calls = 0;
  let executions = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    tools: [
      echoTool(async () => {
        executions += 1;
        return 'safe';
      }),
    ],
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, toolAnswer().slice(0, -1));
    },
  });
  try {
    const result = await session.prompt('Use echo.');
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.error, { code: 'MAAS_INCOMPLETE_STREAM' });
    assert.equal(calls, 1);
    assert.equal(executions, 0);
  } finally {
    session.dispose();
  }
});

test('停止后迟到输出不再显示、不执行工具或发送下一轮', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let releaseStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let calls = 0;
  let executions = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    tools: [
      echoTool(async () => {
        executions += 1;
        return 'safe';
      }),
    ],
    fetch: async (_input, init) => {
      calls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {},
      });
      queueMicrotask(releaseStarted);
      return response(init, body);
    },
  });
  const displayed: string[] = [];
  try {
    const pending = session.prompt('Hello', (delta) => displayed.push(delta));
    await started;
    await session.stop();
    const before = session.captureNativeState();
    try {
      streamController!.enqueue(new TextEncoder().encode(toolAnswer().map(encode).join('')));
    } catch {
      /* 取消后底层可能已关闭。 */
    }
    const result = await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.status, 'stopped');
    assert.equal(displayed.length, 0);
    assert.equal(calls, 1);
    assert.equal(executions, 0);
    assert.deepEqual(session.captureNativeState(), before);
  } finally {
    session.dispose();
  }
});

test('文字增量在 finish 和 DONE 之前交付，SDK 没有等整轮结束才回调', async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let releaseText!: () => void;
  const receivedText = new Promise<void>((resolve) => {
    releaseText = resolve;
  });
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    fetch: async (_input, init) =>
      response(
        init,
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode(encode(chunk({ content: 'early' }))));
          },
        }),
      ),
  });
  try {
    let settled = false;
    const pending = session
      .prompt('Hello', () => {
        releaseText();
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await receivedText;
    assert.equal(settled, false);
    streamController.enqueue(
      new TextEncoder().encode([chunk({}, 'stop'), '[DONE]'].map(encode).join('')),
    );
    streamController.close();
    const result = await pending;
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'early');
  } finally {
    session.dispose();
  }
});

test('在文字回调中停止，即使剩余工具输出已缓冲也不能启动工具', async () => {
  let calls = 0;
  let executions = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    tools: [
      echoTool(async () => {
        executions += 1;
        return 'safe';
      }),
    ],
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, [chunk({ content: 'stop now' }), ...toolAnswer()]);
    },
  });
  try {
    const result = await session.prompt('Hello', () => {
      void session.stop();
    });
    assert.equal(result.status, 'stopped');
    assert.equal(calls, 1);
    assert.equal(executions, 0);
    assert.ok(!session.captureNativeState().entries.some((entry) => entry.type === 'custom'));
    assert.ok(
      session
        .captureNativeState()
        .entries.some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'assistant' &&
            entry.message.stopReason === 'aborted' &&
            entry.message.content.some(
              (part) => part.type === 'text' && part.text === 'stop now',
            ) &&
            entry.message.content.every((part) => part.type !== 'toolCall'),
        ),
    );
    assert.equal(result.text, '');
  } finally {
    session.dispose();
  }
});

test('已接受的增量在协议错误后保留为原生 error 事实，不变成成功交付或挂起工具', async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let releaseText!: () => void;
  const receivedText = new Promise<void>((resolve) => {
    releaseText = resolve;
  });
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    fetch: async (_input, init) =>
      response(
        init,
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              new TextEncoder().encode(encode(chunk({ content: 'accepted prefix' }))),
            );
          },
        }),
      ),
  });
  try {
    const pending = session.prompt('Hello', () => {
      releaseText();
    });
    await receivedText;
    streamController.enqueue(new TextEncoder().encode(encode(chunk({}, 'length'))));
    streamController.close();
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.text, '');
    assert.equal(result.error?.code, 'MAAS_OUTPUT_TRUNCATED');
    assert.ok(
      session
        .captureNativeState()
        .entries.some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'assistant' &&
            entry.message.stopReason === 'error' &&
            entry.message.content.some(
              (part) => part.type === 'text' && part.text === 'accepted prefix',
            ) &&
            entry.message.content.every((part) => part.type !== 'toolCall'),
        ),
    );
  } finally {
    session.dispose();
  }
});

test('失败与停止竞态保留第一项可信原因，状态与脱敏错误保持一致', async () => {
  for (const first of ['failure', 'stop'] as const) {
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: identity,
      fetch: async (_input, init) => response(init, answer('accepted prefix')),
    });
    try {
      const result = await session.prompt('Hello', () => {
        if (first === 'stop') void session.stop();
        else
          queueMicrotask(() => {
            void session.stop();
          });
        throw new Error(config.serviceToken);
      });
      assert.equal(result.status, first === 'failure' ? 'failed' : 'stopped');
      assert.deepEqual(
        result.error,
        first === 'failure' ? { code: 'PI_OUTPUT_CONSUMER_FAILED' } : null,
      );
      assert.ok(!JSON.stringify(result).includes(config.serviceToken));
      assert.ok(!JSON.stringify(session.captureNativeState()).includes(config.serviceToken));
    } finally {
      session.dispose();
    }
  }
});

test('停止等待中的 assistant 屏障后，迟到回调持有的副本不能修改原生状态', async () => {
  let releaseStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let releaseBarrier!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    barriers: {
      afterAssistant: async (state, message) => {
        releaseStarted();
        await waiting;
        state.entries.length = 0;
        message.content.length = 0;
      },
    },
    fetch: async (_input, init) => response(init, answer('saved prefix')),
  });
  try {
    const pending = session.prompt('Hello');
    await started;
    await session.stop();
    assert.equal((await pending).status, 'stopped');
    const stopped = session.captureNativeState();
    releaseBarrier();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(session.captureNativeState(), stopped);
  } finally {
    session.dispose();
  }
});

for (const pendingStage of ['identity', 'barrier'] as const) {
  test(`HTTP 之前的 ${pendingStage} 等待可停止，迟到解析结果不能启动请求`, async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let calls = 0;
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: async () => {
        if (pendingStage === 'identity') {
          releaseStarted();
          await preparation;
        }
        return identity();
      },
      barriers:
        pendingStage === 'barrier'
          ? {
              beforeModel: async () => {
                releaseStarted();
                await preparation;
              },
            }
          : undefined,
      fetch: async (_input, init) => {
        calls += 1;
        return response(init, answer());
      },
    });
    try {
      const pending = session.prompt('Hello');
      await started;
      await session.stop();
      assert.equal((await pending).status, 'stopped');
      const stopped = session.captureNativeState();
      finishPreparation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.deepEqual(session.captureNativeState(), stopped);
    } finally {
      session.dispose();
    }
  });
}

test('可信身份解析不返回时受准备预算限制，以失败收敛且不发 HTTP', async () => {
  let calls = 0;
  const session = await createPiMemorySession({
    config: { ...config, timeouts: { ...config.timeouts, totalMs: 15 } },
    context: context(),
    resolveIdentity: () => new Promise(() => {}),
    fetch: async () => {
      calls += 1;
      throw new Error('must not call');
    },
  });
  try {
    const result = await session.prompt('Hello');
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.error, { code: 'PI_PREPARATION_TIMEOUT' });
    assert.equal(calls, 0);
  } finally {
    session.dispose();
  }
});

test('原始工具参数必须匹配完整声明，SDK 类型转换不能放行错误对象', async () => {
  let calls = 0;
  let executions = 0;
  const session = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    tools: [
      {
        ...echoTool(async () => {
          executions += 1;
          return 'safe';
        }),
        validate: () => true,
      },
    ],
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call-one',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":123}' },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ]);
    },
  });
  try {
    const result = await session.prompt('Use echo');
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MAAS_TOOL_ARGUMENTS_INVALID');
    assert.equal(calls, 1);
    assert.equal(executions, 0);
  } finally {
    session.dispose();
  }
});

test('模型超时作为失败收敛，HTTP 错误不向调用方透出服务凭据或原始错误', async () => {
  const timeoutSession = await createPiMemorySession({
    config: { ...config, timeouts: { ...config.timeouts, firstProgressMs: 15 } },
    context: context(),
    resolveIdentity: identity,
    fetch: async (_input, init) =>
      response(init, new ReadableStream<Uint8Array>({ start() {}, cancel() {} })),
  });
  try {
    const result = await timeoutSession.prompt('Hello');
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.error, { code: 'MAAS_FIRST_PROGRESS_TIMEOUT' });
  } finally {
    timeoutSession.dispose();
  }
  let calls = 0;
  const failed = await createPiMemorySession({
    config,
    context: context(),
    resolveIdentity: identity,
    fetch: async () => {
      calls += 1;
      return new Response(`secret ${config.serviceToken}`, { status: 503 });
    },
  });
  try {
    const result = await failed.prompt('Hello');
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes(config.serviceToken));
    assert.ok(!JSON.stringify(failed.captureNativeState()).includes(config.serviceToken));
  } finally {
    failed.dispose();
  }
});

function directChunk(
  modelId: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) {
  return {
    id: 'completion-direct-isolated',
    object: 'chat.completion.chunk',
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
function directResponse(data: unknown[] | ReadableStream<Uint8Array>) {
  return new Response(Array.isArray(data) ? data.map(encode).join('') : data, {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'isolated-upstream-request' },
  });
}

test('显式官方 DeepSeek 直连复用原生多轮，关闭思考且不伪造平台身份和路由', async () => {
  const direct = readDirectModelConfig({
    NODE_ENV: 'test',
    AGENT_MODEL_API_KEY: 'isolated-direct-api-key',
  });
  const payloads: Record<string, unknown>[] = [];
  const session = await createPiDirectModelSession({
    config: direct,
    fetch: async (input, init) => {
      assert.equal(String(input), `${direct.baseUrl}/chat/completions`);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${direct.apiKey}`);
      assert.ok([...headers.keys()].every((name) => !/^x-(agent|platform)-/i.test(name)));
      const payload = JSON.parse(String(init?.body));
      payloads.push(payload);
      assert.deepEqual(payload.thinking, { type: 'disabled' });
      assert.equal(payload.parallel_tool_calls, undefined);
      assert.equal(payload.store, undefined);
      assert.equal(payload.tools, undefined);
      return directResponse([
        directChunk(direct.modelId, {
          role: 'assistant',
          content: payloads.length === 1 ? 'remembered' : 'recalled',
        }),
        directChunk(direct.modelId, { role: null, content: '' }, 'stop'),
        '[DONE]',
      ]);
    },
  });
  try {
    const deltas: string[] = [];
    const first = await session.prompt('Remember this word.', (delta) => deltas.push(delta));
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.equal(deltas.join(''), 'remembered');
    assert.equal(first.observations[0].profile, 'direct-model');
    assert.equal(first.observations[0].platformRequestId, null);
    assert.equal(first.observations[0].routeVersion, null);
    assert.equal(first.observations[0].usage.totalTokens, null);
    assert.equal((await session.prompt('Recall the word.')).status, 'completed');
    assert.ok(JSON.stringify(payloads[1].messages).includes('remembered'));
    const native = session.captureNativeState();
    assert.ok(
      native.entries.some(
        (entry) => entry.type === 'model_change' && entry.provider === 'deepseek',
      ),
    );
    assert.ok(!JSON.stringify(native).includes(direct.apiKey));
    assert.ok(!JSON.stringify(first).includes(direct.apiKey));
  } finally {
    session.dispose();
  }
});

test('URL 与 Key 的通用模型直连不发送供应商扩展，停止沿用相同原生执行门槛', async () => {
  const direct = readDirectModelConfig({
    NODE_ENV: 'test',
    AGENT_MODEL_API_KEY: 'isolated-generic-api-key',
    AGENT_MODEL_BASE_URL: 'https://models.example.test/custom/v1',
    AGENT_MODEL_ID: 'custom-model',
  });
  let calls = 0;
  const session = await createPiDirectModelSession({
    config: direct,
    fetch: async (_input, init) => {
      calls += 1;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, 'custom-model');
      for (const field of ['thinking', 'reasoning_effort', 'parallel_tool_calls', 'store'])
        assert.equal(payload[field], undefined);
      return directResponse([
        directChunk(direct.modelId, { content: 'accepted prefix' }),
        directChunk(direct.modelId, {}, 'stop'),
        '[DONE]',
      ]);
    },
  });
  try {
    const result = await session.prompt('Hello', () => {
      void session.stop();
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.text, '');
    assert.equal(calls, 1);
    assert.ok(
      session
        .captureNativeState()
        .entries.some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'assistant' &&
            entry.message.stopReason === 'aborted' &&
            entry.message.content.some(
              (part) => part.type === 'text' && part.text === 'accepted prefix',
            ),
        ),
    );
    assert.ok(!JSON.stringify(result).includes(direct.apiKey));
  } finally {
    session.dispose();
  }
});

test('显式直连不完整响应失败且不自动重试或改走平台路径', async () => {
  const direct = readDirectModelConfig({
    NODE_ENV: 'test',
    AGENT_MODEL_API_KEY: 'isolated-direct-api-key',
  });
  let calls = 0;
  const session = await createPiDirectModelSession({
    config: direct,
    fetch: async (_input, _init) => {
      calls += 1;
      return directResponse([
        directChunk(direct.modelId, { content: 'prefix' }),
        directChunk(direct.modelId, {}, 'stop'),
      ]);
    },
  });
  try {
    const result = await session.prompt('Hello');
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(result.observations[0].profile, 'direct-model');
    assert.equal(result.observations[0].state, 'failed');
    assert.equal(result.observations[0].platformRequestId, null);
    assert.ok(!JSON.stringify(result).includes(direct.apiKey));
  } finally {
    session.dispose();
  }
});

test('供应商 Key 不绕过平台身份，生产可装配显式服务端模型配置且不隐式请求', async () => {
  const previousKey = process.env.AGENT_MODEL_API_KEY;
  const previousEnv = process.env.NODE_ENV;
  process.env.AGENT_MODEL_API_KEY = 'isolated-direct-api-key';
  let calls = 0;
  try {
    const session = await createPiMemorySession({
      config,
      context: context(),
      resolveIdentity: async () => {
        throw new Error('no platform authorization');
      },
      fetch: async () => {
        calls += 1;
        throw new Error('must not call');
      },
    });
    try {
      const result = await session.prompt('Hello');
      assert.deepEqual(result.error, { code: 'PI_MAAS_IDENTITY_UNAVAILABLE' });
      assert.equal(calls, 0);
    } finally {
      session.dispose();
    }
    const direct = readDirectModelConfig({
      NODE_ENV: 'test',
      AGENT_MODEL_API_KEY: 'isolated-direct-api-key',
    });
    process.env.NODE_ENV = 'production';
    const configured = await createPiDirectModelSession({
      config: direct,
      fetch: async () => {
        calls += 1;
        throw new Error('must not call');
      },
    });
    configured.dispose();
    assert.equal(calls, 0);
  } finally {
    if (previousKey === undefined) delete process.env.AGENT_MODEL_API_KEY;
    else process.env.AGENT_MODEL_API_KEY = previousKey;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});
