import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  validateAgentContract,
  type CommandRequest,
  type CommandReceipt,
  type ResponseEnvelope,
  type TaskView,
  type MessageView,
  type ResultView,
  type ProductFrame,
  type EphemeralFrame,
  type ReadyControlFrame,
  type ToolExecutionSummary,
} from '@tyde/shared/agent';
import type { AgentPrincipal } from '../auth/access.js';
import { prepareCommand } from '../commands/prepare-command.js';
import { executionSnapshot, requireExecutionSnapshot } from '../storage/execution-config.js';
import { localExecutionOwner } from '../execution/process-identity.js';
import { PersistentBudget, type BudgetDispatchPermit } from '../execution/persistent-budget.js';
import {
  createInitialNativeState,
  validatePiNativeState,
  type PiNativeState,
  type PiMemoryBarriers,
  type PiMemorySession,
  type PiToolLifecycle,
} from '../pi/index.js';
import { NativeStore, freezeCommit, type ExecutionAuthority } from '../storage/native-store.js';
import {
  appendEvent,
  digest,
  iso,
  projectConversation,
  projectTask,
  projectMessage,
  projectResult,
  projectInput,
  projectTool,
} from '../storage/projections.js';
import {
  appendToolEvent,
  settleRunningTools,
  toolErrorMessage,
} from '../storage/tool-executions.js';
import { AgentRuntimeError, type RuntimeFrame } from './memory-runtime.js';

type NativeSession = Pick<PiMemorySession, 'prompt' | 'stop' | 'dispose' | 'captureNativeState'>;
type RuntimeOptions = {
  pool: Pool;
  createSession(
    conversationId: string,
    barriers: PiMemoryBarriers,
    nativeState: PiNativeState,
  ): Promise<NativeSession>;
  /** No credentials: this value is frozen in the execution snapshot. */
  executionConfig: Record<string, unknown>;
  toolManifest?: Record<string, unknown>;
  resourceManifestHash?: string;
};
type Active = {
  authority: ExecutionAuthority;
  controller: AbortController;
  session?: NativeSession;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  text: string;
  commandId: string;
  outputId: string;
  modelPermit?: BudgetDispatchPermit;
  toolPermit?: BudgetDispatchPermit;
  stopping: boolean;
  done?: Promise<void>;
};
const missing = () =>
  new AgentRuntimeError(404, 'RESOURCE_NOT_FOUND', '资源不存在或不可访问', 'none');
const invalid = () => new AgentRuntimeError(422, 'INVALID_REQUEST', '请求不符合当前聊天契约');
const checkVersion = (body: unknown) => {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'schema_version' in body &&
    body.schema_version !== 1
  )
    throw new AgentRuntimeError(422, 'UNSUPPORTED_SCHEMA_VERSION', '仅支持公开结构版本 1');
};
const unavailable = () =>
  new AgentRuntimeError(
    503,
    'INTERNAL_ERROR',
    '持久存储或执行资格尚未确认，请保留原请求标识核实',
    'contact_support',
  );

/** One process per Agent database. Reads never schedule execution or replay pending input. */
export class AgentPostgresRuntime {
  readonly storageMode = 'postgres' as const;
  private readonly native: NativeStore;
  private readonly budget: PersistentBudget;
  private readonly ownerId = localExecutionOwner();
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Map<string, Set<(frame: RuntimeFrame) => void>>();
  private readonly cursorSecret = randomBytes(32);
  private guard?: PoolClient;
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  private faulted = false;
  constructor(private readonly options: RuntimeOptions) {
    const freeze = <T>(value: T): T => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    this.options = {
      ...options,
      executionConfig: freeze(structuredClone(options.executionConfig)),
      ...(options.toolManifest
        ? { toolManifest: freeze(structuredClone(options.toolManifest)) }
        : {}),
    };
    this.native = new NativeStore(options.pool, () => this.failClosed());
    this.budget = new PersistentBudget(options.pool, {
      projectTask,
      onDatabaseFailure: () => this.failClosed(),
      onLimit: (authority) => {
        const active = this.active.get(authority.conversationId);
        if (active?.authority.attemptId === authority.attemptId) {
          active.controller.abort();
          void active.session?.stop().catch(() => {});
        }
      },
    });
  }
  async initialize(): Promise<void> {
    const guard = await this.options.pool.connect();
    const {
      rows: [row],
    } = await guard.query('SELECT pg_try_advisory_lock(729514052035::bigint) AS acquired');
    if (!row.acquired) {
      guard.release();
      throw new Error('AGENT_PROCESS_ALREADY_RUNNING');
    }
    this.guard = guard;
    guard.on('error', () => this.failClosed());
    this.options.pool.on('error', () => this.failClosed());
    // A released database lock is not proof that old network execution was isolated.
    // Open attempts remain unresolved until an explicit, externally isolated recovery.
    this.poll = setInterval(() => {
      void guard.query('SELECT 1').catch(() => this.failClosed());
    }, 1000);
    this.poll.unref();
  }
  private failClosed(): void {
    this.faulted = true;
    for (const running of this.active.values()) {
      running.controller.abort(new Error('AGENT_STORAGE_UNCONFIRMED'));
      void running.session?.stop().catch(() => {});
    }
  }
  private assertOpen(): void {
    if (this.closed || this.faulted) throw unavailable();
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    this.assertOpen();
    const client = await this.options.pool.connect().catch((error) => {
      this.failClosed();
      throw error;
    });
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!(error instanceof AgentRuntimeError)) this.failClosed();
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async owned(client: PoolClient, principal: AgentPrincipal, id: string, lock = false) {
    if (!validateAgentContract('UUID', id)) throw invalid();
    const {
      rows: [c],
    } = await client.query(
      `SELECT * FROM agent_conversations WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [id.toLowerCase(), principal.userId],
    );
    if (!c) throw missing();
    return c;
  }
  private cursor(c: Record<string, unknown>) {
    return { stream_id: c.event_stream_id as string, event_seq: c.last_event_seq as string };
  }
  private async detail(client: PoolClient, id: string) {
    const { rows } = await client.query(
      "SELECT id FROM agent_tasks WHERE conversation_id=$1 ORDER BY (status<>'completed') DESC,created_at DESC,id DESC LIMIT 1",
      [id],
    );
    return {
      conversation: await projectConversation(client, id),
      focus_task: rows[0] ? await projectTask(client, rows[0].id) : null,
    };
  }
  async createConversation(principal: AgentPrincipal, body: unknown) {
    checkVersion(body);
    if (!validateAgentContract('CreateConversationRequest', body)) throw invalid();
    return this.transaction(async (client) => {
      const id = randomUUID(),
        stream = randomUUID();
      await client.query(
        `INSERT INTO agent_conversations(id,owner_user_id,title,pi_session_id,row_version,last_message_seq,event_stream_id,last_event_seq,event_pruned_through_seq,created_at,updated_at,last_activity_at,deleted_at) VALUES($1,$2,$3,NULL,$5,0,$4,0,0,clock_timestamp(),clock_timestamp(),clock_timestamp(),NULL)`,
        [id, principal.userId, body.title ?? '新会话', stream, body.title === undefined ? 0 : 1],
      );
      return {
        conversation: await projectConversation(client, id),
        focus_task: null,
        read_cursor: { stream_id: stream, event_seq: '0' },
      };
    });
  }
  async listConversations(
    principal: AgentPrincipal,
    query: { limit?: number; cursor?: string } = {},
  ) {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
    let after: { at: string; id: string } | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(query.cursor)) throw invalid();
        const [encoded, mac] = query.cursor.split('.');
        if (
          !encoded ||
          mac !==
            createHmac('sha256', this.cursorSecret)
              .update(`${principal.userId}:${limit}:${encoded}`)
              .digest('base64url')
        )
          throw invalid();
        after = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      } catch {
        throw new AgentRuntimeError(422, 'INVALID_CURSOR', '列表游标无效，请刷新会话列表');
      }
    }
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM agent_conversations WHERE owner_user_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (last_activity_at,id)<($2,$3::uuid)) ORDER BY last_activity_at DESC,id DESC LIMIT $4`,
        [principal.userId, after?.at ?? null, after?.id ?? null, limit + 1],
      );
      const page = rows.slice(0, limit),
        last = page.at(-1);
      const encoded = last
        ? Buffer.from(JSON.stringify({ at: iso(last.last_activity_at), id: last.id })).toString(
            'base64url',
          )
        : '';
      return {
        items: await Promise.all(
          page.map(async (c) => ({
            conversation: await projectConversation(client, c.id),
            read_cursor: this.cursor(c),
          })),
        ),
        has_more: rows.length > limit,
        next_cursor:
          rows.length > limit
            ? `${encoded}.${createHmac('sha256', this.cursorSecret).update(`${principal.userId}:${limit}:${encoded}`).digest('base64url')}`
            : null,
      };
    }, true);
  }
  async getConversation(principal: AgentPrincipal, id: string) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      return { ...(await this.detail(client, c.id)), read_cursor: this.cursor(c) };
    }, true);
  }
  async getSnapshot(principal: AgentPrincipal, id: string, limit = 50) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      const messages = await this.messages(client, id, c.last_message_seq, undefined, limit);
      const detail = await this.detail(client, id);
      const { rows: pending } = await client.query(
        "SELECT q.*,m.id AS message_id FROM agent_commands q JOIN agent_messages m ON m.source_command_id=q.id WHERE q.task_id=$1 AND q.input_state='pending'",
        [detail.focus_task?.id ?? null],
      );
      for (const q of pending)
        if (!messages.input_receipts.some((receipt) => receipt.command_id === q.id))
          messages.input_receipts.push(projectInput(q, q.message_id));
      return {
        ...detail,
        ...messages,
        pinned_messages: [],
        event_pruned_through_seq: c.event_pruned_through_seq,
        operations: [],
        tool_executions: await this.toolsFor(
          client,
          id,
          messages.messages.map((message) => message.task_id),
          detail.focus_task?.id,
        ),
        read_cursor: this.cursor(c),
      };
    }, true);
  }
  async listMessages(
    principal: AgentPrincipal,
    id: string,
    query: { streamId: string; upperMessageSeq: string; beforeMessageSeq?: string; limit?: number },
  ) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      this.checkStream(c, query.streamId);
      if (BigInt(query.upperMessageSeq) > BigInt(c.last_message_seq)) throw invalid();
      if (
        query.beforeMessageSeq !== undefined &&
        BigInt(query.beforeMessageSeq) > BigInt(query.upperMessageSeq)
      )
        throw invalid();
      return {
        ...(await this.messages(
          client,
          id,
          query.upperMessageSeq,
          query.beforeMessageSeq,
          query.limit ?? 50,
        )),
        operations: [],
        read_cursor: this.cursor(c),
      };
    }, true);
  }
  private async messages(
    client: PoolClient,
    id: string,
    upper: string,
    before: string | undefined,
    limit: number,
  ) {
    const { rows } = await client.query(
      'SELECT * FROM agent_messages WHERE conversation_id=$1 AND message_seq<=$2 AND ($3::bigint IS NULL OR message_seq<$3) ORDER BY message_seq DESC LIMIT $4',
      [id, upper, before ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).reverse(),
      inputReceipts = [];
    for (const m of page)
      if (m.source_command_id) {
        const {
          rows: [q],
        } = await client.query('SELECT * FROM agent_commands WHERE id=$1', [m.source_command_id]);
        inputReceipts.push(projectInput(q, m.id));
      }
    const resultIds = page.flatMap((m) => (m.result_id ? [m.result_id] : []));
    const { rows: results } = await client.query(
      'SELECT * FROM agent_results WHERE id=ANY($1::uuid[])',
      [resultIds],
    );
    return {
      messages: page.map(projectMessage),
      input_receipts: inputReceipts,
      results: results.map(projectResult),
      tool_executions: await this.toolsFor(
        client,
        id,
        page.map((message) => message.task_id),
      ),
      page: {
        upper_message_seq: upper,
        has_more: rows.length > limit,
        next_before_message_seq: rows.length > limit ? page[0].message_seq : null,
      },
    };
  }
  private async toolsFor(
    client: PoolClient,
    conversationId: string,
    taskIds: readonly (string | null)[],
    focusTaskId?: string,
  ): Promise<ToolExecutionSummary[]> {
    const ids = [...new Set([...taskIds, focusTaskId].filter((id): id is string => !!id))];
    const { rows } = await client.query(
      `SELECT * FROM agent_tool_executions WHERE conversation_id=$1 AND task_id=ANY($2::uuid[])
       ORDER BY started_at,id`,
      [conversationId, ids],
    );
    return rows.map(projectTool);
  }
  async getTask(principal: AgentPrincipal, id: string, taskId: string) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      const {
        rows: [t],
      } = await client.query('SELECT id FROM agent_tasks WHERE id=$1 AND conversation_id=$2', [
        taskId,
        id,
      ]);
      if (!t) throw missing();
      const task = await projectTask(client, t.id);
      const {
        rows: [d],
      } = await client.query('SELECT * FROM agent_results WHERE task_id=$1', [taskId]);
      return {
        task,
        operations: [],
        tool_executions: await this.toolsFor(client, id, [taskId]),
        result: d ? projectResult(d) : null,
        read_cursor: this.cursor(c),
      };
    }, true);
  }
  async getResult(principal: AgentPrincipal, id: string, resultId: string) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      const {
        rows: [d],
      } = await client.query('SELECT * FROM agent_results WHERE id=$1 AND conversation_id=$2', [
        resultId,
        id,
      ]);
      if (!d) throw missing();
      return {
        result: projectResult(d),
        operations: [],
        tool_executions: await this.toolsFor(client, id, [d.task_id]),
        read_cursor: this.cursor(c),
      };
    }, true);
  }
  async getCommand(principal: AgentPrincipal, id: string, key: string) {
    return this.transaction(async (client) => {
      const c = await this.owned(client, principal, id);
      const {
        rows: [q],
      } = await client.query(
        'SELECT * FROM agent_commands WHERE actor_user_id=$1 AND request_key=$2 AND conversation_id=$3',
        [principal.userId, key, id],
      );
      if (!q) throw missing();
      const {
        rows: [m],
      } = await client.query('SELECT id FROM agent_messages WHERE source_command_id=$1', [q.id]);
      return {
        receipt: q.result_summary as CommandReceipt,
        input_receipt: m ? projectInput(q, m.id) : null,
        read_cursor: this.cursor(c),
      };
    }, true);
  }
  private checkStream(c: Record<string, unknown>, stream: string) {
    if (c.event_stream_id !== stream)
      throw new AgentRuntimeError(409, 'STREAM_CHANGED', '会话事件流已改变', 'reload_snapshot', {
        current_stream_id: c.event_stream_id as string,
      });
  }

  async submitCommand(
    principal: AgentPrincipal,
    id: string,
    body: unknown,
    requestId = randomUUID(),
  ) {
    checkVersion(body);
    if (!validateAgentContract('CommandRequest', body)) throw invalid();
    const prepared = prepareCommand(id, body);
    let run: Active | undefined;
    const response = await this.transaction(async (client) => {
      // A user-scoped idempotency lock serializes the same key across conversations.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${principal.userId}:${prepared.requestKey}`,
      ]);
      const c = await this.owned(client, principal, id, true);
      const {
        rows: [old],
      } = await client.query(
        'SELECT * FROM agent_commands WHERE actor_user_id=$1 AND request_key=$2',
        [principal.userId, prepared.requestKey],
      );
      if (old) {
        if (old.payload_hash !== prepared.payloadHash)
          throw new AgentRuntimeError(
            409,
            'IDEMPOTENCY_KEY_CONFLICT',
            '同一请求标识已用于不同原意图',
          );
        return this.response(old.result_summary, requestId, true);
      }
      if (body.kind !== 'start_task' && body.kind !== 'stop_attempt') throw invalid();
      if (body.kind === 'start_task' && body.task_kind !== 'business_query') throw invalid();
      const commandId = randomUUID();
      await client.query(
        `INSERT INTO agent_commands(id,conversation_id,actor_user_id,client_instance_id,request_key,kind,payload_schema_version,payload,payload_hash,status,input_state,created_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'accepted','none',clock_timestamp())`,
        [
          commandId,
          id,
          principal.userId,
          prepared.clientInstanceId ?? null,
          prepared.requestKey,
          body.kind,
          JSON.stringify(prepared.semanticPayload),
          prepared.payloadHash,
        ],
      );
      let task: TaskView | null,
        userMessageId: string | null = null,
        outcome = 'UNFINISHED_TASK_EXISTS',
        rejected = false;
      if (body.kind === 'start_task') {
        const {
          rows: [unfinished],
        } = await client.query(
          "SELECT id FROM agent_tasks WHERE conversation_id=$1 AND status<>'completed'",
          [id],
        );
        if (unfinished) {
          task = await projectTask(client, unfinished.id);
          rejected = true;
        } else {
          const created = await this.startTask(client, c, body, commandId);
          run = created.active;
          task = created.task;
          userMessageId = created.userMessageId;
          outcome = 'TASK_CREATED';
        }
      } else {
        const {
          rows: [target],
        } = await client.query(
          'SELECT t.id FROM agent_tasks t JOIN agent_attempts a ON a.task_id=t.id WHERE t.conversation_id=$1 AND t.id=$2 AND a.id=$3',
          [id, body.task_id, body.target_attempt_id],
        );
        if (!target) throw missing();
        await client.query(
          'UPDATE agent_commands SET task_id=$2,pi_session_id=(SELECT pi_session_id FROM agent_tasks WHERE id=$2),target_attempt_id=$3,result_attempt_id=$3 WHERE id=$1',
          [commandId, target.id, body.target_attempt_id],
        );
        await client.query('SELECT id FROM agent_tasks WHERE id=$1 FOR UPDATE', [target.id]);
        await client.query(
          'SELECT id FROM pi_sessions WHERE id=(SELECT pi_session_id FROM agent_tasks WHERE id=$1) FOR UPDATE',
          [target.id],
        );
        const {
          rows: [attempt],
        } = await client.query(
          'SELECT *,clock_timestamp() AS observed_now FROM agent_attempts WHERE id=$1 FOR UPDATE',
          [body.target_attempt_id],
        );
        if (
          !attempt.ended_at &&
          !attempt.stop_requested_at &&
          !attempt.limit_exceeded_kind &&
          attempt.execution_deadline_at &&
          new Date(attempt.observed_now).getTime() >=
            new Date(attempt.execution_deadline_at).getTime()
        ) {
          await client.query(
            "UPDATE agent_attempts SET limit_exceeded_kind='duration',limit_exceeded_at=clock_timestamp() WHERE id=$1",
            [attempt.id],
          );
          await client.query(
            'UPDATE agent_tasks SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
            [target.id],
          );
          await appendEvent(client, {
            conversationId: id,
            eventType: 'task.updated',
            payload: { task: await projectTask(client, target.id) },
            producerKey: `budget:limit:${attempt.id}`,
            taskId: target.id,
            attemptId: attempt.id,
          });
        }
        task = await projectTask(client, target.id);
        if (task.latest_attempt.ended_at) outcome = 'TARGET_ALREADY_ENDED';
        else if (task.latest_attempt.budget?.limit_exceeded_kind) {
          outcome = 'TASK_STATE_CONFLICT';
          rejected = true;
        } else if (task.latest_attempt.stop_requested_at) outcome = 'STOP_ALREADY_REQUESTED';
        else {
          await client.query(
            'UPDATE agent_attempts SET stop_requested_at=clock_timestamp() WHERE id=$1',
            [body.target_attempt_id],
          );
          await client.query(
            "UPDATE agent_tasks SET status='stopping',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
            [task.id],
          );
          task = await projectTask(client, task.id);
          outcome = 'STOP_REQUESTED';
          await appendEvent(client, {
            conversationId: id,
            eventType: 'task.updated',
            payload: { task },
            producerKey: `stop:${commandId}`,
            taskId: task.id,
            attemptId: task.latest_attempt.id,
            commandId,
          });
        }
      }
      const receipt = this.receipt(body, commandId, id, task!, outcome, rejected, userMessageId);
      await client.query(
        `UPDATE agent_commands SET task_id=$2,pi_session_id=$3,target_attempt_id=$4,result_attempt_id=$5,status=$6,outcome_code=$7,result_summary=$8,input_state=$9,processed_at=clock_timestamp() WHERE id=$1`,
        [
          commandId,
          rejected && body.kind === 'start_task' ? null : task!.id,
          rejected && body.kind === 'start_task'
            ? null
            : (await client.query('SELECT pi_session_id FROM agent_tasks WHERE id=$1', [task!.id]))
                .rows[0].pi_session_id,
          body.kind === 'start_task' ? null : body.target_attempt_id,
          rejected ? null : task!.latest_attempt.id,
          rejected ? 'rejected' : 'applied',
          outcome,
          JSON.stringify(receipt),
          userMessageId ? 'pending' : 'none',
        ],
      );
      return this.response(receipt, requestId, false);
    });
    if (run) {
      this.active.set(id, run);
      queueMicrotask(() => {
        run!.done = this.execute(run!).catch(() => this.failClosed());
      });
    }
    if (body.kind === 'stop_attempt') {
      const current = this.active.get(id);
      if (
        current?.authority.attemptId === body.target_attempt_id &&
        (response.body.command?.outcome_code === 'STOP_REQUESTED' ||
          response.body.command?.outcome_code === 'TASK_STATE_CONFLICT')
      ) {
        current.stopping = true;
        current.controller.abort();
        void current.session?.stop().catch(() => {});
      }
    }
    return response;
  }

  private response(receipt: CommandReceipt, requestId: string, replayed: boolean) {
    return {
      statusCode: receipt.http_status,
      body: {
        schema_version: 1,
        request_id: requestId,
        replayed,
        command: receipt.command,
        decision: receipt.decision,
        error: receipt.error,
      } as ResponseEnvelope,
    };
  }
  private receipt(
    request: CommandRequest,
    id: string,
    conversationId: string,
    task: TaskView,
    outcome: string,
    rejected: boolean,
    userMessageId: string | null,
  ): CommandReceipt {
    const noTarget = rejected && request.kind === 'start_task';
    return {
      http_status: rejected
        ? 409
        : outcome === 'TARGET_ALREADY_ENDED' || outcome === 'STOP_ALREADY_REQUESTED'
          ? 200
          : 202,
      command: {
        id,
        request_key: request.request_key.toLowerCase(),
        kind: request.kind,
        status: rejected ? 'rejected' : 'applied',
        outcome_code: outcome,
        processed_at: new Date().toISOString(),
      },
      decision: {
        conversation_id: conversationId,
        task_id: noTarget ? null : task.id,
        target_attempt_id: request.kind === 'start_task' ? null : task.latest_attempt.id,
        result_attempt_id: rejected ? null : task.latest_attempt.id,
        task_status_at_decision: noTarget ? null : task.status,
        task_version_at_decision: noTarget ? null : task.row_version,
        result_attempt_outcome_at_decision: rejected ? null : task.latest_attempt.outcome,
        input_state_at_decision: userMessageId ? 'pending' : 'none',
        user_message_id: userMessageId,
      },
      error: rejected
        ? {
            code: outcome,
            message:
              outcome === 'UNFINISHED_TASK_EXISTS'
                ? '当前会话仍有未完成目标'
                : '当前尝试受限，正在可靠收尾',
            action: 'refresh_then_decide',
            details: {
              current_task_version: task.row_version,
              current_task_status: task.status,
              latest_attempt_id: task.latest_attempt.id,
              active_task_id: task.id,
            },
          }
        : null,
    } as CommandReceipt;
  }

  private async startTask(
    client: PoolClient,
    c: Record<string, unknown>,
    request: Extract<CommandRequest, { kind: 'start_task' }>,
    commandId: string,
  ) {
    const id = c.id as string;
    let piId = c.pi_session_id as string | null;
    if (!piId) {
      piId = randomUUID();
      const state = createInitialNativeState();
      const revisionId = randomUUID();
      await client.query('SET CONSTRAINTS agent.fk_agent_17_p_r DEFERRED');
      await client.query(
        `INSERT INTO pi_sessions(id,conversation_id,native_session_id,head_revision_id,execution_generation,created_at,updated_at) VALUES($1,$2,$3,$4,0,clock_timestamp(),clock_timestamp())`,
        [piId, id, state.header!.id, revisionId],
      );
      await client.query(
        `INSERT INTO pi_session_revisions(id,pi_session_id,revision_no,last_entry_seq,raw_header,sdk_version,native_format_version,execution_generation,commit_key,commit_schema_version,commit_hash,commit_reason,committed_at) VALUES($1,$2,0,0,$3,'1.3.0',3,0,$4,1,$5,'initial',clock_timestamp())`,
        [revisionId, piId, JSON.stringify(state.header), randomUUID(), digest(state)],
      );
      await client.query(
        'UPDATE agent_conversations SET pi_session_id=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
        [id, piId],
      );
    }
    const snapshotId = await requireExecutionSnapshot(
      client,
      this.options.executionConfig,
      this.options.toolManifest,
      this.options.resourceManifestHash,
    );
    const taskId = randomUUID(),
      attemptId = randomUUID();
    await client.query(
      `INSERT INTO agent_tasks(id,conversation_id,pi_session_id,task_kind,goal_text,business_scope,execution_snapshot_id,status,row_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',1,clock_timestamp(),clock_timestamp())`,
      [
        taskId,
        id,
        piId,
        request.task_kind,
        request.input.text,
        JSON.stringify(request.input.context ?? {}),
        snapshotId,
      ],
    );
    await client.query('UPDATE agent_commands SET task_id=$2,pi_session_id=$3 WHERE id=$1', [
      commandId,
      taskId,
      piId,
    ]);
    const {
      rows: [p],
    } = await client.query('SELECT * FROM pi_sessions WHERE id=$1 FOR UPDATE', [piId]);
    if (p.active_attempt_id) throw new Error('PI_ALREADY_ACTIVE');
    const generation = (BigInt(p.execution_generation) + 1n).toString();
    await client.query(
      `INSERT INTO agent_attempts(id,task_id,pi_session_id,attempt_no,trigger_command_id,start_reason,execution_owner_id,execution_generation,base_revision_id,model_requests_used,tool_calls_used,created_at) VALUES($1,$2,$3,1,$4,'initial',$5,$6,$7,0,0,clock_timestamp())`,
      [attemptId, taskId, piId, commandId, this.ownerId, generation, p.head_revision_id],
    );
    await client.query(
      'UPDATE pi_sessions SET active_attempt_id=$2,writer_owner_id=$3,execution_generation=$4,updated_at=clock_timestamp() WHERE id=$1',
      [piId, attemptId, this.ownerId, generation],
    );
    if (c.last_message_seq === '0' && c.row_version === '0')
      await client.query(
        'UPDATE agent_conversations SET title=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
        [id, Array.from(request.input.text.replace(/\s+/gu, ' ').trim()).slice(0, 80).join('')],
      );
    const input = await this.insertMessage(
      client,
      id,
      taskId,
      null,
      'user_input',
      'complete',
      {
        blocks: [{ type: 'text', text: request.input.text }],
        context: request.input.context ?? {},
      },
      `input:${commandId}`,
      commandId,
    );
    const output = await this.insertMessage(
      client,
      id,
      taskId,
      attemptId,
      'assistant_output',
      'in_progress',
      { blocks: [], context: null },
      `output:${attemptId}`,
    );
    const task = await projectTask(client, taskId);
    await appendEvent(client, {
      conversationId: id,
      eventType: 'conversation.updated',
      payload: { conversation: await projectConversation(client, id) },
      producerKey: `conversation:${commandId}`,
      taskId,
    });
    await appendEvent(client, {
      conversationId: id,
      eventType: 'message.created',
      payload: {
        message: input,
        input_receipt: {
          command_id: commandId,
          user_message_id: input.id,
          task_id: taskId,
          input_state: 'pending',
          input_attempt_id: null,
          handling_summary: null,
        },
      },
      producerKey: `input-created:${commandId}`,
      taskId,
      commandId,
      messageId: input.id,
    });
    await appendEvent(client, {
      conversationId: id,
      eventType: 'message.created',
      payload: { message: output, input_receipt: null },
      producerKey: `output-created:${attemptId}`,
      taskId,
      attemptId,
      messageId: output.id,
    });
    await appendEvent(client, {
      conversationId: id,
      eventType: 'task.updated',
      payload: { task },
      producerKey: `task-created:${taskId}`,
      taskId,
      attemptId,
    });
    return {
      task,
      userMessageId: input.id,
      active: {
        authority: {
          conversationId: id,
          taskId,
          piSessionId: piId,
          attemptId,
          ownerId: this.ownerId,
          generation,
          expectedHeadRevisionId: p.head_revision_id,
        },
        controller: new AbortController(),
        deadline: 0,
        text: '',
        commandId,
        outputId: output.id,
        stopping: false,
      } as Active,
    };
  }
  private async insertMessage(
    client: PoolClient,
    conversationId: string,
    taskId: string,
    attemptId: string | null,
    type: MessageView['message_type'],
    status: MessageView['status'],
    content: unknown,
    producerKey: string,
    commandId: string | null = null,
  ) {
    const {
      rows: [c],
    } = await client.query(
      'UPDATE agent_conversations SET last_message_seq=last_message_seq+1,last_activity_at=clock_timestamp() WHERE id=$1 RETURNING last_message_seq',
      [conversationId],
    );
    const {
      rows: [m],
    } = await client.query(
      `INSERT INTO agent_messages(id,conversation_id,task_id,attempt_id,message_seq,message_type,status,content_schema_version,content,row_version,producer_key,source_command_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,1,$9,$10,clock_timestamp(),clock_timestamp()) RETURNING *`,
      [
        randomUUID(),
        conversationId,
        taskId,
        attemptId,
        c.last_message_seq,
        type,
        status,
        JSON.stringify(content),
        producerKey,
        commandId,
      ],
    );
    return projectMessage(m);
  }

  private assertActive(active: Active): void {
    if (
      this.faulted ||
      active.controller.signal.aborted ||
      this.active.get(active.authority.conversationId) !== active
    )
      throw new Error('ATTEMPT_EXECUTION_REVOKED');
  }
  private async save(
    active: Active,
    state: PiNativeState,
    reason: string,
    inputIds?: readonly string[],
    finish?: { status: string; text: string; code?: string },
  ): Promise<void> {
    validatePiNativeState(state);
    const request = freezeCommit(active.authority, state, reason, {
      inputIds: inputIds ?? null,
      finish: finish ?? null,
    });
    const revisionId = await this.native.commit(request, async (client, revisionId) => {
      const { inputIds, finish } = request.effects as {
        inputIds: readonly string[] | null;
        finish: { status: string; text: string; code?: string } | null;
      };
      if (inputIds) {
        const {
          rows: [q],
        } = await client.query('SELECT * FROM agent_commands WHERE id=$1 FOR UPDATE', [
          active.commandId,
        ]);
        if (q.input_state !== 'pending') throw new Error('PI_INPUT_ALREADY_CONSUMED');
        if (!inputIds.length) throw new Error('PI_INPUT_LINK_MISSING');
        await client.query(
          "UPDATE agent_commands SET input_state='consumed',input_attempt_id=$2,input_revision_id=$3 WHERE id=$1",
          [q.id, active.authority.attemptId, revisionId],
        );
        for (let i = 0; i < inputIds.length; i++)
          await client.query(
            'INSERT INTO agent_command_input_entries(command_id,pi_session_id,input_revision_id,native_entry_id,link_order) VALUES($1,$2,$3,$4,$5)',
            [q.id, active.authority.piSessionId, revisionId, inputIds[i], i + 1],
          );
        const {
          rows: [updated],
        } = await client.query('SELECT * FROM agent_commands WHERE id=$1', [q.id]);
        const {
          rows: [m],
        } = await client.query('SELECT id FROM agent_messages WHERE source_command_id=$1', [q.id]);
        await appendEvent(client, {
          conversationId: active.authority.conversationId,
          eventType: 'input.updated',
          payload: { input_receipt: projectInput(updated, m.id) },
          producerKey: `input-consumed:${q.id}`,
          commandId: q.id,
          taskId: active.authority.taskId,
          attemptId: active.authority.attemptId,
        });
      }
      if (finish) await this.end(client, active, revisionId, finish);
    });
    active.authority.expectedHeadRevisionId = revisionId;
  }
  private async updateTool(active: Active, event: PiToolLifecycle): Promise<void> {
    // A callback from an older executor cannot recreate or reopen its public projection.
    if (this.active.get(active.authority.conversationId) !== active || this.faulted) return;
    const a = active.authority;
    await this.transaction(async (client) => {
      const {
        rows: [conversation],
      } = await client.query('SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE', [
        a.conversationId,
      ]);
      const {
        rows: [task],
      } = await client.query('SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [a.taskId]);
      const {
        rows: [session],
      } = await client.query('SELECT * FROM pi_sessions WHERE id=$1 FOR UPDATE', [a.piSessionId]);
      const {
        rows: [attempt],
      } = await client.query(
        'SELECT *,clock_timestamp() AS now FROM agent_attempts WHERE id=$1 FOR UPDATE',
        [a.attemptId],
      );
      if (attempt && attempt.ended_at !== null) return;
      if (
        !conversation ||
        conversation.deleted_at !== null ||
        conversation.pi_session_id !== a.piSessionId ||
        !task ||
        task.conversation_id !== a.conversationId ||
        task.pi_session_id !== a.piSessionId ||
        !session ||
        session.conversation_id !== a.conversationId ||
        session.active_attempt_id !== a.attemptId ||
        session.writer_owner_id !== a.ownerId ||
        session.execution_generation !== a.generation ||
        session.head_revision_id !== a.expectedHeadRevisionId ||
        !attempt ||
        attempt.task_id !== a.taskId ||
        attempt.pi_session_id !== a.piSessionId ||
        attempt.execution_owner_id !== a.ownerId ||
        attempt.execution_generation !== a.generation
      )
        throw new Error('PI_EXECUTION_REVOKED');
      const {
        rows: [previous],
      } = await client.query(
        'SELECT * FROM agent_tool_executions WHERE attempt_id=$1 AND tool_call_id=$2 FOR UPDATE',
        [a.attemptId, event.toolCallId],
      );
      if (
        previous &&
        (previous.model_request_id !== event.modelRequestId ||
          previous.source_native_entry_id !== event.sourceNativeEntryId ||
          previous.tool_name !== event.toolName)
      )
        throw new Error('TOOL_CALL_IDENTITY_CONFLICT');
      if (previous && (previous.status !== 'running' || event.status === 'running')) return;
      const expired =
        !!attempt.execution_deadline_at &&
        new Date(attempt.now).getTime() >= new Date(attempt.execution_deadline_at).getTime();
      const budgetCancelled = !!attempt.limit_exceeded_kind || expired;
      const cancelled =
        budgetCancelled || !!attempt.stop_requested_at || active.controller.signal.aborted;
      const status = cancelled ? 'cancelled' : event.status;
      const errorCode = cancelled
        ? budgetCancelled
          ? 'budget_exceeded'
          : 'cancelled'
        : event.errorCode;
      const summary: ToolExecutionSummary = {
        id: previous?.id ?? randomUUID(),
        conversation_id: a.conversationId,
        task_id: a.taskId,
        attempt_id: a.attemptId,
        model_request_id: event.modelRequestId,
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        status,
        row_version: previous ? (BigInt(previous.row_version) + 1n).toString() : '1',
        started_at: previous ? iso(previous.started_at)! : event.startedAt,
        ended_at: status === 'running' ? null : (event.endedAt ?? new Date().toISOString()),
        is_demo: previous?.is_demo ?? event.isDemo,
        display_label: previous?.display_label ?? event.displayLabel,
        input_summary: previous?.input_summary ?? event.inputSummary,
        result_summary: status === 'succeeded' ? event.resultSummary : null,
        result_ref: status === 'succeeded' ? randomUUID() : null,
        error: errorCode ? { code: errorCode, message: toolErrorMessage(errorCode) } : null,
      };
      if (!validateAgentContract('ToolExecutionSummary', summary))
        throw new Error('INVALID_TOOL_PROJECTION');
      if (status === 'succeeded' && !event.resultNativeEntryId)
        throw new Error('TOOL_RESULT_NATIVE_LINK_MISSING');
      if (previous) {
        await client.query(
          `UPDATE agent_tool_executions SET result_native_entry_id=$2,result_revision_id=$3,
          status=$4,row_version=$5,ended_at=$6,result_summary=$7,result_ref=$8,error=$9 WHERE id=$1`,
          [
            summary.id,
            event.resultNativeEntryId,
            event.resultNativeEntryId ? a.expectedHeadRevisionId : null,
            status,
            summary.row_version,
            summary.ended_at,
            summary.result_summary,
            summary.result_ref,
            summary.error ? JSON.stringify(summary.error) : null,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO agent_tool_executions(id,conversation_id,task_id,attempt_id,pi_session_id,
          model_request_id,tool_call_id,tool_name,source_native_entry_id,source_revision_id,
          result_native_entry_id,result_revision_id,status,row_version,started_at,ended_at,
          is_demo,display_label,input_summary,result_summary,result_ref,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            summary.id,
            a.conversationId,
            a.taskId,
            a.attemptId,
            a.piSessionId,
            event.modelRequestId,
            event.toolCallId,
            event.toolName,
            event.sourceNativeEntryId,
            a.expectedHeadRevisionId,
            event.resultNativeEntryId,
            event.resultNativeEntryId ? a.expectedHeadRevisionId : null,
            status,
            summary.row_version,
            summary.started_at,
            summary.ended_at,
            summary.is_demo,
            summary.display_label,
            summary.input_summary,
            summary.result_summary,
            summary.result_ref,
            summary.error ? JSON.stringify(summary.error) : null,
          ],
        );
      }
      await appendToolEvent(client, summary);
    });
  }
  private async execute(active: Active): Promise<void> {
    const a = active.authority;
    try {
      const view = await this.budget.start(a);
      active.deadline = Date.parse(view.execution_deadline_at!);
      active.timer = setTimeout(
        () => {
          // Cancel on the local deadline immediately, even if the database has failed.
          active.controller.abort(new Error('ATTEMPT_DURATION_LIMIT_EXCEEDED'));
          void active.session?.stop().catch(() => {});
          void this.budget.check(a).catch(() => {});
        },
        Math.max(0, active.deadline - Date.now()),
      );
      active.timer.unref();
      await this.transaction(async (client) => {
        await client.query('SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE', [
          a.conversationId,
        ]);
        await client.query(
          "UPDATE agent_tasks SET status='running',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 AND status='queued'",
          [a.taskId],
        );
        await appendEvent(client, {
          conversationId: a.conversationId,
          eventType: 'task.updated',
          payload: { task: await projectTask(client, a.taskId) },
          producerKey: `running:${a.attemptId}`,
          taskId: a.taskId,
          attemptId: a.attemptId,
        });
      });
      const {
        rows: [snapshot],
      } = await this.options.pool.query(
        'SELECT s.* FROM agent_tasks t JOIN agent_execution_snapshots s ON s.id=t.execution_snapshot_id WHERE t.id=$1',
        [a.taskId],
      );
      const expected = executionSnapshot(
        this.options.executionConfig,
        this.options.toolManifest,
        this.options.resourceManifestHash,
      );
      await requireExecutionSnapshot(
        this.options.pool,
        this.options.executionConfig,
        this.options.toolManifest,
        this.options.resourceManifestHash,
      );
      if (
        !snapshot ||
        snapshot.snapshot_hash !== digest(expected) ||
        snapshot.resource_manifest_hash !== expected.resource_manifest_hash
      )
        throw new Error('PI_EXECUTION_CONFIG_UNAVAILABLE');
      const loaded = await this.native.load(a.piSessionId);
      if (loaded.revisionId !== a.expectedHeadRevisionId) throw new Error('PI_HEAD_CHANGED');
      validatePiNativeState(loaded.state);
      if (loaded.state.entries.length) {
        const {
          rows: [previousConfig],
        } = await this.options.pool.query(
          `SELECT s.model_config,s.tool_manifest,s.resource_manifest_hash,s.execution_policy
           FROM pi_session_revisions r JOIN agent_execution_snapshots s ON s.id=r.execution_snapshot_id
           WHERE r.id=$1 AND r.pi_session_id=$2`,
          [loaded.revisionId, a.piSessionId],
        );
        const compatible = {
          model_config: expected.model_config,
          tool_manifest: expected.tool_manifest,
          resource_manifest_hash: expected.resource_manifest_hash,
          execution_policy: expected.execution_policy,
        };
        if (!previousConfig || digest(previousConfig) !== digest(compatible))
          throw new Error('PI_EXECUTION_CONFIG_UNAVAILABLE');
      }
      this.assertActive(active);
      const session = await this.options.createSession(
        a.conversationId,
        {
          afterAssembly: (state) => this.save(active, state, 'assembly'),
          afterInput: (state, input) => this.save(active, state, 'input', input.nativeEntryIds),
          beforeModel: async (state, identity) => {
            this.assertActive(active);
            await this.save(active, state, 'before_model');
            const reservation = await this.budget.reserve(a, {
              kind: 'model',
              modelRequestId: identity.modelRequestId,
            });
            if (!reservation.permit) throw new Error('ATTEMPT_AUTHORIZATION_ALREADY_USED');
            active.modelPermit = reservation.permit;
          },
          beforeModelDispatch: async () => {
            this.assertActive(active);
            if (!active.modelPermit) throw new Error('MODEL_PERMIT_MISSING');
            const permit = active.modelPermit;
            active.modelPermit = undefined;
            await this.budget.checkDispatch(a, permit);
            this.assertActive(active);
          },
          afterAssistant: (state) => this.save(active, state, 'assistant'),
          beforeTool: async (state, _name, identity) => {
            this.assertActive(active);
            await this.save(active, state, 'before_tool');
            const reservation = await this.budget.reserve(a, {
              kind: 'tool',
              sourceNativeEntryId: identity.sourceNativeEntryId,
              toolCallId: identity.toolCallId,
            });
            if (!reservation.permit) throw new Error('ATTEMPT_AUTHORIZATION_ALREADY_USED');
            active.toolPermit = reservation.permit;
          },
          beforeToolDispatch: async () => {
            this.assertActive(active);
            if (!active.toolPermit) throw new Error('TOOL_PERMIT_MISSING');
            const permit = active.toolPermit;
            active.toolPermit = undefined;
            await this.budget.checkDispatch(a, permit);
            this.assertActive(active);
          },
          checkToolEligibility: async () => {
            this.assertActive(active);
            await this.budget.check(a);
            this.assertActive(active);
          },
          afterTool: (state) => this.save(active, state, 'tool_result'),
          onToolLifecycle: (event) => this.updateTool(active, event),
          executionSignal: () => active.controller.signal,
          executionRemainingMs: () => Math.max(0, active.deadline - Date.now()),
        },
        loaded.state,
      );
      active.session = session;
      this.assertActive(active);
      const {
        rows: [q],
      } = await this.options.pool.query(
        'SELECT input_state,payload FROM agent_commands WHERE id=$1',
        [active.commandId],
      );
      if (q.input_state !== 'pending') throw new Error('PI_INPUT_ALREADY_CONSUMED');
      let deltaIndex = 0;
      const outputStreamId = randomUUID();
      const result = await session.prompt(q.payload.input.text, (text) => {
        if (!text || active.controller.signal.aborted || this.faulted) return;
        active.text += text;
        this.notify(a.conversationId, {
          schema_version: 1,
          frame_kind: 'delta',
          conversation_id: a.conversationId,
          stream_id: '',
          attempt_id: a.attemptId,
          message_id: active.outputId,
          output_stream_id: outputStreamId,
          delta_index: ++deltaIndex,
          text,
        } as EphemeralFrame);
      });
      if (this.faulted) return;
      const code = result.error?.code;
      await this.save(active, session.captureNativeState(), 'finish', undefined, {
        status: result.status,
        text: result.text || active.text,
        code,
      });
    } catch (error) {
      active.controller.abort();
      void active.session?.stop().catch(() => {});
      if (!this.faulted) {
        const state =
          active.session?.captureNativeState() ?? (await this.native.load(a.piSessionId)).state;
        await this.save(active, state, 'finish', undefined, {
          status: 'failed',
          text: active.text,
          code:
            error instanceof Error && 'code' in error ? String(error.code) : 'PI_EXECUTION_FAILED',
        }).catch(() => this.failClosed());
      }
    } finally {
      if (active.timer) clearTimeout(active.timer);
      active.session?.dispose();
      if (this.active.get(a.conversationId) === active) this.active.delete(a.conversationId);
    }
  }
  private async end(
    client: PoolClient,
    active: Active,
    revisionId: string,
    result: { status: string; text: string; code?: string },
  ): Promise<void> {
    const a = active.authority;
    const {
      rows: [attempt],
    } = await client.query(
      'SELECT *,clock_timestamp() AS now FROM agent_attempts WHERE id=$1 FOR UPDATE',
      [a.attemptId],
    );
    let kind = attempt.limit_exceeded_kind;
    if (
      !attempt.stop_requested_at &&
      !kind &&
      attempt.execution_deadline_at &&
      new Date(attempt.now).getTime() >= new Date(attempt.execution_deadline_at).getTime()
    ) {
      kind = 'duration';
      await client.query(
        "UPDATE agent_attempts SET limit_exceeded_kind='duration',limit_exceeded_at=clock_timestamp() WHERE id=$1",
        [a.attemptId],
      );
    }
    const {
      rows: [tools],
    } = await client.query(
      "SELECT EXISTS(SELECT 1 FROM agent_tool_executions WHERE attempt_id=$1 AND status='running') AS unsettled",
      [a.attemptId],
    );
    const outcome = attempt.stop_requested_at
      ? 'stopped'
      : kind
        ? 'failed'
        : result.status === 'completed' && result.text.trim() && !tools.unsettled
          ? 'completed'
          : this.closed
            ? 'interrupted'
            : 'failed';
    const code = kind
      ? `ATTEMPT_${kind === 'duration' ? 'DURATION' : kind === 'model_requests' ? 'MODEL_REQUEST' : 'TOOL_CALL'}_LIMIT_EXCEEDED`
      : tools.unsettled
        ? 'PI_TOOL_PROCESS_UNSETTLED'
        : (result.code ?? 'PI_EXECUTION_FAILED');
    await settleRunningTools(
      client,
      a,
      kind
        ? 'budget_exceeded'
        : attempt.stop_requested_at || this.closed
          ? 'cancelled'
          : 'tool_failed',
    );
    let delivery: ResultView | null = null;
    if (outcome === 'completed') {
      const resultId = randomUUID();
      const {
        rows: [t],
      } = await client.query('SELECT business_scope FROM agent_tasks WHERE id=$1', [a.taskId]);
      const payload = { blocks: [{ type: 'text', text: result.text }] },
        verification = { business_scope: t.business_scope, data_as_of: null, sources: [] };
      await client.query('SAVEPOINT final_delivery');
      let d: Record<string, unknown>;
      try {
        const inserted = await client.query(
          `INSERT INTO agent_results(id,conversation_id,task_id,delivery_attempt_id,result_type,payload_schema_version,payload,verification,pi_session_id,source_pi_revision_id,content_hash,verified_at,created_at) VALUES($1,$2,$3,$4,'answer',1,$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp()) RETURNING *`,
          [
            resultId,
            a.conversationId,
            a.taskId,
            a.attemptId,
            JSON.stringify(payload),
            JSON.stringify(verification),
            a.piSessionId,
            revisionId,
            digest({ payload, verification }),
          ],
        );
        d = inserted.rows[0];
        await client.query('RELEASE SAVEPOINT final_delivery');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT final_delivery');
        await client.query('RELEASE SAVEPOINT final_delivery');
        if (
          error &&
          typeof error === 'object' &&
          'constraint' in error &&
          error.constraint === 'guard_agent_delivery'
        ) {
          const {
            rows: [current],
          } = await client.query(
            'SELECT *,clock_timestamp() AS now FROM agent_attempts WHERE id=$1',
            [a.attemptId],
          );
          if (
            current.stop_requested_at ||
            current.limit_exceeded_kind ||
            new Date(current.now).getTime() >= new Date(current.execution_deadline_at).getTime()
          ) {
            await this.end(client, active, revisionId, {
              status: 'failed',
              text: result.text,
              code: 'ATTEMPT_DURATION_LIMIT_EXCEEDED',
            });
            return;
          }
        }
        throw error;
      }
      delivery = projectResult(d);
      await client.query(
        "UPDATE agent_messages SET status='complete',result_id=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [active.outputId, resultId],
      );
    } else {
      const {
        rows: [source],
      } = await client.query(
        `SELECT e.native_entry_id,e.raw_entry,r.id AS revision_id FROM pi_session_entries e
        JOIN pi_session_revisions r ON r.pi_session_id=e.pi_session_id AND e.entry_seq<=r.last_entry_seq
        JOIN pi_session_revisions prev ON prev.id=r.previous_revision_id AND e.entry_seq>prev.last_entry_seq
        WHERE e.pi_session_id=$1 AND r.writer_attempt_id=$2 AND e.entry_type='message' AND e.raw_entry->'message'->>'role'='assistant'
        ORDER BY e.entry_seq DESC LIMIT 1`,
        [a.piSessionId, a.attemptId],
      );
      const text =
        source?.raw_entry.message.content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('') ?? '';
      await client.query(
        "UPDATE agent_messages SET status='interrupted',content=$2,pi_session_id=$3,source_revision_id=$4,source_native_entry_id=$5,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [
          active.outputId,
          JSON.stringify({ blocks: text ? [{ type: 'text', text }] : [], context: null }),
          text ? a.piSessionId : null,
          text ? source.revision_id : null,
          text ? source.native_entry_id : null,
        ],
      );
    }
    await client.query(
      'UPDATE agent_attempts SET outcome=$2,ended_at=clock_timestamp(),error_code=$3,error_summary=$4 WHERE id=$1',
      [
        a.attemptId,
        outcome,
        outcome === 'failed' ? code : null,
        outcome === 'failed' ? '执行未完成，请核对持久记录' : null,
      ],
    );
    await client.query(
      "UPDATE agent_tasks SET status=$2,completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE NULL END,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
      [a.taskId, outcome],
    );
    await client.query(
      'UPDATE pi_sessions SET active_attempt_id=NULL,writer_owner_id=NULL,execution_generation=execution_generation+1,updated_at=clock_timestamp() WHERE id=$1',
      [a.piSessionId],
    );
    await client.query(
      'UPDATE agent_conversations SET last_activity_at=clock_timestamp() WHERE id=$1',
      [a.conversationId],
    );
    const task = await projectTask(client, a.taskId);
    const {
      rows: [m],
    } = await client.query('SELECT * FROM agent_messages WHERE id=$1', [active.outputId]);
    const message = projectMessage(m);
    if (delivery)
      await appendEvent(client, {
        conversationId: a.conversationId,
        eventType: 'task.completed',
        payload: { task, result: delivery, message },
        producerKey: `completed:${a.attemptId}`,
        taskId: a.taskId,
        attemptId: a.attemptId,
        resultId: delivery.id,
        messageId: message.id,
      });
    else {
      await appendEvent(client, {
        conversationId: a.conversationId,
        eventType: 'message.updated',
        payload: { message, input_receipt: null },
        producerKey: `message-ended:${a.attemptId}`,
        taskId: a.taskId,
        attemptId: a.attemptId,
        messageId: message.id,
      });
      await appendEvent(client, {
        conversationId: a.conversationId,
        eventType: 'task.updated',
        payload: { task },
        producerKey: `ended:${a.attemptId}`,
        taskId: a.taskId,
        attemptId: a.attemptId,
      });
    }
  }
  private notify(id: string, frame: RuntimeFrame) {
    for (const listener of this.listeners.get(id) ?? [])
      try {
        listener(frame);
      } catch {
        /* A display listener cannot affect execution. */
      }
  }
  async subscribe(
    principal: AgentPrincipal,
    id: string,
    options: {
      streamId: string;
      afterEventSeq: string;
      onFrame(frame: RuntimeFrame): void;
      onError?(error: unknown): void;
    },
  ) {
    let after = BigInt(options.afterEventSeq),
      closed = false,
      pumping = false;
    const read = () =>
      this.transaction(async (client) => {
        const c = await this.owned(client, principal, id);
        this.checkStream(c, options.streamId);
        const details = {
          current_stream_id: c.event_stream_id,
          pruned_through_seq: c.event_pruned_through_seq,
          head_seq: c.last_event_seq,
        };
        if (after < BigInt(c.event_pruned_through_seq))
          throw new AgentRuntimeError(
            410,
            'CURSOR_EXPIRED',
            '事件游标已过期',
            'reload_snapshot',
            details,
          );
        if (after > BigInt(c.last_event_seq))
          throw new AgentRuntimeError(
            409,
            'CURSOR_AHEAD',
            '事件游标超过当前水位',
            'reload_snapshot',
            details,
          );
        const { rows } = await client.query(
          'SELECT payload FROM agent_outbox_events WHERE conversation_id=$1 AND stream_id=$2 AND event_seq>$3 AND event_seq<=$4 ORDER BY event_seq LIMIT 128',
          [id, options.streamId, after.toString(), c.last_event_seq],
        );
        let expected = after + 1n;
        for (const row of rows)
          if (BigInt(row.payload.event_seq) !== expected++)
            throw new AgentRuntimeError(
              503,
              'EVENT_HISTORY_GAP',
              '可靠事件历史不连续',
              'reload_snapshot',
              details,
            );
        if (rows.length < 128 && expected !== BigInt(c.last_event_seq) + 1n)
          throw new AgentRuntimeError(
            503,
            'EVENT_HISTORY_GAP',
            '可靠事件历史不完整',
            'reload_snapshot',
            details,
          );
        return { c, next: expected - 1n, frames: rows.map((r) => r.payload as ProductFrame) };
      }, true);
    const initial = await read();
    after = initial.next;
    const listener = (frame: RuntimeFrame) => {
      if (!closed && frame.frame_kind === 'delta')
        options.onFrame({ ...frame, stream_id: options.streamId });
    };
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    const timer = setInterval(() => {
      if (closed || pumping) return;
      pumping = true;
      void read()
        .then(({ next, frames }) => {
          if (closed) return;
          for (const frame of frames) options.onFrame(frame);
          after = next;
        })
        .catch((error) => {
          options.onError?.(error);
          closed = true;
          clearInterval(timer);
          set!.delete(listener);
        })
        .finally(() => {
          pumping = false;
        });
    }, 100);
    timer.unref();
    return {
      ready: {
        schema_version: 1,
        frame_kind: 'control',
        code: 'ready',
        stream_id: options.streamId,
        accepted_after_seq: options.afterEventSeq,
        observed_head_seq: initial.c.last_event_seq,
        pruned_through_seq: initial.c.event_pruned_through_seq,
      } as ReadyControlFrame,
      replay: initial.frames,
      close: () => {
        closed = true;
        clearInterval(timer);
        set!.delete(listener);
      },
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    for (const active of this.active.values()) {
      active.controller.abort(new Error('AGENT_PROCESS_SHUTDOWN'));
      void active.session?.stop().catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((a) => a.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      active.session?.dispose();
    }
    for (const set of this.listeners.values()) set.clear();
    if (this.guard) {
      await this.guard.query('SELECT pg_advisory_unlock(729514052035::bigint)').catch(() => {});
      this.guard.release();
      this.guard = undefined;
    }
  }
}
