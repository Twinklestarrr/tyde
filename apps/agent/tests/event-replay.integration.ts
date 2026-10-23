import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateAgentContract, type ProductFrame } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config.js';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { appendEvent, projectConversation } from '../src/storage/projections.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated AGENT_TEST_DATABASE_URL *_test database required');
const database = createAgentDatabase({
  connectionString: url,
  applicationName: 'tyde-agent-event-replay-fixture',
});
const userId = `event-replay/${randomUUID()}`;
const token = 'isolated-event-replay-credential-0000000001';
const principal = { userId, source: 'development' as const };
let createSessionCalls = 0;
const runtime = new AgentPostgresRuntime({
  pool: database.pool,
  executionConfig: {},
  createSession: async () => {
    createSessionCalls++;
    throw new Error('Event replay never starts Pi');
  },
});

/** Actual HTTP consumer reads promptly; 600 frames must not overflow a one-shot API queue. */
test('真实HTTP分页补读600条可靠事件，after128断线重连连续且不触发执行', async () => {
  await runtime.initialize();
  const app = await createApp(
    readConfig({
      NODE_ENV: 'test',
      AGENT_STORAGE_MODE: 'postgres',
      AGENT_DATABASE_URL: url,
      AGENT_AUTH_MODE: 'development',
      AGENT_TEST_USER_ID: userId,
      AGENT_TEST_BEARER_TOKEN: token,
    }),
    { runtime },
  );
  try {
    const created = await runtime.createConversation(principal, {
      schema_version: 1,
      title: 'Isolated reliable event replay fixture',
    });
    const id = created.conversation.id;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [id]);
      const conversation = await projectConversation(client, id);
      for (let i = 1; i <= 600; i++)
        await appendEvent(client, {
          conversationId: id,
          eventType: 'conversation.updated',
          payload: { conversation },
          producerKey: `isolated-replay/${i}`,
        });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const snapshot = await runtime.getSnapshot(principal, id);
    assert.equal(snapshot.read_cursor.event_seq, '600');
    assert.equal(snapshot.focus_task, null);
    assert.equal(
      (
        await database.pool.query(
          'SELECT count(*)::text AS n FROM agent_tasks WHERE conversation_id=$1',
          [id],
        )
      ).rows[0].n,
      '0',
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    async function read(after: number, count: number) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('Reliable replay exceeded controlled test deadline')),
        15000,
      );
      timeout.unref();
      const response = await fetch(
        `${origin}/api/agent/v1/conversations/${id}/events?stream_id=${snapshot.read_cursor.stream_id}&after_seq=${after}`,
        { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const products: ProductFrame[] = [];
      let ready = false;
      let buffered = '';
      try {
        while (products.length < count) {
          const part = await reader.read();
          assert.equal(
            part.done,
            false,
            'SSE must stay open until the requested continuous prefix arrives',
          );
          buffered += decoder.decode(part.value, { stream: true });
          let separator = buffered.indexOf('\n\n');
          while (separator >= 0 && products.length < count) {
            const block = buffered.slice(0, separator);
            buffered = buffered.slice(separator + 2);
            separator = buffered.indexOf('\n\n');
            if (block.startsWith(':')) continue;
            const data = block.split('\n').find((line) => line.startsWith('data: '));
            assert.ok(data);
            const frame = JSON.parse(data.slice(6));
            if (frame.frame_kind === 'control') {
              assert.ok(validateAgentContract('ControlFrame', frame));
              assert.equal(
                frame.code,
                'ready',
                'A fast reader must not receive slow_consumer or resync controls',
              );
              assert.equal(frame.observed_head_seq, '600');
              assert.equal(frame.accepted_after_seq, String(after));
              assert.equal(ready, false);
              ready = true;
            } else {
              assert.equal(ready, true);
              assert.ok(validateAgentContract('ProductFrame', frame));
              assert.equal(frame.event_seq, String(after + products.length + 1));
              assert.equal(
                block.split('\n').find((line) => line.startsWith('id: ')),
                `id: ${frame.stream_id}:${frame.event_seq}`,
              );
              products.push(frame);
            }
          }
        }
        return products;
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
    }
    const full = await read(0, 600);
    assert.deepEqual(
      full.map((frame) => frame.event_seq),
      Array.from({ length: 600 }, (_unused, index) => String(index + 1)),
    );
    const prefix = await read(0, 128);
    const resumed = await read(128, 472);
    assert.deepEqual(
      [...prefix, ...resumed].map((frame) => frame.event_seq),
      full.map((frame) => frame.event_seq),
    );
    assert.equal(new Set([...prefix, ...resumed].map((frame) => frame.event_id)).size, 600);
    assert.equal(createSessionCalls, 0);
    const current = await runtime.getSnapshot(principal, id);
    assert.equal(current.read_cursor.event_seq, '600');
  } finally {
    await app.close();
    await database.close();
  }
});
