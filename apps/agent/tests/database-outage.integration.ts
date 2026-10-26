import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { validateAgentContract } from '@tyde/shared/agent';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { modelExecutionConfig, publishExecutionSnapshot } from '../src/storage/execution-config.js';
import { NativeStore } from '../src/storage/native-store.js';
import { createPiDirectModelSession } from '../src/pi/index.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated AGENT_TEST_DATABASE_URL *_test database required');
const applicationName = `tyde-agent-outage-${randomUUID()}`;
const database = createAgentDatabase({ connectionString: url, applicationName });
const principal = { userId: `outage-fixture/${randomUUID()}`, source: 'development' as const };

/** Actual PostgreSQL connection termination + actual HTTP stream, using only a controlled endpoint. */
test('真实PG专用连接中断立即取消受控HTTP执行；持久未知保留，重建读取不执行', async () => {
  let httpCalls = 0;
  let httpClosed = false;
  let opened!: () => void;
  let closed!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const close = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const endpoint = createServer((_request, response) => {
    httpCalls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const chunk = (text: string) =>
      `data: ${JSON.stringify({ id: 'controlled-db-outage', object: 'chat.completion.chunk', created: 1, model: 'controlled-db-outage', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`;
    response.write(chunk('controlled pending response'));
    const interval = setInterval(() => response.write(chunk(' pending')), 50);
    response.on('close', () => {
      clearInterval(interval);
      httpClosed = true;
      closed();
    });
    opened();
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address();
  assert.ok(address && typeof address === 'object');
  const config = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    AGENT_MODEL_ID: 'controlled-db-outage',
    AGENT_MODEL_API_KEY: 'isolated-outage-key',
    AGENT_MODEL_TOTAL_TIMEOUT_MS: '30000',
  });
  const executionConfig = modelExecutionConfig(config);
  const make = () =>
    new AgentPostgresRuntime({
      pool: database.pool,
      executionConfig,
      createSession: async (_id, barriers, nativeState) =>
        createPiDirectModelSession({ config, barriers, nativeState }),
    });
  let runtime = make();
  let initialized = false;
  try {
    await publishExecutionSnapshot(database.pool, executionConfig);
    await runtime.initialize();
    initialized = true;
    const created = await runtime.createConversation(principal, {
      schema_version: 1,
      title: 'Isolated database outage fixture',
    });
    const conversationId = created.conversation.id;
    const submission = await runtime.submitCommand(principal, conversationId, {
      schema_version: 1,
      kind: 'start_task',
      request_key: randomUUID(),
      task_kind: 'business_query',
      input: { text: 'Keep the isolated controlled stream open.' },
    });
    assert.equal(submission.statusCode, 202);
    await Promise.race([
      open,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Controlled HTTP did not start')), 10000);
        timer.unref();
      }),
    ]);
    const activeMap = Reflect.get(runtime, 'active') as Map<
      string,
      { controller: AbortController }
    >;
    const active = activeMap.get(conversationId);
    assert.ok(active);
    const guard = Reflect.get(runtime, 'guard') as PoolClient & { processID: number };
    assert.ok(Number.isInteger(guard.processID));
    const before = performance.now();
    const {
      rows: [termination],
    } = await database.pool.query(
      'SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2',
      [guard.processID, applicationName],
    );
    assert.equal(termination.terminated, true, "only this runtime's exact guard PID is eligible");
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('HTTP stream did not cancel after DB loss')),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(httpClosed, true);
    assert.ok(performance.now() - before < 3000);
    assert.equal(httpCalls, 1);
    await assert.rejects(runtime.getSnapshot(principal, conversationId), { statusCode: 503 });
    await runtime.close();
    initialized = false;
    const {
      rows: [facts],
    } = await database.pool.query(
      'SELECT t.status,a.outcome,a.ended_at,a.model_requests_used,a.tool_calls_used,q.input_state,p.id AS pi_id,p.head_revision_id,p.active_attempt_id FROM agent_tasks t JOIN agent_attempts a ON a.task_id=t.id JOIN agent_commands q ON q.id=a.trigger_command_id JOIN pi_sessions p ON p.id=t.pi_session_id WHERE t.conversation_id=$1',
      [conversationId],
    );
    assert.equal(facts.status, 'running');
    assert.equal(facts.outcome, null);
    assert.equal(facts.ended_at, null);
    assert.equal(facts.model_requests_used, 1);
    assert.equal(facts.tool_calls_used, 0);
    assert.equal(facts.input_state, 'consumed');
    assert.ok(facts.active_attempt_id);
    assert.equal(
      (
        await database.pool.query(
          'SELECT count(*)::text AS n FROM agent_results WHERE conversation_id=$1',
          [conversationId],
        )
      ).rows[0].n,
      '0',
    );
    const saved = await new NativeStore(database.pool, () => undefined).load(facts.pi_id);
    assert.equal(saved.revisionId, facts.head_revision_id);
    assert.ok(
      saved.state.entries.some(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      ),
    );
    runtime = make();
    await runtime.initialize();
    initialized = true;
    const snapshot = await runtime.getSnapshot(principal, conversationId);
    assert.ok(validateAgentContract('SnapshotData', snapshot));
    assert.equal(snapshot.focus_task?.status, 'running');
    assert.equal(snapshot.input_receipts[0]?.input_state, 'consumed');
    const subscription = await runtime.subscribe(principal, conversationId, {
      streamId: snapshot.read_cursor.stream_id,
      afterEventSeq: '0',
      onFrame() {},
    });
    subscription.close();
    await runtime.getConversation(principal, conversationId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(httpCalls, 1, 'restart/read/reconnect must never replay the consumed input');
  } finally {
    if (initialized) await runtime.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await database.close();
  }
});
