import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { PoolClient } from 'pg';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { NativeStore, freezeCommit, type ExecutionAuthority } from '../src/storage/native-store.js';
import { appendEvent, projectMessage } from '../src/storage/projections.js';
import { capturePiNativeState, restorePiNativeState } from '../src/pi/index.js';
import { createAgentDatabaseFixture } from './helpers/agent-database-fixture.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('An isolated AGENT_TEST_DATABASE_URL *_test database is required');
const database = createAgentDatabase({ connectionString: url });
after(() => database.close());
const principal = { userId: `stream-review/${randomUUID()}`, source: 'development' as const };
const makeReadRuntime = () =>
  new AgentPostgresRuntime({
    pool: database.pool,
    executionConfig: {},
    createSession: async () => {
      throw new Error('Read/internal terminal probes never start Pi');
    },
  });

test('live换流向订阅失败通道报告STREAM_CHANGED，读取和重连不执行', async () => {
  const runtime = makeReadRuntime();
  let error: unknown;
  const frames: unknown[] = [];
  const created = await runtime.createConversation(principal, { schema_version: 1 });
  const subscription = await runtime.subscribe(principal, created.conversation.id, {
    streamId: created.read_cursor.stream_id,
    afterEventSeq: '0',
    onFrame: (frame) => frames.push(frame),
    onError: (cause) => {
      error = cause;
    },
  });
  try {
    const stream = randomUUID();
    await database.pool.query('UPDATE agent_conversations SET event_stream_id=$2 WHERE id=$1', [
      created.conversation.id,
      stream,
    ]);
    for (let i = 0; i < 30 && !error; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'STREAM_CHANGED');
    assert.equal(frames.length, 0);
    const snapshot = await runtime.getSnapshot(principal, created.conversation.id);
    assert.equal(snapshot.read_cursor.stream_id, stream);
    const refreshed = await runtime.subscribe(principal, created.conversation.id, {
      streamId: stream,
      afterEventSeq: '0',
      onFrame() {},
    });
    assert.deepEqual(refreshed.replay, []);
    refreshed.close();
  } finally {
    subscription.close();
    await runtime.close();
  }
});

test('完成裁决读取后跨deadline：Result拒绝转为同事务failed，完成槽/owner/outbox一致', async () => {
  const f = await createAgentDatabaseFixture(database.pool, {
    startedAt: new Date(Date.now() - 599_000),
  });
  const runtime = makeReadRuntime();
  let faults = 0;
  const store = new NativeStore(database.pool, () => {
    faults++;
  });
  const loaded = await store.load(f.pi);
  const authority: ExecutionAuthority = {
    conversationId: f.conversation,
    taskId: f.task,
    piSessionId: f.pi,
    attemptId: f.attempt,
    ownerId: f.owner,
    generation: '1',
    expectedHeadRevisionId: loaded.revisionId,
  };
  const outputId = randomUUID();
  const setup = await database.pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('UPDATE agent_conversations SET last_message_seq=2 WHERE id=$1', [
      f.conversation,
    ]);
    const {
      rows: [message],
    } = await setup.query(
      `INSERT INTO agent_messages(id,conversation_id,task_id,attempt_id,message_seq,message_type,status,content_schema_version,content,row_version,producer_key,created_at,updated_at) VALUES($1,$2,$3,$4,2,'assistant_output','in_progress',1,$5,1,$6,clock_timestamp(),clock_timestamp()) RETURNING *`,
      [
        outputId,
        f.conversation,
        f.task,
        f.attempt,
        { blocks: [], context: null },
        `review-output/${f.attempt}`,
      ],
    );
    await appendEvent(setup, {
      conversationId: f.conversation,
      eventType: 'message.created',
      payload: { message: projectMessage(message), input_receipt: null },
      producerKey: `review-output-created/${f.attempt}`,
      taskId: f.task,
      attemptId: f.attempt,
      messageId: outputId,
    });
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }
  const manager = restorePiNativeState(loaded.state);
  manager.appendCustomEntry('isolated.finish-boundary', { fixture: true });
  const finish = { status: 'completed', text: 'controlled result crossing deadline' };
  const request = freezeCommit(authority, capturePiNativeState(manager), 'finish_boundary', finish);
  const active = {
    authority,
    outputId,
    controller: new AbortController(),
    text: finish.text,
    commandId: f.command,
    deadline: f.startedAt.getTime() + 600000,
    stopping: false,
  };
  const end = Reflect.get(runtime, 'end').bind(runtime) as (
    client: PoolClient,
    active: unknown,
    revisionId: string,
    result: typeof finish,
  ) => Promise<void>;
  let delayed = false;
  await store.commit(request, async (client, revisionId, effects) => {
    const delayedClient = {
      query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (!delayed && text.startsWith('SELECT *,clock_timestamp() AS now FROM agent_attempts')) {
          delayed = true;
          const row = result.rows[0];
          assert.ok(
            new Date(row.now).getTime() < new Date(row.execution_deadline_at).getTime(),
            'fixture must enter decision before deadline',
          );
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(1, new Date(row.execution_deadline_at).getTime() - Date.now() + 40),
            ),
          );
        }
        return result;
      },
    } as unknown as PoolClient;
    await end(delayedClient, active, revisionId, effects);
  });
  assert.ok(delayed);
  assert.equal(faults, 0);
  const {
    rows: [task],
  } = await database.pool.query(
    'SELECT t.status,a.outcome,a.ended_at,a.limit_exceeded_kind,a.error_code,p.active_attempt_id,p.writer_owner_id,m.status AS message_status FROM agent_tasks t JOIN agent_attempts a ON a.task_id=t.id JOIN pi_sessions p ON p.id=t.pi_session_id JOIN agent_messages m ON m.attempt_id=a.id WHERE t.id=$1',
    [f.task],
  );
  assert.equal(task.status, 'failed');
  assert.equal(task.outcome, 'failed');
  assert.ok(task.ended_at);
  assert.equal(task.limit_exceeded_kind, 'duration');
  assert.equal(task.error_code, 'ATTEMPT_DURATION_LIMIT_EXCEEDED');
  assert.equal(task.active_attempt_id, null);
  assert.equal(task.writer_owner_id, null);
  assert.equal(task.message_status, 'interrupted');
  assert.equal(
    (
      await database.pool.query('SELECT count(*)::text AS n FROM agent_results WHERE task_id=$1', [
        f.task,
      ])
    ).rows[0].n,
    '0',
  );
  await runtime.close();
});
