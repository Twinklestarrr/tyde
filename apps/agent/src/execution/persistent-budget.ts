import type { Pool, PoolClient } from 'pg';
import type { AttemptBudgetView, ProductFrame, TaskView } from '@tyde/shared/agent';
import { appendEvent, digest, projectTask as defaultProjectTask } from '../storage/projections.js';
import type { AttemptBudgetLimits } from './attempt-budget.js';

export interface ExecutionAuthority {
  conversationId: string;
  taskId: string;
  piSessionId: string;
  attemptId: string;
  /** Unique identity of this process startup, never a reusable host name. */
  ownerId: string;
  generation: string;
  expectedHeadRevisionId: string;
}

export type BudgetAuthorizationIdentity =
  | { kind: 'model'; modelRequestId: string }
  | { kind: 'tool'; sourceNativeEntryId: string; toolCallId: string };

type LimitKind = NonNullable<AttemptBudgetView['limit_exceeded_kind']>;
export type PersistentBudgetCode =
  | 'ATTEMPT_EXECUTION_REVOKED'
  | 'ATTEMPT_HEAD_CONFLICT'
  | 'ATTEMPT_NOT_STARTED'
  | 'ATTEMPT_STOPPED'
  | 'ATTEMPT_ENDED'
  | 'ATTEMPT_BUDGET_UNTRACKED'
  | 'ATTEMPT_INVALID_BUDGET_POLICY'
  | 'ATTEMPT_DURATION_LIMIT_EXCEEDED'
  | 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'
  | 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED'
  | 'ATTEMPT_AUTHORIZATION_ALREADY_USED'
  | 'ATTEMPT_AUTHORIZATION_COMMIT_UNKNOWN'
  | 'ATTEMPT_AUTHORIZATION_CONFIRMATION_LOST'
  | 'ATTEMPT_DATABASE_UNAVAILABLE';

export class PersistentBudgetError extends Error {
  constructor(
    public readonly code: PersistentBudgetCode,
    public readonly producerKey?: string,
  ) {
    super(code);
    this.name = 'PersistentBudgetError';
  }
}

/** This opaque object is valid once, in the process that obtained a confirmed new reservation. */
export interface BudgetDispatchPermit {
  readonly producerKey: string;
}

export interface BudgetAuthorizationReceipt {
  producerKey: string;
  event: ProductFrame;
  /** Re-reading an old authorization confirms consumption but never grants another dispatch. */
  permit: BudgetDispatchPermit | null;
}

export interface PersistentBudgetOptions {
  projectTask?(client: PoolClient, taskId: string): Promise<TaskView>;
  /** Synchronous cancellation request. Called before any reconciliation read after a DB error. */
  onDatabaseFailure?(authority: ExecutionAuthority, error: PersistentBudgetError): void;
  onLimit?(authority: ExecutionAuthority, error: PersistentBudgetError): void;
  /** Notification is only a wake-up; readers must fetch committed database facts. */
  onCommitted?(authority: ExecutionAuthority, event: ProductFrame): void;
}

interface BudgetAttempt {
  id: string;
  task_id: string;
  pi_session_id: string;
  execution_owner_id: string | null;
  execution_generation: string | null;
  started_at: Date | string | null;
  execution_deadline_at: Date | string | null;
  model_requests_used: number | null;
  tool_calls_used: number | null;
  limit_exceeded_kind: LimitKind | null;
  limit_exceeded_at: Date | string | null;
  stop_requested_at: Date | string | null;
  ended_at: Date | string | null;
}
interface LockedBudget {
  attempt: BudgetAttempt;
  limits: AttemptBudgetLimits;
  nowMs: number;
}

const limitCodes: Record<LimitKind, PersistentBudgetCode> = {
  duration: 'ATTEMPT_DURATION_LIMIT_EXCEEDED',
  model_requests: 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED',
  tool_calls: 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED',
};
const timestamp = (value: Date | string): number => new Date(value).getTime();
const sameAuthority = (left: ExecutionAuthority, right: ExecutionAuthority): boolean =>
  left.conversationId === right.conversationId &&
  left.taskId === right.taskId &&
  left.piSessionId === right.piSessionId &&
  left.attemptId === right.attemptId &&
  left.ownerId === right.ownerId &&
  left.generation === right.generation &&
  left.expectedHeadRevisionId === right.expectedHeadRevisionId;

/** Stable tuple hashing prevents ambiguous delimiter collisions in native tool identifiers. */
export function budgetProducerKey(
  attemptId: string,
  identity: BudgetAuthorizationIdentity,
): string {
  const parts =
    identity.kind === 'model'
      ? [attemptId, identity.modelRequestId]
      : [attemptId, identity.sourceNativeEntryId, identity.toolCallId];
  if (parts.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('ATTEMPT_INVALID_AUTHORIZATION_ID');
  }
  return `budget:${identity.kind}:${attemptId}:${digest(parts)}`;
}

/** Pure policy used by the locked database path; equality at the deadline is already expired. */
export function decidePersistentBudget(
  state: {
    startedAtMs: number | null;
    deadlineMs: number | null;
    modelRequestsUsed: number | null;
    toolCallsUsed: number | null;
    limitKind: LimitKind | null;
    stopped: boolean;
    ended: boolean;
  },
  limits: AttemptBudgetLimits,
  nowMs: number,
  kind?: BudgetAuthorizationIdentity['kind'],
): { code: PersistentBudgetCode | null; latch: LimitKind | null } {
  if (state.ended) return { code: 'ATTEMPT_ENDED', latch: null };
  if (state.limitKind) return { code: limitCodes[state.limitKind], latch: null };
  if (state.stopped) return { code: 'ATTEMPT_STOPPED', latch: null };
  if (state.modelRequestsUsed === null || state.toolCallsUsed === null)
    return { code: 'ATTEMPT_BUDGET_UNTRACKED', latch: null };
  if (state.startedAtMs === null || state.deadlineMs === null)
    return { code: 'ATTEMPT_NOT_STARTED', latch: null };
  if (nowMs >= state.deadlineMs) return { code: limitCodes.duration, latch: 'duration' };
  if (kind === 'model' && state.modelRequestsUsed >= limits.max_model_requests)
    return { code: limitCodes.model_requests, latch: 'model_requests' };
  if (kind === 'tool' && state.toolCallsUsed >= limits.max_tool_calls)
    return { code: limitCodes.tool_calls, latch: 'tool_calls' };
  return { code: null, latch: null };
}

/**
 * PostgreSQL admission gate. Transactions never encompass model/tool/network execution.
 * The outbox producer key is the durable reservation identity; a process-local opaque
 * permit is only the one-shot dispatch capability and is deliberately not restorable.
 */
export class PersistentBudget {
  readonly #projectTask: NonNullable<PersistentBudgetOptions['projectTask']>;
  readonly #permits = new WeakMap<BudgetDispatchPermit, ExecutionAuthority>();
  readonly #blockedAttempts = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly options: PersistentBudgetOptions = {},
  ) {
    this.#projectTask = options.projectTask ?? defaultProjectTask;
  }

  /** Sets start and deadline together; an existing start is never reset. */
  async start(authority: ExecutionAuthority): Promise<AttemptBudgetView> {
    authority = Object.freeze({ ...authority });
    this.#assertNotBlocked(authority);
    return this.#transaction(authority, async (client) => {
      const state = await this.#lock(client, authority);
      const { attempt, limits, nowMs } = state;
      if (attempt.ended_at !== null) throw new PersistentBudgetError('ATTEMPT_ENDED');
      if (attempt.stop_requested_at !== null) throw new PersistentBudgetError('ATTEMPT_STOPPED');
      if (attempt.model_requests_used === null || attempt.tool_calls_used === null)
        throw new PersistentBudgetError('ATTEMPT_BUDGET_UNTRACKED');
      if (attempt.started_at === null) {
        await client.query(
          `UPDATE agent_attempts SET started_at=$2, execution_deadline_at=$3 WHERE id=$1`,
          [authority.attemptId, new Date(nowMs), new Date(nowMs + limits.max_duration_ms)],
        );
        attempt.started_at = new Date(nowMs);
        attempt.execution_deadline_at = new Date(nowMs + limits.max_duration_ms);
        await this.#changed(client, authority, `budget:start:${authority.attemptId}`);
      } else if (
        attempt.execution_deadline_at === null ||
        timestamp(attempt.execution_deadline_at) !==
          timestamp(attempt.started_at) + limits.max_duration_ms
      ) {
        throw new PersistentBudgetError('ATTEMPT_INVALID_BUDGET_POLICY');
      }
      return this.#view(state);
    });
  }

  async reserve(
    authority: ExecutionAuthority,
    identity: BudgetAuthorizationIdentity,
  ): Promise<BudgetAuthorizationReceipt> {
    authority = Object.freeze({ ...authority });
    identity = Object.freeze({ ...identity });
    this.#assertNotBlocked(authority);
    const producerKey = budgetProducerKey(authority.attemptId, identity);
    let commitAttempted = false;
    let committed:
      | { error: PersistentBudgetError }
      | { producerKey: string; event: ProductFrame; newlyReserved: boolean };
    try {
      committed = await this.#transaction(
        authority,
        async (client) => {
          const state = await this.#lock(client, authority);
          const old = await this.#findAuthorization(client, authority, producerKey);
          if (old) return { producerKey, event: old, newlyReserved: false };
          const issue = await this.#decision(client, authority, state, identity.kind);
          if (issue) return issue;
          if (identity.kind === 'tool') {
            const { rows } = await client.query(
              `SELECT 1 FROM pi_session_entries WHERE pi_session_id=$1 AND native_entry_id=$2
                AND entry_seq <= (SELECT last_entry_seq FROM pi_session_revisions WHERE id=$3)
                AND raw_entry->>'type'='message'
                AND raw_entry->'message'->>'role'='assistant'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(raw_entry->'message'->'content') c
                  WHERE c->>'type'='toolCall' AND c->>'id'=$4)`,
              [
                authority.piSessionId,
                identity.sourceNativeEntryId,
                authority.expectedHeadRevisionId,
                identity.toolCallId,
              ],
            );
            if (!rows.length) throw new PersistentBudgetError('ATTEMPT_HEAD_CONFLICT');
          }
          const column = identity.kind === 'model' ? 'model_requests_used' : 'tool_calls_used';
          // Column is selected only from this closed union; identifiers never come from a caller.
          await client.query(`UPDATE agent_attempts SET ${column}=${column}+1 WHERE id=$1`, [
            authority.attemptId,
          ]);
          const event = await this.#changed(client, authority, producerKey);
          return { producerKey, event, newlyReserved: true };
        },
        () => {
          commitAttempted = true;
        },
      );
    } catch (cause) {
      if (cause instanceof PersistentBudgetError) throw cause;
      // Cancellation has already been requested by #transaction, before this reconciliation.
      if (commitAttempted) {
        let confirmed = false;
        try {
          const client = await this.pool.connect();
          try {
            confirmed = (await this.#findAuthorization(client, authority, producerKey)) !== null;
          } finally {
            client.release();
          }
        } catch {
          /* Unknown stays unknown; neither outcome can grant a dispatch permit. */
        }
        throw new PersistentBudgetError(
          confirmed
            ? 'ATTEMPT_AUTHORIZATION_CONFIRMATION_LOST'
            : 'ATTEMPT_AUTHORIZATION_COMMIT_UNKNOWN',
          producerKey,
        );
      }
      throw new PersistentBudgetError('ATTEMPT_DATABASE_UNAVAILABLE', producerKey);
    }
    if ('error' in committed) throw committed.error;
    // Only the transaction that inserted a NEW authorization can mint a local permit.
    // Old reads deliberately do not survive this marker check.
    let permit: BudgetDispatchPermit | null = null;
    if (committed.newlyReserved) {
      permit = Object.freeze({ producerKey });
      this.#permits.set(permit, Object.freeze({ ...authority }));
    }
    return Object.freeze({ producerKey, event: committed.event, permit });
  }

  /** Final durable eligibility check. The permit is consumed before waiting, even on failure. */
  async checkDispatch(
    authority: ExecutionAuthority,
    permit: BudgetDispatchPermit,
  ): Promise<AttemptBudgetView> {
    authority = Object.freeze({ ...authority });
    const granted = this.#permits.get(permit);
    this.#permits.delete(permit);
    if (!granted || !sameAuthority(granted, authority))
      throw new PersistentBudgetError('ATTEMPT_AUTHORIZATION_ALREADY_USED', permit.producerKey);
    return this.check(authority);
  }

  /** Use for final delivery, timer expiry and pre-send rechecks; exact-N usage is legal here. */
  async check(authority: ExecutionAuthority): Promise<AttemptBudgetView> {
    authority = Object.freeze({ ...authority });
    this.#assertNotBlocked(authority);
    const result = await this.#transaction(authority, async (client) => {
      const state = await this.#lock(client, authority);
      const issue = await this.#decision(client, authority, state);
      return issue ?? this.#view(state);
    });
    if ('error' in result) throw result.error;
    return result;
  }

  /** Reconciliation is read-only and never manufactures a one-shot permit. */
  async confirm(
    authority: ExecutionAuthority,
    identity: BudgetAuthorizationIdentity,
  ): Promise<ProductFrame | null> {
    authority = Object.freeze({ ...authority });
    identity = Object.freeze({ ...identity });
    const producerKey = budgetProducerKey(authority.attemptId, identity);
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      return await this.#findAuthorization(client, authority, producerKey);
    } catch {
      this.#blockedAttempts.add(authority.attemptId);
      const error = new PersistentBudgetError('ATTEMPT_DATABASE_UNAVAILABLE', producerKey);
      this.#callback(() => this.options.onDatabaseFailure?.(authority, error));
      throw error;
    } finally {
      client?.release();
    }
  }

  #assertNotBlocked(authority: ExecutionAuthority): void {
    if (this.#blockedAttempts.has(authority.attemptId))
      throw new PersistentBudgetError('ATTEMPT_DATABASE_UNAVAILABLE');
  }

  async #transaction<T>(
    authority: ExecutionAuthority,
    work: (client: PoolClient) => Promise<T>,
    beforeCommit?: () => void,
  ): Promise<T> {
    let client: PoolClient | undefined;
    const events: ProductFrame[] = [];
    try {
      client = await this.pool.connect();
      this.#pendingEvents.set(client, events);
      await client.query('BEGIN');
      const value = await work(client);
      beforeCommit?.();
      await client.query('COMMIT');
      for (const event of events) {
        if (
          event.event_type === 'task.updated' &&
          event.payload.task.latest_attempt.budget?.limit_exceeded_kind
        ) {
          this.#callback(() =>
            this.options.onLimit?.(
              authority,
              new PersistentBudgetError(
                limitCodes[event.payload.task.latest_attempt.budget!.limit_exceeded_kind!],
              ),
            ),
          );
        }
        this.#callback(() => this.options.onCommitted?.(authority, event));
      }
      return value;
    } catch (cause) {
      if (!(cause instanceof PersistentBudgetError)) {
        this.#blockedAttempts.add(authority.attemptId);
        this.#callback(() =>
          this.options.onDatabaseFailure?.(
            authority,
            new PersistentBudgetError('ATTEMPT_DATABASE_UNAVAILABLE'),
          ),
        );
      }
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Original error remains authoritative. */
        }
      }
      throw cause;
    } finally {
      if (client) {
        this.#pendingEvents.delete(client);
        client.release();
      }
    }
  }

  readonly #pendingEvents = new WeakMap<PoolClient, ProductFrame[]>();

  async #lock(client: PoolClient, authority: ExecutionAuthority): Promise<LockedBudget> {
    const {
      rows: [conversation],
    } = await client.query('SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      authority.conversationId,
    ]);
    const {
      rows: [task],
    } = await client.query('SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [authority.taskId]);
    const {
      rows: [session],
    } = await client.query('SELECT * FROM pi_sessions WHERE id=$1 FOR UPDATE', [
      authority.piSessionId,
    ]);
    const {
      rows: [attempt],
    } = await client.query<BudgetAttempt>('SELECT * FROM agent_attempts WHERE id=$1 FOR UPDATE', [
      authority.attemptId,
    ]);
    if (
      !conversation ||
      conversation.deleted_at !== null ||
      !task ||
      !session ||
      !attempt ||
      conversation.pi_session_id !== authority.piSessionId ||
      task.conversation_id !== authority.conversationId ||
      task.pi_session_id !== authority.piSessionId ||
      attempt.task_id !== authority.taskId ||
      attempt.pi_session_id !== authority.piSessionId ||
      session.conversation_id !== authority.conversationId ||
      session.active_attempt_id !== authority.attemptId ||
      session.writer_owner_id !== authority.ownerId ||
      session.execution_generation !== authority.generation ||
      attempt.execution_owner_id !== authority.ownerId ||
      attempt.execution_generation !== authority.generation
    ) {
      throw new PersistentBudgetError('ATTEMPT_EXECUTION_REVOKED');
    }
    if (session.head_revision_id !== authority.expectedHeadRevisionId)
      throw new PersistentBudgetError('ATTEMPT_HEAD_CONFLICT');
    if (attempt.ended_at !== null || task.status === 'completed')
      throw new PersistentBudgetError('ATTEMPT_ENDED');
    const {
      rows: [snapshot],
    } = await client.query('SELECT execution_policy FROM agent_execution_snapshots WHERE id=$1', [
      task.execution_snapshot_id,
    ]);
    const limits = snapshot?.execution_policy?.attempt_limits as AttemptBudgetLimits | undefined;
    if (
      !limits ||
      limits.policy_version !== 1 ||
      [limits.max_duration_ms, limits.max_model_requests, limits.max_tool_calls].some(
        (n) => !Number.isSafeInteger(n) || n < 1,
      )
    )
      throw new PersistentBudgetError('ATTEMPT_INVALID_BUDGET_POLICY');
    const {
      rows: [clock],
    } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return { attempt, limits, nowMs: timestamp(clock!.now) };
  }

  async #decision(
    client: PoolClient,
    authority: ExecutionAuthority,
    state: LockedBudget,
    kind?: BudgetAuthorizationIdentity['kind'],
  ): Promise<{ error: PersistentBudgetError } | null> {
    const { attempt: a, limits, nowMs } = state;
    const decision = decidePersistentBudget(
      {
        startedAtMs: a.started_at === null ? null : timestamp(a.started_at),
        deadlineMs: a.execution_deadline_at === null ? null : timestamp(a.execution_deadline_at),
        modelRequestsUsed: a.model_requests_used,
        toolCallsUsed: a.tool_calls_used,
        limitKind: a.limit_exceeded_kind,
        stopped: a.stop_requested_at !== null,
        ended: a.ended_at !== null,
      },
      limits,
      nowMs,
      kind,
    );
    if (decision.latch) {
      await client.query(
        'UPDATE agent_attempts SET limit_exceeded_kind=$2,limit_exceeded_at=$3 WHERE id=$1',
        [authority.attemptId, decision.latch, new Date(nowMs)],
      );
      a.limit_exceeded_kind = decision.latch;
      a.limit_exceeded_at = new Date(nowMs);
      await this.#changed(client, authority, `budget:limit:${authority.attemptId}`);
    }
    return decision.code ? { error: new PersistentBudgetError(decision.code) } : null;
  }

  #view({ attempt: a, limits }: LockedBudget): AttemptBudgetView {
    if (a.model_requests_used === null || a.tool_calls_used === null)
      throw new PersistentBudgetError('ATTEMPT_BUDGET_UNTRACKED');
    return {
      ...limits,
      execution_deadline_at:
        a.execution_deadline_at === null ? null : new Date(a.execution_deadline_at).toISOString(),
      model_requests_used: a.model_requests_used,
      tool_calls_used: a.tool_calls_used,
      limit_exceeded_kind: a.limit_exceeded_kind,
      limit_exceeded_at:
        a.limit_exceeded_at === null ? null : new Date(a.limit_exceeded_at).toISOString(),
    };
  }

  async #changed(
    client: PoolClient,
    authority: ExecutionAuthority,
    producerKey: string,
  ): Promise<ProductFrame> {
    await client.query(
      'UPDATE agent_tasks SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [authority.taskId],
    );
    const task = await this.#projectTask(client, authority.taskId);
    const event = await appendEvent(client, {
      conversationId: authority.conversationId,
      eventType: 'task.updated',
      payload: { task },
      producerKey,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
    });
    this.#pendingEvents.get(client)!.push(event);
    return event;
  }

  async #findAuthorization(
    client: PoolClient,
    authority: ExecutionAuthority,
    producerKey: string,
  ): Promise<ProductFrame | null> {
    const {
      rows: [event],
    } = await client.query(
      `SELECT payload FROM agent_outbox_events WHERE conversation_id=$1 AND attempt_id=$2 AND producer_key=$3`,
      [authority.conversationId, authority.attemptId, producerKey],
    );
    return event ? (event.payload as ProductFrame) : null;
  }

  #callback(callback: () => void): void {
    try {
      callback();
    } catch {
      /* Notifications cannot undo a committed fact. */
    }
  }
}

/** Caller holds C's coordination lock. Active authorization evidence blocks prefix pruning. */
export async function authorizationPruneCeiling(
  client: PoolClient,
  conversationId: string,
  requestedThroughSeq: string,
): Promise<string> {
  const {
    rows: [row],
  } = await client.query<{ floor: string | null }>(
    `SELECT min(v.event_seq)::text AS floor FROM agent_outbox_events v
      JOIN agent_attempts a ON a.id=v.attempt_id AND a.task_id=v.task_id
      WHERE v.conversation_id=$1 AND a.ended_at IS NULL
        AND (v.producer_key LIKE 'budget:model:%' OR v.producer_key LIKE 'budget:tool:%')`,
    [conversationId],
  );
  const requested = BigInt(requestedThroughSeq);
  const floor = row?.floor ?? null;
  const ceiling = floor === null ? requested : BigInt(floor) - 1n;
  return (requested < ceiling ? requested : ceiling).toString();
}
