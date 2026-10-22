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
import { sample, samples, snapshot } from './chat-fixtures';

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
