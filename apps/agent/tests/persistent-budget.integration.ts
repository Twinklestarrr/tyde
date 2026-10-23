import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAgentDatabase } from '../src/storage/database.js';
import { appendEvent, projectTask } from '../src/storage/projections.js';
import { NativeStore, freezeCommit } from '../src/storage/native-store.js';
import {
  PersistentBudget,
  PersistentBudgetError,
  authorizationPruneCeiling,
  type ExecutionAuthority,
} from '../src/execution/persistent-budget.js';
import { createAgentDatabaseFixture } from './helpers/agent-database-fixture.js';

const connectionString = process.env.AGENT_TEST_DATABASE_URL;
if (!connectionString) throw new Error('Agent integration requires AGENT_TEST_DATABASE_URL');
if (!/(?:^|_)test(?:_|$)/i.test(new URL(connectionString).pathname.slice(1)))
  throw new Error('Agent integration requires an explicitly named test database');
const database = createAgentDatabase({
  connectionString,
  maxConnections: 8,
  applicationName: 'tyde-agent-budget-integration',
});
test.after(async () => {
  await database.close();
});

async function fixture() {
  const f = await createAgentDatabaseFixture(database.pool);
  const authority: ExecutionAuthority = {
    conversationId: f.conversation,
    taskId: f.task,
    piSessionId: f.pi,
    attemptId: f.attempt,
    ownerId: f.owner,
    generation: '1',
    expectedHeadRevisionId: f.revision,
  };
  return { ...f, authority };
}
const model = () => ({ kind: 'model', modelRequestId: randomUUID() }) as const;
const hasCode = (code: string) => (error: unknown) =>
  error instanceof PersistentBudgetError && error.code === code;
async function count(attemptId: string) {
  const {
    rows: [a],
  } = await database.pool.query('SELECT * FROM agent_attempts WHERE id=$1', [attemptId]);
  return a;
}

/** A real database commit can succeed while the client loses its confirmation. */
function faultPool(sqlPrefix: string, mode: 'before' | 'after', onIntercept?: () => void): Pool {
  let armed = true;
  return {
    connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property);
          return async (sql: string, values?: unknown[]) => {
            const intercept = armed && sql.startsWith(sqlPrefix);
            if (intercept) {
              armed = false;
              onIntercept?.();
            }
            if (intercept && mode === 'before') throw new Error('controlled-database-disconnect');
            const result = await target.query(sql, values);
            if (intercept && mode === 'after')
              throw new Error('controlled-commit-acknowledgement-lost');
            return result;
          };
        },
      });
    },
  } as Pool;
}

async function stopInDatabase(authority: ExecutionAuthority) {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      authority.conversationId,
    ]);
    await client.query('SELECT id FROM agent_tasks WHERE id=$1 FOR UPDATE', [authority.taskId]);
    await client.query('SELECT id FROM pi_sessions WHERE id=$1 FOR UPDATE', [
      authority.piSessionId,
    ]);
    await client.query(
      'UPDATE agent_attempts SET stop_requested_at=clock_timestamp() WHERE id=$1',
      [authority.attemptId],
    );
    await client.query(
      "UPDATE agent_tasks SET status='stopping',row_version=row_version+1 WHERE id=$1",
      [authority.taskId],
    );
    await appendEvent(client, {
      conversationId: authority.conversationId,
      eventType: 'task.updated',
      payload: { task: await projectTask(client, authority.taskId) },
      producerKey: `controlled-stop:${authority.attemptId}`,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('PG持久授权：同身份20并发仅1次计数和1个permit，重复dispatch不发送', async () => {
  const f = await fixture();
  const budget = new PersistentBudget(database.pool);
  const identity = model();
  const receipts = await Promise.all(
    Array.from({ length: 20 }, () => budget.reserve(f.authority, identity)),
  );
  assert.equal(receipts.filter((r) => r.permit).length, 1);
  assert.equal(new Set(receipts.map((r) => r.event.event_id)).size, 1);
  assert.equal((await count(f.attempt)).model_requests_used, 1);
  const permit = receipts.find((r) => r.permit)!.permit!;
  const dispatches = await Promise.allSettled([
    budget.checkDispatch(f.authority, permit),
    budget.checkDispatch(f.authority, permit),
  ]);
  assert.equal(dispatches.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(dispatches.filter((r) => r.status === 'rejected').length, 1);
  const restarted = new PersistentBudget(database.pool);
  assert.equal((await restarted.reserve(f.authority, identity)).permit, null);
  assert((await restarted.confirm(f.authority, identity))?.event_id);
  assert.equal((await count(f.attempt)).model_requests_used, 1);
});

test('PG持久授权：11/12合法并能正常交付核查，13不递增；并发不同身份不超领', async () => {
  const f = await fixture();
  const budget = new PersistentBudget(database.pool);
  for (let index = 1; index <= 12; index++) {
    const r = await budget.reserve(f.authority, model());
    assert(r.permit);
    await budget.checkDispatch(f.authority, r.permit);
    if (index === 11 || index === 12)
      assert.equal((await count(f.attempt)).model_requests_used, index);
  }
  assert.equal((await budget.check(f.authority)).model_requests_used, 12);
  await assert.rejects(
    budget.reserve(f.authority, model()),
    hasCode('ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'),
  );
  assert.equal((await count(f.attempt)).model_requests_used, 12);
  assert.equal((await count(f.attempt)).limit_exceeded_kind, 'model_requests');
  assert.equal((await count(f.attempt)).stop_requested_at, null);
  const concurrent = await fixture();
  const gate = new PersistentBudget(database.pool);
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => gate.reserve(concurrent.authority, model())),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 12);
  assert.equal((await count(concurrent.attempt)).model_requests_used, 12);
});

test('PG持久授权：只读工具按真实已提交assistant来源计数9/10/11，不创建Operation', async () => {
  const f = await fixture();
  const native = new NativeStore(database.pool, () => {});
  const loaded = await native.load(f.pi);
  const manager = SessionManager.inMemory('/isolated/budget-tool-fixture');
  const sourceNativeEntryId = manager.appendMessage({
    role: 'assistant',
    api: 'openai-completions',
    provider: 'openai-compatible',
    model: 'controlled',
    stopReason: 'toolUse',
    timestamp: Date.now(),
    content: Array.from({ length: 11 }, (_, index) => ({
      type: 'toolCall',
      id: `isolated-call-${index + 1}`,
      name: 'readonly_fixture',
      arguments: {},
    })),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const state = { ...loaded.state, entries: manager.getEntries(), leafId: sourceNativeEntryId };
  const revisionId = await native.commit(freezeCommit(f.authority, state, 'isolated-tool-fixture'));
  f.authority.expectedHeadRevisionId = revisionId;
  const budget = new PersistentBudget(database.pool);
  await assert.rejects(
    budget.reserve(f.authority, { kind: 'tool', sourceNativeEntryId, toolCallId: 'absent-call' }),
    hasCode('ATTEMPT_HEAD_CONFLICT'),
  );
  for (let index = 1; index <= 10; index++) {
    const receipt = await budget.reserve(f.authority, {
      kind: 'tool',
      sourceNativeEntryId,
      toolCallId: `isolated-call-${index}`,
    });
    assert(receipt.permit);
    await budget.checkDispatch(f.authority, receipt.permit);
    if (index === 9 || index === 10) assert.equal((await count(f.attempt)).tool_calls_used, index);
  }
  assert.equal((await budget.check(f.authority)).tool_calls_used, 10);
  await assert.rejects(
    budget.reserve(f.authority, {
      kind: 'tool',
      sourceNativeEntryId,
      toolCallId: 'isolated-call-11',
    }),
    hasCode('ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED'),
  );
  assert.equal((await count(f.attempt)).tool_calls_used, 10);
  const {
    rows: [operations],
  } = await database.pool.query(
    'SELECT count(*)::text AS count FROM agent_operations WHERE task_id=$1',
    [f.task],
  );
  assert.equal(operations.count, '0');
});

test('PG持久授权：旧owner/代次/head在预占与最终发送前均拒绝，停止不退预占', async () => {
  const f = await fixture();
  const budget = new PersistentBudget(database.pool);
  await assert.rejects(
    budget.reserve({ ...f.authority, ownerId: 'old-owner' }, model()),
    hasCode('ATTEMPT_EXECUTION_REVOKED'),
  );
  await assert.rejects(
    budget.reserve({ ...f.authority, generation: '0' }, model()),
    hasCode('ATTEMPT_EXECUTION_REVOKED'),
  );
  await assert.rejects(
    budget.reserve({ ...f.authority, expectedHeadRevisionId: randomUUID() }, model()),
    hasCode('ATTEMPT_HEAD_CONFLICT'),
  );
  assert.equal((await count(f.attempt)).model_requests_used, 0);
  const receipt = await budget.reserve(f.authority, model());
  assert(receipt.permit);
  await stopInDatabase(f.authority);
  await assert.rejects(
    budget.checkDispatch(f.authority, receipt.permit),
    hasCode('ATTEMPT_STOPPED'),
  );
  await assert.rejects(
    budget.checkDispatch(f.authority, receipt.permit),
    hasCode('ATTEMPT_AUTHORIZATION_ALREADY_USED'),
  );
  assert.equal((await count(f.attempt)).model_requests_used, 1);
  assert.equal((await count(f.attempt)).limit_exceeded_kind, null);
});

test('PG持久授权：COMMIT成功但确认丢失先取消，原key核实不再次放行或增加计数', async () => {
  const f = await fixture();
  const sequence: string[] = [];
  const budget = new PersistentBudget(
    faultPool('COMMIT', 'after', () => sequence.push('commit')),
    {
      onDatabaseFailure: () => sequence.push('cancel'),
    },
  );
  const identity = model();
  await assert.rejects(
    budget.reserve(f.authority, identity),
    hasCode('ATTEMPT_AUTHORIZATION_CONFIRMATION_LOST'),
  );
  assert.deepEqual(sequence, ['commit', 'cancel']);
  assert.equal((await count(f.attempt)).model_requests_used, 1);
  assert(await budget.confirm(f.authority, identity));
  await assert.rejects(
    budget.reserve(f.authority, model()),
    hasCode('ATTEMPT_DATABASE_UNAVAILABLE'),
  );
  const newProcess = new PersistentBudget(database.pool);
  assert.equal((await newProcess.reserve(f.authority, identity)).permit, null);
  assert.equal((await count(f.attempt)).model_requests_used, 1);
});

test('PG持久授权：COMMIT未知及DB保存失败均fail closed，不发送、不换key重占', async () => {
  const uncertain = await fixture();
  let cancelled = 0;
  const gate = new PersistentBudget(faultPool('COMMIT', 'before'), {
    onDatabaseFailure: () => cancelled++,
  });
  const identity = model();
  await assert.rejects(
    gate.reserve(uncertain.authority, identity),
    hasCode('ATTEMPT_AUTHORIZATION_COMMIT_UNKNOWN'),
  );
  assert.equal(cancelled, 1);
  assert.equal((await count(uncertain.attempt)).model_requests_used, 0);
  assert.equal(await gate.confirm(uncertain.authority, identity), null);
  await assert.rejects(
    gate.reserve(uncertain.authority, identity),
    hasCode('ATTEMPT_DATABASE_UNAVAILABLE'),
  );
  const failed = await fixture();
  const fail = new PersistentBudget(faultPool('UPDATE agent_attempts', 'before'), {
    onDatabaseFailure: () => cancelled++,
  });
  await assert.rejects(
    fail.reserve(failed.authority, model()),
    hasCode('ATTEMPT_DATABASE_UNAVAILABLE'),
  );
  assert.equal(cancelled, 2);
  assert.equal((await count(failed.attempt)).model_requests_used, 0);
});

test('PG持久授权：活动Attempt的授权事件保留，confirmed状态也不能裁剪', async () => {
  const f = await fixture();
  const budget = new PersistentBudget(database.pool);
  const receipt = await budget.reserve(f.authority, model());
  const client: PoolClient = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      f.conversation,
    ]);
    const ceiling = await authorizationPruneCeiling(
      client,
      f.conversation,
      receipt.event.event_seq,
    );
    assert.equal(ceiling, (BigInt(receipt.event.event_seq) - 1n).toString());
    await assert.rejects(
      client.query('DELETE FROM agent_outbox_events WHERE id=$1', [receipt.event.event_id]),
      (error) =>
        error instanceof Error &&
        'constraint' in error &&
        error.constraint === 'guard_agent_budget_retention',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal((await count(f.attempt)).model_requests_used, 1);
});

test('PG持久授权：started/deadline复读不重置，到期锁存duration且重复核对不改首因', async () => {
  const f = await createAgentDatabaseFixture(database.pool, {
    startedAt: new Date(Date.now() - 600_001),
  });
  const authority: ExecutionAuthority = {
    conversationId: f.conversation,
    taskId: f.task,
    piSessionId: f.pi,
    attemptId: f.attempt,
    ownerId: f.owner,
    generation: '1',
    expectedHeadRevisionId: f.revision,
  };
  const gate = new PersistentBudget(database.pool);
  const original = await count(f.attempt);
  const started = await gate.start(authority);
  assert.equal(started.execution_deadline_at, original.execution_deadline_at.toISOString());
  await assert.rejects(
    gate.reserve(authority, model()),
    hasCode('ATTEMPT_DURATION_LIMIT_EXCEEDED'),
  );
  const limited = await count(f.attempt);
  assert.equal(limited.limit_exceeded_kind, 'duration');
  assert.equal(limited.model_requests_used, 0);
  assert.equal(limited.stop_requested_at, null);
  await assert.rejects(gate.check(authority), hasCode('ATTEMPT_DURATION_LIMIT_EXCEEDED'));
  const checked = await count(f.attempt);
  assert.equal(checked.limit_exceeded_at.toISOString(), limited.limit_exceeded_at.toISOString());
  assert.equal(
    checked.execution_deadline_at.toISOString(),
    original.execution_deadline_at.toISOString(),
  );
});
