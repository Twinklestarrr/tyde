import { Value } from '@sinclair/typebox/value';
import { AGENT_HEALTH_PATH, agentHealthSchema, type AgentHealth } from '@tyde/shared/agent';
import {
  validateAgentContract,
  type AgentContractName,
  type AgentContractTypes,
  type CommandRequest,
  type ReadCursor,
} from '@tyde/shared/agent';
import { AgentEventError, SseParseError, SseParser, type RawSseEvent } from '../agent-events';

export type AgentStorageMode = 'postgres' | 'memory';

type Fetch = typeof globalThis.fetch;

const API = '/agent-api/api/agent/v1/conversations';

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly action: string = 'none',
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

/** The bearer belongs to the controlled Agent identity adapter, never to the model. */
export class AgentClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private headers(accept = 'application/json'): Record<string, string> {
    return { Accept: accept, Authorization: `Bearer ${this.token}` };
  }

  private async json<N extends AgentContractName>(
    path: string,
    contract: N,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<AgentContractTypes[N]> {
    const response = await this.fetcher(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...this.headers(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      credentials: 'omit',
      cache: 'no-store',
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await this.readJson(response);
    // Commands deliberately return confirmed rejections and unconfirmed outcomes.
    if (contract === 'ResponseEnvelope' && validateAgentContract(contract, data)) return data;
    if (!response.ok) throw this.responseError(response.status, data);
    if (!validateAgentContract(contract, data)) {
      throw new AgentApiError(
        'Agent 响应不符合共享契约，请检查客户端与服务版本。',
        response.status,
        'INVALID_RESPONSE',
      );
    }
    return data;
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new AgentApiError(
        `Agent 服务返回了非 JSON 响应（HTTP ${response.status}）。`,
        response.status,
        'INVALID_RESPONSE',
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AgentApiError('Agent 服务返回了无效 JSON。', response.status, 'INVALID_RESPONSE');
    }
  }

  private responseError(status: number, data: unknown): AgentApiError {
    if (validateAgentContract('ReadErrorResponse', data)) {
      return new AgentApiError(
        data.error.message,
        status,
        data.error.code,
        data.error.action,
        data.request_id,
      );
    }
    return new AgentApiError(`Agent 服务返回 HTTP ${status}`, status, 'HTTP_ERROR');
  }

  /** Authenticated read-only runtime metadata. An unavailable mode stays unknown. */
  async storageMode(signal?: AbortSignal): Promise<AgentStorageMode> {
    const response = await this.fetcher('/agent-api/api/agent/v1/runtime', {
      method: 'GET',
      headers: this.headers(),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    const data = await this.readJson(response);
    if (!response.ok) throw this.responseError(response.status, data);
    if (
      typeof data !== 'object' ||
      data === null ||
      !('storage_mode' in data) ||
      (data.storage_mode !== 'postgres' && data.storage_mode !== 'memory')
    ) {
      throw new AgentApiError(
        'Agent 存储模式尚未确认，请检查客户端与服务版本。',
        response.status,
        'INVALID_RUNTIME_METADATA',
      );
    }
    return data.storage_mode;
  }

  list(signal?: AbortSignal, cursor?: string) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.json(`${API}?${query}`, 'ConversationListResponse', signal);
  }

  /** Non-idempotent: exactly one POST, even when its response is lost. */
  create(signal?: AbortSignal) {
    return this.json(API, 'CreateConversationResponse', signal, { schema_version: 1 });
  }

  snapshot(conversationId: string, signal?: AbortSignal) {
    return this.json(
      `${API}/${conversationId}/snapshot?message_limit=100`,
      'SnapshotResponse',
      signal,
    );
  }

  history(
    conversationId: string,
    cursor: ReadCursor,
    upper: string,
    before: string,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      stream_id: cursor.stream_id,
      upper_message_seq: upper,
      before_message_seq: before,
      limit: '100',
    });
    return this.json(
      `${API}/${conversationId}/messages?${query}`,
      'MessageHistoryResponse',
      signal,
    );
  }

  command(conversationId: string, command: CommandRequest, signal?: AbortSignal) {
    if (!validateAgentContract('CommandRequest', command))
      throw new Error('消息不符合命令契约（正文需为 1—16000 个字符）。');
    return this.json(`${API}/${conversationId}/commands`, 'ResponseEnvelope', signal, command);
  }

  lookup(conversationId: string, key: string, signal?: AbortSignal) {
    return this.json(
      `${API}/${conversationId}/commands/by-key/${key}`,
      'CommandLookupResponse',
      signal,
    );
  }

  /** Await each frame before reading again: bounded parser plus network backpressure. */
  async events(
    conversationId: string,
    cursor: ReadCursor,
    onFrame: (frame: RawSseEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const query = new URLSearchParams({ stream_id: cursor.stream_id, after_seq: cursor.event_seq });
    const response = await this.fetcher(`${API}/${conversationId}/events?${query}`, {
      headers: this.headers('text/event-stream'),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw this.responseError(response.status, await this.readJson(response));
    if (
      !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ||
      !response.body
    ) {
      throw new AgentApiError('Agent 事件响应不是 SSE 流。', response.status, 'INVALID_RESPONSE');
    }
    const parser = new SseParser();
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > 2 * 1024 * 1024)
          throw new AgentEventError(
            'BASELINE_REQUIRED',
            '事件网络块超过本机处理容量，需要重新读取快照。',
          );
        for (const frame of parser.feed(chunk.value)) {
          signal.throwIfAborted();
          await onFrame(frame);
        }
      }
      for (const frame of parser.finish()) await onFrame(frame);
    } catch (error) {
      if (error instanceof SseParseError)
        throw new AgentEventError('BASELINE_REQUIRED', error.message);
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

/** 只查询服务存活状态，不启动任务，也不将健康状态当成模型可用性。 */
export async function getAgentHealth(
  options: { signal?: AbortSignal; fetch?: Fetch } = {},
): Promise<AgentHealth> {
  const response = await (options.fetch ?? globalThis.fetch)(`/agent-api${AGENT_HEALTH_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Agent 服务返回 HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('Agent 服务响应不是 JSON');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Agent 服务返回了无效 JSON');
  }
  if (!Value.Check(agentHealthSchema, data)) throw new Error('Agent 服务响应不符合健康契约');
  return data;
}
