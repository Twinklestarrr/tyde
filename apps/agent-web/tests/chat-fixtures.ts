import { readFileSync } from 'node:fs';
import type {
  ConversationView,
  EphemeralFrame,
  ProductFrame,
  SnapshotData,
  TaskView,
  ToolExecutionSummary,
} from '@tyde/shared/agent';
import type { RawSseEvent } from '../src/agent-events';

export const conversationId = '10000000-0000-4000-8000-000000000001';
export const secondConversationId = '10000000-0000-4000-8000-000000000002';
export const streamId = 'a0000000-0000-4000-8000-000000000001';
export const requestId = '80000000-0000-4000-8000-000000000001';
export const samples = JSON.parse(
  readFileSync(new URL('../fixtures/events-v1.json', import.meta.url), 'utf8'),
) as { product: ProductFrame[]; delta: EphemeralFrame[] };
export function sample<T extends ProductFrame['event_type']>(
  eventType: T,
): Extract<ProductFrame, { event_type: T }> {
  return structuredClone(
    samples.product.find((event) => event.event_type === eventType),
  ) as Extract<ProductFrame, { event_type: T }>;
}
export function snapshot(id = conversationId, seq = '10'): SnapshotData {
  const conversation: ConversationView = {
    ...sample('conversation.updated').payload.conversation,
    id,
  };
  return {
    conversation,
    focus_task: null,
    messages: [],
    pinned_messages: [],
    input_receipts: [],
    results: [],
    operations: [],
    page: { upper_message_seq: '0', next_before_message_seq: null, has_more: false },
    read_cursor: { stream_id: streamId, event_seq: seq },
    event_pruned_through_seq: '0',
  };
}
export function runningTask(): TaskView {
  const task = sample('task.updated').payload.task;
  return {
    ...task,
    status: 'running',
    active_attempt_id: task.latest_attempt.id,
    latest_attempt: {
      ...task.latest_attempt,
      outcome: null,
      ended_at: null,
      stop_requested_at: null,
    },
  };
}
export function response(data: unknown): Response {
  return Response.json({ schema_version: 1, request_id: requestId, data, error: null });
}
export function raw(frame: ProductFrame | EphemeralFrame): RawSseEvent {
  return {
    event: frame.frame_kind,
    data: JSON.stringify(frame),
    ...(frame.frame_kind === 'product' ? { id: `${frame.stream_id}:${frame.event_seq}` } : {}),
  };
}
export function readError(status = 404): Response {
  return Response.json(
    {
      schema_version: 1,
      request_id: requestId,
      data: null,
      error: {
        code: status === 401 ? 'UNAUTHENTICATED' : 'RESOURCE_NOT_FOUND',
        message: '测试接口未观察到记录',
        action: status === 401 ? 'reauthenticate' : 'none',
        details: {},
      },
    },
    { status },
  );
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Minimal synthetic projection only; no demo personnel, rules or tool implementation. */
export function toolExecution(
  status: ToolExecutionSummary['status'] = 'running',
): ToolExecutionSummary {
  const task = runningTask();
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    conversation_id: conversationId,
    task_id: task.id,
    attempt_id: task.latest_attempt.id,
    model_request_id: 'model-request-test-1',
    tool_call_id: 'tool-call-test-1',
    tool_name: 'synthetic_readonly_query',
    status,
    row_version: status === 'running' ? '1' : '2',
    started_at: '2026-10-22T08:00:01Z',
    ended_at: status === 'running' ? null : '2026-10-22T08:00:02Z',
    is_demo: true,
    display_label: '合成测试资源 v1',
    input_summary: '只读查询合成测试记录',
    result_summary: status === 'succeeded' ? '演示数据：返回 2 条合成测试记录。' : null,
    result_ref: status === 'succeeded' ? 'f0000000-0000-4000-8000-000000000001' : null,
    error:
      status === 'failed'
        ? { code: 'tool_failed', message: '合成测试工具执行失败。' }
        : status === 'cancelled'
          ? { code: 'cancelled', message: '执行已取消。' }
          : null,
  };
}
export function toolUpdated(
  status: ToolExecutionSummary['status'] = 'running',
  sequence = '11',
): Extract<ProductFrame, { event_type: 'tool.updated' }> {
  return {
    ...sample('operation.updated'),
    event_type: 'tool.updated',
    event_seq: sequence,
    payload: { tool_execution: toolExecution(status) },
  };
}
