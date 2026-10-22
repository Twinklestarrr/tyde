import type {
  ConversationView,
  EphemeralFrame,
  InputReceipt,
  MessageHistoryData,
  MessagePage,
  MessageView,
  OperationSummary,
  ProductFrame,
  ResultView,
  SnapshotData,
  TaskView,
} from '@tyde/shared/agent';
import { AgentEventError } from './protocol';

interface Overlay {
  stream: string;
  attempt: string;
  index: number;
  text: string;
  blocked: boolean;
  retired: string[];
}

export interface ChatProjection {
  conversation: ConversationView;
  focusTask: TaskView | null;
  messages: Map<string, MessageView>;
  receipts: Map<string, InputReceipt>;
  results: Map<string, ResultView>;
  operations: Map<string, OperationSummary>;
  overlays: Map<string, Overlay>;
  page: MessagePage;
  activitySeq: string;
}

const MAX_OBJECTS = 4096;
const MAX_OVERLAY_CHARACTERS = 1024 * 1024;

function versioned<T extends { id: string; row_version: string }>(map: Map<string, T>, value: T) {
  const previous = map.get(value.id);
  if (!previous || BigInt(previous.row_version) < BigInt(value.row_version))
    map.set(value.id, value);
}

function receipt(map: Map<string, InputReceipt>, value: InputReceipt) {
  const previous = map.get(value.command_id);
  if (previous && previous.input_state !== 'pending') {
    if (value.input_state === 'pending') return;
    if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('输入消费终态矛盾。');
  }
  map.set(value.command_id, value);
}

function result(map: Map<string, ResultView>, value: ResultView) {
  const previous = map.get(value.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('不可变结果发生变化。');
  map.set(value.id, value);
}

function clone(view: ChatProjection): ChatProjection {
  return {
    ...view,
    messages: new Map(view.messages),
    receipts: new Map(view.receipts),
    results: new Map(view.results),
    operations: new Map(view.operations),
    overlays: new Map(view.overlays),
  };
}

function bounded(view: ChatProjection): ChatProjection {
  if (
    view.messages.size + view.receipts.size + view.results.size + view.operations.size >
    MAX_OBJECTS
  ) {
    throw new AgentEventError('BASELINE_REQUIRED', '会话缓存达到本机容量，需要重新读取快照。');
  }
  return view;
}

function mergeContent(
  view: ChatProjection,
  data: Pick<SnapshotData, 'messages' | 'input_receipts' | 'results' | 'operations'>,
) {
  for (const message of data.messages) {
    if (message.conversation_id !== view.conversation.id) throw new Error('消息属于其他会话。');
    versioned(view.messages, message);
    if (view.messages.get(message.id)?.status !== 'in_progress') view.overlays.delete(message.id);
  }
  for (const value of data.input_receipts) receipt(view.receipts, value);
  for (const value of data.results) {
    if (value.conversation_id !== view.conversation.id) throw new Error('结果属于其他会话。');
    result(view.results, value);
  }
  for (const value of data.operations) versioned(view.operations, value);
}

/** Complete snapshot content and its coverage maps are installed as one value. */
export function fromSnapshot(data: SnapshotData): ChatProjection {
  if (data.focus_task && data.focus_task.conversation_id !== data.conversation.id)
    throw new Error('快照任务不属于当前会话。');
  const view: ChatProjection = {
    conversation: data.conversation,
    focusTask: data.focus_task,
    messages: new Map(),
    receipts: new Map(),
    results: new Map(),
    operations: new Map(),
    overlays: new Map(),
    page: data.page,
    activitySeq: data.read_cursor.event_seq,
  };
  mergeContent(view, { ...data, messages: [...data.messages, ...data.pinned_messages] });
  return bounded(view);
}

/** A history page may carry newer entities, but never acknowledges reliable events. */
export function mergeHistory(view: ChatProjection, data: MessageHistoryData): ChatProjection {
  const next = clone(view);
  mergeContent(next, data);
  next.page = data.page;
  return bounded(next);
}

export function applyProduct(view: ChatProjection, frame: ProductFrame): ChatProjection {
  const next = clone(view);
  if (BigInt(frame.event_seq) >= BigInt(next.activitySeq)) {
    next.conversation = { ...next.conversation, activity: frame.activity };
    next.activitySeq = frame.event_seq;
  }
  const task = (value: TaskView) => {
    if (
      !next.focusTask ||
      next.focusTask.id !== value.id ||
      BigInt(value.row_version) > BigInt(next.focusTask.row_version)
    )
      next.focusTask = value;
  };
  switch (frame.event_type) {
    case 'conversation.updated':
      if (BigInt(frame.payload.conversation.row_version) >= BigInt(next.conversation.row_version)) {
        next.conversation = { ...frame.payload.conversation, activity: next.conversation.activity };
      }
      break;
    case 'task.updated':
      task(frame.payload.task);
      break;
    case 'task.completed':
      task(frame.payload.task);
      result(next.results, frame.payload.result);
      versioned(next.messages, frame.payload.message);
      next.overlays.delete(frame.payload.message.id);
      break;
    case 'message.created':
    case 'message.updated':
      versioned(next.messages, frame.payload.message);
      if (frame.payload.input_receipt) receipt(next.receipts, frame.payload.input_receipt);
      if (next.messages.get(frame.payload.message.id)?.status !== 'in_progress')
        next.overlays.delete(frame.payload.message.id);
      break;
    case 'input.updated':
      receipt(next.receipts, frame.payload.input_receipt);
      break;
    case 'operation.updated':
      versioned(next.operations, frame.payload.operation);
      break;
  }
  return bounded(next);
}

/** Unreliable overlays are discarded on a missing index, reconnect, or final message. */
export function applyDelta(view: ChatProjection, frame: EphemeralFrame): ChatProjection {
  const message = view.messages.get(frame.message_id);
  if (!message || message.status !== 'in_progress' || message.attempt_id !== frame.attempt_id)
    return view;
  const previous = view.overlays.get(frame.message_id);
  if (previous?.retired.includes(frame.output_stream_id)) return view;
  if (previous && previous.stream === frame.output_stream_id && frame.delta_index <= previous.index)
    return view;
  const next = clone(view);
  const same = previous?.stream === frame.output_stream_id;
  const retired = same ? previous.retired : previous ? [...previous.retired, previous.stream] : [];
  const blocked =
    (same && previous.blocked) ||
    retired.length > 32 ||
    frame.delta_index !== (same ? previous.index + 1 : 1);
  const text = blocked ? '' : `${same ? previous.text : ''}${frame.text}`;
  const totalCharacters = [...view.overlays.entries()].reduce(
    (total, [id, overlay]) => total + (id === frame.message_id ? 0 : overlay.text.length),
    text.length,
  );
  next.overlays.set(frame.message_id, {
    stream: frame.output_stream_id,
    attempt: frame.attempt_id,
    index: frame.delta_index,
    text: totalCharacters <= MAX_OVERLAY_CHARACTERS ? text : '',
    retired: retired.slice(-33),
    blocked: Boolean(blocked || totalCharacters > MAX_OVERLAY_CHARACTERS),
  });
  return next;
}

export function clearOverlays(view: ChatProjection): ChatProjection {
  return { ...view, overlays: new Map() };
}

export function messageText(view: ChatProjection, message: MessageView): string {
  if (message.result_id) {
    const result = view.results.get(message.result_id);
    if (result?.result_type === 'answer')
      return result.payload.blocks.map((block) => block.text).join('\n\n');
    if (result?.result_type === 'scheduling_draft') return result.payload.summary;
  }
  const authoritative = message.content.blocks.map((block) => block.text).join('\n\n');
  if (message.status !== 'in_progress') return authoritative;
  return view.overlays.get(message.id)?.text || authoritative;
}
