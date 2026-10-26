import type { AttemptBudgetView } from '@tyde/shared/agent';

export interface AttemptBudgetLimits {
  policy_version: number;
  max_duration_ms: number;
  max_model_requests: number;
  max_tool_calls: number;
}

export const DEFAULT_ATTEMPT_LIMITS: Readonly<AttemptBudgetLimits> = Object.freeze({
  policy_version: 1,
  max_duration_ms: 600_000,
  max_model_requests: 12,
  max_tool_calls: 10,
});

export interface AttemptBudgetClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

type LimitKind = NonNullable<AttemptBudgetView['limit_exceeded_kind']>;
type LimitCode =
  | 'ATTEMPT_DURATION_LIMIT_EXCEEDED'
  | 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'
  | 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED';
type BudgetCode = LimitCode | 'ATTEMPT_NOT_STARTED' | 'ATTEMPT_STOPPED' | 'ATTEMPT_ENDED';

export class AttemptBudgetError extends Error {
  constructor(public readonly code: BudgetCode) {
    super(code);
    this.name = 'AttemptBudgetError';
  }
}

interface AttemptBudgetOptions {
  limits?: AttemptBudgetLimits;
  clock?: AttemptBudgetClock;
  /** 同步发布投影；调用方应在同一协调临界区更新 Task 及事件水位。 */
  onChange?(view: AttemptBudgetView): void;
  /** 此回调只请求取消；不能在 Pi 等待的屏障中等待 Pi 自身结束。 */
  onLimit?(error: AttemptBudgetError): void;
}

const realClock: AttemptBudgetClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const limitCodes: Record<LimitKind, LimitCode> = {
  duration: 'ATTEMPT_DURATION_LIMIT_EXCEEDED',
  model_requests: 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED',
  tool_calls: 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED',
};

/**
 * 单进程 Attempt 执行门禁。同步预占保证同一事件循环内不超领；不提供持久授权
 * 或崩溃后的发送恢复。授权失败不退计数，相同身份不再授权第二次派发。
 */
export class AttemptBudget {
  readonly #limits: Readonly<AttemptBudgetLimits>;
  readonly #clock: AttemptBudgetClock;
  readonly #controller = new AbortController();
  readonly #options: AttemptBudgetOptions;
  readonly #modelAuthorizations = new Set<string>();
  readonly #toolAuthorizations = new Set<string>();
  #state: 'queued' | 'running' | 'stopping' | 'ended' = 'queued';
  #deadline: number | null = null;
  #limitKind: LimitKind | null = null;
  #limitAt: number | null = null;
  #limitError: AttemptBudgetError | null = null;
  #timer: unknown;

  constructor(options: AttemptBudgetOptions = {}) {
    const limits = { ...(options.limits ?? DEFAULT_ATTEMPT_LIMITS) };
    if (
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      limits.policy_version !== 1
    ) {
      throw new Error('ATTEMPT_INVALID_BUDGET_POLICY');
    }
    this.#limits = Object.freeze(limits);
    this.#clock = options.clock ?? realClock;
    this.#options = options;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get limitError(): AttemptBudgetError | null {
    return this.#limitError;
  }

  start(startedAtMs = this.#clock.now()): void {
    if (this.#state !== 'queued') throw new Error('ATTEMPT_ALREADY_STARTED');
    const deadline = startedAtMs + this.#limits.max_duration_ms;
    if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(deadline))
      throw new Error('ATTEMPT_INVALID_STARTED_AT');
    // Validate the public timestamp before recording any state.
    new Date(deadline).toISOString();
    this.#deadline = deadline;
    this.#state = 'running';
    this.#changed();
    this.#scheduleDeadline();
  }

  authorizeModel(authorizationId: string): boolean {
    return this.#authorize('model_requests', authorizationId);
  }

  authorizeTool(authorizationId: string): boolean {
    return this.#authorize('tool_calls', authorizationId);
  }

  assertCanProceed(): void {
    if (this.#limitError) throw this.#limitError;
    if (this.#state !== 'running') {
      throw new AttemptBudgetError(
        this.#state === 'queued'
          ? 'ATTEMPT_NOT_STARTED'
          : this.#state === 'stopping'
            ? 'ATTEMPT_STOPPED'
            : 'ATTEMPT_ENDED',
      );
    }
    if (this.#clock.now() >= this.#deadline!) throw this.#latch('duration');
  }

  remainingMs(): number {
    return this.#deadline === null ? 0 : Math.max(0, this.#deadline - this.#clock.now());
  }

  /** 返回 true 表示停止先行取得裁决；预算锁存后不能冒充用户停止。 */
  requestStop(): boolean {
    if (this.#state === 'ended' || this.#state === 'stopping' || this.#limitError) return false;
    // Deadline is checked under the same synchronous gate as user stop.
    if (this.#state === 'running' && this.#clock.now() >= this.#deadline!) {
      this.#latch('duration');
      return false;
    }
    this.#state = 'stopping';
    this.#clearTimer();
    this.#controller.abort(new AttemptBudgetError('ATTEMPT_STOPPED'));
    return true;
  }

  /** 交付必须在本方法成功后发布；用尽最后一次授权仍可正常完成。 */
  complete(): void {
    this.assertCanProceed();
    this.finish();
  }

  /** 失败或停止收敛；不清除首个预算原因或授权消耗。 */
  finish(): void {
    this.#state = 'ended';
    this.#clearTimer();
  }

  view(): AttemptBudgetView {
    return {
      ...this.#limits,
      execution_deadline_at:
        this.#deadline === null ? null : new Date(this.#deadline).toISOString(),
      model_requests_used: this.#modelAuthorizations.size,
      tool_calls_used: this.#toolAuthorizations.size,
      limit_exceeded_kind: this.#limitKind,
      limit_exceeded_at: this.#limitAt === null ? null : new Date(this.#limitAt).toISOString(),
    };
  }

  #authorize(kind: 'model_requests' | 'tool_calls', authorizationId: string): boolean {
    this.assertCanProceed();
    if (!authorizationId) throw new Error('ATTEMPT_INVALID_AUTHORIZATION_ID');
    const authorizations =
      kind === 'model_requests' ? this.#modelAuthorizations : this.#toolAuthorizations;
    if (authorizations.has(authorizationId)) return false;
    const maximum =
      kind === 'model_requests' ? this.#limits.max_model_requests : this.#limits.max_tool_calls;
    if (authorizations.size >= maximum) throw this.#latch(kind);
    authorizations.add(authorizationId);
    this.#changed();
    return true;
  }

  #changed(): void {
    this.#options.onChange?.(this.view());
  }

  #latch(kind: LimitKind): AttemptBudgetError {
    if (this.#limitError) return this.#limitError;
    this.#limitKind = kind;
    this.#limitAt = this.#clock.now();
    this.#limitError = new AttemptBudgetError(limitCodes[kind]);
    this.#clearTimer();
    this.#controller.abort(this.#limitError);
    try {
      this.#changed();
    } finally {
      this.#options.onLimit?.(this.#limitError);
    }
    return this.#limitError;
  }

  #scheduleDeadline(): void {
    this.#clearTimer();
    if (this.#state !== 'running' || this.#limitError) return;
    const remaining = this.remainingMs();
    if (remaining === 0) {
      this.#latch('duration');
      return;
    }
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timer = undefined;
        if (this.#state !== 'running' || this.#limitError) return;
        if (this.remainingMs() === 0) this.#latch('duration');
        else this.#scheduleDeadline();
      },
      Math.min(remaining, 2_147_483_647),
    );
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
