import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  validateToolArguments,
  type AssistantMessage,
  type Model,
  type TSchema,
  type ToolCall,
  type TextContent,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  type ResourceLoader,
  type SessionEntry,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent';
import {
  createMaasTransport,
  createDirectModelTransport,
  type DirectModelConfig,
  type MaasConfig,
  type MaasContext,
  type MaasObservation,
  type MaasTool,
} from '../maas/index.js';
import { assertTrustedPiResources, resourceSha256, type TrustedPiResources } from './resources.js';

export const PI_SDK_VERSION = '1.3.0';
export const PI_SOURCE_COMMIT = '71023aec1546d6d677a65669c5665c0927ce0dd0';

/** 原生内存树的只读副本；不是持久提交回执或另一种恢复格式。 */
export interface PiNativeState {
  header: SessionHeader | null;
  entries: SessionEntry[];
  leafId: string | null;
  /** Host envelope metadata, not a replacement for the native header/entries tree. */
  configuration?: PiExecutionConfiguration;
}

export interface PiExecutionConfiguration {
  schemaVersion: 1;
  sha256: string;
  piSdkVersion: string;
  model: {
    provider: string;
    id: string;
    baseUrl: string;
    contextWindow: number;
    maxTokens: number;
    compat: NativeModelConfig['compat'];
    timeouts: NativeModelConfig['timeouts'];
  };
  systemPromptSha256: string;
  resources: TrustedPiResources['manifest'] | null;
  tools: readonly {
    name: string;
    description: string;
    parameters: TSchema;
    timeoutMs: number;
    publicMetadata: { isDemo: boolean; displayLabel: string } | null;
  }[];
}

export interface TrustedMaasIdentity {
  platformSubjectRef: string;
  serviceToken?: string;
  source?: 'platform';
}

export interface PiMemoryTool {
  name: string;
  description: string;
  parameters: TSchema;
  validate(args: Record<string, unknown>): boolean;
  /** Only deployment-owned, reviewed text is eligible for product projection. */
  publicMetadata?: { isDemo: boolean; displayLabel: string };
  projectInput?(args: Readonly<Record<string, unknown>>): string;
  timeoutMs?: number;
  execute(
    args: Record<string, unknown>,
    context: { signal: AbortSignal; toolCallId: string },
  ): Promise<string | { content: string; summary: string }>;
}

export interface PiModelRequestContext {
  modelRequestId: string;
}

export interface PiToolCallContext extends PiModelRequestContext {
  toolCallId: string;
  toolName: string;
  sourceNativeEntryId: string;
}

export interface PiToolLifecycle extends PiToolCallContext {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  isDemo: boolean;
  displayLabel: string;
  inputSummary: string;
  resultSummary: string | null;
  errorCode:
    'invalid_arguments' | 'tool_failed' | 'cancelled' | 'budget_exceeded' | 'timeout' | null;
  resultNativeEntryId: string | null;
}

/** 后续保存屏障的等待点。拒绝后锁住会话，禁止工具或下一轮模型。 */
export interface PiMemoryBarriers {
  beforeModel?(state: PiNativeState, request?: PiModelRequestContext): Promise<void>;
  /** 授权后、实际模型发送前再次校验资格，不重复计数。 */
  beforeModelDispatch?(request?: PiModelRequestContext): Promise<void>;
  afterAssistant?(
    state: PiNativeState,
    message: AssistantMessage,
    request?: PiModelRequestContext,
  ): Promise<void>;
  beforeTool?(state: PiNativeState, toolName: string, call?: PiToolCallContext): Promise<void>;
  beforeToolDispatch?(call?: PiToolCallContext): Promise<void>;
  afterTool?(state: PiNativeState, call?: PiToolCallContext): Promise<void>;
  /** Awaited capture/projection hook; receives no raw arguments or tool receipt. */
  onToolLifecycle?(event: PiToolLifecycle): Promise<void>;
  /** 当前 Attempt 的信号和剩余时间；不能缓存为整个 Pi 会话的固定值。 */
  executionSignal?(): AbortSignal;
  executionRemainingMs?(): number;
}

interface PiMemoryCommonOptions {
  fetch?: typeof globalThis.fetch;
  tools?: readonly PiMemoryTool[];
  barriers?: PiMemoryBarriers;
  systemPrompt?: string;
  /** Explicitly assembled once by the trusted host. Cannot be combined with tools/systemPrompt. */
  resources?: TrustedPiResources;
  /** 仅宿主提供的逻辑工作目录；此适配不发现或读取其中的资源。 */
  cwd?: string;
}

export interface PiMemorySessionOptions extends PiMemoryCommonOptions {
  config: MaasConfig;
  context: MaasContext;
  resolveIdentity: (signal?: AbortSignal) => Promise<TrustedMaasIdentity>;
}

export interface PiDirectModelSessionOptions extends PiMemoryCommonOptions {
  config: DirectModelConfig;
}

type NativeModelConfig = Pick<
  MaasConfig,
  'baseUrl' | 'modelId' | 'contextWindow' | 'maxTokens' | 'compat' | 'timeouts'
>;
interface NativeConnection {
  apiKey: string;
  transport: Pick<ReturnType<typeof createMaasTransport>, 'fetch' | 'observation'>;
  samplingParams?: Record<string, unknown>;
}
interface NativeMemorySessionOptions extends PiMemoryCommonOptions {
  config: NativeModelConfig;
  provider: 'tyde-maas' | 'deepseek' | 'openai-compatible';
  bootstrapApiKey: string;
  connect(
    signal: AbortSignal,
    tools: Readonly<Record<string, MaasTool>>,
    request: PiModelRequestContext,
  ): Promise<NativeConnection>;
}
class PiConnectionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface PiPromptResult {
  status: 'completed' | 'stopped' | 'failed';
  text: string;
  error: { code: string } | null;
  observations: readonly MaasObservation[];
}

interface ActiveRun {
  controller: AbortController;
  stopped: boolean;
  failureCode?: string;
  observations: MaasObservation[];
  onText?: (text: string) => void;
  toolCalls: Map<string, PiToolLifecycle>;
  executedToolIds: Set<string>;
}

function resources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function failure(
  model: Model<'openai-completions'>,
  code: string,
  aborted: boolean,
  content: TextContent[] = [],
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: code,
    timestamp: Date.now(),
  };
}

/** 仅服务端、内存模式；调用方不能取得 Session/Agent 的扩展、压缩或任意工具入口。 */
async function createNativeMemorySession(options: NativeMemorySessionOptions) {
  const config = structuredClone(options.config);
  if (options.resources) assertTrustedPiResources(options.resources);
  if (options.resources && (options.tools || options.systemPrompt !== undefined))
    throw new Error('PI_RESOURCE_CONFIGURATION_CONFLICT');
  const tools = (options.resources?.tools ?? options.tools ?? []).map((tool) => ({
    ...tool,
    parameters: structuredClone(tool.parameters),
    ...(tool.publicMetadata ? { publicMetadata: Object.freeze({ ...tool.publicMetadata }) } : {}),
  }));
  const toolNames = tools.map((tool) => tool.name);
  if (
    tools.length > 64 ||
    new Set(toolNames).size !== toolNames.length ||
    toolNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) ||
    tools.some(
      (tool) =>
        (tool.parameters as unknown as Record<string, unknown>).type !== 'object' ||
        (tool.parameters as unknown as Record<string, unknown>).additionalProperties !== false ||
        (tool.timeoutMs !== undefined &&
          (!Number.isSafeInteger(tool.timeoutMs) ||
            tool.timeoutMs < 1 ||
            tool.timeoutMs > 300_000)) ||
        (tool.publicMetadata !== undefined &&
          (!tool.publicMetadata.displayLabel.trim() ||
            tool.publicMetadata.displayLabel.length > 128)),
    )
  ) {
    throw new Error('PI_INVALID_TOOL_ALLOWLIST');
  }
  const toolMap = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        parameters: tool.parameters as unknown as Record<string, unknown>,
        validate: (args: Record<string, unknown>) => {
          try {
            // Pi 的验证器允许类型转换；本协议要求原始完整对象本身合法。
            const validated: unknown = validateToolArguments(tool, {
              type: 'toolCall',
              id: 'validation-only',
              name: tool.name,
              arguments: structuredClone(args) as ToolCall['arguments'],
            });
            return isDeepStrictEqual(validated, args) && tool.validate(structuredClone(args));
          } catch {
            return false;
          }
        },
      },
    ]),
  );
  const manager = SessionManager.inMemory(options.cwd);
  if (options.resources)
    manager.appendCustomEntry(
      'tyde.execution.resources',
      structuredClone(options.resources.manifest),
    );
  const configurationBody = {
    schemaVersion: 1 as const,
    piSdkVersion: PI_SDK_VERSION,
    model: {
      provider: options.provider,
      id: config.modelId,
      baseUrl: config.baseUrl,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      compat: structuredClone(config.compat),
      timeouts: structuredClone(config.timeouts),
    },
    systemPromptSha256: resourceSha256(
      options.resources?.systemPrompt ??
        options.systemPrompt ??
        'You are a helpful assistant. Use only the explicitly provided tools.',
    ),
    resources: options.resources ? structuredClone(options.resources.manifest) : null,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
      timeoutMs: tool.timeoutMs ?? 30_000,
      publicMetadata: tool.publicMetadata ? { ...tool.publicMetadata } : null,
    })),
  };
  const configuration: PiExecutionConfiguration = {
    ...configurationBody,
    sha256: resourceSha256(canonicalize(configurationBody)!),
  };
  const captureNativeState = (): PiNativeState =>
    structuredClone({
      header: manager.getHeader(),
      entries: manager.getEntries(),
      leafId: manager.getLeafId(),
      configuration,
    });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
    defaultTools: [],
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model: Model<'openai-completions'> = {
    id: config.modelId,
    name: config.modelId,
    provider: options.provider,
    api: 'openai-completions',
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: config.compat,
  };
  // 固定版 registerProvider 会后台调用全量 refresh。收窄公开入口，避免探测其他
  // Provider 的环境凭据或本机 ADC 文件；静态内置目录不参与当前会话执行。
  const nativeRefresh = runtime.refresh.bind(runtime);
  runtime.refresh = (refreshOptions = {}) =>
    nativeRefresh({
      ...refreshOptions,
      allowNetwork: false,
      providers: [model.provider],
    });
  // 本地目录、用户凭据、models.json 和 Provider 环境变量均不参与执行配置。
  runtime.registerProvider(model.provider, {
    api: model.api,
    baseUrl: config.baseUrl,
    models: [model],
  });
  // 只满足原生 Session 的已配置鉴权检查；每次真实发送仍重新解析可信身份与凭据。
  await runtime.setRuntimeApiKey(model.provider, options.bootstrapApiKey);
  manager.appendModelChange(model.provider, model.id);
  manager.appendThinkingLevelChange('off');
  let active: ActiveRun | undefined;
  let disposed = false;
  let blocked = false;
  const permitted = (run: ActiveRun) =>
    active === run && !disposed && !run.controller.signal.aborted && !run.failureCode;
  const block = (run: ActiveRun, code: string) => {
    if (run.stopped) return;
    run.failureCode ??= code;
    blocked = true;
    run.controller.abort();
    agent.abort();
  };
  const waitForPreparation = <T>(run: ActiveRun, callback: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const signal = run.controller.signal;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('PI_EXECUTION_REVOKED'));
      };
      const timer = setTimeout(() => {
        block(run, 'PI_PREPARATION_TIMEOUT');
      }, config.timeouts.totalMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (!permitted(run)) {
        onAbort();
        return;
      }
      Promise.resolve()
        .then(callback)
        .then(
          (value) => {
            cleanup();
            if (permitted(run)) resolve(value);
            else reject(new Error('PI_EXECUTION_REVOKED'));
          },
          (cause: unknown) => {
            cleanup();
            reject(cause);
          },
        );
    });
  const barrier = async (run: ActiveRun, callback: (() => Promise<void>) | undefined) => {
    if (!permitted(run)) return false;
    try {
      await waitForPreparation(run, callback ?? (() => Promise.resolve()));
    } catch {
      if (!run.stopped && !run.failureCode) block(run, 'PI_NATIVE_BARRIER_FAILED');
    }
    return permitted(run);
  };
  const agent = new Agent({
    initialState: { model, thinkingLevel: 'off', tools: [], messages: [] },
    toolExecution: 'sequential',
    streamFn: (_requestedModel, transcript, streamOptions) => {
      const output = createAssistantMessageEventStream();
      const run = active;
      const request: PiModelRequestContext = { modelRequestId: randomUUID() };
      void (async () => {
        let observation: (() => MaasObservation | undefined) | undefined;
        const acceptedText = new Map<number, string>();
        try {
          if (
            !run ||
            !(await barrier(
              run,
              () =>
                options.barriers?.beforeModel?.(captureNativeState(), request) ?? Promise.resolve(),
            ))
          ) {
            throw new Error('PI_EXECUTION_REVOKED');
          }
          const signal = AbortSignal.any([
            run.controller.signal,
            ...(streamOptions?.signal ? [streamOptions.signal] : []),
            ...(options.barriers?.executionSignal ? [options.barriers.executionSignal()] : []),
          ]);
          let connection: NativeConnection;
          try {
            connection = await waitForPreparation(run, () =>
              options.connect(signal, toolMap, request),
            );
          } catch (cause) {
            if (!run.stopped && !run.failureCode)
              block(
                run,
                cause instanceof PiConnectionError ? cause.code : 'PI_CONNECTION_UNAVAILABLE',
              );
            throw cause;
          }
          if (!permitted(run)) throw new Error('PI_EXECUTION_REVOKED');
          if (
            !(await barrier(
              run,
              () => options.barriers?.beforeModelDispatch?.(request) ?? Promise.resolve(),
            ))
          ) {
            throw new Error('PI_EXECUTION_REVOKED');
          }
          observation = connection.transport.observation;
          const upstream = streamSimple(model, transcript, {
            signal,
            fetch: connection.transport.fetch,
            apiKey: connection.apiKey,
            maxTokens: config.maxTokens,
            maxRetries: 0,
            cacheRetention: 'none',
            samplingParams: connection.samplingParams,
          });
          for await (const event of upstream) {
            if (!permitted(run)) throw new Error('PI_EXECUTION_REVOKED');
            if (event.type === 'text_delta') {
              acceptedText.set(
                event.contentIndex,
                (acceptedText.get(event.contentIndex) ?? '') + event.delta,
              );
              try {
                run.onText?.(event.delta);
              } catch {
                block(run, 'PI_OUTPUT_CONSUMER_FAILED');
              }
              if (!permitted(run)) throw new Error('PI_EXECUTION_REVOKED');
            }
            if (event.type === 'done') {
              const observed = observation();
              if (observed?.state !== 'complete') {
                throw new Error(observed?.errorCode ?? 'MAAS_INCOMPLETE_STREAM');
              }
              run.observations.push(observed);
            }
            if (event.type === 'error') {
              throw new Error(observation()?.errorCode ?? 'PI_MODEL_FAILED');
            }
            output.push(event);
          }
          output.end();
        } catch {
          const observed = observation?.();
          if (run && observed && !run.observations.includes(observed))
            run.observations.push(observed);
          const code =
            run?.failureCode ??
            observed?.errorCode ??
            (run?.stopped ? 'PI_STOPPED' : 'PI_MODEL_FAILED');
          if (run && !run.stopped) run.failureCode ??= code;
          const message = failure(
            model,
            code,
            run?.stopped === true,
            [...acceptedText]
              .sort(([left], [right]) => left - right)
              .map(([, text]) => ({ type: 'text', text })),
          );
          output.push({
            type: 'error',
            reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
            error: message,
          });
          output.end(message);
        }
      })();
      return output;
    },
  });
  const toolContextForHook = (toolCallId: string, toolName: string): PiToolCallContext => {
    const entries = manager.getEntries();
    const source = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'assistant' &&
          entry.message.content.some((part) => part.type === 'toolCall' && part.id === toolCallId),
      );
    const observed = active?.observations.at(-1);
    if (!source || !observed || observed.state !== 'complete')
      throw new Error('PI_TOOL_NATIVE_LINK_MISSING');
    return {
      toolCallId,
      toolName,
      sourceNativeEntryId: source.id,
      modelRequestId: observed.modelRequestId,
    };
  };
  const safeSummary = (value: string): string => {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 500 ||
      [...value].some(
        (char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
      )
    )
      throw new Error('PI_TOOL_PROJECTION_INVALID');
    return value;
  };
  // Result/cancellation capture is also awaited after execution has been revoked.
  // Its finite save window never grants another model/tool dispatch.
  const settleBarrier = async (run: ActiveRun, callback: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(callback),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('PI_NATIVE_BARRIER_FAILED')),
            config.timeouts.totalMs,
          );
        }),
      ]);
    } catch {
      if (!run.stopped && !run.failureCode) block(run, 'PI_NATIVE_BARRIER_FAILED');
      blocked = true;
    } finally {
      clearTimeout(timer);
    }
  };
  const hostTools: Record<string, AgentTool> = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) => {
          const run = active;
          if (
            !run ||
            !permitted(run) ||
            signal?.aborted ||
            !args ||
            typeof args !== 'object' ||
            Array.isArray(args) ||
            !toolMap[tool.name]!.validate(args as Record<string, unknown>)
          ) {
            if (run && permitted(run)) block(run, 'PI_TOOL_ARGUMENTS_INVALID');
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          }
          const call = toolContextForHook(toolCallId, tool.name);
          if (run.executedToolIds.has(toolCallId)) {
            block(run, 'PI_TOOL_DUPLICATE_CALL');
            throw new Error('PI_TOOL_DUPLICATE_CALL');
          }
          if (
            !(await barrier(
              run,
              () => options.barriers?.beforeToolDispatch?.(call) ?? Promise.resolve(),
            ))
          ) {
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          }
          let inputSummary: string;
          try {
            inputSummary = safeSummary(
              tool.projectInput?.(structuredClone(args as Record<string, unknown>)) ??
                'Validated tool input',
            );
          } catch {
            block(run, 'PI_TOOL_PROJECTION_INVALID');
            throw new Error('PI_TOOL_PROJECTION_INVALID');
          }
          const lifecycle: PiToolLifecycle = {
            ...call,
            status: 'running',
            startedAt: new Date().toISOString(),
            endedAt: null,
            isDemo: tool.publicMetadata?.isDemo ?? false,
            displayLabel: tool.publicMetadata?.displayLabel ?? tool.name,
            inputSummary,
            resultSummary: null,
            errorCode: null,
            resultNativeEntryId: null,
          };
          run.toolCalls.set(toolCallId, lifecycle);
          if (
            !(await barrier(
              run,
              () =>
                options.barriers?.onToolLifecycle?.(structuredClone(lifecycle)) ??
                Promise.resolve(),
            ))
          )
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          // Projection/save waits do not extend the authorization into a later stop.
          if (
            !(await barrier(
              run,
              () => options.barriers?.beforeToolDispatch?.(call) ?? Promise.resolve(),
            ))
          )
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          run.executedToolIds.add(toolCallId);
          const timeout = new AbortController();
          const remaining = options.barriers?.executionRemainingMs?.() ?? Infinity;
          const executionSignal = options.barriers?.executionSignal?.();
          // The Attempt signal owns its deadline and latches the budget reason.
          // A second timer at exactly that deadline can fire first (or slightly
          // early) and incorrectly turn a budget cancellation into a tool timeout.
          const timeoutMs = Math.max(
            1,
            executionSignal
              ? (tool.timeoutMs ?? 30_000)
              : Math.min(tool.timeoutMs ?? 30_000, remaining),
          );
          const timer = setTimeout(() => timeout.abort(new Error('PI_TOOL_TIMEOUT')), timeoutMs);
          const toolSignal = AbortSignal.any([
            run.controller.signal,
            timeout.signal,
            ...(signal ? [signal] : []),
            ...(executionSignal ? [executionSignal] : []),
          ]);
          let removeAbort = () => {};
          try {
            const result = await Promise.race([
              Promise.resolve().then(() => {
                if (toolSignal.aborted || !permitted(run))
                  throw new Error('PI_TOOL_EXECUTION_REVOKED');
                return tool.execute(structuredClone(args as Record<string, unknown>), {
                  signal: toolSignal,
                  toolCallId,
                });
              }),
              new Promise<never>((_resolve, reject) => {
                const abort = () => reject(new Error('PI_TOOL_EXECUTION_REVOKED'));
                removeAbort = () => toolSignal.removeEventListener('abort', abort);
                if (toolSignal.aborted) abort();
                else toolSignal.addEventListener('abort', abort, { once: true });
              }),
            ]);
            if (!permitted(run) || toolSignal.aborted) throw new Error('PI_TOOL_EXECUTION_REVOKED');
            const text = typeof result === 'string' ? result : result.content;
            if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256 * 1024)
              throw new Error('PI_TOOL_RESULT_INVALID');
            lifecycle.status = 'succeeded';
            lifecycle.resultSummary = safeSummary(
              typeof result === 'string' ? 'Tool completed' : result.summary,
            );
            lifecycle.endedAt = new Date().toISOString();
            return { content: [{ type: 'text' as const, text }], details: {} };
          } catch {
            const budgetExceeded =
              toolSignal.reason &&
              typeof toolSignal.reason === 'object' &&
              'code' in toolSignal.reason &&
              /^ATTEMPT_(?:DURATION|MODEL_REQUEST|TOOL_CALL)_LIMIT_EXCEEDED$/.test(
                String(toolSignal.reason.code),
              );
            lifecycle.status = run.stopped && !budgetExceeded ? 'cancelled' : 'failed';
            lifecycle.errorCode = budgetExceeded
              ? 'budget_exceeded'
              : run.stopped
                ? 'cancelled'
                : timeout.signal.aborted
                  ? 'timeout'
                  : 'tool_failed';
            lifecycle.endedAt = new Date().toISOString();
            if (!run.stopped)
              block(run, timeout.signal.aborted ? 'PI_TOOL_TIMEOUT' : 'PI_TOOL_FAILED');
            throw new Error('PI_TOOL_FAILED');
          } finally {
            clearTimeout(timer);
            removeAbort();
          }
        },
      },
    ]),
  );
  const session = new AgentSession({
    agent,
    sessionManager: manager,
    settingsManager: settings,
    modelRuntime: runtime,
    cwd: manager.getCwd(),
    resourceLoader: resources(
      options.resources?.systemPrompt ??
        options.systemPrompt ??
        'You are a helpful assistant. Use only the explicitly provided tools.',
    ),
    baseToolsOverride: hostTools,
    initialActiveToolNames: toolNames,
    allowedToolNames: toolNames,
  });
  // Session 安装自身 hooks 后再包裹，不通过不等待 Promise 的公开 Session 订阅充当屏障。
  const nativeBeforeTool = agent.beforeToolCall;
  agent.beforeToolCall = async (toolContext, signal) => {
    const run = active;
    let call: PiToolCallContext;
    try {
      call = toolContextForHook(toolContext.toolCall.id, toolContext.toolCall.name);
    } catch {
      if (run) block(run, 'PI_TOOL_NATIVE_LINK_MISSING');
      return { block: true, terminate: true, reason: 'PI_TOOL_NATIVE_LINK_MISSING' };
    }
    if (
      !run ||
      !(await barrier(
        run,
        () =>
          options.barriers?.beforeTool?.(captureNativeState(), toolContext.toolCall.name, call) ??
          Promise.resolve(),
      ))
    ) {
      return { block: true, terminate: true, reason: 'PI_TOOL_EXECUTION_REVOKED' };
    }
    return nativeBeforeTool?.(toolContext, signal);
  };
  agent.subscribe(async (event) => {
    const run = active;
    if (!run) return;
    if (event.type !== 'message_end') return;
    if (
      event.message.role === 'assistant' &&
      ['stop', 'toolUse'].includes(event.message.stopReason) &&
      permitted(run)
    ) {
      const sourceNativeEntryId = manager.getLeafId();
      const observed = run.observations.at(-1);
      if (observed?.state === 'complete')
        manager.appendCustomEntry(
          options.provider === 'tyde-maas'
            ? 'tyde.maas.usage-observation'
            : 'tyde.model.usage-observation',
          {
            ...observed,
            sourceNativeEntryId,
          },
        );
      await barrier(
        run,
        () =>
          options.barriers?.afterAssistant?.(
            captureNativeState(),
            structuredClone(event.message) as AssistantMessage,
            observed ? { modelRequestId: observed.modelRequestId } : undefined,
          ) ?? Promise.resolve(),
      );
    }
    if (event.message.role === 'toolResult') {
      const toolCallId = event.message.toolCallId;
      const lifecycle = run.toolCalls.get(toolCallId);
      if (lifecycle?.status === 'running') {
        lifecycle.status = run.stopped ? 'cancelled' : 'failed';
        lifecycle.endedAt = new Date().toISOString();
        lifecycle.errorCode = run.stopped ? 'cancelled' : 'tool_failed';
      }
      const nativeResult = [...manager.getEntries()]
        .reverse()
        .find(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolCallId === toolCallId,
        );
      if (lifecycle && nativeResult) lifecycle.resultNativeEntryId = nativeResult.id;
      await settleBarrier(run, async () => {
        await options.barriers?.afterTool?.(captureNativeState(), lifecycle);
        if (lifecycle) await options.barriers?.onToolLifecycle?.(structuredClone(lifecycle));
      });
    }
  });

  return {
    async prompt(text: string, onText?: (text: string) => void): Promise<PiPromptResult> {
      if (disposed || blocked)
        throw new Error(disposed ? 'PI_SESSION_DISPOSED' : 'PI_SESSION_BLOCKED');
      if (active) throw new Error('PI_SESSION_BUSY');
      if (!text.trim()) throw new Error('PI_EMPTY_PROMPT');
      const run: ActiveRun = {
        controller: new AbortController(),
        stopped: false,
        observations: [],
        toolCalls: new Map(),
        executedToolIds: new Set(),
        onText,
      };
      active = run;
      try {
        await session.prompt(text, { expandPromptTemplates: false });
        const last = [...session.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        const completed =
          !run.stopped &&
          !run.failureCode &&
          last?.role === 'assistant' &&
          last.stopReason === 'stop';
        return {
          status: run.failureCode
            ? 'failed'
            : run.stopped
              ? 'stopped'
              : completed
                ? 'completed'
                : 'failed',
          text: completed
            ? last.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('')
            : '',
          error: completed || run.stopped ? null : { code: run.failureCode ?? 'PI_MODEL_FAILED' },
          observations: structuredClone(run.observations),
        };
      } catch {
        return {
          status: run.failureCode ? 'failed' : run.stopped ? 'stopped' : 'failed',
          text: '',
          error: run.failureCode
            ? { code: run.failureCode }
            : run.stopped
              ? null
              : { code: 'PI_EXECUTION_FAILED' },
          observations: structuredClone(run.observations),
        };
      } finally {
        if (active === run) active = undefined;
      }
    },
    async stop(): Promise<void> {
      const run = active;
      if (!run) return;
      // 第一项可信终止原因决定结果，后来的停止不能抹掉已经确认的失败。
      if (!run.failureCode) run.stopped = true;
      run.controller.abort();
      await session.abort();
    },
    captureNativeState,
    dispose(): void {
      disposed = true;
      active?.controller.abort();
      session.dispose();
    },
  };
}

/** 平台路径始终要求服务鉴权和可信主体；不能因存在供应商 Key 回退为直连。 */
export function createPiMemorySession(options: PiMemorySessionOptions) {
  const config = structuredClone(options.config);
  const context = Object.freeze({ ...options.context });
  const resolveIdentity = options.resolveIdentity;
  return createNativeMemorySession({
    ...options,
    config,
    provider: 'tyde-maas',
    bootstrapApiKey: config.serviceToken,
    connect: async (signal, tools, request) => {
      let identity: TrustedMaasIdentity;
      try {
        identity = await resolveIdentity(signal);
      } catch {
        throw new PiConnectionError('PI_MAAS_IDENTITY_UNAVAILABLE');
      }
      if (
        !identity ||
        typeof identity !== 'object' ||
        (identity.source !== undefined && identity.source !== 'platform') ||
        identity.platformSubjectRef !== context.platformSubjectRef ||
        (identity.serviceToken !== undefined &&
          !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(identity.serviceToken))
      ) {
        throw new PiConnectionError('PI_UNTRUSTED_MAAS_IDENTITY');
      }
      const apiKey = identity.serviceToken ?? config.serviceToken;
      return {
        apiKey,
        samplingParams: { parallel_tool_calls: false },
        transport: createMaasTransport(
          { ...boundedConfig(config, options.barriers), serviceToken: apiKey },
          context,
          {
            fetch: options.fetch,
            signal,
            tools,
            modelRequestId: request.modelRequestId,
          },
        ),
      };
    },
  });
}

/** 通过显式服务端配置连接模型，不构造或替代平台身份与路由。 */
export function createPiDirectModelSession(options: PiDirectModelSessionOptions) {
  const config = structuredClone(options.config);
  return createNativeMemorySession({
    ...options,
    config,
    provider: config.provider,
    bootstrapApiKey: config.apiKey,
    connect: async (signal, tools, request) => ({
      apiKey: config.apiKey,
      transport: createDirectModelTransport(boundedConfig(config, options.barriers), {
        fetch: options.fetch,
        signal,
        tools,
        modelRequestId: request.modelRequestId,
      }),
      samplingParams:
        config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : undefined,
    }),
  });
}

export type PiMemorySession = Awaited<ReturnType<typeof createNativeMemorySession>>;

function boundedConfig<T extends NativeModelConfig>(config: T, barriers?: PiMemoryBarriers): T {
  const remaining = barriers?.executionRemainingMs?.();
  if (remaining === undefined) return config;
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('PI_EXECUTION_REVOKED');
  const cap = Math.max(1, Math.floor(remaining));
  return {
    ...config,
    timeouts: Object.fromEntries(
      Object.entries(config.timeouts).map(([key, value]) => [key, Math.min(value, cap)]),
    ) as NativeModelConfig['timeouts'],
  };
}
