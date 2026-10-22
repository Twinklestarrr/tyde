import { readFileSync } from 'node:fs';
import type {
  ConversationView,
  EphemeralFrame,
  ProductFrame,
  SnapshotData,
  TaskView,
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
