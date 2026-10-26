import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateAgentContract, type CommandRequest } from '@tyde/shared/agent';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { publishExecutionSnapshot } from '../src/storage/execution-config.js';
import { checkAgentDatabase } from '../src/storage/migrations.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';
import { createPiDirectModelSession } from '../src/pi/index.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url)
  throw new Error('AGENT_TEST_DATABASE_URL is required; use a dedicated Agent test database');
const database = createAgentDatabase({ connectionString: url });
const principal = { userId: `runtime-test-${randomUUID()}`, source: 'development' as const };
const prompt = (text: string): CommandRequest => ({
  schema_version: 1,
  kind: 'start_task',
  request_key: randomUUID(),
  task_kind: 'business_query',
  input: { text },
});
const config = readDirectModelConfig({
  AGENT_MODEL_BASE_URL: 'http://127.0.0.1:55439/v1',
  AGENT_MODEL_ID: 'controlled-w5',
  AGENT_MODEL_API_KEY: 'isolated-key',
});
let calls = 0;
const fetcher: typeof fetch = async (_input, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  const text =
    calls === 1
      ? '已记住口令 W5-CONTEXT'
      : JSON.stringify(body.messages).includes('W5-CONTEXT')
        ? '原生上下文口令 W5-CONTEXT'
        : '缺失上下文';
  const frame = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: `controlled-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'controlled-w5', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
  return new Response(
    frame({ role: 'assistant', content: text }, null) + frame({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const make = () =>
  new AgentPostgresRuntime({
    pool: database.pool,
    executionConfig: { model: 'controlled-w5' },
    createSession: async (_id, barriers, nativeState) =>
      createPiDirectModelSession({ config, barriers, nativeState, fetch: fetcher }),
  });
async function ended(runtime: AgentPostgresRuntime, id: string) {
  for (let i = 0; i < 400; i++) {
    const detail = await runtime.getConversation(principal, id);
    if (detail.focus_task?.latest_attempt.ended_at) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Runtime did not reach durable outcome');
}

test('PG command/native/outbox atomic path, restart display and explicit contextual follow-up', async () => {
  await checkAgentDatabase(database.pool);
  await publishExecutionSnapshot(database.pool, { model: 'controlled-w5' });
  let runtime = make();
  await runtime.initialize();
  try {
    const created = await runtime.createConversation(principal, { schema_version: 1 });
    const id = created.conversation.id;
    const request = prompt('记住口令 W5-CONTEXT');
    const [first, replay] = await Promise.all([
      runtime.submitCommand(principal, id, request),
      runtime.submitCommand(principal, id, request),
    ]);
    assert.equal(first.statusCode, 202);
    assert.equal(replay.body.command?.id, first.body.command?.id);
    assert.equal(validateAgentContract('ResponseEnvelope', first.body), true);
    await assert.rejects(
      runtime.submitCommand(principal, id, { ...request, input: { text: 'different intent' } }),
      { code: 'IDEMPOTENCY_KEY_CONFLICT' },
    );
    await assert.rejects(runtime.getSnapshot({ userId: 'other', source: 'platform' }, id), {
      statusCode: 404,
    });
    const finished = await ended(runtime, id);
    assert.equal(finished.focus_task?.status, 'completed');
    const snapshot = await runtime.getSnapshot(principal, id);
    assert.equal(validateAgentContract('SnapshotData', snapshot), true);
    assert.equal(snapshot.input_receipts[0]?.input_state, 'consumed');
    assert.equal(calls, 1);
    const subscription = await runtime.subscribe(principal, id, {
      streamId: snapshot.read_cursor.stream_id,
      afterEventSeq: '0',
      onFrame() {},
    });
    assert.equal(subscription.replay.at(-1)?.event_seq, snapshot.read_cursor.event_seq);
    for (const frame of subscription.replay)
      assert.equal(validateAgentContract('ProductFrame', frame), true);
    subscription.close();
    const {
      rows: [p],
    } = await database.pool.query('SELECT * FROM pi_sessions WHERE conversation_id=$1', [id]);
    assert.equal(p.active_attempt_id, null);
    assert.equal(p.writer_owner_id, null);
    await runtime.close();
    runtime = make();
    await runtime.initialize();
    const restored = await runtime.getSnapshot(principal, id);
    assert.deepEqual(restored, snapshot);
    assert.equal(calls, 1);
    await runtime.getConversation(principal, id);
    assert.equal(calls, 1);
    await runtime.submitCommand(principal, id, prompt('刚才的口令是什么？'));
    const second = await ended(runtime, id);
    assert.equal(second.focus_task?.status, 'completed');
    assert.equal(calls, 2);
    const after = await runtime.getSnapshot(principal, id);
    assert.ok(JSON.stringify(after.results).includes('W5-CONTEXT'));
    const {
      rows: [bound],
    } = await database.pool.query('SELECT id FROM pi_sessions WHERE conversation_id=$1', [id]);
    assert.equal(bound.id, p.id);
  } finally {
    await runtime.close();
    await database.close();
  }
});
