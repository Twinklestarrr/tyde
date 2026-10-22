import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  validateAgentContract,
  type CommandLookupData,
  type CommandReceipt,
  type CommandRequest,
  type ConversationDetailData,
  type ConversationListData,
  type ConversationView,
  type CreateConversationData,
  type Decision,
  type EphemeralFrame,
  type InputReceipt,
  type MessageHistoryData,
  type MessagePage,
  type MessageView,
  type ProductFrame,
  type ReadCursor,
  type ReadError,
  type ReadyControlFrame,
  type RejectedError,
  type ResponseEnvelope,
  type ResultDetailData,
  type ResultView,
  type SnapshotData,
  type TaskDetailData,
  type TaskView,
  type UnconfirmedError,
} from '@tyde/shared/agent';
import { requireOwnedConversation, type AgentPrincipal } from '../auth/access.js';
import { prepareCommand } from '../commands/prepare-command.js';
import { AttemptBudget, type AttemptBudgetClock } from '../execution/attempt-budget.js';
import type { PiMemoryBarriers, PiMemorySession } from '../pi/session.js';

export type RuntimeFrame = ProductFrame | EphemeralFrame;
export type RuntimeSession = Pick<PiMemorySession, 'prompt' | 'stop' | 'dispose'>;

export interface AgentMemoryRuntimeOptions {
  createSession(conversationId: string, barriers: PiMemoryBarriers): Promise<RuntimeSession>;
  now?: () => number;
  budgetClock?: AttemptBudgetClock;
  id?: () => string;
  /** 仅裁剪完整产品事件前缀；过期订阅必须重新建立快照。 */
  maxEventsPerConversation?: number;
}

export class AgentRuntimeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ReadError['code'],
    message: string,
    public readonly action: ReadError['action'] = 'fix_request',
    public readonly details: ReadError['details'] = {},
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

interface SavedCommand {
  conversationId: string;
  payloadHash: string;
  receipt: CommandReceipt;
}

interface Execution {
  task: TaskView;
  commandId: string;
  output: MessageView;
  outputStreamId: string;
  deltaIndex: number;
  budget: AttemptBudget;
  text: string;
}

interface Conversation {
  ownerUserId: string;
  deletedAt: null;
  view: ConversationView;
  useFirstInputAsTitle: boolean;
  streamId: string;
  head: bigint;
  pruned: bigint;
  messages: MessageView[];
  tasks: TaskView[];
  results: Map<string, ResultView>;
  inputs: Map<string, InputReceipt>;
  events: ProductFrame[];
  listeners: Set<(frame: RuntimeFrame) => void>;
  session?: Promise<RuntimeSession>;
  active?: Execution;
}

function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(copy);
  return copy;
}

const invalid = (message = '请求参数不符合契约') =>
  new AgentRuntimeError(422, 'INVALID_REQUEST', message);
const missing = () =>
  new AgentRuntimeError(404, 'RESOURCE_NOT_FOUND', '资源不存在或不可访问', 'none');
const increment = (value: string) => (BigInt(value) + 1n).toString();

/** W3 单进程协调器。同步段是原子提交边界，绝不跨模型等待持锁。 */
export class AgentMemoryRuntime {
  private readonly conversations = new Map<string, Conversation>();
  private readonly commands = new Map<string, SavedCommand>();
  private readonly cursorSecret = randomBytes(32);
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly eventLimit: number;
  private closed = false;

  constructor(private readonly options: AgentMemoryRuntimeOptions) {
    this.now = options.now ?? options.budgetClock?.now.bind(options.budgetClock) ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.eventLimit = options.maxEventsPerConversation ?? 10_000;
    if (!Number.isSafeInteger(this.eventLimit) || this.eventLimit < 1) {
      throw new Error('产品事件保留上限必须为正整数');
    }
  }

  createConversation(principal: AgentPrincipal, body: unknown): CreateConversationData {
    this.assertOpen();
    if (this.unsupportedVersion(body)) {
      throw new AgentRuntimeError(422, 'UNSUPPORTED_SCHEMA_VERSION', '仅支持公开结构版本 1');
    }
    if (!validateAgentContract('CreateConversationRequest', body)) throw invalid();
    const timestamp = this.timestamp();
    const conversation: Conversation = {
      ownerUserId: principal.userId,
      deletedAt: null,
      view: {
        id: this.id(),
        title: body.title ?? '新会话',
        row_version: '1',
        created_at: timestamp,
        activity: { last_activity_at: timestamp, last_message_seq: '0' },
      },
      useFirstInputAsTitle: body.title === undefined,
      streamId: this.id(),
      head: 0n,
      pruned: 0n,
      messages: [],
      tasks: [],
      results: new Map(),
      inputs: new Map(),
      events: [],
      listeners: new Set(),
    };
    this.conversations.set(conversation.view.id, conversation);
    return structuredClone({
      conversation: conversation.view,
      focus_task: null,
      read_cursor: this.cursor(conversation),
    });
  }

  listConversations(
    principal: AgentPrincipal,
    query: { limit?: number; cursor?: string } = {},
  ): ConversationListData {
    this.assertOpen();
    const limit = this.limit(query.limit, 20);
    let after: { activity: string; id: string } | undefined;
    if (query.cursor !== undefined) after = this.decodeCursor(query.cursor, principal, limit);
    const items = [...this.conversations.values()]
      .filter((entry) => entry.ownerUserId === principal.userId)
      .sort(
        (left, right) =>
          right.view.activity.last_activity_at.localeCompare(left.view.activity.last_activity_at) ||
          right.view.id.localeCompare(left.view.id),
      )
      .filter(
        (entry) =>
          !after ||
          entry.view.activity.last_activity_at < after.activity ||
          (entry.view.activity.last_activity_at === after.activity && entry.view.id < after.id),
      );
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return structuredClone({
      items: page.map((entry) => ({ conversation: entry.view, read_cursor: this.cursor(entry) })),
      has_more: items.length > limit,
      next_cursor: items.length > limit && last ? this.encodeCursor(last, principal, limit) : null,
    });
  }

  getConversation(principal: AgentPrincipal, id: string): ConversationDetailData {
    const conversation = this.owned(principal, id);
    return structuredClone({
      conversation: conversation.view,
      focus_task: this.focus(conversation),
      read_cursor: this.cursor(conversation),
    });
  }

  getSnapshot(principal: AgentPrincipal, id: string, messageLimit = 50): SnapshotData {
    const conversation = this.owned(principal, id);
    const limit = this.limit(messageLimit, 50);
    const messages = conversation.messages.slice(-limit);
    const selected = new Set(messages.map((message) => message.id));
    const pinned = conversation.messages.filter(
      (message) => message.status === 'in_progress' && !selected.has(message.id),
    );
    const focus = this.focus(conversation);
    return structuredClone({
      conversation: conversation.view,
      focus_task: focus,
      messages,
      pinned_messages: pinned,
      input_receipts: this.inputsFor(conversation, [...messages, ...pinned], focus?.id),
      results: this.resultsFor(conversation, [...messages, ...pinned], focus?.result_id),
      operations: [],
      page: this.page(conversation, messages, conversation.view.activity.last_message_seq),
      read_cursor: this.cursor(conversation),
      event_pruned_through_seq: conversation.pruned.toString(),
    });
  }

  listMessages(
    principal: AgentPrincipal,
    id: string,
    query: {
      streamId: string;
      upperMessageSeq: string;
      beforeMessageSeq?: string;
      limit?: number;
    },
  ): MessageHistoryData {
    const conversation = this.owned(principal, id);
    this.stream(conversation, query.streamId);
    if (!validateAgentContract('NonNegativeBigInt', query.upperMessageSeq)) throw invalid();
    const upper = BigInt(query.upperMessageSeq);
    if (upper > BigInt(conversation.view.activity.last_message_seq)) {
      throw invalid('消息上界超过当前消息水位');
    }
    if (
      query.beforeMessageSeq !== undefined &&
      (!validateAgentContract('PositiveBigInt', query.beforeMessageSeq) ||
        BigInt(query.beforeMessageSeq) > upper)
    ) {
      throw invalid('历史分页边界无效');
    }
    const messages = conversation.messages
      .filter(
        (message) =>
          BigInt(message.message_seq) <= upper &&
          (query.beforeMessageSeq === undefined ||
            BigInt(message.message_seq) < BigInt(query.beforeMessageSeq)),
      )
      .slice(-this.limit(query.limit, 50));
    return structuredClone({
      messages,
      input_receipts: this.inputsFor(conversation, messages),
      results: this.resultsFor(conversation, messages),
      operations: [],
      page: this.page(conversation, messages, query.upperMessageSeq),
      read_cursor: this.cursor(conversation),
    });
  }

  getTask(principal: AgentPrincipal, id: string, taskId: string): TaskDetailData {
    const conversation = this.owned(principal, id);
    const task = this.task(conversation, taskId);
    return structuredClone({
      task,
      operations: [],
      result: task.result_id ? conversation.results.get(task.result_id)! : null,
      read_cursor: this.cursor(conversation),
    });
  }

  getResult(principal: AgentPrincipal, id: string, resultId: string): ResultDetailData {
    const conversation = this.owned(principal, id);
    if (!validateAgentContract('UUID', resultId)) throw invalid();
    const result = conversation.results.get(resultId.toLowerCase());
    if (!result) throw missing();
    return structuredClone({ result, operations: [], read_cursor: this.cursor(conversation) });
  }

  getCommand(principal: AgentPrincipal, id: string, requestKey: string): CommandLookupData {
    const conversation = this.owned(principal, id);
    if (!validateAgentContract('UUID', requestKey)) throw invalid();
    const command = this.commands.get(this.commandKey(principal, requestKey));
    if (!command || command.conversationId !== conversation.view.id) throw missing();
    return structuredClone({
      receipt: command.receipt,
      input_receipt: conversation.inputs.get(command.receipt.command.id) ?? null,
      read_cursor: this.cursor(conversation),
    });
  }

  submitCommand(
    principal: AgentPrincipal,
    id: string,
    body: unknown,
    requestId = randomUUID(),
  ): { statusCode: number; body: ResponseEnvelope } {
    const conversation = this.owned(principal, id);
    if (this.unsupportedVersion(body)) {
      return this.unconfirmed(requestId, 422, 'UNSUPPORTED_SCHEMA_VERSION', '仅支持公开结构版本 1');
    }
    if (!validateAgentContract('CommandRequest', body)) {
      return this.unconfirmed(requestId, 422, 'INVALID_REQUEST', '命令不符合 v1 契约');
    }
    const prepared = prepareCommand(conversation.view.id, body);
    const key = this.commandKey(principal, prepared.requestKey);
    const previous = this.commands.get(key);
    if (previous) {
      if (previous.payloadHash !== prepared.payloadHash) {
        return this.unconfirmed(
          requestId,
          409,
          'IDEMPOTENCY_KEY_CONFLICT',
          '同一请求标识已用于不同原意图，请核实原命令',
        );
      }
      return this.commandResponse(previous.receipt, requestId, true);
    }
    // 尚无恢复与业务工具能力，不把 SDK 方法冒充产品继续、补充或重试。
    if (body.kind !== 'start_task' && body.kind !== 'stop_attempt') {
      return this.unconfirmed(requestId, 422, 'INVALID_REQUEST', '开发内存模式尚未开放此命令');
    }
    if (body.kind === 'start_task' && body.task_kind !== 'business_query') {
      return this.unconfirmed(requestId, 422, 'INVALID_REQUEST', '本阶段仅支持聊天问答任务');
    }
    const commandId = this.id();
    let receipt: CommandReceipt;
    if (body.kind === 'start_task') {
      const unfinished = conversation.tasks.find((task) => task.status !== 'completed');
      if (unfinished) {
        receipt = this.rejected(
          conversation,
          body,
          commandId,
          unfinished,
          'UNFINISHED_TASK_EXISTS',
        );
      } else {
        receipt = this.start(conversation, body, commandId);
      }
    } else {
      // 目标关联先于任何确定拒绝；跨会话目标不泄漏存在性。
      const target = this.task(conversation, body.task_id);
      if (target.latest_attempt.id !== body.target_attempt_id.toLowerCase()) throw missing();
      receipt = this.stop(conversation, body, commandId, target);
    }
    this.commands.set(key, {
      conversationId: conversation.view.id,
      payloadHash: prepared.payloadHash,
      receipt: frozen(receipt),
    });
    return this.commandResponse(receipt, requestId, false);
  }

  /** 同步注册并冻结补读上界，之后只发送新事件；关闭订阅绝不停止执行。 */
  subscribe(
    principal: AgentPrincipal,
    id: string,
    options: {
      streamId: string;
      afterEventSeq: string;
      onFrame(frame: RuntimeFrame): void;
    },
  ): { ready: ReadyControlFrame; replay: readonly ProductFrame[]; close(): void } {
    const conversation = this.owned(principal, id);
    this.stream(conversation, options.streamId);
    if (!validateAgentContract('NonNegativeBigInt', options.afterEventSeq)) throw invalid();
    const after = BigInt(options.afterEventSeq);
    const details = {
      current_stream_id: conversation.streamId,
      pruned_through_seq: conversation.pruned.toString(),
      head_seq: conversation.head.toString(),
    };
    if (after < conversation.pruned) {
      throw new AgentRuntimeError(
        410,
        'CURSOR_EXPIRED',
        '事件游标已过期',
        'reload_snapshot',
        details,
      );
    }
    if (after > conversation.head) {
      throw new AgentRuntimeError(
        409,
        'CURSOR_AHEAD',
        '事件游标超过当前水位',
        'reload_snapshot',
        details,
      );
    }
    const replay = conversation.events.filter((frame) => BigInt(frame.event_seq) > after);
    let expected = after + 1n;
    for (const frame of replay) {
      if (BigInt(frame.event_seq) !== expected++) {
        throw new AgentRuntimeError(
          503,
          'EVENT_HISTORY_GAP',
          '事件历史不连续',
          'reload_snapshot',
          details,
        );
      }
    }
    if (expected !== conversation.head + 1n) {
      throw new AgentRuntimeError(
        503,
        'EVENT_HISTORY_GAP',
        '事件历史不完整',
        'reload_snapshot',
        details,
      );
    }
    const listener = (frame: RuntimeFrame) => options.onFrame(frame);
    conversation.listeners.add(listener);
    return {
      ready: {
        schema_version: 1,
        frame_kind: 'control',
        code: 'ready',
        stream_id: conversation.streamId,
        accepted_after_seq: after.toString(),
        observed_head_seq: conversation.head.toString(),
        pruned_through_seq: conversation.pruned.toString(),
      },
      replay: frozen(replay),
      close: () => conversation.listeners.delete(listener),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cleanup: Promise<void>[] = [];
    const acquired = new Set<RuntimeSession>();
    let cleanupExpired = false;
    for (const conversation of this.conversations.values()) {
      conversation.listeners.clear();
      conversation.active?.budget.requestStop();
      conversation.active?.budget.finish();
      if (conversation.session) {
        cleanup.push(
          conversation.session.then(
            async (session) => {
              acquired.add(session);
              if (cleanupExpired) {
                void session.stop().catch(() => {});
                session.dispose();
                acquired.delete(session);
                return;
              }
              try {
                await session.stop();
              } finally {
                session.dispose();
                acquired.delete(session);
              }
            },
            () => {},
          ),
        );
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(cleanup),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      cleanupExpired = true;
      for (const session of acquired) session.dispose();
    }
  }

  private start(
    conversation: Conversation,
    request: Extract<CommandRequest, { kind: 'start_task' }>,
    commandId: string,
  ): CommandReceipt {
    const timestamp = this.timestamp();
    const task: TaskView = {
      id: this.id(),
      conversation_id: conversation.view.id,
      task_kind: request.task_kind,
      goal_text: request.input.text,
      business_scope: structuredClone(request.input.context ?? {}),
      scope_locked_at: null,
      status: 'queued',
      row_version: '1',
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      latest_attempt: {
        id: this.id(),
        attempt_no: 1,
        previous_attempt_id: null,
        start_reason: 'initial',
        outcome: null,
        created_at: timestamp,
        started_at: null,
        stop_requested_at: null,
        ended_at: null,
        error: null,
      },
      active_attempt_id: null,
      result_id: null,
    };
    task.active_attempt_id = task.latest_attempt.id;
    const budget = new AttemptBudget({
      clock: this.options.budgetClock,
      onChange: (view) => {
        task.latest_attempt.budget = view;
        this.updateTask(conversation, task);
      },
      onLimit: () => {
        // 不在 Pi 等待的关口内等待自身 abort。
        queueMicrotask(() => this.cancel(conversation, task.latest_attempt.id));
      },
    });
    task.latest_attempt.budget = budget.view();
    conversation.tasks.push(task);
    const input = this.message(conversation, task, 'user_input', 'complete', request.input.text);
    input.source_command_id = commandId;
    input.attempt_id = null;
    input.content.context = structuredClone(request.input.context ?? {});
    const inputReceipt: InputReceipt = {
      command_id: commandId,
      user_message_id: input.id,
      task_id: task.id,
      input_state: 'pending',
      input_attempt_id: null,
      handling_summary: null,
    };
    conversation.inputs.set(commandId, inputReceipt);
    const output = this.message(conversation, task, 'assistant_output', 'in_progress');
    const execution: Execution = {
      task,
      commandId,
      output,
      outputStreamId: this.id(),
      deltaIndex: 0,
      budget,
      text: '',
    };
    conversation.active = execution;
    if (conversation.useFirstInputAsTitle) {
      conversation.view.title = Array.from(request.input.text.replace(/\s+/gu, ' ').trim())
        .slice(0, 80)
        .join('');
      conversation.view.row_version = increment(conversation.view.row_version);
      conversation.useFirstInputAsTitle = false;
      this.product(conversation, 'conversation.updated', { conversation: conversation.view });
    }
    this.product(conversation, 'message.created', { message: input, input_receipt: inputReceipt });
    this.product(conversation, 'message.created', { message: output, input_receipt: null });
    this.product(conversation, 'task.updated', { task });
    const receipt = this.applied(
      conversation,
      request,
      commandId,
      task,
      'TASK_CREATED',
      202,
      input.id,
    );
    // 先完成命令裁决的同步提交，再让执行者获得控制。
    queueMicrotask(() => {
      void this.execute(conversation, execution);
    });
    return receipt;
  }

  private stop(
    conversation: Conversation,
    request: Extract<CommandRequest, { kind: 'stop_attempt' }>,
    commandId: string,
    task: TaskView,
  ): CommandReceipt {
    if (task.latest_attempt.ended_at !== null) {
      return this.applied(conversation, request, commandId, task, 'TARGET_ALREADY_ENDED', 200);
    }
    if (task.latest_attempt.stop_requested_at !== null) {
      return this.applied(conversation, request, commandId, task, 'STOP_ALREADY_REQUESTED', 200);
    }
    const execution = conversation.active;
    if (!execution || execution.task !== task) throw new Error('活动尝试缺少执行资格');
    // 也在同步门禁检查时间，不能依赖事件循环恰好已经触发计时器。
    try {
      execution.budget.assertCanProceed();
    } catch {
      /* 读取首个限制裁决。 */
    }
    if (execution.budget.limitError) {
      return this.rejected(conversation, request, commandId, task, 'TASK_STATE_CONFLICT');
    }
    execution.budget.requestStop();
    task.latest_attempt.stop_requested_at = this.timestamp();
    task.status = 'stopping';
    this.updateTask(conversation, task);
    queueMicrotask(() => this.cancel(conversation, request.target_attempt_id.toLowerCase()));
    return this.applied(conversation, request, commandId, task, 'STOP_REQUESTED', 202);
  }

  private async execute(conversation: Conversation, execution: Execution): Promise<void> {
    const { task, budget } = execution;
    if (!this.current(conversation, execution)) return;
    try {
      if (task.status === 'stopping') {
        this.finish(conversation, execution, 'stopped');
        return;
      }
      task.status = 'running';
      task.latest_attempt.started_at = this.timestamp();
      budget.start(this.now());
      if (!conversation.session) {
        conversation.session = this.options.createSession(conversation.view.id, {
          beforeModel: async () => {
            const active = this.requireExecution(conversation);
            active.budget.authorizeModel(this.id());
            const receipt = conversation.inputs.get(active.commandId)!;
            if (receipt.input_state === 'pending') {
              const consumed: InputReceipt = {
                ...receipt,
                input_state: 'consumed',
                input_attempt_id: active.task.latest_attempt.id,
              };
              conversation.inputs.set(active.commandId, consumed);
              this.product(conversation, 'input.updated', { input_receipt: consumed });
            }
          },
          beforeModelDispatch: async () => {
            this.requireExecution(conversation).budget.assertCanProceed();
          },
          beforeTool: async () => {
            this.requireExecution(conversation).budget.authorizeTool(this.id());
          },
          beforeToolDispatch: async () => {
            this.requireExecution(conversation).budget.assertCanProceed();
          },
          executionSignal: () => this.requireExecution(conversation).budget.signal,
          executionRemainingMs: () => this.requireExecution(conversation).budget.remainingMs(),
        });
      }
      const session = await conversation.session;
      if (!this.current(conversation, execution)) return;
      if (this.stopping(task)) {
        this.finish(conversation, execution, 'stopped');
        return;
      }
      budget.assertCanProceed();
      const result = await session.prompt(task.goal_text, (text) => {
        if (!text || !this.current(conversation, execution) || task.status !== 'running') return;
        try {
          budget.assertCanProceed();
        } catch {
          return;
        }
        execution.text += text;
        const delta: EphemeralFrame = {
          schema_version: 1,
          frame_kind: 'delta',
          conversation_id: conversation.view.id,
          stream_id: conversation.streamId,
          attempt_id: task.latest_attempt.id,
          message_id: execution.output.id,
          output_stream_id: execution.outputStreamId,
          delta_index: ++execution.deltaIndex,
          text,
        };
        this.notify(conversation, frozen(delta));
      });
      if (!this.current(conversation, execution)) return;
      if (budget.limitError) {
        this.finish(conversation, execution, 'failed', budget.limitError.code);
      } else if (this.stopping(task) || result.status === 'stopped') {
        this.finish(conversation, execution, 'stopped');
      } else if (result.status === 'completed' && result.text.trim()) {
        try {
          budget.complete();
          this.complete(conversation, execution, result.text);
        } catch {
          this.finish(
            conversation,
            execution,
            'failed',
            this.limitCode(execution) ?? 'PI_EXECUTION_FAILED',
          );
        }
      } else {
        this.finish(conversation, execution, 'failed', result.error?.code ?? 'PI_EXECUTION_FAILED');
      }
    } catch {
      if (!this.current(conversation, execution)) return;
      this.finish(
        conversation,
        execution,
        task.status === 'stopping' ? 'stopped' : 'failed',
        budget.limitError?.code ?? 'PI_EXECUTION_FAILED',
      );
    }
  }

  private complete(conversation: Conversation, execution: Execution, text: string): void {
    const { task, output } = execution;
    const timestamp = this.timestamp();
    const result: ResultView = frozen({
      id: this.id(),
      conversation_id: conversation.view.id,
      task_id: task.id,
      delivery_attempt_id: task.latest_attempt.id,
      payload_schema_version: 1,
      verification_summary: { business_scope: task.business_scope, data_as_of: null, sources: [] },
      verified_at: timestamp,
      created_at: timestamp,
      result_type: 'answer',
      payload: { blocks: [{ type: 'text', text }] },
    });
    conversation.results.set(result.id, result);
    task.status = 'completed';
    task.completed_at = timestamp;
    task.result_id = result.id;
    task.active_attempt_id = null;
    task.latest_attempt.outcome = 'completed';
    task.latest_attempt.ended_at = timestamp;
    task.row_version = increment(task.row_version);
    task.updated_at = timestamp;
    output.status = 'complete';
    output.result_id = result.id;
    output.row_version = increment(output.row_version);
    output.updated_at = timestamp;
    conversation.active = undefined;
    this.product(conversation, 'task.completed', { task, result, message: output });
  }

  private finish(
    conversation: Conversation,
    execution: Execution,
    outcome: 'stopped' | 'failed',
    code = 'PI_EXECUTION_FAILED',
  ): void {
    const { task, output, budget } = execution;
    budget.finish();
    task.status = outcome;
    task.active_attempt_id = null;
    task.latest_attempt.outcome = outcome;
    task.latest_attempt.ended_at = this.timestamp();
    task.latest_attempt.error =
      outcome === 'failed' ? { code: this.safeCode(code), summary: this.errorSummary(code) } : null;
    output.status = 'interrupted';
    output.content.blocks = execution.text ? [{ type: 'text', text: execution.text }] : [];
    output.row_version = increment(output.row_version);
    output.updated_at = this.timestamp();
    conversation.active = undefined;
    this.product(conversation, 'message.updated', { message: output, input_receipt: null });
    this.updateTask(conversation, task);
  }

  private cancel(conversation: Conversation, attemptId: string): void {
    if (!conversation.active || conversation.active.task.latest_attempt.id !== attemptId) return;
    void conversation.session?.then(
      (session) => {
        if (conversation.active?.task.latest_attempt.id === attemptId) {
          void session.stop().catch(() => {});
        }
      },
      () => {},
    );
  }

  private requireExecution(conversation: Conversation): Execution {
    const execution = conversation.active;
    if (
      !execution ||
      !this.current(conversation, execution) ||
      execution.task.status !== 'running'
    ) {
      throw new Error('ATTEMPT_EXECUTION_REVOKED');
    }
    return execution;
  }

  private current(conversation: Conversation, execution: Execution): boolean {
    return (
      !this.closed &&
      conversation.active === execution &&
      execution.task.latest_attempt.ended_at === null
    );
  }

  private stopping(task: TaskView): boolean {
    return task.status === 'stopping';
  }
  private limitCode(execution: Execution): string | undefined {
    return execution.budget.limitError?.code;
  }

  private applied(
    conversation: Conversation,
    request: CommandRequest,
    id: string,
    task: TaskView,
    outcome: 'TASK_CREATED' | 'STOP_REQUESTED' | 'STOP_ALREADY_REQUESTED' | 'TARGET_ALREADY_ENDED',
    status: 200 | 202,
    userMessageId: string | null = null,
  ): CommandReceipt {
    return frozen({
      http_status: status,
      command: {
        id,
        request_key: request.request_key.toLowerCase(),
        kind: request.kind,
        status: 'applied',
        outcome_code: outcome,
        processed_at: this.timestamp(),
      },
      decision: this.decision(conversation, request, task, userMessageId),
      error: null,
    }) as CommandReceipt;
  }

  private rejected(
    conversation: Conversation,
    request: CommandRequest,
    id: string,
    task: TaskView,
    code: RejectedError['code'],
  ): CommandReceipt {
    return frozen({
      http_status: 409,
      command: {
        id,
        request_key: request.request_key.toLowerCase(),
        kind: request.kind,
        status: 'rejected',
        outcome_code: code,
        processed_at: this.timestamp(),
      },
      decision: {
        ...this.decision(conversation, request, task, null),
        result_attempt_id: null,
        result_attempt_outcome_at_decision: null,
      },
      error: {
        code,
        message:
          code === 'UNFINISHED_TASK_EXISTS'
            ? '当前会话仍有未完成目标，请查看当前任务或新建会话'
            : '当前尝试正在因执行限制收尾，请刷新后查看',
        action: 'refresh_then_decide',
        details: {
          current_task_version: task.row_version,
          current_task_status: task.status,
          latest_attempt_id: task.latest_attempt.id,
          active_task_id: task.id,
        },
      },
    });
  }

  private decision(
    conversation: Conversation,
    request: CommandRequest,
    task: TaskView,
    userMessageId: string | null,
  ): Decision {
    return {
      conversation_id: conversation.view.id,
      task_id: request.kind === 'start_task' && !userMessageId ? null : task.id,
      target_attempt_id: request.kind === 'start_task' ? null : task.latest_attempt.id,
      result_attempt_id:
        request.kind === 'start_task' && !userMessageId ? null : task.latest_attempt.id,
      task_status_at_decision: request.kind === 'start_task' && !userMessageId ? null : task.status,
      task_version_at_decision:
        request.kind === 'start_task' && !userMessageId ? null : task.row_version,
      result_attempt_outcome_at_decision: task.latest_attempt.outcome,
      input_state_at_decision: userMessageId ? 'pending' : 'none',
      user_message_id: userMessageId,
    };
  }

  private commandResponse(receipt: CommandReceipt, requestId: string, replayed: boolean) {
    return {
      statusCode: receipt.http_status,
      body: structuredClone({
        schema_version: 1,
        request_id: requestId,
        replayed,
        command: receipt.command,
        decision: receipt.decision,
        error: receipt.error,
      }) as ResponseEnvelope,
    };
  }

  private unconfirmed(
    requestId: string,
    statusCode: number,
    code: UnconfirmedError['code'],
    message: string,
  ) {
    return {
      statusCode,
      body: {
        schema_version: 1,
        request_id: requestId,
        replayed: false,
        command: null,
        decision: null,
        error: { code, message, action: 'fix_request', details: {} },
      } as ResponseEnvelope,
    };
  }

  private message(
    conversation: Conversation,
    task: TaskView,
    type: MessageView['message_type'],
    status: MessageView['status'],
    text?: string,
  ): MessageView {
    const timestamp = this.timestamp();
    const seq = increment(conversation.view.activity.last_message_seq);
    conversation.view.activity = { last_activity_at: timestamp, last_message_seq: seq };
    const message: MessageView = {
      id: this.id(),
      conversation_id: conversation.view.id,
      task_id: task.id,
      attempt_id: task.latest_attempt.id,
      message_seq: seq,
      message_type: type,
      status,
      content_schema_version: 1,
      content: { blocks: text ? [{ type: 'text', text }] : [], context: null },
      row_version: '1',
      source_command_id: null,
      result_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    conversation.messages.push(message);
    return message;
  }

  private updateTask(conversation: Conversation, task: TaskView): void {
    task.row_version = increment(task.row_version);
    task.updated_at = this.timestamp();
    this.product(conversation, 'task.updated', { task });
  }

  private product(
    conversation: Conversation,
    eventType: ProductFrame['event_type'],
    payload: unknown,
  ): void {
    conversation.head += 1n;
    conversation.view.activity.last_activity_at = this.timestamp();
    const frame = frozen({
      schema_version: 1,
      frame_kind: 'product',
      event_id: this.id(),
      conversation_id: conversation.view.id,
      stream_id: conversation.streamId,
      event_seq: conversation.head.toString(),
      event_type: eventType,
      occurred_at: this.timestamp(),
      activity: conversation.view.activity,
      payload,
    }) as ProductFrame;
    conversation.events.push(frame);
    while (conversation.events.length > this.eventLimit) {
      conversation.pruned = BigInt(conversation.events.shift()!.event_seq);
    }
    this.notify(conversation, frame);
  }

  private notify(conversation: Conversation, frame: RuntimeFrame): void {
    const listeners = [...conversation.listeners];
    queueMicrotask(() => {
      for (const listener of listeners) {
        if (!conversation.listeners.has(listener)) continue;
        try {
          listener(frame);
        } catch {
          conversation.listeners.delete(listener);
        }
      }
    });
  }

  private owned(principal: AgentPrincipal, id: string): Conversation {
    this.assertOpen();
    if (!validateAgentContract('UUID', id)) throw invalid('会话 ID 必须为 UUID');
    return requireOwnedConversation(principal, this.conversations.get(id.toLowerCase()));
  }

  private task(conversation: Conversation, id: string): TaskView {
    if (!validateAgentContract('UUID', id)) throw invalid('任务 ID 必须为 UUID');
    const task = conversation.tasks.find((entry) => entry.id === id.toLowerCase());
    if (!task) throw missing();
    return task;
  }

  private focus(conversation: Conversation): TaskView | null {
    return (
      conversation.tasks.find((task) => task.status !== 'completed') ??
      conversation.tasks.at(-1) ??
      null
    );
  }

  private cursor(conversation: Conversation): ReadCursor {
    return { stream_id: conversation.streamId, event_seq: conversation.head.toString() };
  }

  private stream(conversation: Conversation, id: string): void {
    if (!validateAgentContract('UUID', id)) throw invalid('流 ID 必须为 UUID');
    if (id.toLowerCase() !== conversation.streamId) {
      throw new AgentRuntimeError(409, 'STREAM_CHANGED', '会话事件流已变化', 'reload_snapshot', {
        current_stream_id: conversation.streamId,
      });
    }
  }

  private inputsFor(
    conversation: Conversation,
    messages: MessageView[],
    focusTaskId?: string,
  ): InputReceipt[] {
    const commands = new Set(
      messages.flatMap((message) => (message.source_command_id ? [message.source_command_id] : [])),
    );
    return [...conversation.inputs.values()].filter(
      (receipt) =>
        commands.has(receipt.command_id) ||
        (receipt.task_id === focusTaskId && receipt.input_state === 'pending'),
    );
  }

  private resultsFor(
    conversation: Conversation,
    messages: MessageView[],
    focusResultId?: string | null,
  ): ResultView[] {
    const ids = new Set(
      messages.flatMap((message) => (message.result_id ? [message.result_id] : [])),
    );
    if (focusResultId) ids.add(focusResultId);
    return [...ids].map((id) => conversation.results.get(id)!);
  }

  private page(conversation: Conversation, messages: MessageView[], upper: string): MessagePage {
    const first = messages[0];
    const hasMore =
      !!first &&
      conversation.messages.some(
        (message) => BigInt(message.message_seq) < BigInt(first.message_seq),
      );
    return {
      upper_message_seq: upper,
      has_more: hasMore,
      next_before_message_seq: hasMore ? first!.message_seq : null,
    };
  }

  private limit(value: number | undefined, fallback: number): number {
    const limit = value ?? fallback;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw invalid('分页数量必须为 1 至 100');
    return limit;
  }

  private encodeCursor(
    conversation: Conversation,
    principal: AgentPrincipal,
    limit: number,
  ): string {
    const data = Buffer.from(
      JSON.stringify({
        v: 1,
        user: principal.userId,
        limit,
        activity: conversation.view.activity.last_activity_at,
        id: conversation.view.id,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(data).digest('base64url');
    return `${data}.${signature}`;
  }

  private decodeCursor(
    value: string,
    principal: AgentPrincipal,
    limit: number,
  ): { activity: string; id: string } {
    const error = () =>
      new AgentRuntimeError(422, 'INVALID_CURSOR', '列表游标无效，请刷新会话列表');
    if (typeof value !== 'string' || value.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(value))
      throw error();
    const [data, signature] = value.split('.');
    const expected = createHmac('sha256', this.cursorSecret).update(data!).digest();
    const actual = Buffer.from(signature!, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw error();
    try {
      const parsed: unknown = JSON.parse(Buffer.from(data!, 'base64url').toString('utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('v' in parsed) ||
        parsed.v !== 1 ||
        !('user' in parsed) ||
        parsed.user !== principal.userId ||
        !('limit' in parsed) ||
        parsed.limit !== limit ||
        !('activity' in parsed) ||
        typeof parsed.activity !== 'string' ||
        !('id' in parsed) ||
        typeof parsed.id !== 'string' ||
        !validateAgentContract('UUID', parsed.id)
      )
        throw error();
      return { activity: parsed.activity, id: parsed.id };
    } catch {
      throw error();
    }
  }

  private commandKey(principal: AgentPrincipal, key: string): string {
    return `${principal.userId}\0${key.toLowerCase()}`;
  }
  private unsupportedVersion(body: unknown): boolean {
    return (
      !!body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      'schema_version' in body &&
      body.schema_version !== 1
    );
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private assertOpen(): void {
    if (this.closed)
      throw new AgentRuntimeError(503, 'SERVICE_UNAVAILABLE', 'Agent 服务正在关闭', 'none');
  }
  private safeCode(code: string): string {
    return /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : 'PI_EXECUTION_FAILED';
  }
  private errorSummary(code: string): string {
    if (code.startsWith('ATTEMPT_') && code.endsWith('_LIMIT_EXCEEDED'))
      return '本次执行达到限制，已停止继续执行';
    return '模型执行失败，请检查服务端模型配置或稍后在新会话中重试';
  }
}
