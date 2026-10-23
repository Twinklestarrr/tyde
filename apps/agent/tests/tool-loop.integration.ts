import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { validateAgentContract, type CommandRequest } from '@tyde/shared/agent';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';
import { createAgentDatabase } from '../src/storage/database.js';
import { modelExecutionConfig, publishExecutionSnapshot } from '../src/storage/execution-config.js';
import { budgetProducerKey } from '../src/execution/persistent-budget.js';
import { createPiDirectModelSession, type PiMemoryTool } from '../src/pi/index.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated AGENT_TEST_DATABASE_URL *_test database required');
const database = createAgentDatabase({ connectionString: url });
const principal = { userId: `isolated-tool-loop/${randomUUID()}`, source: 'development' as const };
const config = readDirectModelConfig({
  AGENT_MODEL_BASE_URL: 'http://127.0.0.1:55439/v1',
  AGENT_MODEL_ID: 'controlled-tool-loop',
  AGENT_MODEL_API_KEY: 'isolated-fixture-key',
});
const executionConfig = modelExecutionConfig(config);
const name = 'isolated_readonly_fixture';
const callId = 'w5-readonly-call';
const parameters = Type.Object({ lookup: Type.String() }, { additionalProperties: false });
const fixtureValue = 'isolated archive value: AMBER-42';
const toolManifestBody = {
  isolated_fixture: true,
  tools: [
    {
      name,
      description: 'Read one explicitly isolated synthetic value without business side effects.',
      parameters,
      output: { type: 'string' },
      read_only: true,
      implementation: {
        kind: 'isolated-test-fixture',
        entry: 'tests/tool-loop.integration.ts:readonlyTool',
        sha256: createHash('sha256')
          .update(await readFile(new URL(import.meta.url)))
          .digest('hex'),
      },
    },
  ],
};
const toolManifest = {
  ...toolManifestBody,
  fixture_tool_exports: toolManifestBody.tools.map((tool) => tool.implementation),
};
const prompt = (text: string): CommandRequest => ({
  schema_version: 1,
  kind: 'start_task',
  request_key: randomUUID(),
  task_kind: 'business_query',
  input: { text },
});
let conversationId = '';
let modelCalls = 0;
let toolCalls = 0;
let heldTool: { entered(): void; late: Promise<void> } | undefined;
let heldSignal: AbortSignal | undefined;
async function nativeEntries() {
  const { rows } = await database.pool.query(
    'SELECT e.native_entry_id,e.raw_entry FROM pi_sessions p JOIN pi_session_entries e ON e.pi_session_id=p.id WHERE p.conversation_id=$1 ORDER BY e.entry_seq',
    [conversationId],
  );
  return rows;
}
async function activeAttempt() {
  const {
    rows: [attempt],
  } = await database.pool.query(
    'SELECT a.* FROM agent_attempts a JOIN agent_tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND a.ended_at IS NULL',
    [conversationId],
  );
  assert.ok(attempt);
  return attempt;
}
const readonlyTool: PiMemoryTool = {
  name,
  description: toolManifest.tools[0]!.description,
  parameters,
  validate: (args) => typeof args.lookup === 'string' && Object.keys(args).length === 1,
  publicMetadata: { isDemo: true, displayLabel: '合成隔离测试数据' },
  projectInput: () => '查询固定合成测试值',
  execute: async (args, context) => {
    toolCalls++;
    assert.deepEqual(args, { lookup: 'synthetic-only' });
    assert.equal(context.toolCallId, callId);
    const entries = await nativeEntries();
    const source = entries.find(
      (entry) =>
        entry.raw_entry.type === 'message' &&
        entry.raw_entry.message.role === 'assistant' &&
        entry.raw_entry.message.content.some(
          (part: Record<string, unknown>) => part.type === 'toolCall' && part.id === callId,
        ),
    );
    assert.ok(source, 'complete tool call must already be committed before fixture execution');
    assert.deepEqual(
      source.raw_entry.message.content.find(
        (part: Record<string, unknown>) => part.type === 'toolCall',
      ).arguments,
      { lookup: 'synthetic-only' },
    );
    const attempt = await activeAttempt();
    assert.equal(attempt.model_requests_used, 1);
    assert.equal(attempt.tool_calls_used, 1);
    const producer = budgetProducerKey(attempt.id, {
      kind: 'tool',
      sourceNativeEntryId: source.native_entry_id,
      toolCallId: callId,
    });
    const {
      rows: [authorization],
    } = await database.pool.query(
      'SELECT payload FROM agent_outbox_events WHERE conversation_id=$1 AND producer_key=$2',
      [conversationId, producer],
    );
    assert.equal(authorization.payload.payload.task.latest_attempt.budget.tool_calls_used, 1);
    const {
      rows: [running],
    } = await database.pool.query(
      'SELECT * FROM agent_tool_executions WHERE attempt_id=$1 AND tool_call_id=$2',
      [attempt.id, callId],
    );
    assert.equal(running.status, 'running', 'safe running projection is saved before dispatch');
    assert.equal(running.source_native_entry_id, source.native_entry_id);
    assert.equal(running.is_demo, true);
    assert.equal(
      (
        await database.pool.query(
          'SELECT count(*)::text AS n FROM agent_operations WHERE conversation_id=$1',
          [conversationId],
        )
      ).rows[0].n,
      '0',
    );
    if (heldTool) {
      heldSignal = context.signal;
      heldTool.entered();
      await heldTool.late; // Deliberately ignores abort to prove that a late receipt cannot reopen.
    }
    return { content: fixtureValue, summary: '演示数据：合成值 AMBER-42，仅供隔离测试。' };
  },
};
function response(text: string | undefined, tool = false) {
  const frame = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: `controlled-loop-${modelCalls}`, object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } } : {}) })}\n\n`;
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: 'function',
            function: { name, arguments: JSON.stringify({ lookup: 'synthetic-only' }) },
          },
        ],
      }
    : { role: 'assistant', content: text };
  return new Response(
    frame(delta, null) + frame({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const controlledFetch: typeof fetch = async (_url, init) => {
  modelCalls++;
  const payload = JSON.parse(String(init?.body));
  assert.ok(
    payload.tools.some((tool: Record<string, unknown>) => JSON.stringify(tool).includes(name)),
  );
  if (modelCalls === 1) return response(undefined, true);
  if (modelCalls === 2) {
    const entries = await nativeEntries();
    assert.ok(
      entries.some(
        (entry) =>
          entry.raw_entry.type === 'message' &&
          entry.raw_entry.message.role === 'toolResult' &&
          entry.raw_entry.message.toolCallId === callId &&
          JSON.stringify(entry.raw_entry.message.content).includes(fixtureValue),
      ),
      'complete tool result must be committed before the next model send',
    );
    const attempt = await activeAttempt();
    assert.equal(attempt.model_requests_used, 2);
    assert.equal(attempt.tool_calls_used, 1);
    assert.equal(
      (
        await database.pool.query(
          'SELECT status FROM agent_tool_executions WHERE attempt_id=$1 AND tool_call_id=$2',
          [attempt.id, callId],
        )
      ).rows[0].status,
      'succeeded',
      'safe terminal projection must commit before the next model request',
    );
    assert.ok(JSON.stringify(payload.messages).includes(fixtureValue));
    return response('Synthetic lookup completed: AMBER-42');
  }
  if (modelCalls === 4) return response(undefined, true);
  assert.equal(modelCalls, 3, 'a stopped tool cannot dispatch a subsequent model');
  assert.ok(
    payload.messages.some(
      (message: Record<string, unknown>) =>
        message.role === 'tool' && JSON.stringify(message.content).includes(fixtureValue),
    ),
    'restored native context must contain the original exact tool result',
  );
  return response('The persisted read-only fixture returned AMBER-42.');
};
const make = () =>
  new AgentPostgresRuntime({
    pool: database.pool,
    executionConfig,
    toolManifest,
    createSession: async (_id, barriers, nativeState) =>
      createPiDirectModelSession({
        config,
        barriers: {
          ...barriers,
          onToolLifecycle: async (event) => {
            await barriers.onToolLifecycle?.(event);
            await barriers.onToolLifecycle?.(event); // Duplicate SDK callback is not a dispatch grant.
          },
        },
        nativeState,
        tools: [readonlyTool],
        fetch: controlledFetch,
      }),
  });
async function ended(runtime: AgentPostgresRuntime) {
  for (let i = 0; i < 400; i++) {
    const detail = await runtime.getConversation(principal, conversationId);
    if (detail.focus_task?.latest_attempt.ended_at) return detail.focus_task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Isolated tool-loop attempt did not finish');
}

test(
  '真实Pi+PG隔离只读工具循环经过完整持久屏障，重建runtime后保留原工具上下文',
  { timeout: 30_000 },
  async () => {
    await publishExecutionSnapshot(database.pool, executionConfig, toolManifest);
    let runtime = make();
    await runtime.initialize();
    try {
      const created = await runtime.createConversation(principal, {
        schema_version: 1,
        title: 'Isolated native tool-loop fixture',
      });
      conversationId = created.conversation.id;
      await runtime.submitCommand(
        principal,
        conversationId,
        prompt('Read the isolated synthetic fixture.'),
      );
      const first = await ended(runtime);
      assert.equal(first.status, 'completed');
      assert.equal(first.latest_attempt.budget?.model_requests_used, 2);
      assert.equal(first.latest_attempt.budget?.tool_calls_used, 1);
      assert.equal(modelCalls, 2);
      assert.equal(toolCalls, 1);
      const {
        rows: [binding],
      } = await database.pool.query(
        'SELECT id,active_attempt_id,writer_owner_id FROM pi_sessions WHERE conversation_id=$1',
        [conversationId],
      );
      assert.equal(binding.active_attempt_id, null);
      assert.equal(binding.writer_owner_id, null);
      const snapshot = await runtime.getSnapshot(principal, conversationId);
      assert.ok(validateAgentContract('SnapshotData', snapshot));
      assert.equal(snapshot.tool_executions.length, 1);
      const tool = snapshot.tool_executions[0]!;
      assert.equal(tool.status, 'succeeded');
      assert.equal(tool.row_version, '2');
      assert.ok(tool.result_ref);
      assert.equal(tool.is_demo, true);
      assert.equal('source_native_entry_id' in tool, false);
      assert.equal('pi_session_id' in tool, false);
      const {
        rows: [link],
      } = await database.pool.query('SELECT * FROM agent_tool_executions WHERE result_ref=$1', [
        tool.result_ref,
      ]);
      assert.ok(link.source_native_entry_id);
      assert.ok(link.result_native_entry_id);
      assert.ok(link.result_revision_id);
      assert.equal(link.tool_call_id, tool.tool_call_id);
      assert.deepEqual(
        (await runtime.getTask(principal, conversationId, first.id)).tool_executions,
        [tool],
      );
      assert.deepEqual(
        (await runtime.getResult(principal, conversationId, first.result_id!)).tool_executions,
        [tool],
      );
      assert.deepEqual(
        (
          await runtime.listMessages(principal, conversationId, {
            streamId: snapshot.read_cursor.stream_id,
            upperMessageSeq: snapshot.page.upper_message_seq,
          })
        ).tool_executions,
        [tool],
      );
      await assert.rejects(
        runtime.getSnapshot({ userId: 'other', source: 'platform' }, conversationId),
        { statusCode: 404 },
      );
      await assert.rejects(
        database.pool.query(
          "UPDATE agent_tool_executions SET status='running',row_version=row_version+1 WHERE id=$1",
          [tool.id],
        ),
        /tool terminal state/,
      );
      await runtime.close();
      runtime = make();
      await runtime.initialize();
      assert.deepEqual(await runtime.getSnapshot(principal, conversationId), snapshot);
      const subscription = await runtime.subscribe(principal, conversationId, {
        streamId: snapshot.read_cursor.stream_id,
        afterEventSeq: '0',
        onFrame() {},
      });
      subscription.close();
      assert.deepEqual(
        subscription.replay
          .filter((frame) => frame.event_type === 'tool.updated')
          .map((frame) =>
            frame.event_type === 'tool.updated' ? frame.payload.tool_execution.status : null,
          ),
        ['running', 'succeeded'],
      );
      assert.equal(modelCalls, 2, 'history loading/subscription must never execute');
      await runtime.submitCommand(
        principal,
        conversationId,
        prompt('What value did the original fixture return?'),
      );
      const second = await ended(runtime);
      assert.equal(second.status, 'completed');
      assert.equal(second.latest_attempt.budget?.model_requests_used, 1);
      assert.equal(second.latest_attempt.budget?.tool_calls_used, 0);
      assert.equal(modelCalls, 3);
      assert.equal(toolCalls, 1);
      assert.ok(
        JSON.stringify((await runtime.getSnapshot(principal, conversationId)).results).includes(
          'AMBER-42',
        ),
      );
      assert.equal(
        (
          await database.pool.query('SELECT id FROM pi_sessions WHERE conversation_id=$1', [
            conversationId,
          ])
        ).rows[0].id,
        binding.id,
      );
      assert.equal(
        (
          await database.pool.query(
            'SELECT count(*)::text AS n FROM agent_operations WHERE conversation_id=$1',
            [conversationId],
          )
        ).rows[0].n,
        '0',
      );

      const oldConversationId = conversationId;
      let entered!: () => void;
      let releaseLate!: () => void;
      const toolEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      heldTool = {
        entered,
        late: new Promise<void>((resolve) => {
          releaseLate = resolve;
        }),
      };
      const next = await runtime.createConversation(principal, { schema_version: 1 });
      conversationId = next.conversation.id;
      await runtime.submitCommand(
        principal,
        conversationId,
        prompt('Run the controlled cancellable fixture.'),
      );
      await toolEntered;
      const running = await runtime.getSnapshot(principal, conversationId);
      assert.equal(running.tool_executions[0]!.status, 'running');
      await runtime.submitCommand(principal, conversationId, {
        schema_version: 1,
        kind: 'stop_attempt',
        request_key: randomUUID(),
        task_id: running.focus_task!.id,
        target_attempt_id: running.focus_task!.latest_attempt.id,
      });
      assert.equal((await ended(runtime)).status, 'stopped');
      const stopped = await runtime.getSnapshot(principal, conversationId);
      assert.equal(stopped.tool_executions[0]!.status, 'cancelled');
      assert.equal(stopped.tool_executions[0]!.result_ref, null);
      assert.equal(heldSignal?.aborted, true);
      assert.equal(stopped.focus_task!.latest_attempt.budget!.model_requests_used, 1);
      assert.equal(stopped.focus_task!.latest_attempt.budget!.tool_calls_used, 1);
      releaseLate();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(await runtime.getSnapshot(principal, conversationId), stopped);
      assert.equal(modelCalls, 4);
      assert.equal(toolCalls, 2);
      assert.deepEqual((await runtime.getSnapshot(principal, oldConversationId)).tool_executions, [
        tool,
      ]);
    } finally {
      await runtime.close();
      await database.close();
    }
  },
);
