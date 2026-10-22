import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { isDeepStrictEqual } from 'node:util';
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

export const PI_SDK_VERSION = '1.3.0';
export const PI_SOURCE_COMMIT = '71023aec1546d6d677a65669c5665c0927ce0dd0';

/** 原生内存树的只读副本；不是持久提交回执或另一种恢复格式。 */
export interface PiNativeState {
  header: SessionHeader | null;
  entries: SessionEntry[];
  leafId: string | null;
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
  execute(
    args: Record<string, unknown>,
    context: { signal: AbortSignal; toolCallId: string },
  ): Promise<string>;
}

/** 后续保存屏障的等待点。拒绝后锁住会话，禁止工具或下一轮模型。 */
export interface PiMemoryBarriers {
  beforeModel?(state: PiNativeState): Promise<void>;
  /** 授权后、实际模型发送前再次校验资格，不重复计数。 */
  beforeModelDispatch?(): Promise<void>;
  afterAssistant?(state: PiNativeState, message: AssistantMessage): Promise<void>;
  beforeTool?(state: PiNativeState, toolName: string): Promise<void>;
  beforeToolDispatch?(): Promise<void>;
  afterTool?(state: PiNativeState): Promise<void>;
  /** 当前 Attempt 的信号和剩余时间；不能缓存为整个 Pi 会话的固定值。 */
  executionSignal?(): AbortSignal;
  executionRemainingMs?(): number;
}

interface PiMemoryCommonOptions {
  fetch?: typeof globalThis.fetch;
  tools?: readonly PiMemoryTool[];
  barriers?: PiMemoryBarriers;
  systemPrompt?: string;
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
  const tools = (options.tools ?? []).map((tool) => ({
    ...tool,
    parameters: structuredClone(tool.parameters),
  }));
  const toolNames = tools.map((tool) => tool.name);
  if (
    tools.length > 64 ||
    new Set(toolNames).size !== toolNames.length ||
    toolNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))
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
            return isDeepStrictEqual(validated, args) && tool.validate(args);
          } catch {
            return false;
          }
        },
      },
    ]),
  );
  const manager = SessionManager.inMemory(options.cwd);
  const captureNativeState = (): PiNativeState =>
    structuredClone({
      header: manager.getHeader(),
      entries: manager.getEntries(),
      leafId: manager.getLeafId(),
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
      void (async () => {
        let observation: (() => MaasObservation | undefined) | undefined;
        const acceptedText = new Map<number, string>();
        try {
          if (
            !run ||
            !(await barrier(
              run,
              () => options.barriers?.beforeModel?.(captureNativeState()) ?? Promise.resolve(),
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
            connection = await waitForPreparation(run, () => options.connect(signal, toolMap));
          } catch (cause) {
            if (!run.stopped && !run.failureCode)
              block(
                run,
                cause instanceof PiConnectionError ? cause.code : 'PI_CONNECTION_UNAVAILABLE',
              );
            throw cause;
          }
          if (!permitted(run)) throw new Error('PI_EXECUTION_REVOKED');
          if (!(await barrier(run, options.barriers?.beforeModelDispatch))) {
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
            !tool.validate(args as Record<string, unknown>)
          ) {
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          }
          if (!(await barrier(run, options.barriers?.beforeToolDispatch))) {
            throw new Error('PI_TOOL_EXECUTION_REVOKED');
          }
          let text: string;
          try {
            text = await tool.execute(args as Record<string, unknown>, {
              signal: AbortSignal.any([
                run.controller.signal,
                ...(signal ? [signal] : []),
                ...(options.barriers?.executionSignal ? [options.barriers.executionSignal()] : []),
              ]),
              toolCallId,
            });
          } catch {
            if (!run.stopped) block(run, 'PI_TOOL_FAILED');
            throw new Error('PI_TOOL_FAILED');
          }
          if (!permitted(run)) throw new Error('PI_TOOL_EXECUTION_REVOKED');
          return { content: [{ type: 'text' as const, text }], details: {} };
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
    if (
      !run ||
      !(await barrier(
        run,
        () =>
          options.barriers?.beforeTool?.(captureNativeState(), toolContext.toolCall.name) ??
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
          ) ?? Promise.resolve(),
      );
    }
    if (event.message.role === 'toolResult') {
      await barrier(
        run,
        () => options.barriers?.afterTool?.(captureNativeState()) ?? Promise.resolve(),
      );
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
    connect: async (signal, tools) => {
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
    connect: async (signal, tools) => ({
      apiKey: config.apiKey,
      transport: createDirectModelTransport(boundedConfig(config, options.barriers), {
        fetch: options.fetch,
        signal,
        tools,
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
