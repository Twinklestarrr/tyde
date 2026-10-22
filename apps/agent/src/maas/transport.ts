import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { MaasConfig } from './config.js';
import { assertDirectModelConfig } from './direct-model.js';
import type { DirectModelConfig } from './direct-model.js';
import { createMaasHttpClient, isMaasConnectTimeout } from './http-client.js';
import type { MaasSocketOptions } from './http-client.js';

export class MaasError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly retryAfter?: string,
  ) {
    super(code);
    this.name = 'MaasError';
  }
}

export interface MaasContext {
  conversationId: string;
  taskId: string;
  attemptId: string;
  executionGeneration: string;
  executionSnapshotId: string;
  /** Only an authenticated platform resolver may supply this delegated subject. */
  platformSubjectRef: string;
}

export interface MaasTool {
  parameters: Record<string, unknown>;
  validate: (arguments_: Record<string, unknown>) => boolean;
}

export interface UsageObservation {
  usageState: 'reported' | 'missing' | 'invalid';
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costAmount: null;
  costCurrency: null;
}

export interface MaasObservation {
  profile?: 'chat-sse-v1' | 'direct-model';
  provider?: 'deepseek' | 'openai-compatible';
  modelCallId: string;
  modelRequestId: string;
  platformRequestId: string | null;
  upstreamRequestId: string | null;
  routeVersion: string | null;
  httpStatus: number | null;
  retryAfter: string | null;
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  finishReason: 'stop' | 'tool_calls' | null;
  errorCode: string | null;
  usage: UsageObservation;
}

interface TransportOptions {
  fetch?: typeof globalThis.fetch;
  socket?: MaasSocketOptions;
  signal?: AbortSignal;
  tools?: Readonly<Record<string, MaasTool>>;
  limits?: { responseBytes?: number; eventBytes?: number; toolArgumentsBytes?: number };
}

type JsonObject = Record<string, unknown>;
type RuntimeConfig = Pick<
  MaasConfig,
  'baseUrl' | 'modelId' | 'actualModelIds' | 'contextWindow' | 'maxTokens' | 'compat' | 'timeouts'
>;
type Profile =
  | { kind: 'chat-sse-v1'; config: MaasConfig; context: MaasContext }
  | { kind: 'direct-model'; config: DirectModelConfig };

function safeErrorCode(value: unknown, profile: Profile): value is string {
  return (
    typeof value === 'string' &&
    (profile.kind === 'chat-sse-v1'
      ? /^MAAS_[A-Z0-9_]{1,100}$/
      : /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/
    ).test(value)
  );
}
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fail(code = 'MAAS_PROTOCOL_ERROR'): never {
  throw new MaasError(code);
}
function assert(condition: unknown, code = 'MAAS_PROTOCOL_ERROR'): asserts condition {
  if (!condition) fail(code);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function unknownUsage(state: 'missing' | 'invalid' = 'missing'): UsageObservation {
  return {
    usageState: state,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costAmount: null,
    costCurrency: null,
  };
}

async function httpErrorCode(
  response: Response,
  signal: AbortSignal,
  profile: Profile,
): Promise<string | undefined> {
  if (
    !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
    !response.body
  )
    return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (!signal.aborted) {
      const result = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
        (resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          reader.read().then(
            (value) => {
              signal.removeEventListener('abort', onAbort);
              resolve(value);
            },
            (cause: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(cause);
            },
          );
        },
      );
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 64 * 1024) return undefined;
      body += decoder.decode(result.value, { stream: true });
    }
    if (signal.aborted) throw signal.reason;
    body += decoder.decode();
    const parsed: unknown = JSON.parse(body);
    if (object(parsed) && object(parsed.error) && safeErrorCode(parsed.error.code, profile))
      return parsed.error.code;
  } catch {
    if (signal.aborted) throw signal.reason;
    // An invalid/proxy error body never becomes a model answer or a diagnostic message.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return undefined;
}
function validateContext(context: MaasContext): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const key of ['conversationId', 'taskId', 'attemptId', 'executionSnapshotId'] as const) {
    assert(uuid.test(context[key]), 'MAAS_CONTEXT_INVALID');
  }
  assert(
    /^[1-9][0-9]*$/.test(context.executionGeneration) &&
      BigInt(context.executionGeneration) <= 9_223_372_036_854_775_807n,
    'MAAS_CONTEXT_INVALID',
  );
  assert(
    text(context.platformSubjectRef, 256) && !/[\p{Cc}\p{Cs}]/u.test(context.platformSubjectRef),
    'MAAS_SUBJECT_REQUIRED',
  );
}
function validateTextContent(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.every(
        (part) =>
          object(part) &&
          part.type === 'text' &&
          typeof part.text === 'string' &&
          Object.keys(part).every((key) => ['type', 'text'].includes(key)),
      ))
  );
}
function validatePayload(
  raw: string,
  config: RuntimeConfig,
  tools: Readonly<Record<string, MaasTool>>,
  profile: Profile,
): void {
  assert(Buffer.byteLength(raw) <= 8 * 1024 * 1024, 'MAAS_REQUEST_LIMIT_EXCEEDED');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail('MAAS_REQUEST_INVALID');
  }
  assert(object(payload), 'MAAS_REQUEST_INVALID');
  const allowed = [
    'model',
    'messages',
    'stream',
    'stream_options',
    'n',
    'store',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    config.compat.maxTokensField,
  ];
  if (profile.kind === 'direct-model' && profile.config.provider === 'deepseek')
    allowed.push('thinking');
  // Thinking is enabled only by the explicit, non-thinking DeepSeek request preset.
  assert(
    Object.keys(payload).every((key) => allowed.includes(key)),
    'MAAS_REQUEST_INVALID',
  );
  if (profile.kind === 'direct-model' && profile.config.provider === 'deepseek')
    assert(isDeepStrictEqual(payload.thinking, { type: 'disabled' }), 'MAAS_REQUEST_INVALID');
  assert(payload.model === config.modelId && payload.stream === true, 'MAAS_REQUEST_INVALID');
  assert(
    object(payload.stream_options) &&
      payload.stream_options.include_usage === true &&
      Object.keys(payload.stream_options).length === 1,
    'MAAS_REQUEST_INVALID',
  );
  assert(payload.n === undefined || payload.n === 1, 'MAAS_REQUEST_INVALID');
  assert(payload.store === undefined || payload.store === false, 'MAAS_REQUEST_INVALID');
  assert(payload.store === undefined || config.compat.supportsStore, 'MAAS_REQUEST_INVALID');
  assert(
    payload[config.compat.maxTokensField] === config.maxTokens &&
      Number.isSafeInteger(payload[config.compat.maxTokensField]),
    'MAAS_REQUEST_INVALID',
  );
  assert(
    Array.isArray(payload.messages) &&
      payload.messages.length > 0 &&
      payload.messages.length <= 512,
    'MAAS_REQUEST_INVALID',
  );
  const pendingTools = new Map<string, string>();
  for (const message of payload.messages) {
    assert(object(message), 'MAAS_REQUEST_INVALID');
    assert(
      Object.keys(message).every((key) =>
        ['role', 'content', 'tool_calls', 'tool_call_id'].includes(key),
      ),
      'MAAS_REQUEST_INVALID',
    );
    if (message.role === 'system' || message.role === 'developer') {
      assert(
        message.role !== 'developer' || config.compat.supportsDeveloperRole,
        'MAAS_REQUEST_INVALID',
      );
      assert(
        typeof message.content === 'string' &&
          message.tool_calls === undefined &&
          message.tool_call_id === undefined,
        'MAAS_REQUEST_INVALID',
      );
    } else if (message.role === 'user') {
      assert(
        validateTextContent(message.content) &&
          message.tool_calls === undefined &&
          message.tool_call_id === undefined &&
          pendingTools.size === 0,
        'MAAS_REQUEST_INVALID',
      );
    } else if (message.role === 'assistant') {
      assert(message.tool_call_id === undefined && pendingTools.size === 0, 'MAAS_REQUEST_INVALID');
      if (message.tool_calls !== undefined) {
        assert(
          Array.isArray(message.tool_calls) && message.tool_calls.length === 1,
          'MAAS_REQUEST_INVALID',
        );
        assert(
          message.content === null || typeof message.content === 'string',
          'MAAS_REQUEST_INVALID',
        );
        for (const call of message.tool_calls) {
          assert(
            object(call) && text(call.id, 128) && call.type === 'function' && object(call.function),
            'MAAS_REQUEST_INVALID',
          );
          assert(
            text(call.function.name, 64) &&
              Object.hasOwn(tools, call.function.name) &&
              typeof call.function.arguments === 'string',
            'MAAS_REQUEST_INVALID',
          );
          validateArguments(call.function.arguments, tools[call.function.name]!, 64 * 1024);
          pendingTools.set(call.id, call.function.name);
        }
      } else {
        assert(typeof message.content === 'string', 'MAAS_REQUEST_INVALID');
      }
    } else if (message.role === 'tool') {
      assert(
        typeof message.tool_call_id === 'string' &&
          pendingTools.has(message.tool_call_id) &&
          validateTextContent(message.content) &&
          message.tool_calls === undefined,
        'MAAS_REQUEST_INVALID',
      );
      pendingTools.delete(message.tool_call_id);
    } else fail('MAAS_REQUEST_INVALID');
  }
  assert(pendingTools.size === 0, 'MAAS_REQUEST_INVALID');
  if (payload.tools !== undefined) {
    assert(Array.isArray(payload.tools) && payload.tools.length <= 64, 'MAAS_REQUEST_INVALID');
    const names = new Set<string>();
    for (const declaration of payload.tools) {
      assert(
        object(declaration) && declaration.type === 'function' && object(declaration.function),
        'MAAS_REQUEST_INVALID',
      );
      const fn = declaration.function;
      assert(
        typeof fn.name === 'string' && Object.hasOwn(tools, fn.name) && !names.has(fn.name),
        'MAAS_REQUEST_INVALID',
      );
      assert(isDeepStrictEqual(fn.parameters, tools[fn.name]!.parameters), 'MAAS_REQUEST_INVALID');
      assert(
        Object.keys(fn).every((key) =>
          ['name', 'description', 'parameters', 'strict'].includes(key),
        ) &&
          (fn.strict === undefined || typeof fn.strict === 'boolean'),
        'MAAS_REQUEST_INVALID',
      );
      names.add(fn.name);
    }
    assert(names.size === Object.keys(tools).length, 'MAAS_REQUEST_INVALID');
  } else assert(Object.keys(tools).length === 0, 'MAAS_REQUEST_INVALID');
  assert(
    payload.tool_choice === undefined ||
      payload.tool_choice === 'none' ||
      payload.tool_choice === 'auto',
    'MAAS_REQUEST_INVALID',
  );
  assert(
    payload.parallel_tool_calls === undefined || payload.parallel_tool_calls === false,
    'MAAS_REQUEST_INVALID',
  );
}
function validateArguments(raw: string, tool: MaasTool, limit: number): void {
  assert(Buffer.byteLength(raw) <= limit, 'MAAS_RESPONSE_LIMIT_EXCEEDED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('MAAS_TOOL_ARGUMENTS_INVALID');
  }
  assert(object(parsed), 'MAAS_TOOL_ARGUMENTS_INVALID');
  let valid = false;
  try {
    valid = tool.validate(parsed);
  } catch {
    fail('MAAS_TOOL_ARGUMENTS_INVALID');
  }
  assert(valid, 'MAAS_TOOL_ARGUMENTS_INVALID');
}

class StreamGuard {
  private identity?: { id: string; created: number; model: string };
  private tool?: { index: number; id?: string; name?: string; type?: string; arguments: string };
  private content = '';
  private done = false;
  constructor(
    private readonly config: RuntimeConfig,
    private readonly tools: Readonly<Record<string, MaasTool>>,
    private readonly observation: MaasObservation,
    private readonly argumentLimit: number,
    private readonly profile: Profile,
  ) {}
  accept(data: string): { done: boolean; progress: boolean } {
    if (this.done) return { done: true, progress: false };
    if (data === '[DONE]') {
      assert(this.observation.finishReason !== null, 'MAAS_INCOMPLETE_STREAM');
      if (this.observation.finishReason === 'tool_calls') {
        assert(
          this.tool && this.tool.id && this.tool.type === 'function' && this.tool.name,
          'MAAS_TOOL_ARGUMENTS_INVALID',
        );
        assert(Object.hasOwn(this.tools, this.tool.name), 'MAAS_TOOL_NOT_ALLOWED');
        validateArguments(this.tool.arguments, this.tools[this.tool.name]!, this.argumentLimit);
      } else {
        assert(!this.tool && this.content.trim().length > 0, 'MAAS_EMPTY_OUTPUT');
      }
      this.done = true;
      this.observation.state = 'complete';
      return { done: true, progress: false };
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      fail();
    }
    assert(object(chunk));
    if (chunk.error !== undefined) {
      assert(object(chunk.error));
      const code = chunk.error.code;
      fail(safeErrorCode(code, this.profile) ? code : 'MAAS_UPSTREAM_ERROR');
    }
    assert(
      text(chunk.id, 256) &&
        chunk.object === 'chat.completion.chunk' &&
        Number.isSafeInteger(chunk.created) &&
        Number(chunk.created) >= 0 &&
        text(chunk.model, 128) &&
        this.config.actualModelIds.includes(chunk.model),
    );
    const identity = { id: chunk.id, created: Number(chunk.created), model: chunk.model };
    if (this.identity) assert(isDeepStrictEqual(identity, this.identity));
    else this.identity = identity;
    assert(Array.isArray(chunk.choices) && chunk.choices.length <= 1);
    if (chunk.usage !== undefined && chunk.usage !== null) this.usage(chunk.usage);
    if (!chunk.choices.length) {
      assert(
        this.observation.finishReason !== null && chunk.usage !== undefined && chunk.usage !== null,
      );
      return { done: false, progress: false };
    }
    const choice: unknown = chunk.choices[0];
    assert(
      object(choice) &&
        choice.index === 0 &&
        object(choice.delta) &&
        Object.hasOwn(choice, 'finish_reason'),
    );
    const delta = choice.delta;
    assert(
      delta.role === undefined ||
        delta.role === 'assistant' ||
        (this.profile.kind === 'direct-model' && delta.role === null),
    );
    assert(
      delta.content === undefined || delta.content === null || typeof delta.content === 'string',
    );
    // Reasoning is deliberately disabled until a mode has been separately accepted.
    assert(
      delta.reasoning_content === undefined ||
        delta.reasoning_content === null ||
        delta.reasoning_content === '',
    );
    assert(delta.function_call === undefined && delta.reasoning_details === undefined);
    let progress = false;
    if (typeof delta.content === 'string' && delta.content.length) {
      assert(this.observation.finishReason === null);
      this.content += delta.content;
      progress = true;
    }
    if (delta.tool_calls !== undefined) {
      assert(Array.isArray(delta.tool_calls));
      if (delta.tool_calls.length) assert(this.observation.finishReason === null);
      for (const item of delta.tool_calls) {
        assert(object(item) && Number.isSafeInteger(item.index) && Number(item.index) >= 0);
        if (this.tool && this.tool.index !== item.index) fail('MAAS_PARALLEL_TOOLS_UNSUPPORTED');
        if (!this.tool) this.tool = { index: Number(item.index), arguments: '' };
        const tool = this.tool;
        for (const key of ['id', 'type'] as const) {
          if (item[key] !== undefined) {
            assert(text(item[key], key === 'id' ? 128 : 8), 'MAAS_TOOL_ARGUMENTS_INVALID');
            assert(tool[key] === undefined || tool[key] === item[key]);
            progress ||= tool[key] === undefined;
            tool[key] = item[key];
          }
        }
        assert(tool.type === undefined || tool.type === 'function', 'MAAS_TOOL_ARGUMENTS_INVALID');
        if (item.function !== undefined) {
          assert(object(item.function));
          const fn = item.function;
          if (fn.name !== undefined) {
            assert(
              text(fn.name, 64) && /^[a-zA-Z0-9_-]+$/.test(fn.name),
              'MAAS_TOOL_ARGUMENTS_INVALID',
            );
            assert(tool.name === undefined || tool.name === fn.name);
            assert(Object.hasOwn(this.tools, fn.name), 'MAAS_TOOL_NOT_ALLOWED');
            progress ||= tool.name === undefined;
            tool.name = fn.name;
          }
          if (fn.arguments !== undefined) {
            assert(typeof fn.arguments === 'string', 'MAAS_TOOL_ARGUMENTS_INVALID');
            tool.arguments += fn.arguments;
            assert(
              Buffer.byteLength(tool.arguments) <= this.argumentLimit,
              'MAAS_RESPONSE_LIMIT_EXCEEDED',
            );
            progress ||= fn.arguments.length > 0;
          }
        }
      }
    }
    if (choice.finish_reason !== null) {
      assert(this.observation.finishReason === null);
      if (choice.finish_reason === 'length') fail('MAAS_OUTPUT_TRUNCATED');
      if (choice.finish_reason === 'content_filter') fail('MAAS_CONTENT_FILTERED');
      assert(
        choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls',
        'MAAS_UNSUPPORTED_FINISH_REASON',
      );
      assert(choice.finish_reason !== 'stop' || !this.tool);
      this.observation.finishReason = choice.finish_reason;
    }
    return { done: false, progress };
  }
  private usage(raw: unknown): void {
    const bad = (): never => {
      this.observation.usage = unknownUsage('invalid');
      return fail('MAAS_USAGE_INVALID');
    };
    if (!object(raw)) bad();
    const usage = raw as JsonObject;
    const counter = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (
      !counter(usage.prompt_tokens) ||
      !counter(usage.completion_tokens) ||
      !counter(usage.total_tokens)
    )
      bad();
    const prompt = usage.prompt_tokens as number;
    const completion = usage.completion_tokens as number;
    const total = usage.total_tokens as number;
    if (prompt + completion !== total) bad();
    let cached: number | null = null;
    let reasoning: number | null = null;
    if (
      usage.prompt_tokens_details !== undefined &&
      !(this.profile.kind === 'direct-model' && usage.prompt_tokens_details === null)
    ) {
      if (!object(usage.prompt_tokens_details)) bad();
      const value = (usage.prompt_tokens_details as JsonObject).cached_tokens;
      if (value !== undefined) {
        if (!counter(value) || value > prompt) bad();
        cached = value as number;
      }
    }
    if (
      usage.completion_tokens_details !== undefined &&
      !(this.profile.kind === 'direct-model' && usage.completion_tokens_details === null)
    ) {
      if (!object(usage.completion_tokens_details)) bad();
      const value = (usage.completion_tokens_details as JsonObject).reasoning_tokens;
      if (value !== undefined) {
        if (!counter(value) || value > completion) bad();
        reasoning = value as number;
      }
    }
    if (this.profile.kind === 'direct-model' && this.profile.config.provider === 'deepseek') {
      const hit = usage.prompt_cache_hit_tokens;
      const miss = usage.prompt_cache_miss_tokens;
      if (hit !== undefined) {
        if (!counter(hit) || hit > prompt || (cached !== null && cached !== hit)) bad();
        cached = hit as number;
      }
      if (miss !== undefined) {
        if (
          !counter(miss) ||
          miss > prompt ||
          (hit !== undefined && Number(hit) + Number(miss) !== prompt)
        )
          bad();
      }
    }
    const projected: UsageObservation = {
      usageState: 'reported',
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      cachedTokens: cached,
      reasoningTokens: reasoning,
      costAmount: null,
      costCurrency: null,
    };
    if (
      this.observation.usage.usageState === 'reported' &&
      !isDeepStrictEqual(this.observation.usage, projected)
    )
      bad();
    this.observation.usage = projected;
  }
}

function createGuardedTransport(
  config: RuntimeConfig,
  profile: Profile,
  options: TransportOptions,
) {
  const all: MaasObservation[] = [];
  const tools = options.tools ?? {};
  const endpoint = `${config.baseUrl}/chat/completions`;
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert(
      url === endpoint && init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string',
      'MAAS_REQUEST_INVALID',
    );
    validatePayload(init.body, config, tools, profile);
    const observation: MaasObservation = {
      profile: profile.kind,
      ...(profile.kind === 'direct-model' ? { provider: profile.config.provider } : {}),
      modelCallId: randomUUID(),
      modelRequestId: randomUUID(),
      platformRequestId: null,
      upstreamRequestId: null,
      routeVersion: null,
      httpStatus: null,
      retryAfter: null,
      state: 'pending',
      finishReason: null,
      errorCode: null,
      usage: unknownUsage(),
    };
    all.push(observation);
    const abort = new AbortController();
    const httpClient = options.fetch
      ? undefined
      : createMaasHttpClient(config.timeouts.connectMs, abort.signal, options.socket);
    const underlyingFetch = options.fetch ?? httpClient!.fetch;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const removers: (() => void)[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receivedResponse: Response | undefined;
    const error = (value: unknown): MaasError =>
      value instanceof MaasError
        ? value
        : abort.signal.reason instanceof MaasError
          ? abort.signal.reason
          : new MaasError(
              isMaasConnectTimeout(value) ? 'MAAS_CONNECT_TIMEOUT' : 'MAAS_TRANSPORT_ERROR',
            );
    const markFailure = (value: unknown): MaasError => {
      const failure = error(value);
      observation.state = failure.code === 'MAAS_CANCELLED' ? 'cancelled' : 'failed';
      observation.errorCode = failure.code;
      return failure;
    };
    const cancel = (failure: MaasError) => {
      if (!abort.signal.aborted && observation.state === 'pending') abort.abort(failure);
    };
    const schedule = (code: string, milliseconds: number) => {
      const timer = setTimeout(() => cancel(new MaasError(code)), milliseconds);
      timers.add(timer);
      return timer;
    };
    const clear = (timer: ReturnType<typeof setTimeout> | undefined) => {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };
    const cleanup = () => {
      timers.forEach(clearTimeout);
      timers.clear();
      removers.forEach((remove) => remove());
      void httpClient?.dispose().catch(() => undefined);
    };
    for (const signal of [options.signal, init.signal]) {
      if (!signal) continue;
      const handler = () => cancel(new MaasError('MAAS_CANCELLED'));
      if (signal.aborted) handler();
      else {
        signal.addEventListener('abort', handler, { once: true });
        removers.push(() => signal.removeEventListener('abort', handler));
      }
    }
    const headers = profile.kind === 'chat-sse-v1' ? new Headers(init.headers) : new Headers();
    if (profile.kind === 'chat-sse-v1') {
      const context = profile.context;
      const metadata: Record<string, string> = {
        Authorization: `Bearer ${profile.config.serviceToken}`,
        'X-Platform-Subject-Ref': context.platformSubjectRef,
        'X-Agent-Conversation-ID': context.conversationId,
        'X-Agent-Task-ID': context.taskId,
        'X-Agent-Attempt-ID': context.attemptId,
        'X-Agent-Execution-Generation': context.executionGeneration,
        'X-Agent-Execution-Snapshot-ID': context.executionSnapshotId,
        'X-Agent-Model-Call-ID': observation.modelCallId,
        'X-Agent-Model-Request-ID': observation.modelRequestId,
        'X-Agent-Model-Role': 'primary',
        'X-Agent-MaaS-Contract': 'chat-sse-v1',
        'X-Agent-MaaS-Route-Version': profile.config.routeVersion,
        'X-Agent-Request-Timeout-Ms': String(config.timeouts.totalMs),
      };
      Object.entries(metadata).forEach(([key, value]) => headers.set(key, value));
    } else headers.set('authorization', `Bearer ${profile.config.apiKey}`);
    headers.set('content-type', 'application/json');
    schedule('MAAS_TOTAL_TIMEOUT', config.timeouts.totalMs);
    const headersTimer = schedule('MAAS_HEADERS_TIMEOUT', config.timeouts.headersMs);
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      const pendingFetch = underlyingFetch(input, {
        ...init,
        headers,
        signal: abort.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      // A host-injected fetch may ignore AbortSignal. Local stop must still converge promptly.
      const response = await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', onAbort, { once: true });
        pendingFetch.then(
          (value) => {
            abort.signal.removeEventListener('abort', onAbort);
            if (abort.signal.aborted) {
              void value.body?.cancel().catch(() => undefined);
              reject(abort.signal.reason);
            } else resolve(value);
          },
          (cause: unknown) => {
            abort.signal.removeEventListener('abort', onAbort);
            reject(cause);
          },
        );
      });
      receivedResponse = response;
      clear(headersTimer);
      if (abort.signal.aborted) throw abort.signal.reason;
      observation.httpStatus = response.status;
      observation.retryAfter = response.headers.get('retry-after');
      const platformId =
        profile.kind === 'chat-sse-v1' ? response.headers.get('x-platform-request-id') : null;
      const upstreamId = response.headers.get(
        profile.kind === 'chat-sse-v1' ? 'x-upstream-request-id' : 'x-request-id',
      );
      observation.platformRequestId = text(platformId, 256) ? platformId : null;
      observation.upstreamRequestId = text(upstreamId, 256) ? upstreamId : null;
      observation.routeVersion =
        profile.kind === 'chat-sse-v1' ? response.headers.get('x-maas-route-version') : null;
      if (response.status !== 200) {
        // Never expose upstream error messages or response bodies to a caller/log.
        const code =
          profile.kind === 'chat-sse-v1' && response.status === 409
            ? 'MAAS_ROUTE_VERSION_CONFLICT'
            : ((await httpErrorCode(response, abort.signal, profile)) ?? 'MAAS_HTTP_ERROR');
        throw new MaasError(
          code,
          response.status,
          response.headers.get('retry-after') ?? undefined,
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase();
      assert(contentType?.split(';')[0]?.trim() === 'text/event-stream');
      const encoding = response.headers.get('content-encoding');
      assert(!encoding || encoding.trim().toLowerCase() === 'identity');
      const charset = contentType?.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/);
      assert(!charset || (charset[1] ?? charset[2]) === 'utf-8');
      if (profile.kind === 'chat-sse-v1') {
        assert(
          response.headers
            .get('cache-control')
            ?.split(',')
            .some((value) => value.trim().toLowerCase() === 'no-store'),
        );
        assert(
          response.headers.get('x-agent-model-request-id') === observation.modelRequestId &&
            observation.platformRequestId &&
            observation.routeVersion === profile.config.routeVersion,
        );
      }
      assert(response.body);
      reader = response.body.getReader();
      const guard = new StreamGuard(
        config,
        tools,
        observation,
        options.limits?.toolArgumentsBytes ?? 64 * 1024,
        profile,
      );
      let progressTimer = schedule('MAAS_FIRST_PROGRESS_TIMEOUT', config.timeouts.firstProgressMs);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const encoder = new TextEncoder();
      let buffered = '';
      let dataLines: string[] = [];
      let eventBytes = 0;
      let responseBytes = 0;
      let finished = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => {
            if (finished) return;
            finished = true;
            const failure = markFailure(abort.signal.reason);
            controller.error(failure);
            void reader?.cancel(failure).catch(() => undefined);
            cleanup();
          };
          abort.signal.addEventListener('abort', onAbort, { once: true });
          removers.push(() => abort.signal.removeEventListener('abort', onAbort));
          const line = (value: string) => {
            eventBytes += Buffer.byteLength(value) + 1;
            assert(
              eventBytes <= (options.limits?.eventBytes ?? 256 * 1024),
              'MAAS_RESPONSE_LIMIT_EXCEEDED',
            );
            if (value === '') {
              if (dataLines.length) {
                const data = dataLines.join('\n');
                const result = guard.accept(data);
                if (result.progress) {
                  clear(progressTimer);
                  progressTimer = schedule('MAAS_IDLE_TIMEOUT', config.timeouts.idleMs);
                }
                controller.enqueue(encoder.encode(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`));
                if (result.done) {
                  finished = true;
                  cleanup();
                  controller.close();
                  void reader?.cancel().catch(() => undefined);
                }
              }
              dataLines = [];
              eventBytes = 0;
            } else if (value === 'data') dataLines.push('');
            else if (value.startsWith('data:'))
              dataLines.push(value.slice(value[5] === ' ' ? 6 : 5));
          };
          const lines = (eof: boolean) => {
            while (!finished) {
              const index = buffered.search(/[\r\n]/);
              if (index < 0 || (!eof && buffered[index] === '\r' && index === buffered.length - 1))
                break;
              const width = buffered[index] === '\r' && buffered[index + 1] === '\n' ? 2 : 1;
              const value = buffered.slice(0, index);
              buffered = buffered.slice(index + width);
              line(value);
            }
            assert(
              Buffer.byteLength(buffered) + eventBytes <=
                (options.limits?.eventBytes ?? 256 * 1024),
              'MAAS_RESPONSE_LIMIT_EXCEEDED',
            );
          };
          void (async () => {
            try {
              while (!finished) {
                const item = await reader!.read();
                if (finished) break;
                if (abort.signal.aborted) throw abort.signal.reason;
                if (item.done) {
                  try {
                    buffered += decoder.decode();
                  } catch {
                    fail();
                  }
                  lines(true);
                  if (!finished) fail('MAAS_INCOMPLETE_STREAM');
                  break;
                }
                responseBytes += item.value.byteLength;
                assert(
                  responseBytes <= (options.limits?.responseBytes ?? 8 * 1024 * 1024),
                  'MAAS_RESPONSE_LIMIT_EXCEEDED',
                );
                try {
                  buffered += decoder.decode(item.value, { stream: true });
                } catch {
                  fail();
                }
                lines(false);
              }
            } catch (cause) {
              if (!finished) {
                finished = true;
                const failure = markFailure(cause);
                controller.error(failure);
                abort.abort(failure);
                void reader?.cancel(failure).catch(() => undefined);
                cleanup();
              }
            }
          })();
        },
        cancel() {
          finished = true;
          const failure = markFailure(new MaasError('MAAS_CANCELLED'));
          abort.abort(failure);
          cleanup();
          return reader?.cancel(failure);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (cause) {
      const failure = markFailure(cause);
      abort.abort(failure);
      void reader?.cancel(failure).catch(() => undefined);
      if (!reader) void receivedResponse?.body?.cancel(failure).catch(() => undefined);
      cleanup();
      throw failure;
    }
  };
  return {
    fetch: guardedFetch,
    observation: (): MaasObservation | undefined => all.at(-1),
    observations: (): readonly MaasObservation[] => all,
  };
}

/** Strict platform contract: local direct-model environment never changes this entry point. */
export function createMaasTransport(
  config: MaasConfig,
  context: MaasContext,
  options: TransportOptions = {},
) {
  validateContext(context);
  return createGuardedTransport(config, { kind: 'chat-sse-v1', config, context }, options);
}

/** Explicit local URL/key entry point; it creates no platform identity or route metadata. */
export function createDirectModelTransport(
  config: DirectModelConfig,
  options: TransportOptions = {},
) {
  assertDirectModelConfig(config);
  return createGuardedTransport(config, { kind: 'direct-model', config }, options);
}
