import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGENT_API_PREFIX,
  validateAgentContract,
  type AgentContractName,
  type ReadError,
  type UnconfirmedError,
} from '@tyde/shared/agent';
import { AgentAccessError, type AgentPrincipal } from '../auth/access.js';
import { AgentMemoryRuntime, AgentRuntimeError } from '../runtime/memory-runtime.js';
import { contractRouteSchema, registerContractDocumentation } from './documentation.js';
import { createSseWriter, encodeFrame, type AgentFrame } from './sse-writer.js';
import { parseStrictJson } from './strict-json.js';

type Query = Record<string, string>;
type Params = { conversation_id: string; task_id: string; result_id: string; request_key: string };
const prefix = `${AGENT_API_PREFIX}/conversations`;

function invalid(message = '请求参数不符合 v1 契约'): never {
  throw new AgentRuntimeError(422, 'INVALID_REQUEST', message, 'fix_request');
}
function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100) invalid('条数必须是 1 至 100 的整数');
  return Number(value);
}
function requiredScalar<K extends 'UUID' | 'NonNegativeBigInt' | 'PositiveBigInt'>(
  name: K,
  value: unknown,
): string {
  if (!validateAgentContract(name, value)) invalid(`${name} 参数格式无效`);
  return value;
}
function queryParameters(request: FastifyRequest, allowed: string[]): Query {
  const url = new URL(request.raw.url!, 'http://agent.invalid');
  const result: Query = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) invalid('查询包含未知或重复字段');
    result[key] = value;
  }
  return result;
}

export async function registerAgentRoutes(app: FastifyInstance, runtime: AgentMemoryRuntime) {
  registerContractDocumentation(app);
  const streams = new Set<ReturnType<typeof createSseWriter>>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.close();
    await runtime.close();
  });

  await app.register(async (api) => {
    const identities = new WeakMap<FastifyRequest, AgentPrincipal>();
    api.removeContentTypeParser('application/json');
    api.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 128 * 1024 },
      (_request, body, done) => {
        try {
          done(null, parseStrictJson(body as Buffer));
        } catch {
          done(
            new AgentRuntimeError(
              400,
              'INVALID_JSON',
              '请求必须是合法 UTF-8 JSON，不含重复键或非法 Unicode',
              'fix_request',
            ),
          );
        }
      },
    );
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    api.setErrorHandler((cause, request, reply) => {
      const command = request.method === 'POST' && request.routeOptions.url?.endsWith('/commands');
      let statusCode = 500;
      let code = 'INTERNAL_ERROR';
      let message = 'Agent 请求失败，请保留请求关联号排查';
      let action = 'contact_support';
      let details = {};
      const fastifyCode =
        cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      if (cause instanceof AgentRuntimeError || cause instanceof AgentAccessError) {
        statusCode = cause.statusCode;
        code = cause.code;
        message = cause.message;
        action =
          cause instanceof AgentRuntimeError
            ? cause.action
            : statusCode === 401
              ? 'reauthenticate'
              : statusCode === 503
                ? 'resend_same_request'
                : 'none';
        details = cause instanceof AgentRuntimeError ? cause.details : {};
      } else if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        statusCode = 413;
        code = 'REQUEST_TOO_LARGE';
        message = '请求不能超过 128 KiB';
        action = 'fix_request';
      } else if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        statusCode = 415;
        code = 'UNSUPPORTED_MEDIA_TYPE';
        message = '请求必须使用 application/json';
        action = 'fix_request';
      } else if (fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
        statusCode = 400;
        code = 'INVALID_JSON';
        message = 'JSON 请求体不能为空';
        action = 'fix_request';
      }
      const requestId = randomUUID();
      const body = command
        ? {
            schema_version: 1,
            request_id: requestId,
            replayed: false,
            command: null,
            decision: null,
            error: { code, message, action, details } as UnconfirmedError,
          }
        : {
            schema_version: 1,
            request_id: requestId,
            data: null,
            error: { code, message, action, details } as ReadError,
          };
      // 不记录请求正文、授权或上游错误文本。
      if (statusCode === 500) api.log.error({ request_id: requestId }, 'Agent API 内部失败');
      reply.code(statusCode).send(body);
    });
    const route = (
      path: string,
      method: 'get' | 'post',
      handler: (request: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<unknown>,
    ) => {
      api.route({
        url: path.replaceAll(/\{([^}]+)\}/g, ':$1'),
        method: method.toUpperCase() as 'GET' | 'POST',
        bodyLimit: 128 * 1024,
        schema: contractRouteSchema(path, method),
        // 共享语义校验器是权威入口；文档 Schema 不进行强制转换、默认填值或移除字段。
        validatorCompiler: () => () => true,
        serializerCompiler: () => (value) => JSON.stringify(value),
        handler: async (request, reply) => {
          identities.set(request, await api.agentAccess.authenticate(request));
          if (
            method === 'post' &&
            !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
          ) {
            throw new AgentRuntimeError(
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              '请求必须使用 application/json',
              'fix_request',
            );
          }
          return handler(request, reply);
        },
      });
    };
    const principal = (request: FastifyRequest) => identities.get(request)!;
    const id = (request: FastifyRequest) =>
      requiredScalar('UUID', (request.params as Params).conversation_id).toLowerCase();
    const result = (name: AgentContractName, data: unknown) => {
      const body = { schema_version: 1, request_id: randomUUID(), data, error: null };
      if (!validateAgentContract(name, body)) throw new Error('AGENT_INVALID_RESPONSE');
      return body;
    };
    route(prefix, 'post', async (req, reply) => {
      queryParameters(req, []);
      const data = runtime.createConversation(await principal(req), req.body);
      return reply.code(201).send(result('CreateConversationResponse', data));
    });
    route(prefix, 'get', async (req) => {
      const query = queryParameters(req, ['limit', 'cursor']);
      return result(
        'ConversationListResponse',
        runtime.listConversations(await principal(req), {
          limit: integer(query.limit, 20),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        }),
      );
    });
    route(`${prefix}/{conversation_id}`, 'get', async (req) => {
      queryParameters(req, []);
      return result(
        'ConversationDetailResponse',
        runtime.getConversation(await principal(req), id(req)),
      );
    });
    route(`${prefix}/{conversation_id}/snapshot`, 'get', async (req) => {
      const query = queryParameters(req, ['message_limit']);
      return result(
        'SnapshotResponse',
        runtime.getSnapshot(await principal(req), id(req), integer(query.message_limit, 50)),
      );
    });
    route(`${prefix}/{conversation_id}/messages`, 'get', async (req) => {
      const query = queryParameters(req, [
        'stream_id',
        'upper_message_seq',
        'before_message_seq',
        'limit',
      ]);
      return result(
        'MessageHistoryResponse',
        runtime.listMessages(await principal(req), id(req), {
          streamId: requiredScalar('UUID', query.stream_id).toLowerCase(),
          upperMessageSeq: requiredScalar('NonNegativeBigInt', query.upper_message_seq),
          ...(query.before_message_seq === undefined
            ? {}
            : { beforeMessageSeq: requiredScalar('PositiveBigInt', query.before_message_seq) }),
          limit: integer(query.limit, 50),
        }),
      );
    });
    route(`${prefix}/{conversation_id}/tasks/{task_id}`, 'get', async (req) => {
      queryParameters(req, []);
      return result(
        'TaskDetailResponse',
        runtime.getTask(
          await principal(req),
          id(req),
          requiredScalar('UUID', (req.params as Params).task_id).toLowerCase(),
        ),
      );
    });
    route(`${prefix}/{conversation_id}/results/{result_id}`, 'get', async (req) => {
      queryParameters(req, []);
      return result(
        'ResultDetailResponse',
        runtime.getResult(
          await principal(req),
          id(req),
          requiredScalar('UUID', (req.params as Params).result_id).toLowerCase(),
        ),
      );
    });
    route(`${prefix}/{conversation_id}/commands/by-key/{request_key}`, 'get', async (req) => {
      queryParameters(req, []);
      return result(
        'CommandLookupResponse',
        runtime.getCommand(
          await principal(req),
          id(req),
          requiredScalar('UUID', (req.params as Params).request_key).toLowerCase(),
        ),
      );
    });
    route(`${prefix}/{conversation_id}/commands`, 'post', async (req, reply) => {
      queryParameters(req, []);
      const submission = runtime.submitCommand(
        await principal(req),
        id(req),
        req.body,
        randomUUID(),
      );
      if (!validateAgentContract('ResponseEnvelope', submission.body))
        throw new Error('AGENT_INVALID_COMMAND_RESPONSE');
      return reply.code(submission.statusCode).send(submission.body);
    });
    route(`${prefix}/{conversation_id}/events`, 'get', async (req, reply) => {
      const query = queryParameters(req, ['stream_id', 'after_seq']);
      if (req.headers['last-event-id'] !== undefined)
        invalid('本版不接受 Last-Event-ID，请使用明确的 stream_id 和 after_seq');
      const identity = await principal(req);
      const conversationId = id(req);
      const streamId = requiredScalar('UUID', query.stream_id).toLowerCase();
      const afterEventSeq = requiredScalar('NonNegativeBigInt', query.after_seq);
      let ended = false;
      let pumping = false;
      let recheck = false;
      let queuedBytes = 0;
      const queue: AgentFrame[] = [];
      const pump = async () => {
        if (pumping || ended) return;
        pumping = true;
        try {
          while (!ended && (queue.length || recheck)) {
            recheck = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const authenticated = await Promise.race([
                api.agentAccess.authenticate(req),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error('AUTH_CHECK_TIMEOUT')), 5000);
                }),
              ]);
              if (ended) return;
              if (
                authenticated.userId !== identity.userId ||
                authenticated.source !== identity.source
              )
                throw new Error('IDENTITY_CHANGED');
              runtime.getConversation(authenticated, conversationId);
            } catch {
              if (!ended) {
                writer.send({ schema_version: 1, frame_kind: 'control', code: 'reauthenticate' });
                writer.close();
              }
              return;
            } finally {
              if (timer) clearTimeout(timer);
            }
            // 权限复核与本批串行发送之间没有异步窗口。
            for (let index = 0; index < 32 && queue.length && !ended; index += 1) {
              const frame = queue.shift()!;
              queuedBytes -= Buffer.byteLength(encodeFrame(frame));
              writer.send(frame);
            }
          }
        } finally {
          pumping = false;
        }
      };
      const enqueue = (frame: AgentFrame) => {
        if (ended) return;
        const bytes = Buffer.byteLength(encodeFrame(frame));
        if (queue.length >= 512 || queuedBytes + bytes > 1024 * 1024) {
          writer.send({
            schema_version: 1,
            frame_kind: 'control',
            code: 'slow_consumer',
            retry_after_ms: 1000,
          });
          writer.close();
          return;
        }
        queue.push(frame);
        queuedBytes += bytes;
        queueMicrotask(() => {
          void pump();
        });
      };
      const subscription = runtime.subscribe(identity, conversationId, {
        streamId,
        afterEventSeq,
        onFrame: enqueue,
      });
      // subscribe 与 ready/replay 同步入队；异步鉴权不能让实时事件越过补读。
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const writer = createSseWriter(reply.raw, () => {
        ended = true;
        clearInterval(authorizationTimer);
        queue.length = 0;
        queuedBytes = 0;
        subscription.close();
        streams.delete(writer);
      });
      const authorizationTimer = setInterval(() => {
        recheck = true;
        void pump();
      }, 10_000);
      authorizationTimer.unref();
      streams.add(writer);
      enqueue(subscription.ready);
      for (const frame of subscription.replay) enqueue(frame);
    });
  });
}
