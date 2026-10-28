import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAgentDatabase } from '../src/storage/database.js';
import { appendEvent, projectTask } from '../src/storage/projections.js';
import { PersistentBudget, PersistentBudgetError } from '../src/execution/persistent-budget.js';
import { createAgentDatabaseFixture } from './helpers/agent-database-fixture.js';

/** Explicit slow integration entry point; never imported by the regular unit-test glob. */
const connectionString = process.env.AGENT_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error('AGENT_TEST_DATABASE_URL is required; business DATABASE_URL is never read');
const target = new URL(connectionString);
if (!/(?:^|_)test(?:_|$)/i.test(target.pathname.slice(1)))
  throw new Error('The real-time integration requires an explicitly named Agent test database');

const database = createAgentDatabase({
  connectionString,
  applicationName: 'tyde-agent-budget-real-clock',
});
const controller = new AbortController();
const pending = new Set<ReturnType<typeof setTimeout>>();
let endpointStarted = 0;
let endpointCompleted = 0;
let endpointCancelled = 0;
const endpoint = createServer((_request, response) => {
  endpointStarted++;
  let completed = false;
  const timer = setTimeout(() => {
    pending.delete(timer);
    completed = true;
    endpointCompleted++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"controlled":true}');
  }, 55_000);
  pending.add(timer);
  response.on('close', () => {
    if (!completed) {
      endpointCancelled++;
      clearTimeout(timer);
      pending.delete(timer);
    }
  });
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address();
  assert(address && typeof address === 'object');
  const fixture = await createAgentDatabaseFixture(database.pool);
  const authority = {
    conversationId: fixture.conversation,
    taskId: fixture.task,
    piSessionId: fixture.pi,
    attemptId: fixture.attempt,
    ownerId: fixture.owner,
    generation: '1',
    expectedHeadRevisionId: fixture.revision,
  };
  const budget = new PersistentBudget(database.pool, {
    onLimit: (_authority, error) => controller.abort(error),
    onDatabaseFailure: (_authority, error) => controller.abort(error),
  });
  const startedAt = fixture.startedAt.getTime();
  const deadline = startedAt + 600_000;
  const expire = () => {
    void budget.check(authority).then(
      () => {
        timer = setTimeout(expire, 5);
      },
      (error) => {
        if (
          !(error instanceof PersistentBudgetError) ||
          error.code !== 'ATTEMPT_DURATION_LIMIT_EXCEEDED'
        )
          controller.abort(error);
      },
    );
  };
  timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  process.stdout.write(
    JSON.stringify({
      stage: 'started',
      evidence: '真实时钟＋受控端点',
      attempt_id: fixture.attempt,
      started_at: fixture.startedAt.toISOString(),
      deadline_at: new Date(deadline).toISOString(),
      duration_ms: 600000,
    }) + '\n',
  );
  let observedError: unknown;
  try {
    while (!controller.signal.aborted) {
      const reservation = await budget.reserve(authority, {
        kind: 'model',
        modelRequestId: randomUUID(),
      });
      assert(reservation.permit);
      await budget.checkDispatch(authority, reservation.permit);
      const response = await fetch(`http://127.0.0.1:${address.port}/controlled-inference`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { controlled: true });
    }
  } catch (error) {
    observedError = error;
  }
  assert.equal(controller.signal.aborted, true);
  assert(controller.signal.reason instanceof PersistentBudgetError);
  assert.equal(controller.signal.reason.code, 'ATTEMPT_DURATION_LIMIT_EXCEEDED');
  assert(observedError);
  const cancelledAt = Date.now();
  assert(cancelledAt - startedAt >= 600_000);
  assert(
    cancelledAt - startedAt < 610_000,
    'cancellation must converge within the explicit 10s controlled-test window',
  );
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      fixture.conversation,
    ]);
    await client.query('SELECT id FROM agent_tasks WHERE id=$1 FOR UPDATE', [fixture.task]);
    await client.query('SELECT id FROM pi_sessions WHERE id=$1 FOR UPDATE', [fixture.pi]);
    await client.query(
      "UPDATE agent_attempts SET ended_at=clock_timestamp(),outcome='failed',error_code='ATTEMPT_DURATION_LIMIT_EXCEEDED',error_summary='Controlled real-clock deadline reached' WHERE id=$1",
      [fixture.attempt],
    );
    await client.query(
      "UPDATE agent_tasks SET status='failed',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
      [fixture.task],
    );
    await client.query(
      'UPDATE pi_sessions SET active_attempt_id=NULL,writer_owner_id=NULL,execution_generation=execution_generation+1 WHERE id=$1',
      [fixture.pi],
    );
    await appendEvent(client, {
      conversationId: fixture.conversation,
      eventType: 'task.updated',
      payload: { task: await projectTask(client, fixture.task) },
      producerKey: `real-clock:failed:${fixture.attempt}`,
      taskId: fixture.task,
      attemptId: fixture.attempt,
    });
    await client.query('COMMIT');
    const {
      rows: [attempt],
    } = await client.query('SELECT * FROM agent_attempts WHERE id=$1', [fixture.attempt]);
    assert.equal(attempt.limit_exceeded_kind, 'duration');
    assert.equal(attempt.error_code, 'ATTEMPT_DURATION_LIMIT_EXCEEDED');
    assert.equal(attempt.outcome, 'failed');
    assert.equal(attempt.stop_requested_at, null);
    assert.equal(attempt.model_requests_used, endpointStarted);
    assert.equal(attempt.model_requests_used, 11);
    assert.equal(attempt.tool_calls_used, 0);
    const {
      rows: [session],
    } = await client.query('SELECT * FROM pi_sessions WHERE id=$1', [fixture.pi]);
    assert.equal(session.active_attempt_id, null);
    assert.equal(session.writer_owner_id, null);
    const afterFinish = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(endpointCompleted, 10);
    assert.equal(endpointCancelled, 1);
    process.stdout.write(
      JSON.stringify({
        stage: 'passed',
        evidence: '真实时钟＋受控端点',
        scope:
          'PostgreSQL budget gate and actual local HTTP cancellation; not supplier or Pi loop acceptance',
        attempt_id: fixture.attempt,
        elapsed_ms: cancelledAt - startedAt,
        cleanup_ms: afterFinish - cancelledAt,
        requests_started: endpointStarted,
        requests_completed: endpointCompleted,
        requests_cancelled: endpointCancelled,
        model_authorizations: attempt.model_requests_used,
        tool_authorizations: attempt.tool_calls_used,
        limit_kind: attempt.limit_exceeded_kind,
        outcome: attempt.outcome,
        original_deadline_retained: new Date(attempt.execution_deadline_at).getTime() === deadline,
      }) + '\n',
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} finally {
  if (timer) clearTimeout(timer);
  controller.abort();
  for (const pendingTimer of pending) clearTimeout(pendingTimer);
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  await database.close();
}
