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
