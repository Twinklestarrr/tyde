import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentHealth } from '../src/services/agent-client';

test('health uses the Agent proxy and validates the shared response', async () => {
  const health = await getAgentHealth({
    fetch: async (url, init) => {
      assert.equal(url, '/agent-api/health/live');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.credentials, 'omit');
      return Response.json({ service: 'tyde-agent', status: 'ok' });
    },
  });
  assert.deepEqual(health, { service: 'tyde-agent', status: 'ok' });
});

test('HTTP failure is surfaced without a simulated success', async () => {
  await assert.rejects(
    getAgentHealth({ fetch: async () => new Response('', { status: 503 }) }),
    /HTTP 503/,
  );
});

test('wrong service, malformed JSON and HTML fallback are rejected', async () => {
  for (const response of [
    Response.json({ service: 'other-service', status: 'ok' }),
    Response.json({ service: 'tyde-agent', status: 'unavailable' }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(getAgentHealth({ fetch: async () => response }), /响应|JSON|契约/);
  }
});

test('network errors and cancellation stay visible to the caller', async () => {
  const failure = new TypeError('network unreachable');
  await assert.rejects(
    getAgentHealth({
      fetch: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    getAgentHealth({
      signal: controller.signal,
      fetch: async (_url, init) => {
        assert.equal(init?.signal, controller.signal);
        init?.signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    }),
    { name: 'AbortError' },
  );
});

test('product requests carry only the controlled bearer and validate shared responses', async () => {
  const { AgentClient } = await import('../src/services/agent-client');
  const { conversationId, response, snapshot } = await import('./chat-fixtures');
  const client = new AgentClient('local-test-identity', async (url, init) => {
    assert.equal(
      url,
      `/agent-api/api/agent/v1/conversations/${conversationId}/snapshot?message_limit=100`,
    );
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-test-identity');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return response(snapshot());
  });
  assert.equal((await client.snapshot(conversationId)).data.conversation.id, conversationId);
});

test('SSE awaits frame application before dispatching the next frame and cancels its reader', async () => {
  const { AgentClient } = await import('../src/services/agent-client');
  const { conversationId, deferred, snapshot } = await import('./chat-fixtures');
  const firstApplied = deferred<void>();
  let cancelled = false;
  const client = new AgentClient('local-test-identity', async (url, init) => {
    assert.match(String(url), /events\?stream_id=.*&after_seq=10$/);
    assert.doesNotMatch(String(url), /local-test-identity/);
    assert.equal(new Headers(init?.headers).get('accept'), 'text/event-stream');
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: control\ndata: {"part":1}\n\nevent: control\ndata: {"part":2}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const controller = new AbortController();
  const seen: string[] = [];
  const reading = client.events(
    conversationId,
    snapshot().read_cursor,
    async (frame) => {
      seen.push(frame.data);
      if (seen.length === 1) await firstApplied.promise;
      else controller.abort();
    },
    controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  firstApplied.resolve();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(seen.length, 2);
  assert.equal(cancelled, true);
});

test('SSE pre-open authorization error is a structured failure, not an empty stream', async () => {
  const { AgentApiError, AgentClient } = await import('../src/services/agent-client');
  const { conversationId, readError, snapshot } = await import('./chat-fixtures');
  const client = new AgentClient('expired', async () => readError(401));
  await assert.rejects(
    client.events(
      conversationId,
      snapshot().read_cursor,
      async () => {},
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentApiError && error.status === 401 && error.action === 'reauthenticate',
  );
});

test('default browser fetch retains its required global receiver', async () => {
  const { AgentClient } = await import('../src/services/agent-client');
  const { conversationId, response, snapshot } = await import('./chat-fixtures');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async function (this: typeof globalThis) {
      assert.equal(this, globalThis);
      return response(snapshot());
    };
    const client = new AgentClient('local-test-identity');
    assert.equal((await client.snapshot(conversationId)).data.conversation.id, conversationId);
  } finally {
    globalThis.fetch = original;
  }
});

test('storage metadata is authenticated, read only, and accepts only explicit server modes', async () => {
  const { AgentClient } = await import('../src/services/agent-client');
  for (const storage_mode of ['postgres', 'memory'] as const) {
    const client = new AgentClient('controlled-identity', async (url, init) => {
      assert.equal(url, '/agent-api/api/agent/v1/runtime');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer controlled-identity');
      assert.equal(init?.body, undefined);
      return Response.json({ storage_mode });
    });
    assert.equal(await client.storageMode(), storage_mode);
  }
  for (const data of [{}, { storage_mode: 'unknown' }, null]) {
    const client = new AgentClient('controlled-identity', async () => Response.json(data));
    await assert.rejects(client.storageMode(), /存储模式尚未确认/);
  }
  const unavailable = new AgentClient('controlled-identity', async () =>
    Response.json({}, { status: 503 }),
  );
  await assert.rejects(unavailable.storageMode(), /503/);
});
