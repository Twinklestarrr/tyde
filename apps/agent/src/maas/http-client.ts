import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { Agent, buildConnector, errors, request } from 'undici';

/** Only trusted host code/test infrastructure may inject DNS lookup; model input cannot. */
export interface MaasSocketOptions {
  lookup?: LookupFunction;
}

/** A real socket deadline, independent of the response-header and model-progress budgets. */
export function createMaasHttpClient(
  connectMs: number,
  signal: AbortSignal,
  options: MaasSocketOptions = {},
) {
  const pendingConnections = new Set<(reason: Error) => void>();
  const connect: buildConnector.connector = (connection, callback) => {
    const connectionAbort = new AbortController();
    let settled = false;
    const finish: buildConnector.Callback = (error, socket) => {
      if (settled) {
        socket?.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingConnections.delete(cancel);
      if (error) callback(error, null);
      else callback(null, socket);
    };
    const cancel = (reason: Error) => {
      finish(reason, null);
      connectionAbort.abort(reason);
    };
    const onAbort = () =>
      cancel(
        signal.reason instanceof Error ? signal.reason : new Error('MaaS connection cancelled'),
      );
    // Undici's built-in connect timer uses coarse fast timers. Keep the phase deadline exact here.
    const timer = setTimeout(() => cancel(new errors.ConnectTimeoutError()), connectMs);
    pendingConnections.add(cancel);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      buildConnector({
        timeout: 0,
        signal: connectionAbort.signal,
        ...(options.lookup ? { lookup: options.lookup } : {}),
      })(connection, finish);
    } catch (cause) {
      cancel(cause instanceof Error ? cause : new Error('MaaS connection failed'));
    }
  };
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 0,
    allowH2: false,
    connect,
    // Guarded transport owns these timers, including their distinct error classification.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    for (const cancel of pendingConnections) cancel(new errors.ClientDestroyedError());
    disposal ??= dispatcher.destroy();
    return disposal;
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    requestHeaders.set('accept-encoding', 'identity');
    // request deliberately avoids WHATWG fetch's implicit HTTP 421 resend.
    const response = await request(input instanceof Request ? input.url : String(input), {
      dispatcher,
      method: 'POST',
      headers: Object.fromEntries(requestHeaders),
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
      idempotent: false,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
    }
    const bodyless = [204, 205, 304].includes(response.statusCode);
    if (bodyless) response.body.destroy();
    return new Response(bodyless ? null : Readable.toWeb(response.body), {
      status: response.statusCode,
      headers,
    });
  };
  return { fetch, dispose };
}

/** Accept only the pinned transport's real error class, never a remote/code-only claim. */
export function isMaasConnectTimeout(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const candidate = pending.pop();
    if (!(candidate instanceof Error) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof errors.ConnectTimeoutError) return true;
    pending.push(candidate.cause);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
  }
  return false;
}
