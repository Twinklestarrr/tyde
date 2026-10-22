import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { errors } from 'undici';
import { createMaasTransport, MaasError, readMaasConfig } from '../src/maas/index.js';
import { createMaasHttpClient, isMaasConnectTimeout } from '../src/maas/http-client.js';

const config = readMaasConfig({
  AGENT_MAAS_BASE_URL: 'https://isolated-connect.invalid/internal/agent-maas/v1',
  AGENT_MAAS_MODEL_ID: 'isolated-model',
  AGENT_MAAS_ACTUAL_MODEL_IDS: '["isolated-model"]',
  AGENT_MAAS_ROUTE_VERSION: 'isolated-route',
  AGENT_MAAS_SERVICE_TOKEN: 'isolated-service-token',
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
const context = () => ({
  conversationId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  executionGeneration: '1',
  executionSnapshotId: randomUUID(),
  platformSubjectRef: 'trusted-isolated-subject',
});
const payload = JSON.stringify({
  model: config.modelId,
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: config.maxTokens,
});

test(
  '独立 socket 建连预算默认 3000ms，停滞 DNS 触发真实连接超时且不发送 HTTP',
  { timeout: 2000 },
  async () => {
    assert.equal(config.timeouts.connectMs, 3000);
    let lookups = 0;
    const transport = createMaasTransport(
      {
        ...config,
        timeouts: { ...config.timeouts, connectMs: 20, headersMs: 1000, totalMs: 1500 },
      },
      context(),
      {
        socket: {
          lookup() {
            lookups++; /* Deliberately never resolves; no DNS or remote socket is used. */
          },
        },
      },
    );
    await assert.rejects(
      transport.fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', body: payload }),
      (error: unknown) => error instanceof MaasError && error.code === 'MAAS_CONNECT_TIMEOUT',
    );
    assert.equal(lookups, 1);
    assert.equal(transport.observation()?.errorCode, 'MAAS_CONNECT_TIMEOUT');
    assert.equal(transport.observation()?.httpStatus, null);
  },
);

test('连接超时分类只信实际 undici 错误类，遍历 cause 与 AggregateError 并防循环', () => {
  const actual = new errors.ConnectTimeoutError();
  assert.equal(isMaasConnectTimeout(new TypeError('fetch failed', { cause: actual })), true);
  assert.equal(
    isMaasConnectTimeout(
      new AggregateError([new Error('other'), new Error('wrapped', { cause: actual })]),
    ),
    true,
  );
  assert.equal(
    isMaasConnectTimeout(
      Object.assign(new Error('ConnectTimeoutError'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    ),
    false,
  );
  const cycle = new Error('cycle');
  cycle.cause = cycle;
  assert.equal(isMaasConnectTimeout(cycle), false);
});

test(
  '停止会取消连接中的 socket，dispatcher 显式销毁且 dispose 可重复等待',
  { timeout: 2000 },
  async () => {
    const abort = new AbortController();
    let lookupStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const client = createMaasHttpClient(1000, abort.signal, {
      lookup() {
        lookupStarted!();
      },
    });
    const pending = client.fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      body: payload,
      signal: abort.signal,
    });
    await started;
    abort.abort();
    await assert.rejects(pending);
    const disposal = client.dispose();
    assert.equal(client.dispose(), disposal);
    await disposal;
  },
);

test(
  '实际 HTTP 421、408、307 各只发送一次，不隐式重发、跟随重定向或换路由',
  { timeout: 3000 },
  async () => {
    for (const status of [421, 408, 307]) {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(status, {
          location: '/another-route',
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({ error: { code: 'MAAS_ROUTE_REJECTED', message: 'isolated error' } }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        assert(address && typeof address === 'object');
        const local = {
          ...config,
          baseUrl: `http://127.0.0.1:${address.port}/internal/agent-maas/v1`,
        };
        const transport = createMaasTransport(local, context());
        await assert.rejects(
          transport.fetch(`${local.baseUrl}/chat/completions`, { method: 'POST', body: payload }),
          (error: unknown) => error instanceof MaasError && error.status === status,
        );
        assert.equal(requests, 1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);
