import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDelta,
  applyProduct,
  clearOverlays,
  fromSnapshot,
  mergeHistory,
  messageText,
} from '../src/agent-events/projection';
import { sample, samples, snapshot, toolExecution, toolUpdated } from './chat-fixtures';

test('temporary text converges into the immutable final answer without duplication', () => {
  let view = fromSnapshot(snapshot());
  view = applyProduct(view, sample('message.created'));
  const delta = structuredClone(samples.delta[0]!);
  view = applyDelta(view, { ...delta, delta_index: 1, text: '临时' });
  view = applyDelta(view, { ...delta, delta_index: 2, text: '回答' });
  const slot = view.messages.get(delta.message_id)!;
  assert.equal(messageText(view, slot), '临时回答');
  const final = sample('task.completed');
  final.payload.message = {
    ...slot,
    message_type: 'assistant_output',
    content: { blocks: [], context: null },
    source_command_id: null,
    attempt_id: slot.attempt_id!,
    status: 'complete',
    row_version: '1',
    result_id: final.payload.result.id,
  };
  final.payload.result.task_id = slot.task_id;
  final.payload.result.delivery_attempt_id = slot.attempt_id!;
  final.payload.task.id = slot.task_id;
  final.payload.task.latest_attempt.id = slot.attempt_id!;
  view = applyProduct(view, final);
  const message = view.messages.get(final.payload.message.id)!;
  assert.equal(
    messageText(view, message),
    final.payload.result.result_type === 'answer'
      ? final.payload.result.payload.blocks.map((block) => block.text).join('\n\n')
      : final.payload.result.payload.summary,
  );
  assert.equal(view.overlays.size, 0);
  assert.equal(applyDelta(view, { ...delta, delta_index: 3, text: '迟到' }), view);
  assert.equal(view.messages.size, 1);
});

test('missing first delta, gaps and output streams never concatenate unrelated text', () => {
  let view = applyProduct(fromSnapshot(snapshot()), sample('message.created'));
  const delta = samples.delta[0]!;
  const message = view.messages.get(delta.message_id)!;
  view = applyDelta(view, { ...delta, delta_index: 2, text: '缺少开头' });
  assert.equal(messageText(view, message), '');
  view = clearOverlays(view);
  view = applyDelta(view, { ...delta, delta_index: 1, text: '开头' });
  view = applyDelta(view, { ...delta, delta_index: 1, text: '重复' });
  assert.equal(messageText(view, message), '开头');
  view = applyDelta(view, { ...delta, delta_index: 3, text: '缺号' });
  assert.equal(messageText(view, message), '');
  view = applyDelta(view, {
    ...delta,
    output_stream_id: 'd0000000-0000-4000-8000-000000000002',
    delta_index: 1,
    text: '新段',
  });
  assert.equal(messageText(view, message), '新段');
  assert.equal(
    applyDelta(view, {
      ...delta,
      attempt_id: '40000000-0000-4000-8000-000000000003',
      text: '旧尝试',
    }),
    view,
  );
});

test('oversized temporary output is discarded within a bounded overlay', () => {
  let view = applyProduct(fromSnapshot(snapshot()), sample('message.created'));
  const delta = samples.delta[0]!;
  view = applyDelta(view, { ...delta, delta_index: 1, text: 'a'.repeat(1024 * 1024 + 1) });
  assert.equal(view.overlays.get(delta.message_id)?.text, '');
  assert.equal(view.overlays.get(delta.message_id)?.blocked, true);
});

test('late history cannot replace a terminal message or regress consumed input', () => {
  const final = sample('message.updated');
  let view = applyProduct(fromSnapshot(snapshot()), final);
  const input = sample('input.updated');
  view = applyProduct(view, input);
  const old = sample('message.created').payload.message;
  const receipt = input.payload.input_receipt;
  const data = {
    messages: [old],
    input_receipts: [
      {
        ...receipt,
        input_state: 'pending' as const,
        input_attempt_id: null,
        handling_summary: null,
      },
    ],
    results: [],
    operations: [],
    read_cursor: snapshot().read_cursor,
    page: snapshot().page,
  };
  view = mergeHistory(view, data);
  assert.equal(view.messages.get(old.id)?.status, final.payload.message.status);
  assert.equal(view.receipts.get(receipt.command_id)?.input_state, receipt.input_state);
});

test('results are immutable and completion is applied atomically', () => {
  const frame = sample('task.completed');
  const view = applyProduct(fromSnapshot(snapshot()), frame);
  assert.equal(view.focusTask?.status, 'completed');
  assert.ok(view.results.has(frame.payload.result.id));
  assert.ok(view.messages.has(frame.payload.message.id));
  const changed = structuredClone(frame);
  changed.payload.result.created_at = '2026-10-22T10:00:00Z';
  assert.throws(() => applyProduct(view, changed), /不可变结果/);
  assert.equal(
    view.results.get(frame.payload.result.id)?.created_at,
    frame.payload.result.created_at,
  );
});

test('tool processes install with snapshot H and retain terminal state across late history', () => {
  const data = snapshot();
  data.tool_executions = [toolExecution()];
  let view = fromSnapshot(data);
  assert.equal(view.toolExecutions.get(toolExecution().id)?.status, 'running');
  view = applyProduct(view, toolUpdated('succeeded'));
  const terminal = view.toolExecutions.get(toolExecution().id)!;
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.tool_call_id, 'tool-call-test-1');
  assert.equal(terminal.model_request_id, 'model-request-test-1');
  assert.equal(view.operations.size, 0);
  view = mergeHistory(view, {
    messages: [],
    results: [],
    input_receipts: [],
    operations: [],
    tool_executions: [toolExecution()],
    read_cursor: { ...data.read_cursor, event_seq: '99' },
    page: data.page,
  });
  assert.deepEqual(view.toolExecutions.get(terminal.id), terminal);
  assert.equal(view.activitySeq, '11');
  const refreshed = fromSnapshot({ ...data, tool_executions: [terminal] });
  assert.deepEqual(refreshed.toolExecutions.get(terminal.id), terminal);
  assert.equal(fromSnapshot(snapshot()).toolExecutions.size, 0);
});

test('tool updates do not disturb text overlays and completed output converges independently', () => {
  let view = applyProduct(fromSnapshot(snapshot()), sample('message.created'));
  const delta = { ...samples.delta[0]!, delta_index: 1, text: '临时文字' };
  view = applyDelta(view, delta);
  view = applyProduct(view, toolUpdated());
  view = applyProduct(view, toolUpdated('cancelled', '12'));
  assert.equal(messageText(view, view.messages.get(delta.message_id)!), '临时文字');
  assert.equal(view.toolExecutions.get(toolExecution().id)?.status, 'cancelled');
  const final = sample('message.updated');
  view = applyProduct(view, final);
  assert.equal(view.overlays.size, 0);
  assert.equal(view.toolExecutions.get(toolExecution().id)?.status, 'cancelled');
});

test('snapshot, history and updates reject tool processes belonging to another conversation', () => {
  const foreign = { ...toolExecution(), conversation_id: '10000000-0000-4000-8000-000000000099' };
  assert.throws(() => fromSnapshot({ ...snapshot(), tool_executions: [foreign] }), /其他会话/);
  assert.throws(
    () =>
      mergeHistory(fromSnapshot(snapshot()), {
        ...snapshot(),
        tool_executions: [foreign],
      }),
    /其他会话/,
  );
  const frame = toolUpdated();
  frame.payload.tool_execution = foreign;
  assert.throws(() => applyProduct(fromSnapshot(snapshot()), frame), /其他会话/);
});

test('higher versions cannot regress or rewrite a terminal tool process', () => {
  for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
    const view = applyProduct(fromSnapshot(snapshot()), toolUpdated(status));
    const regression = toolUpdated('running', '12');
    regression.payload.tool_execution.row_version = '3';
    assert.throws(() => applyProduct(view, regression), /终态矛盾/);
    assert.equal(view.toolExecutions.get(toolExecution().id)?.status, status);
    const changed = toolUpdated(status, '12');
    changed.payload.tool_execution.row_version = '3';
    changed.payload.tool_execution.ended_at = '2026-10-22T08:00:03Z';
    assert.throws(() => applyProduct(view, changed), /终态矛盾/);
  }
  const cancelled = applyProduct(fromSnapshot(snapshot()), toolUpdated('cancelled'));
  const lateSuccess = toolUpdated('succeeded', '12');
  lateSuccess.payload.tool_execution.row_version = '3';
  assert.throws(() => applyProduct(cancelled, lateSuccess), /终态矛盾/);
});

test('same-version contradictions fail closed while older running history is ignored', () => {
  const view = applyProduct(fromSnapshot(snapshot()), toolUpdated('succeeded'));
  const old = toolUpdated('running', '12');
  assert.equal(applyProduct(view, old).toolExecutions.get(toolExecution().id)?.status, 'succeeded');
  old.payload.tool_execution.row_version = '2';
  assert.throws(() => applyProduct(view, old), /版本或终态矛盾/);
});

test('one process cannot change its call identity or hide a duplicate native call under another id', () => {
  const view = applyProduct(fromSnapshot(snapshot()), toolUpdated());
  const changes = {
    task_id: '30000000-0000-4000-8000-000000000099',
    attempt_id: '40000000-0000-4000-8000-000000000099',
    tool_call_id: 'another-call',
    model_request_id: 'another-model-request',
    tool_name: 'another_tool',
    input_summary: '另一份输入摘要',
    is_demo: false,
  };
  for (const [field, value] of Object.entries(changes)) {
    const changed = toolUpdated('succeeded', '12');
    Object.assign(changed.payload.tool_execution, { [field]: value });
    assert.throws(() => applyProduct(view, changed), /身份或固定摘要发生变化/);
  }
  const duplicate = toolUpdated('succeeded', '12');
  duplicate.payload.tool_execution.id = 'e0000000-0000-4000-8000-000000000099';
  assert.throws(() => applyProduct(view, duplicate), /多个过程记录/);
  assert.equal(view.toolExecutions.size, 1);
});

test('known task, message and result attempts cannot be reassigned by a tool or a later entity', () => {
  const task = sample('task.updated').payload.task;
  const foreignTask = '30000000-0000-4000-8000-000000000099';
  const tool = { ...toolExecution(), task_id: foreignTask };
  assert.throws(
    () => fromSnapshot({ ...snapshot(), focus_task: task, tool_executions: [tool] }),
    /执行尝试.*关联矛盾/,
  );
  const withMessage = applyProduct(fromSnapshot(snapshot()), sample('message.created'));
  const wrong = toolUpdated();
  wrong.payload.tool_execution.task_id = foreignTask;
  assert.throws(() => applyProduct(withMessage, wrong), /执行尝试.*关联矛盾/);
  const withTool = applyProduct(fromSnapshot(snapshot()), toolUpdated());
  const message = sample('message.created');
  message.payload.message.task_id = foreignTask;
  assert.throws(() => applyProduct(withTool, message), /执行尝试.*关联矛盾/);
  const complete = sample('task.completed');
  complete.payload.result.task_id = foreignTask;
  assert.throws(() => applyProduct(withTool, complete), /执行尝试.*关联矛盾/);
});

test('an older attempt remains valid beside the latest task attempt when its own links agree', () => {
  const task = sample('task.updated').payload.task;
  const tool = {
    ...toolExecution('succeeded'),
    attempt_id: '40000000-0000-4000-8000-000000000099',
  };
  const view = fromSnapshot({ ...snapshot(), focus_task: task, tool_executions: [tool] });
  assert.equal(view.toolExecutions.get(tool.id)?.attempt_id, tool.attempt_id);
});
