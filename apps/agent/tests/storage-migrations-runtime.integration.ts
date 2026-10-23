import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TaskView } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';
import { createPiDirectModelSession } from '../src/pi/index.js';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { publishExecutionSnapshot } from '../src/storage/execution-config.js';
import {
  checkAgentDatabase,
  loadAgentMigration,
  loadAgentMigrations,
} from '../src/storage/migrations.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
test(
  'non-owner runtime completes and stops through real HTTP with controlled model transport',
  { skip: !url },
  async () => {
    assert.ok(url);
    const admin = createAgentDatabase({ connectionString: url });
    const role = `agent_runtime_probe_${randomUUID().replaceAll('-', '')}`;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let closeRuntime: (() => Promise<void>) | undefined;
    let database: ReturnType<typeof createAgentDatabase> | undefined;
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    let calls = 0;
    let entered!: () => void;
    const modelEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const credential = `isolated-http-${randomUUID()}`;
    const executionConfig = { model: `controlled-permissions-${randomUUID()}` };
    const config = readDirectModelConfig({
      AGENT_MODEL_BASE_URL: 'http://127.0.0.1:55439/v1',
      AGENT_MODEL_ID: 'controlled-w5-permissions',
      AGENT_MODEL_API_KEY: 'isolated-fixture-key',
    });
    try {
      await admin.pool.query(
        await readFile(new URL('../migrations/roles.sql', import.meta.url), 'utf8'),
      );
      await admin.pool.query(
        (await loadAgentMigration()).resources.find((r) => r.name === '05_privileges.sql')!.sql,
      );
      await admin.pool.query(
        (await loadAgentMigrations())[1]!.resources.find((r) => r.name === '02_privileges.sql')!
          .sql,
      );
      await admin.pool.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await admin.pool.query(`GRANT tyde_agent_runtime TO ${role}`);
      await publishExecutionSnapshot(admin.pool, executionConfig);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = role;
      runtimeUrl.password = '';
      database = createAgentDatabase({ connectionString: runtimeUrl.toString() });
      await checkAgentDatabase(database.pool);
      const actual = (
        await database.pool.query(
          'SELECT session_user,current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser',
        )
      ).rows[0];
      assert.equal(actual.session_user, role);
      assert.equal(actual.current_user, role);
      assert.equal(actual.superuser, false);
      const fetcher: typeof fetch = async (_input, init) => {
        calls++;
        const wire = (text: string, finish: string | null) =>
          `data: ${JSON.stringify({ id: `permission-fixture-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'controlled-w5-permissions', choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content: text }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}) })}\n\n`;
        if (calls === 1)
          return new Response(
            wire('受控运行账号回答', null) + wire('', 'stop') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              held = controller;
              controller.enqueue(
                new TextEncoder().encode(wire('受控部分输出，等待用户停止', null)),
              );
              const abort = () => {
                try {
                  controller.error(new DOMException('controlled model aborted', 'AbortError'));
                } catch {
                  /* SDK already cancelled. */
                }
              };
              if (init?.signal?.aborted) abort();
              else init?.signal?.addEventListener('abort', abort, { once: true });
              entered();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      };
      const runtime = new AgentPostgresRuntime({
        pool: database.pool,
        executionConfig,
        createSession: async (_id, barriers, nativeState) =>
          createPiDirectModelSession({ config, barriers, nativeState, fetch: fetcher }),
      });
      closeRuntime = () => runtime.close();
      let lastCommandError = '';
      const submitCommand = runtime.submitCommand.bind(runtime);
      runtime.submitCommand = async (...args) => {
        try {
          return await submitCommand(...args);
        } catch (error) {
          lastCommandError = error instanceof Error ? error.message : 'unknown command failure';
          throw error;
        }
      };
      await runtime.initialize();
      app = await createApp(
        {
          env: 'test',
          host: '127.0.0.1',
          port: 0,
          auth: {
            mode: 'development',
            userId: `http-runtime-${randomUUID()}`,
            bearerToken: credential,
          },
          storage: { mode: 'postgres', databaseUrl: runtimeUrl.toString() },
        },
        { runtime },
      );
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      async function request(path: string, body?: unknown) {
        const response = await fetch(`${address}/api/agent/v1/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      }
      async function create() {
        const result = await request('conversations', { schema_version: 1 });
        assert.equal(result.status, 201);
        return result.body.data.conversation.id as string;
      }
      async function ended(id: string): Promise<TaskView> {
        for (let i = 0; i < 300; i++) {
          const result = await request(`conversations/${id}`);
          assert.equal(result.status, 200);
          const task = result.body.data.focus_task as TaskView | null;
          if (task?.latest_attempt.ended_at) return task;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('non-owner HTTP runtime did not reliably finish');
      }
      const start = (id: string) =>
        request(`conversations/${id}/commands`, {
          schema_version: 1,
          kind: 'start_task',
          request_key: randomUUID(),
          task_kind: 'business_query',
          input: { text: '验证受控运行账号' },
        });
      assert.deepEqual((await request('runtime')).body, { storage_mode: 'postgres' });
      const completeId = await create();
      assert.equal((await start(completeId)).status, 202);
      assert.equal((await ended(completeId)).status, 'completed');
      const snapshot = await request(`conversations/${completeId}/snapshot`);
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.data.results.length, 1);
      const stopId = await create();
      const started = await start(stopId);
      assert.equal(started.status, 202);
      let modelWait: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          modelEntered,
          new Promise<never>((_resolve, reject) => {
            modelWait = setTimeout(
              () => reject(new Error('controlled model was not dispatched')),
              5_000,
            );
          }),
        ]);
      } finally {
        if (modelWait) clearTimeout(modelWait);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const stop = {
        schema_version: 1,
        kind: 'stop_attempt',
        request_key: randomUUID(),
        task_id: started.body.decision.task_id,
        target_attempt_id: started.body.decision.result_attempt_id,
      };
      const accepted = await request(`conversations/${stopId}/commands`, stop);
      assert.equal(accepted.status, 202, lastCommandError);
      const replay = await request(`conversations/${stopId}/commands`, stop);
      assert.equal(replay.body.command.id, accepted.body.command.id);
      const settled = await ended(stopId);
      assert.equal(settled.status, 'stopped');
      assert.equal(settled.result_id, null);
      const saved = await request(`conversations/${stopId}/snapshot`);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.data.results.length, 0);
      assert.equal(saved.body.data.messages.at(-1).status, 'interrupted');
      assert.equal(calls, 2);
      for (const statement of [
        'CREATE TABLE agent.runtime_forbidden(id integer)',
        'TRUNCATE agent.agent_tasks',
        'DELETE FROM agent.pi_session_entries',
      ])
        await assert.rejects(() => database!.pool.query(statement), /permission denied/);
    } finally {
      try {
        held?.close();
      } catch {
        /* Aborted stream is already closed. */
      }
      await app?.close();
      await closeRuntime?.();
      await database?.close();
      await admin.pool.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.close();
    }
  },
);
