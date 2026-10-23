import {
  validateAgentContract,
  type ControlFrame,
  type EphemeralFrame,
  type ProductFrame,
} from '@tyde/shared/agent';
import type { RawSseEvent } from './sse-parser';

export type AgentEventFrame = ProductFrame | ControlFrame | EphemeralFrame;
export type AgentEventErrorCode =
  | 'INVALID_FRAME'
  | 'UNSUPPORTED_EVENT'
  | 'STREAM_CHANGED'
  | 'EVENT_GAP'
  | 'APPLICATION_FAILED'
  | 'BASELINE_REQUIRED';

export class AgentEventError extends Error {
  constructor(
    readonly code: AgentEventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentEventError';
  }
}

function invalid(message: string): never {
  throw new AgentEventError('INVALID_FRAME', message);
}

/** Validate the JSON and the surrounding SSE fields together. */
export function decodeAgentEvent(raw: RawSseEvent): AgentEventFrame {
  let data: unknown;
  try {
    data = JSON.parse(raw.data);
  } catch {
    return invalid('SSE data 不是完整的 JSON。');
  }
  if (raw.event === 'product') {
    if (!validateAgentContract('ProductFrame', data)) {
      return invalid('可靠事件结构或版本不受支持，不能跳过此事件。');
    }
    const frame = data as ProductFrame;
    if (raw.id !== `${frame.stream_id}:${frame.event_seq}`) {
      return invalid('可靠事件的 SSE id 与产品游标不一致。');
    }
    validateProductLinks(frame);
    return frame;
  }
  if (raw.event === 'control') {
    if (raw.id !== undefined || !validateAgentContract('ControlFrame', data)) {
      return invalid('控制帧不符合契约或携带了持久 id。');
    }
    const frame = data as ControlFrame;
    if (
      frame.code === 'ready' &&
      (BigInt(frame.pruned_through_seq) > BigInt(frame.accepted_after_seq) ||
        BigInt(frame.accepted_after_seq) > BigInt(frame.observed_head_seq))
    ) {
      return invalid('ready 帧的裁剪、接受和观察水位顺序不正确。');
    }
    return frame;
  }
  if (raw.event === 'delta') {
    if (raw.id !== undefined || !validateAgentContract('EphemeralFrame', data)) {
      return invalid('临时片段不符合契约或携带了持久 id。');
    }
    return data as EphemeralFrame;
  }
  throw new AgentEventError('UNSUPPORTED_EVENT', 'SSE event 类型不受支持。');
}

function validateProductLinks(frame: ProductFrame): void {
  const belongsToConversation = (conversationId: string): void => {
    if (conversationId !== frame.conversation_id) invalid('可靠事件携带了其他会话的对象。');
  };
  switch (frame.event_type) {
    case 'conversation.updated':
      belongsToConversation(frame.payload.conversation.id);
      break;
    case 'task.updated':
      belongsToConversation(frame.payload.task.conversation_id);
      break;
    case 'task.completed': {
      const { task, result, message } = frame.payload;
      belongsToConversation(task.conversation_id);
      belongsToConversation(result.conversation_id);
      belongsToConversation(message.conversation_id);
      if (
        task.id !== result.task_id ||
        task.id !== message.task_id ||
        task.result_id !== result.id ||
        message.result_id !== result.id ||
        task.latest_attempt.id !== result.delivery_attempt_id ||
        message.attempt_id !== result.delivery_attempt_id
      ) {
        invalid('完成事件中的任务、结果和最终消息没有对应同一次交付。');
      }
      if (BigInt(message.message_seq) > BigInt(frame.activity.last_message_seq)) {
        invalid('最终消息序号超过事件冻结的会话消息水位。');
      }
      break;
    }
    case 'message.created':
    case 'message.updated': {
      const { message, input_receipt: receipt } = frame.payload;
      belongsToConversation(message.conversation_id);
      if (BigInt(message.message_seq) > BigInt(frame.activity.last_message_seq)) {
        invalid('消息序号超过事件冻结的会话消息水位。');
      }
      if (
        receipt !== null &&
        (receipt.user_message_id !== message.id ||
          receipt.task_id !== message.task_id ||
          receipt.command_id !== message.source_command_id)
      ) {
        invalid('输入消费投影没有对应本事件的用户消息。');
      }
      break;
    }
    case 'tool.updated':
      belongsToConversation(frame.payload.tool_execution.conversation_id);
      break;
    case 'input.updated':
    case 'operation.updated':
      break;
    default: {
      const unsupported: never = frame;
      throw new AgentEventError('UNSUPPORTED_EVENT', `可靠事件不受支持：${String(unsupported)}`);
    }
  }
}
