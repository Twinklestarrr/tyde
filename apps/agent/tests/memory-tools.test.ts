import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { validateAgentContract, type CommandRequest } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';
import { createPiDirectModelSession, type PiMemoryTool } from '../src/pi/session.js';
import { AgentMemoryRuntime, type NativeExecutionCapture } from '../src/runtime/memory-runtime.js';

const principal = { userId: 'tool-fixture-owner', source: 'platform' as const };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let index = 0; index < 200 && !check(); index += 1) await tick();
  assert.ok(check(), 'expected bounded asynchronous state');
}
const command = (): CommandRequest => ({
  schema_version: 1,
  kind: 'start_task',
  request_key: randomUUID(),
  task_kind: 'business_query',
  input: { text: 'Use the explicit fixture tool.' },
});
const chunk = (delta: unknown, finish: string | null = null) => ({
  id: 'fixture-completion',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fixture-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const wire = (items: unknown[]) =>
  new Response(
    items
      .map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
const toolAnswer = (id = 'fixture-call-1') =>
  wire([
    chunk({
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name: 'lookup_fixture', arguments: '{"record":"alpha"}' },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ]);
const answer = () =>
  wire([
    chunk({ content: 'Fixture Alpha, from the real tool result.' }),
    chunk({}, 'stop'),
    '[DONE]',
  ]);
const fixtureTool = (execute: PiMemoryTool['execute']): PiMemoryTool => ({
  name: 'lookup_fixture',
  description: 'Read one synthetic fixture record.',
  parameters: Type.Object({ record: Type.Literal('alpha') }, { additionalProperties: false }),
  validate: (args) => args.record === 'alpha' && Object.keys(args).length === 1,
  publicMetadata: { isDemo: true, displayLabel: 'Synthetic fixture data' },
  projectInput: () => 'Read alpha fixture',
  execute,
});
function harness(
  tool: PiMemoryTool,
  loop = false,
  save?: (capture: NativeExecutionCapture) => Promise<void>,
) {
  let requests = 0;
  let executions = 0;
  const captures: NativeExecutionCapture[] = [];
  const config = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'http://127.0.0.1/v1',
    AGENT_MODEL_API_KEY: 'isolated-fixture-model-key',
    AGENT_MODEL_ID: 'fixture-model',
  });
  const runtime = new AgentMemoryRuntime({
    saveNativeState: async (capture) => {
      captures.push(capture);
      await save?.(capture);
    },
    createSession: async (_id, barriers) =>
      createPiDirectModelSession({
        config,
        barriers,
        tools: [
          {
            ...tool,
            execute: async (...args) => {
              executions += 1;
              return tool.execute(...args);
            },
          },
        ],
        fetch: async (_url, init) => {
          requests += 1;
          if (requests === 1 || loop) return toolAnswer(`fixture-call-${requests}`);
          const body = JSON.parse(String(init?.body));
          assert.ok(
            body.messages.some(
              (message: { role: string; content: string }) =>
                message.role === 'tool' && message.content.includes('Fixture Alpha'),
            ),
          );
          return answer();
        },
      }),
  });
  const created = runtime.createConversation(principal, { schema_version: 1 });
  const id = created.conversation.id;
  const snapshot = () => runtime.getSnapshot(principal, id);
  return {
    runtime,
    id,
    created,
    snapshot,
    captures,
    requests: () => requests,
    executions: () => executions,
  };
}

test('real Pi tool loop projects linked records through reads and HTTP; replay/refresh never redispatch', async (t) => {
  const h = harness(
    fixtureTool(async () => ({
      content: '{"name":"Fixture Alpha"}',
      summary: 'Synthetic data: Fixture Alpha',
    })),
  );
  t.after(() => h.runtime.close());
  const initial = h.snapshot();
  const request = command();
  const receipt = h.runtime.submitCommand(principal, h.id, request);
  h.runtime.submitCommand(principal, h.id, request);
  await until(() => h.snapshot().focus_task?.status === 'completed');
  const snapshot = h.snapshot();
  const tool = snapshot.tool_executions![0]!;
  assert.equal(validateAgentContract('SnapshotData', snapshot), true);
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.tool_call_id, 'fixture-call-1');
  assert.ok(tool.result_ref);
  assert.equal(snapshot.operations.length, 0);
  assert.equal(snapshot.focus_task!.latest_attempt.budget!.model_requests_used, 2);
  assert.equal(snapshot.focus_task!.latest_attempt.budget!.tool_calls_used, 1);
  assert.equal(
    snapshot.results[0]!.payload.blocks[0]!.text,
    'Fixture Alpha, from the real tool result.',
  );
  const history = h.runtime.listMessages(principal, h.id, {
    streamId: snapshot.read_cursor.stream_id,
    upperMessageSeq: snapshot.page.upper_message_seq,
  });
  assert.deepEqual(history.tool_executions, snapshot.tool_executions);
  assert.deepEqual(
    h.runtime.getTask(principal, h.id, tool.task_id).tool_executions,
    snapshot.tool_executions,
  );
  assert.deepEqual(
    h.runtime.getResult(principal, h.id, snapshot.results[0]!.id).tool_executions,
    snapshot.tool_executions,
  );
  const replay = h.runtime.subscribe(principal, h.id, {
    streamId: initial.read_cursor.stream_id,
    afterEventSeq: initial.read_cursor.event_seq,
    onFrame() {},
  });
  const events = replay.replay.filter((frame) => frame.event_type === 'tool.updated');
  assert.deepEqual(
    events.map((frame) => frame.payload.tool_execution.status),
    ['running', 'succeeded'],
  );
  assert.deepEqual(
    replay.replay.map((frame) => frame.event_seq),
    replay.replay.map((_, index) => String(index + 1)),
  );
  replay.close();
  assert.equal(receipt.body.decision!.task_id, tool.task_id);
  assert.equal(tool.attempt_id, snapshot.focus_task!.latest_attempt.id);
  assert.ok(
    h.captures.some(
      (capture) =>
        capture.phase === 'before_tool' &&
        capture.modelRequestId === tool.model_request_id &&
        capture.toolCallId === tool.tool_call_id,
    ),
  );
  const captured = h.captures.find((capture) => capture.phase === 'after_tool')!;
  assert.ok(Object.isFrozen(captured.state));
  assert.equal(captured.state.configuration!.piSdkVersion, '1.3.0');
  assert.equal(captured.state.configuration!.model.id, 'fixture-model');
  assert.match(captured.state.configuration!.sha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.state.configuration!.tools[0]!.name, 'lookup_fixture');
  assert.equal(JSON.stringify(captured.state).includes('isolated-fixture-model-key'), false);
  assert.ok(
    captured.state.entries.some(
      (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
    ),
  );
  assert.throws(() => h.runtime.getSnapshot({ userId: 'other', source: 'platform' }, h.id), {
    statusCode: 404,
  });
  const other = h.runtime.createConversation(principal, { schema_version: 1 });
  assert.throws(() => h.runtime.getTask(principal, other.conversation.id, tool.task_id), {
    statusCode: 404,
  });
  const app = await createApp(readConfig({ NODE_ENV: 'test' }), {
    runtime: h.runtime,
    identityAdapter: { authenticateBearer: async () => ({ userId: principal.userId }) },
  });
  t.after(() => app.close());
  const response = await app.inject({
    url: `/api/agent/v1/conversations/${h.id}/snapshot`,
    headers: { authorization: 'Bearer fixture-browser-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(validateAgentContract('SnapshotResponse', response.json()), true);
  assert.deepEqual(response.json().data.tool_executions, snapshot.tool_executions);
  assert.equal(JSON.stringify(response.json()).includes('sourceNativeEntryId'), false);
  assert.equal(h.requests(), 2);
  assert.equal(h.executions(), 1);
});

test('tool exception is failed with a safe projection; blocked session cannot bypass unfinished task', async (t) => {
  const h = harness(
    fixtureTool(async () => {
      throw new Error('private-server-path-and-receipt');
    }),
  );
  t.after(() => h.runtime.close());
  h.runtime.submitCommand(principal, h.id, command());
  await until(() => h.snapshot().focus_task?.status === 'failed');
  const snapshot = h.snapshot();
  assert.equal(snapshot.tool_executions![0]!.status, 'failed');
  assert.equal(snapshot.tool_executions![0]!.error!.code, 'tool_failed');
  assert.equal(snapshot.tool_executions![0]!.result_ref, null);
  assert.equal(JSON.stringify(snapshot).includes('private-server-path-and-receipt'), false);
  assert.equal(h.runtime.submitCommand(principal, h.id, command()).statusCode, 409);
  assert.equal(h.requests(), 1);
  assert.equal(h.executions(), 1);
});

test('stop during tool captures cancellation and rejects late success without another model', async (t) => {
  let resolve: ((value: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  const h = harness(
    fixtureTool(async (_args, context) => {
      signal = context.signal;
      return new Promise<string>((done) => {
        resolve = done;
      });
    }),
  );
  t.after(() => h.runtime.close());
  const accepted = h.runtime.submitCommand(principal, h.id, command());
  await until(() => !!resolve);
  const before = h.snapshot();
  const stop = h.runtime.submitCommand(principal, h.id, {
    schema_version: 1,
    kind: 'stop_attempt',
    request_key: randomUUID(),
    task_id: accepted.body.decision!.task_id!,
    target_attempt_id: accepted.body.decision!.result_attempt_id!,
  });
  assert.equal(stop.statusCode, 202);
  await until(() => h.snapshot().focus_task?.status === 'stopped');
  assert.equal(signal!.aborted, true);
  const stopped = h.snapshot();
  assert.equal(stopped.tool_executions![0]!.status, 'cancelled');
  assert.equal(stopped.tool_executions![0]!.error!.code, 'cancelled');
  assert.ok(h.captures.some((capture) => capture.phase === 'after_tool'));
  resolve!('late result');
  await tick();
  assert.deepEqual(h.snapshot(), stopped);
  const replay = h.runtime.subscribe(principal, h.id, {
    streamId: before.read_cursor.stream_id,
    afterEventSeq: before.read_cursor.event_seq,
    onFrame() {},
  });
  assert.ok(
    replay.replay.some(
      (frame) =>
        frame.event_type === 'tool.updated' && frame.payload.tool_execution.status === 'cancelled',
    ),
  );
  replay.close();
  assert.equal(h.requests(), 1);
  assert.equal(h.executions(), 1);
});

test('eleventh tool authorization fails without execution; prior ten results and usage remain truthful', async (t) => {
  const h = harness(
    fixtureTool(async () => ({ content: 'Fixture Alpha', summary: 'Synthetic fixture data' })),
    true,
  );
  t.after(() => h.runtime.close());
  h.runtime.submitCommand(principal, h.id, command());
  await until(() => h.snapshot().focus_task?.status === 'failed');
  const snapshot = h.snapshot();
  assert.equal(snapshot.focus_task!.latest_attempt.error!.code, 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED');
  assert.equal(snapshot.focus_task!.latest_attempt.budget!.tool_calls_used, 10);
  assert.equal(snapshot.focus_task!.latest_attempt.budget!.model_requests_used, 11);
  assert.equal(h.executions(), 10);
  assert.equal(h.requests(), 11);
  assert.equal(snapshot.tool_executions!.length, 10);
  assert.ok(snapshot.tool_executions!.every((tool) => tool.status === 'succeeded'));
});

test('awaited native save rejection blocks tool dispatch and the next model', async (t) => {
  const h = harness(
    fixtureTool(async () => 'Fixture Alpha'),
    false,
    async (capture) => {
      if (capture.phase === 'before_tool') throw new Error('isolated-save-failed');
    },
  );
  t.after(() => h.runtime.close());
  h.runtime.submitCommand(principal, h.id, command());
  await until(() => h.snapshot().focus_task?.status === 'failed');
  assert.equal(h.executions(), 0);
  assert.equal(h.requests(), 1);
  assert.equal(h.snapshot().focus_task!.latest_attempt.budget!.tool_calls_used, 1);
  assert.equal(h.snapshot().tool_executions!.length, 0);
});
