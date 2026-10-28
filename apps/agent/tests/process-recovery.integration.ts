import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAgentDatabase } from '../src/storage/database.js';
import { digest } from '../src/storage/projections.js';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { recoverInterruptedAttempt } from '../src/execution/recovery.js';
import {
  localExecutionOwner,
  assertLocalProcessExited,
  parseLocalProcessOwner,
} from '../src/execution/process-identity.js';
import { PersistentBudget, type ExecutionAuthority } from '../src/execution/persistent-budget.js';

const connectionString = process.env.AGENT_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error('Agent process integration requires AGENT_TEST_DATABASE_URL');
if (!/(?:^|_)test(?:_|$)/i.test(new URL(connectionString).pathname.slice(1)))
  throw new Error('Agent process integration requires an explicitly named test database');
const database = createAgentDatabase({
  connectionString,
  applicationName: 'tyde-agent-process-recovery-test',
});
test.after(async () => {
  await database.close();
});

interface WorkerReady {
  stage: 'ready';
  authority: ExecutionAuthority;
  outputId: string;
  fixture: {
    conversation: string;
    pi: string;
    task: string;
    attempt: string;
    command: string;
    user: string;
  };
}
async function worker(stage: 'before_input' | 'after_input') {
  const child = fork(
    fileURLToPath(new URL('./helpers/process-worker.ts', import.meta.url)),
    [stage],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr = (stderr + String(data)).slice(-4096);
  });
  const ready = await new Promise<WorkerReady>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Isolated crash worker did not become ready'));
    }, 10000);
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message as WorkerReady);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Isolated worker exited before readiness: ${code}/${signal}: ${stderr}`));
    });
  });
  assert.equal(ready.stage, 'ready');
  return { child, ready };
}

async function facts(ready: WorkerReady) {
  const { fixture: f } = ready;
  const {
    rows: [command],
  } = await database.pool.query('SELECT * FROM agent_commands WHERE id=$1', [f.command]);
  const {
    rows: [session],
  } = await database.pool.query('SELECT * FROM pi_sessions WHERE id=$1', [f.pi]);
  const { rows: entries } = await database.pool.query(
    'SELECT raw_entry FROM pi_session_entries WHERE pi_session_id=$1 ORDER BY entry_seq',
    [f.pi],
  );
  const { rows: links } = await database.pool.query(
    'SELECT * FROM agent_command_input_entries WHERE command_id=$1 ORDER BY link_order',
    [f.command],
  );
  const {
    rows: [output],
  } = await database.pool.query('SELECT * FROM agent_messages WHERE id=$1', [ready.outputId]);
  const {
    rows: [attempt],
  } = await database.pool.query('SELECT * FROM agent_attempts WHERE id=$1', [f.attempt]);
  return {
    command,
    session,
    attempt,
    entriesHash: digest(entries),
    entries: entries.length,
    links: links.length,
    output,
  };
}

test('单机隔离证明拒绝仍存活进程、旧格式及远主机，不把advisory解锁当作失效', () => {
  assert(parseLocalProcessOwner(localExecutionOwner()));
  assert.throws(
    () => assertLocalProcessExited(localExecutionOwner()),
    /AGENT_PROCESS_STILL_EXISTS/,
  );
  assert.throws(
    () => assertLocalProcessExited('fixture-owner'),
    /AGENT_PROCESS_ISOLATION_NOT_LOCAL/,
  );
  const foreign = localExecutionOwner().replace(/^local:[^:]+:/, 'local:0000000000000000:');
  assert.throws(() => assertLocalProcessExited(foreign), /AGENT_PROCESS_ISOLATION_NOT_LOCAL/);
});

for (const inputStage of ['before_input', 'after_input'] as const)
  test(`隔离原生worker SIGKILL：${inputStage}，查询/SSE不执行，内部恢复保留原输入与head`, async () => {
    const { child, ready } = await worker(inputStage);
    let killed = false;
    const runtime = new AgentPostgresRuntime({
      pool: database.pool,
      executionConfig: { isolated: 'process-recovery-read-only' },
      createSession: async () => {
        executions++;
        throw new Error('Reads must never create a Pi session');
      },
    });
    let executions = 0;
    let subscription: Awaited<ReturnType<AgentPostgresRuntime['subscribe']>> | undefined;
    try {
      const before = await facts(ready);
      await assert.rejects(
        recoverInterruptedAttempt(database.pool, ready.authority),
        /AGENT_PROCESS_STILL_EXISTS/,
      );
      const exiting = once(child, 'exit');
      assert.equal(child.kill('SIGKILL'), true);
      killed = true;
      const [code, signal] = await exiting;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      assertLocalProcessExited(ready.authority.ownerId);
      const principal = { userId: ready.fixture.user, source: 'development' as const };
      const baseline = await runtime.getSnapshot(principal, ready.fixture.conversation);
      assert.equal(baseline.focus_task?.status, 'running');
      subscription = await runtime.subscribe(principal, ready.fixture.conversation, {
        streamId: baseline.read_cursor.stream_id,
        afterEventSeq: baseline.read_cursor.event_seq,
        onFrame: () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await runtime.getSnapshot(principal, ready.fixture.conversation);
      await runtime.getCommand(principal, ready.fixture.conversation, before.command.request_key);
      assert.equal(executions, 0);
      const afterReads = await facts(ready);
      assert.equal(afterReads.entriesHash, before.entriesHash);
      assert.equal(afterReads.command.input_state, before.command.input_state);
      assert.equal(afterReads.session.active_attempt_id, ready.fixture.attempt);
      await assert.rejects(
        recoverInterruptedAttempt(database.pool, {
          ...ready.authority,
          ownerId: ready.authority.ownerId.slice(0, -36) + randomUUID(),
        }),
        /AGENT_RECOVERY_AUTHORITY_MISMATCH/,
      );
      const result = await recoverInterruptedAttempt(database.pool, ready.authority);
      assert.equal(result.task.status, 'interrupted');
      assert.equal(result.task.latest_attempt.outcome, 'interrupted');
      assert.equal(result.task.latest_attempt.error?.code, 'EXECUTION_PROCESS_CONFIRMED_EXITED');
      assert.equal(result.executionGranted, false);
      assert.equal(result.replayed, false);
      const recovered = await facts(ready);
      assert.equal(recovered.entriesHash, before.entriesHash);
      assert.equal(
        recovered.command.input_state,
        inputStage === 'after_input' ? 'consumed' : 'pending',
      );
      assert.equal(recovered.command.input_revision_id, before.command.input_revision_id);
      assert.equal(recovered.links, before.links);
      assert.equal(recovered.links, inputStage === 'after_input' ? 1 : 0);
      assert.equal(recovered.session.head_revision_id, before.session.head_revision_id);
      assert.equal(recovered.session.active_attempt_id, null);
      assert.equal(recovered.session.writer_owner_id, null);
      assert.equal(recovered.session.execution_generation, '2');
      assert.equal(recovered.attempt.model_requests_used, before.attempt.model_requests_used);
      assert.equal(recovered.attempt.model_requests_used, inputStage === 'after_input' ? 1 : 0);
      assert.equal(
        recovered.attempt.execution_deadline_at.toISOString(),
        before.attempt.execution_deadline_at.toISOString(),
      );
      assert.equal(recovered.attempt.stop_requested_at, null);
      assert.equal(recovered.output.status, 'interrupted');
      assert.equal(recovered.output.row_version, '1');
      assert.equal(
        (await recoverInterruptedAttempt(database.pool, ready.authority)).replayed,
        true,
      );
      const blocked = await runtime.submitCommand(principal, ready.fixture.conversation, {
        schema_version: 1,
        request_key: randomUUID(),
        kind: 'start_task',
        task_kind: 'business_query',
        input: { text: 'Do not bypass the interrupted goal' },
      });
      assert.equal(blocked.statusCode, 409);
      assert.equal(blocked.body.command?.outcome_code, 'UNFINISHED_TASK_EXISTS');
      const {
        rows: [total],
      } = await database.pool.query(
        'SELECT count(*)::text AS count FROM agent_tasks WHERE conversation_id=$1',
        [ready.fixture.conversation],
      );
      assert.equal(total.count, '1');
      await assert.rejects(
        new PersistentBudget(database.pool).reserve(ready.authority, {
          kind: 'model',
          modelRequestId: randomUUID(),
        }),
        /ATTEMPT_EXECUTION_REVOKED/,
      );
      assert.equal(executions, 0);
    } finally {
      if (!killed) {
        const exiting = once(child, 'exit');
        child.kill('SIGKILL');
        await exiting;
      }
      subscription?.close();
      await runtime.close();
    }
  });
