import {
  validateAgentContract,
  type ControlFrame,
  type EphemeralFrame,
  type ProductFrame,
} from '@tyde/shared/agent';
import { AgentEventError, decodeAgentEvent } from './protocol';
import type { RawSseEvent } from './sse-parser';

export interface EventBaseline {
  conversationId: string;
  streamId: string;
  eventSeq: string;
}

export interface EventApplicationContext {
  generation: number;
  /** Check again before an asynchronous application commits its own cache. */
  isCurrent(): boolean;
}

export interface AgentEventHandlers {
  applyProduct(frame: ProductFrame, context: EventApplicationContext): void | Promise<void>;
  onControl?(frame: ControlFrame, context: EventApplicationContext): void | Promise<void>;
  onDelta?(frame: EphemeralFrame, context: EventApplicationContext): void | Promise<void>;
}

export type EventApplication = 'applied' | 'duplicate' | 'control' | 'delta' | 'stale';

/**
 * A single in-memory view and its last successfully applied reliable cursor.
 * Create/reset only after the complete snapshot and its coverage cache have
 * been applied. This class does not fetch, reconnect, execute or persist tasks.
 */
export class AgentEventCursor {
  private baseline: EventBaseline;
  private currentGeneration = 0;
  private blocked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(baseline: EventBaseline) {
    this.validateBaseline(baseline);
    this.baseline = { ...baseline };
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get lastApplied(): Readonly<EventBaseline> {
    return { ...this.baseline };
  }

  /** Invalidates all old callbacks, including old asynchronous completions. */
  reset(baseline: EventBaseline): number {
    this.validateBaseline(baseline);
    this.currentGeneration += 1;
    this.baseline = { ...baseline };
    this.blocked = false;
    this.queue = Promise.resolve();
    return this.currentGeneration;
  }

  apply(
    raw: RawSseEvent,
    generation: number,
    handlers: AgentEventHandlers,
  ): Promise<EventApplication> {
    const operation = this.queue.then(() => this.applyInOrder(raw, generation, handlers));
    // Retain serial ordering even when a consumer has its own rejection handler.
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyInOrder(
    raw: RawSseEvent,
    generation: number,
    handlers: AgentEventHandlers,
  ): Promise<EventApplication> {
    if (generation !== this.currentGeneration) return 'stale';
    if (this.blocked) {
      throw new AgentEventError(
        'BASELINE_REQUIRED',
        '当前事件基线已阻断，需要核对兼容性或重建快照。',
      );
    }
    const context: EventApplicationContext = {
      generation,
      isCurrent: () => generation === this.currentGeneration,
    };
    try {
      const frame = decodeAgentEvent(raw);
      if (frame.frame_kind === 'product' || frame.frame_kind === 'delta') {
        if (
          frame.conversation_id !== this.baseline.conversationId ||
          frame.stream_id !== this.baseline.streamId
        ) {
          throw new AgentEventError(
            'STREAM_CHANGED',
            '当前事件不属于此会话和事件流，请重新读取快照。',
          );
        }
      }
      if (frame.frame_kind === 'control') {
        if (frame.code === 'ready' && frame.stream_id !== this.baseline.streamId) {
          throw new AgentEventError('STREAM_CHANGED', 'ready 帧属于另一事件流，请重新读取快照。');
        }
        if (frame.code === 'resync_required') this.blocked = true;
        await handlers.onControl?.(frame, context);
        return context.isCurrent() ? 'control' : 'stale';
      }
      if (frame.frame_kind === 'delta') {
        await handlers.onDelta?.(frame, context);
        return context.isCurrent() ? 'delta' : 'stale';
      }
      const previous = BigInt(this.baseline.eventSeq);
      const received = BigInt(frame.event_seq);
      if (received <= previous) return 'duplicate';
      if (received !== previous + 1n) {
        throw new AgentEventError('EVENT_GAP', '可靠事件出现序号缺口，不能跳到较新水位。');
      }
      await handlers.applyProduct(frame, context);
      if (!context.isCurrent()) return 'stale';
      this.baseline = { ...this.baseline, eventSeq: frame.event_seq };
      return 'applied';
    } catch (error) {
      if (!context.isCurrent()) return 'stale';
      this.blocked = true;
      if (error instanceof AgentEventError) throw error;
      throw new AgentEventError(
        'APPLICATION_FAILED',
        '事件应用失败，保留原游标并停止当前事件合并。',
      );
    }
  }

  private validateBaseline(baseline: EventBaseline): void {
    if (
      !validateAgentContract('UUID', baseline.conversationId) ||
      !validateAgentContract('ReadCursor', {
        stream_id: baseline.streamId,
        event_seq: baseline.eventSeq,
      })
    ) {
      throw new AgentEventError('INVALID_FRAME', '产品快照的会话或应用游标无效。');
    }
  }
}
