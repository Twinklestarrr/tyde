import {
  validateAgentContract,
  type CommandRequest,
  type ConversationListItem,
  type ReadCursor,
  type ResponseEnvelope,
} from '@tyde/shared/agent';
import { AgentEventCursor, AgentEventError } from '../agent-events';
import {
  applyDelta,
  applyProduct,
  clearOverlays,
  fromSnapshot,
  mergeHistory,
  type ChatProjection,
} from '../agent-events/projection';
import { AgentApiError, AgentClient } from './agent-client';
import { taskExecutionPhase } from '../lib/task-state';
import { mergeConversationItem } from '../lib/conversation-list';

export interface PendingCommand {
  conversationId: string;
  command: CommandRequest;
  status: 'submitting' | 'unknown';
}

export interface ChatState {
  conversations: ConversationListItem[];
  listCursor: string | null;
  selectedId: string | null;
  view: ChatProjection | null;
  connection: 'idle' | 'loading' | 'connecting' | 'connected' | 'offline' | 'blocked';
  error: string | null;
  creating: boolean;
  listLoading: boolean;
  historyLoading: boolean;
  pending: PendingCommand | null;
}

class RetryStream extends Error {
  constructor(readonly milliseconds: number) {
    super('订阅暂时中断，正在重新连接。');
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentApiError && error.requestId)
    return `${error.message}（请求 ${error.requestId}）`;
  return error instanceof Error ? error.message : 'Agent 请求失败。';
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Owns one current read generation. Only explicit command methods start/stop work. */
export class ChatController {
  private state: ChatState = {
    conversations: [],
    listCursor: null,
    selectedId: null,
    view: null,
    connection: 'idle',
    error: null,
    creating: false,
    listLoading: false,
    historyLoading: false,
    pending: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private reading = new AbortController();
  private generation = 0;
  private listGeneration = 0;
  private cursor: AgentEventCursor | null = null;
  private pending = new Map<string, PendingCommand>();
  private disposed = false;
  private connectionError: string | null = null;

  constructor(private readonly client: AgentClient) {}

  getSnapshot = (): ChatState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ChatState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.reading.abort();
    this.lifetime.abort();
    this.listeners.clear();
    this.pending.clear();
    // Disconnecting never submits a stop command.
  }

  async refreshList(append = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.listGeneration;
    this.update({ listLoading: true });
    try {
      const response = await this.client.list(
        this.lifetime.signal,
        append ? (this.state.listCursor ?? undefined) : undefined,
      );
      if (this.disposed || generation !== this.listGeneration) return;
      const items = append
        ? new Map(this.state.conversations.map((item) => [item.conversation.id, item]))
        : new Map<string, ConversationListItem>();
      for (const item of response.data.items) {
        const previous = this.state.conversations.find(
          (entry) => entry.conversation.id === item.conversation.id,
        );
        items.set(item.conversation.id, mergeConversationItem(previous, item));
      }
      // A list page captured before creation/activity must not remove the open conversation.
      if (this.state.view) {
        const selected = this.state.conversations.find(
          (item) => item.conversation.id === this.state.view?.conversation.id,
        );
        if (selected && !items.has(selected.conversation.id))
          items.set(selected.conversation.id, selected);
      }
      this.update({ conversations: [...items.values()], listCursor: response.data.next_cursor });
    } catch (error) {
      if (!this.disposed && generation === this.listGeneration)
        this.update({ error: errorMessage(error) });
    } finally {
      if (generation === this.listGeneration) this.update({ listLoading: false });
    }
  }

  async create(): Promise<void> {
    if (this.disposed || this.state.creating) return;
    const generation = this.generation;
    this.update({ creating: true, error: null });
    try {
      const response = await this.client.create(this.lifetime.signal);
      if (this.disposed) return;
      await this.refreshList();
      if (this.current(generation)) await this.select(response.data.conversation.id);
    } catch (error) {
      await this.refreshList();
      if (this.current(generation))
        this.update({
          error: `${errorMessage(error)} 创建结果可能尚未确认，请刷新会话列表核对；本次创建不会自动重发。`,
        });
    } finally {
      this.update({ creating: false });
    }
  }

  async select(conversationId: string): Promise<void> {
    if (this.disposed) return;
    this.reading.abort();
    this.reading = new AbortController();
    const generation = ++this.generation;
    this.cursor = null;
    this.connectionError = null;
    this.update({
      selectedId: conversationId,
      view: null,
      connection: 'loading',
      error: null,
      historyLoading: false,
      pending: this.pending.get(conversationId) ?? null,
    });
    try {
      const response = await this.client.snapshot(conversationId, this.reading.signal);
      if (!this.current(generation)) return;
      if (response.data.conversation.id !== conversationId) throw new Error('快照返回了其他会话。');
      const view = fromSnapshot(response.data);
      this.cursor = new AgentEventCursor({
        conversationId,
        streamId: response.data.read_cursor.stream_id,
        eventSeq: response.data.read_cursor.event_seq,
      });
      this.update({
        view,
        connection: 'connecting',
        conversations: this.observeConversation(view, response.data.read_cursor),
      });
      void this.stream(generation, conversationId, this.reading.signal);
    } catch (error) {
      if (!this.current(generation)) return;
      this.update({ view: null, connection: 'blocked', error: errorMessage(error) });
      if (error instanceof AgentApiError && error.status === 404) {
        this.update({
          error: '这个会话已不可访问。开发内存服务重启会清空旧会话，请刷新列表或新建会话。',
        });
        void this.refreshList();
      }
    }
  }

  private async stream(generation: number, conversationId: string, signal: AbortSignal) {
    let failures = 0;
    while (this.current(generation) && !signal.aborted) {
      const cursor = this.cursor;
      if (!cursor) return;
      const baseline = cursor.lastApplied;
      const requested = baseline.eventSeq;
      try {
        this.update({ connection: 'connecting' });
        await this.client.events(
          conversationId,
          { stream_id: baseline.streamId, event_seq: requested },
          async (raw) => {
            if (!this.current(generation)) return;
            let controlFailure: Error | undefined;
            await cursor.apply(raw, cursor.generation, {
              applyProduct: (frame) => {
                if (!this.current(generation) || !this.state.view) return;
                const view = applyProduct(this.state.view, frame);
                this.update({
                  view,
                  conversations: this.observeConversation(view, {
                    stream_id: frame.stream_id,
                    event_seq: frame.event_seq,
                  }),
                });
                failures = 0;
              },
              onDelta: (frame) => {
                if (this.current(generation) && this.state.view)
                  this.update({ view: applyDelta(this.state.view, frame) });
              },
              onControl: (frame) => {
                if (!this.current(generation)) return;
                if (frame.code === 'ready') {
                  if (frame.accepted_after_seq !== requested)
                    throw new AgentEventError('STREAM_CHANGED', '订阅基线与请求位置不一致。');
                  this.update({
                    connection: 'connected',
                    ...(this.state.error === this.connectionError ? { error: null } : {}),
                  });
                  this.connectionError = null;
                } else if (frame.code === 'resync_required') {
                  controlFailure = new AgentEventError(
                    'BASELINE_REQUIRED',
                    '服务要求重新读取快照。',
                  );
                } else if (frame.code === 'reauthenticate') {
                  controlFailure = new AgentApiError(
                    '身份已失效，请重新连接身份。',
                    401,
                    'UNAUTHENTICATED',
                  );
                } else {
                  controlFailure = new RetryStream(Math.min(frame.retry_after_ms, 30_000));
                }
              },
            });
            if (controlFailure) throw controlFailure;
          },
          signal,
        );
        throw new Error('事件连接已断开。');
      } catch (error) {
        if (!this.current(generation) || signal.aborted) return;
        if (this.state.view) this.update({ view: clearOverlays(this.state.view) });
        if (error instanceof AgentEventError) {
          if (['STREAM_CHANGED', 'EVENT_GAP', 'BASELINE_REQUIRED'].includes(error.code)) {
            this.update({
              connection: 'offline',
              error: `${error.message} 正在重新读取完整快照。`,
            });
            await wait(250, signal).catch(() => undefined);
            if (this.current(generation)) await this.select(conversationId);
          } else {
            this.update({ connection: 'blocked', error: error.message });
          }
          return;
        }
        if (error instanceof AgentApiError) {
          if ([401, 403, 404].includes(error.status)) {
            if (error.status === 401) this.pending.clear();
            else this.pending.delete(conversationId);
            this.update({
              view: null,
              pending: null,
              conversations:
                error.status === 401
                  ? []
                  : this.state.conversations.filter(
                      (item) => item.conversation.id !== conversationId,
                    ),
              connection: 'blocked',
              error: errorMessage(error),
            });
            return;
          }
          if (error.action === 'reload_snapshot') {
            await this.select(conversationId);
            return;
          }
          if (error.code === 'INVALID_RESPONSE') {
            this.update({ connection: 'blocked', error: error.message });
            return;
          }
        }
        failures += 1;
        this.connectionError = `${errorMessage(error)} ${failures > 5 ? '自动重连已暂停，可点击重新连接。' : '将从已应用游标重新订阅。'}`;
        this.update({
          connection: 'offline',
          error: this.connectionError,
        });
        if (failures > 5) return;
        const delay =
          error instanceof RetryStream
            ? error.milliseconds
            : Math.min(500 * 2 ** (failures - 1), 8_000);
        await wait(delay, signal).catch(() => undefined);
      }
    }
  }

  private observeConversation(view: ChatProjection, cursor: ReadCursor) {
    const incoming = { conversation: view.conversation, read_cursor: cursor };
    const previous = this.state.conversations.find(
      (item) => item.conversation.id === view.conversation.id,
    );
    const merged = mergeConversationItem(previous, incoming);
    return previous
      ? this.state.conversations.map((item) =>
          item.conversation.id === view.conversation.id ? merged : item,
        )
      : [merged, ...this.state.conversations];
  }

  async history(): Promise<void> {
    const { view, selectedId } = this.state;
    const cursor = this.cursor?.lastApplied;
    if (
      !view ||
      !selectedId ||
      !cursor ||
      !view.page.next_before_message_seq ||
      this.state.historyLoading
    )
      return;
    const generation = this.generation;
    this.update({ historyLoading: true });
    try {
      const response = await this.client.history(
        selectedId,
        { stream_id: cursor.streamId, event_seq: cursor.eventSeq },
        view.page.upper_message_seq,
        view.page.next_before_message_seq,
        this.reading.signal,
      );
      if (!this.current(generation) || !this.state.view) return;
      if (response.data.read_cursor.stream_id !== cursor.streamId)
        throw new AgentEventError('STREAM_CHANGED', '历史响应的事件流已变化。');
      this.update({ view: mergeHistory(this.state.view, response.data) });
    } catch (error) {
      if (!this.current(generation)) return;
      if (
        error instanceof AgentEventError ||
        (error instanceof AgentApiError && error.action === 'reload_snapshot')
      )
        await this.select(selectedId);
      else this.update({ error: errorMessage(error) });
    } finally {
      if (this.current(generation)) this.update({ historyLoading: false });
    }
  }

  async send(text: string): Promise<boolean> {
    if (!validateAgentContract('UserInput', { text })) {
      this.update({ error: '消息需为 1—16000 个 Unicode 字符，且不能全为空白。' });
      return false;
    }
    const { view, selectedId } = this.state;
    if (
      !view ||
      !selectedId ||
      this.pending.has(selectedId) ||
      (view.focusTask && view.focusTask.status !== 'completed')
    )
      return false;
    const command: CommandRequest = {
      schema_version: 1,
      request_key: crypto.randomUUID(),
      kind: 'start_task',
      task_kind: 'business_query',
      input: { text },
    };
    return this.submit({ conversationId: selectedId, command, status: 'submitting' });
  }

  async stop(): Promise<boolean> {
    const { view, selectedId } = this.state;
    const task = view?.focusTask;
    if (
      !task?.active_attempt_id ||
      taskExecutionPhase(task) === 'budget_closing' ||
      !selectedId ||
      this.pending.has(selectedId)
    )
      return false;
    const command: CommandRequest = {
      schema_version: 1,
      request_key: crypto.randomUUID(),
      kind: 'stop_attempt',
      task_id: task.id,
      target_attempt_id: task.active_attempt_id,
    };
    return this.submit({ conversationId: selectedId, command, status: 'submitting' });
  }

  async verifyPending(): Promise<boolean> {
    const pending = this.state.pending;
    if (!pending || pending.status === 'submitting') return false;
    return this.verify(pending);
  }

  async resendPending(): Promise<boolean> {
    const pending = this.state.pending;
    if (!pending || pending.status === 'submitting') return false;
    return this.submit(pending);
  }

  private showPending(pending: PendingCommand) {
    this.pending.set(pending.conversationId, pending);
    if (this.state.selectedId === pending.conversationId) this.update({ pending });
  }

  private async confirmed(
    pending: PendingCommand,
    applied: boolean,
    message?: string,
  ): Promise<boolean> {
    if (this.disposed) return false;
    this.pending.delete(pending.conversationId);
    if (this.state.selectedId === pending.conversationId && !this.disposed) {
      this.update({ pending: null });
      await this.select(pending.conversationId);
      if (message && this.state.selectedId === pending.conversationId)
        this.update({ error: message });
    }
    void this.refreshList();
    return applied;
  }

  private async submit(original: PendingCommand): Promise<boolean> {
    const pending: PendingCommand = { ...original, status: 'submitting' };
    this.showPending(pending);
    try {
      const response: ResponseEnvelope = await this.client.command(
        pending.conversationId,
        pending.command,
        this.lifetime.signal,
      );
      if (response.command)
        return this.confirmed(
          pending,
          response.command.status === 'applied',
          response.error?.message,
        );
      if (this.state.selectedId === pending.conversationId)
        this.update({ error: response.error.message });
    } catch (error) {
      if (this.state.selectedId === pending.conversationId)
        this.update({ error: errorMessage(error) });
    }
    if (this.disposed) return false;
    return this.verify(pending);
  }

  private async verify(pending: PendingCommand): Promise<boolean> {
    this.showPending({ ...pending, status: 'submitting' });
    try {
      const response = await this.client.lookup(
        pending.conversationId,
        pending.command.request_key,
        this.lifetime.signal,
      );
      return this.confirmed(
        pending,
        response.data.receipt.command.status === 'applied',
        response.data.receipt.error?.message,
      );
    } catch (error) {
      if (this.disposed) return false;
      this.showPending({ ...pending, status: 'unknown' });
      if (this.state.selectedId === pending.conversationId)
        this.update({
          error: `${errorMessage(error)} 原请求结果尚未确认；查询未命中也不代表请求没有执行。`,
        });
      return false;
    }
  }
}
