import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { Pool } from 'pg';
import { capturePiNativeState, restorePiNativeState, type PiNativeState } from '../src/pi/index.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { checkAgentDatabase } from '../src/storage/migrations.js';
import {
  freezeCommit,
  NativeCommitOutcomeUnknownError,
  NativeStore,
  type ExecutionAuthority,
} from '../src/storage/native-store.js';
import { appendEvent, projectInput, projectTask } from '../src/storage/projections.js';
import { nativeSample } from './fixtures/pi-native.js';
import { createAgentDatabaseFixture } from './helpers/agent-database-fixture.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url) throw new Error('AGENT_TEST_DATABASE_URL required; use an isolated Agent database');
if (!new URL(url).pathname.endsWith('_test'))
  throw new Error('Agent integration requires *_test database');
const database = createAgentDatabase({ connectionString: url, maxConnections: 8 });
after(() => database.close());

async function fixture() {
  await checkAgentDatabase(database.pool);
  const ids = await createAgentDatabaseFixture(database.pool);
  const store = new NativeStore(database.pool, () => undefined);
  const loaded = await store.load(ids.pi);
  const authority: ExecutionAuthority = {
    conversationId: ids.conversation,
    taskId: ids.task,
    piSessionId: ids.pi,
    attemptId: ids.attempt,
    ownerId: ids.owner,
    generation: '1',
    expectedHeadRevisionId: loaded.revisionId,
  };
  return { ids, store, authority, state: loaded.state };
}
function appended(state: PiNativeState) {
  const manager = restorePiNativeState(state);
  manager.appendCustomEntry('isolated.store-fixture', { value: [0, null, false] });
  return capturePiNativeState(manager);
}

/** Real server COMMIT succeeds; only its acknowledgement is deliberately lost. */
function loseCommitAcknowledgement(
  pool: Pool,
  trace: string[],
  verificationUnavailable = false,
): Pool {
  let lose = true;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          if (text === 'COMMIT' && lose) {
            lose = false;
            trace.push('server-committed');
            throw new Error('controlled acknowledgement loss');
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
    query: async (text: string, values?: unknown[]) => {
      trace.push('lookup');
      assert.ok(trace.includes('cancelled'), 'cancellation must precede reconnection/verification');
      if (verificationUnavailable) throw new Error('controlled verification unavailable');
      return pool.query(text, values);
    },
  } as unknown as Pool;
}

test('PostgreSQL完整原生往返、原追加顺序、旧leaf/null及多个根', async () => {
  const f = await fixture();
  const sample = capturePiNativeState(nativeSample().manager);
  const state = { ...sample, header: f.state.header };
  const first = freezeCommit(f.authority, state, 'native_roundtrip');
  const r1 = await f.store.commit(first);
  assert.deepEqual((await f.store.load(f.ids.pi)).state, state);
  const nullLeaf = { ...state, leafId: null };
  const r2 = await f.store.commit(
    freezeCommit({ ...f.authority, expectedHeadRevisionId: r1 }, nullLeaf, 'leaf_only'),
  );
  assert.notEqual(r1, r2);
  assert.deepEqual((await f.store.load(f.ids.pi)).state, nullLeaf);
  assert.deepEqual((await f.store.load(f.ids.pi, r1)).state, state);
  const { rows } = await database.pool.query(
    'SELECT raw_entry FROM pi_session_entries WHERE pi_session_id=$1 ORDER BY entry_seq',
    [f.ids.pi],
  );
  assert.deepEqual(
    rows.map((row) => row.raw_entry),
    state.entries,
  );
  assert.equal(state.entries.filter((entry) => entry.parentId === null).length, 2);
  assert.notEqual(state.leafId, state.entries.at(-1)?.id);
});

test('同commit key并发只落一个revision，effect冻结且相同key不同内容拒绝', async () => {
  const f = await fixture();
  const effects = { marker: { value: 'frozen-original' } };
  const request = freezeCommit(f.authority, appended(f.state), 'idempotency', effects);
  effects.marker.value = 'mutated-outside';
  let applications = 0;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.store.commit(request, async (_client, _id, frozen) => {
        assert.ok(Object.isFrozen(frozen.marker));
        assert.equal(frozen.marker.value, 'frozen-original');
        applications += 1;
      }),
    ),
  );
  assert.equal(new Set(results).size, 1);
  assert.equal(applications, 1);
  assert.equal(await f.store.lookup(f.ids.pi, request.key, request.hash), results[0]);
  const changed = {
    ...freezeCommit(f.authority, request.state as PiNativeState, 'idempotency', {
      marker: { value: 'changed-intent' },
    }),
    key: request.key,
  };
  await assert.rejects(f.store.commit(changed), /PI_COMMIT_KEY_CONFLICT/);
  await assert.rejects(
    f.store.commit({ ...request, effects: { marker: { value: 'forged-with-old-hash' } } }),
    /PI_COMMIT_HASH_INVALID/,
  );
  const {
    rows: [counts],
  } = await database.pool.query(
    'SELECT count(*)::text AS revisions FROM pi_session_revisions WHERE pi_session_id=$1',
    [f.ids.pi],
  );
  assert.equal(counts.revisions, '2');
});

test('旧owner、代次、head和跨对象authority拒绝；不能重写原生前缀', async () => {
  const f = await fixture();
  const state = appended(f.state);
  for (const patch of [
    { ownerId: `old/${randomUUID()}` },
    { generation: '2' },
    { expectedHeadRevisionId: randomUUID() },
    { conversationId: randomUUID() },
    { taskId: randomUUID() },
    { attemptId: randomUUID() },
  ])
    await assert.rejects(
      f.store.commit(freezeCommit({ ...f.authority, ...patch }, state, 'stale_writer')),
      /PI_EXECUTION_REVOKED/,
    );
  const r1 = await f.store.commit(freezeCommit(f.authority, state, 'append'));
  const revised = structuredClone(state);
  const entry = revised.entries[0]!;
  assert.equal(entry.type, 'custom');
  if (entry.type === 'custom') entry.data = { changed: true };
  await assert.rejects(
    f.store.commit(
      freezeCommit({ ...f.authority, expectedHeadRevisionId: r1 }, revised, 'rewrite'),
    ),
    /PI_IMMUTABLE_ENTRY_CHANGED/,
  );
  assert.deepEqual((await f.store.load(f.ids.pi)).state, state);
});

test('输入消费、原生revision、head及outbox同事务；失败前后不残留半条消费', async () => {
  const f = await fixture();
  const manager = restorePiNativeState(f.state);
  const inputId = manager.appendMessage({
    role: 'user',
    content: 'storage fixture',
    timestamp: Date.now(),
  });
  const request = freezeCommit(f.authority, capturePiNativeState(manager), 'input', {
    commandId: f.ids.command,
    inputIds: [inputId],
  });
  const apply = async (
    client: import('pg').PoolClient,
    revisionId: string,
    effects: typeof request.effects,
  ) => {
    await client.query(
      "UPDATE agent_commands SET input_state='consumed',input_attempt_id=$2,input_revision_id=$3 WHERE id=$1",
      [effects.commandId, f.ids.attempt, revisionId],
    );
    await client.query('INSERT INTO agent_command_input_entries VALUES($1,$2,$3,$4,1)', [
      effects.commandId,
      f.ids.pi,
      revisionId,
      effects.inputIds[0],
    ]);
    const {
      rows: [command],
    } = await client.query('SELECT * FROM agent_commands WHERE id=$1', [effects.commandId]);
    await appendEvent(client, {
      conversationId: f.ids.conversation,
      eventType: 'input.updated',
      payload: { input_receipt: projectInput(command, f.ids.message) },
      producerKey: `native-input/${effects.commandId}`,
      taskId: f.ids.task,
      attemptId: f.ids.attempt,
      commandId: effects.commandId,
    });
  };
  await assert.rejects(
    f.store.commit(request, async (...args) => {
      await apply(...args);
      throw new Error('controlled pre-commit failure');
    }),
    /controlled pre-commit failure/,
  );
  let {
    rows: [q],
  } = await database.pool.query('SELECT input_state FROM agent_commands WHERE id=$1', [
    f.ids.command,
  ]);
  assert.equal(q.input_state, 'pending');
  assert.equal(
    (await f.store.load(f.ids.pi)).revisionId,
    f.state.header ? f.authority.expectedHeadRevisionId : 'invalid',
  );
  const revisionId = await f.store.commit(request, apply);
  ({
    rows: [q],
  } = await database.pool.query(
    'SELECT input_state,input_revision_id FROM agent_commands WHERE id=$1',
    [f.ids.command],
  ));
  assert.equal(q.input_state, 'consumed');
  assert.equal(q.input_revision_id, revisionId);
  assert.equal(
    await f.store.commit(request, async () => {
      throw new Error('must not consume again');
    }),
    revisionId,
  );
});

test('COMMIT成功但确认丢失：先取消再按原key核实，返回历史成功不授予新执行权', async () => {
  const f = await fixture();
  const trace: string[] = [];
  const store = new NativeStore(loseCommitAcknowledgement(database.pool, trace), () =>
    trace.push('cancelled'),
  );
  const request = freezeCommit(f.authority, appended(f.state), 'lost_ack');
  const revisionId = await store.commit(request);
  assert.deepEqual(trace, ['server-committed', 'cancelled', 'lookup']);
  assert.equal(await f.store.lookup(f.ids.pi, request.key, request.hash), revisionId);
  assert.equal(f.authority.expectedHeadRevisionId, f.ids.revision);
  await assert.rejects(
    f.store.commit(
      freezeCommit(f.authority, request.state as PiNativeState, 'new_action_with_old_authority'),
    ),
    /PI_EXECUTION_REVOKED/,
  );
});

test('无法核实的提交保持原key/hash并阻断，恢复后只查询原结果', async () => {
  const f = await fixture();
  const trace: string[] = [];
  const store = new NativeStore(loseCommitAcknowledgement(database.pool, trace, true), () =>
    trace.push('cancelled'),
  );
  const request = freezeCommit(f.authority, appended(f.state), 'unknown_ack');
  await assert.rejects(store.commit(request), (error: unknown) => {
    assert.ok(error instanceof NativeCommitOutcomeUnknownError);
    assert.equal(error.commitKey, request.key);
    assert.equal(error.commitHash, request.hash);
    return true;
  });
  assert.ok(trace.indexOf('cancelled') < trace.indexOf('lookup'));
  assert.ok(await f.store.lookup(f.ids.pi, request.key, request.hash));
});

test('旧成功在head/owner/代次结束后仍可核实，但旧writer不能再写', async () => {
  const f = await fixture();
  const request = freezeCommit(f.authority, appended(f.state), 'historical_success');
  const revisionId = await f.store.commit(request);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      f.ids.conversation,
    ]);
    await client.query(
      "UPDATE agent_attempts SET ended_at=clock_timestamp(),outcome='failed',error_code='ISOLATED_FIXTURE_END',error_summary='fixture ended' WHERE id=$1",
      [f.ids.attempt],
    );
    await client.query(
      "UPDATE agent_tasks SET status='failed',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
      [f.ids.task],
    );
    await client.query(
      'UPDATE pi_sessions SET active_attempt_id=NULL,writer_owner_id=NULL,execution_generation=2 WHERE id=$1',
      [f.ids.pi],
    );
    await appendEvent(client, {
      conversationId: f.ids.conversation,
      eventType: 'task.updated',
      payload: { task: await projectTask(client, f.ids.task) },
      producerKey: `isolated-ended/${f.ids.attempt}`,
      taskId: f.ids.task,
      attemptId: f.ids.attempt,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  assert.equal(await f.store.commit(request), revisionId);
  await assert.rejects(
    f.store.commit(
      freezeCommit(
        { ...f.authority, expectedHeadRevisionId: revisionId },
        request.state as PiNativeState,
        'stale_after_end',
      ),
    ),
    /PI_EXECUTION_REVOKED/,
  );
});
