import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { MaasConfig, MaasContext } from '../src/maas/index.js';
import { readDirectModelConfig } from '../src/maas/index.js';
import { createPiDirectModelSession, createPiMemorySession } from '../src/pi/index.js';

const context = (): MaasContext => ({
  conversationId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  executionSnapshotId: randomUUID(),
  executionGeneration: '1',
  platformSubjectRef: 'isolated-platform-subject',
});

function config(port: number): MaasConfig {
  return {
    baseUrl: `http://127.0.0.1:${port}/internal/agent-maas/v1`,
    modelId: 'isolated-model',
    actualModelIds: ['isolated-model'],
    routeVersion: 'isolated-route',
    serviceToken: 'isolated-test-service-token',
    contextWindow: 8192,
    maxTokens: 256,
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
      connectMs: 3000,
      headersMs: 2000,
      firstProgressMs: 2000,
      idleMs: 2000,
      totalMs: 4000,
    },
  };
}

function chunk(response: ServerResponse, text: string, finish: string | null = null): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'isolated-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'isolated-model',
      choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
    })}\n\n`,
  );
}

test('真实本机 HTTP：Pi 增量在 DONE 前可见，第二轮携带原生历史', { timeout: 8000 }, async () => {
  let calls = 0;
  let finished = false;
  let earlyText = false;
  const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    payloads.push(JSON.parse(Buffer.concat(parts).toString()) as (typeof payloads)[number]);
    calls++;
    assert.equal(request.url, '/internal/agent-maas/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer isolated-test-service-token');
    assert.equal(request.headers['x-platform-subject-ref'], 'isolated-platform-subject');
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-agent-model-request-id': request.headers['x-agent-model-request-id'] as string,
      'x-platform-request-id': `isolated-http-${calls}`,
      'x-maas-route-version': 'isolated-route',
    });
    chunk(response, calls === 1 ? 'first answer' : 'second answer');
    setTimeout(() => {
      finished = true;
      chunk(response, '', 'stop');
      response.end('data: [DONE]\n\n');
    }, 80);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const session = await createPiMemorySession({
    config: config(address.port),
    context: context(),
    resolveIdentity: async () => ({ platformSubjectRef: 'isolated-platform-subject' }),
  });
  try {
    assert.equal(
      (
        await session.prompt('first question', () => {
          earlyText ||= !finished;
        })
      ).status,
      'completed',
    );
    assert(earlyText, '流式文字必须早于完整结束');
    assert.equal((await session.prompt('second question')).status, 'completed');
    assert.equal(calls, 2);
    assert(
      payloads[1]!.messages.some(
        (message) => message.role === 'assistant' && message.content === 'first answer',
      ),
    );
    assert(
      payloads[1]!.messages.some(
        (message) =>
          message.role === 'user' &&
          (message.content === 'first question' ||
            (Array.isArray(message.content) &&
              message.content.some(
                (part: unknown) =>
                  !!part &&
                  typeof part === 'object' &&
                  'type' in part &&
                  part.type === 'text' &&
                  'text' in part &&
                  part.text === 'first question',
              ))),
      ),
    );
  } finally {
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('真实本机 HTTP：停止撤销读取并被服务端观察到，无后继调用', { timeout: 8000 }, async () => {
  let calls = 0;
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    calls++;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-agent-model-request-id': request.headers['x-agent-model-request-id'] as string,
      'x-platform-request-id': 'isolated-http-stop',
      'x-maas-route-version': 'isolated-route',
    });
    chunk(response, 'partial answer');
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20);
    response.once('close', () => {
      clearInterval(heartbeat);
      disconnected();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const session = await createPiMemorySession({
    config: config(address.port),
    context: context(),
    resolveIdentity: async () => ({ platformSubjectRef: 'isolated-platform-subject' }),
  });
  try {
    const result = await session.prompt('count slowly', () => {
      void session.stop();
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.text, '');
    await closed;
    assert.equal(calls, 1);
  } finally {
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('真实本机 HTTP：URL＋Key 入口无需平台头，复用 Pi 连续多轮', { timeout: 8000 }, async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const payload = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    payloads.push(payload);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer isolated-direct-key');
    assert.equal(
      Object.keys(request.headers).some((name) => /^x-(agent|platform|maas)-/.test(name)),
      false,
    );
    assert.equal(payload.model, 'isolated-model');
    assert.equal(payload.stream, true);
    assert.equal('thinking' in payload, false);
    assert.equal('store' in payload, false);
    assert.equal('parallel_tool_calls' in payload, false);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    chunk(response, payloads.length === 1 ? 'direct first answer' : 'direct second answer');
    chunk(response, '', 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const session = await createPiDirectModelSession({
    config: readDirectModelConfig({
      AGENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENT_MODEL_API_KEY: 'isolated-direct-key',
      AGENT_MODEL_ID: 'isolated-model',
    }),
  });
  try {
    const first = await session.prompt('direct first question');
    const second = await session.prompt('direct second question');
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(second.text, 'direct second answer');
    assert.equal(payloads.length, 2);
    const messages = payloads[1]!.messages as Array<{ role: string; content: unknown }>;
    assert(
      messages.some(
        (message) => message.role === 'assistant' && message.content === 'direct first answer',
      ),
    );
    for (const observation of [...first.observations, ...second.observations]) {
      assert.equal(observation.profile, 'direct-model');
      assert.equal(observation.platformRequestId, null);
      assert.equal(observation.routeVersion, null);
      assert.equal(observation.usage.usageState, 'missing');
      assert.equal(observation.usage.promptTokens, null);
      assert.equal(observation.usage.costAmount, null);
    }
  } finally {
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
