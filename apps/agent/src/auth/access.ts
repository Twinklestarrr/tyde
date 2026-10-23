import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { assertAuthConfiguration, isValidUserId, type AgentConfig } from '../config.js';

export interface AgentPrincipal {
  readonly userId: string;
  readonly source: 'development' | 'platform';
}

/** 仅服务端装配；平台令牌验证、续期与撤销检查由后续平台对接实现。 */
export interface PlatformIdentityAdapter {
  authenticateBearer(token: string): Promise<{ userId: string } | null>;
}

export class AgentAccessError extends Error {
  constructor(
    public readonly statusCode: 401 | 404 | 503,
    public readonly code: 'UNAUTHENTICATED' | 'RESOURCE_NOT_FOUND' | 'SERVICE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentAccessError';
  }
}

export interface AgentAccess {
  authenticate(request: FastifyRequest): Promise<AgentPrincipal>;
}

const unauthenticated = () => new AgentAccessError(401, 'UNAUTHENTICATED', '请重新验证身份');
const unavailable = () => new AgentAccessError(503, 'SERVICE_UNAVAILABLE', '身份验证暂不可用');

function readBearer(request: FastifyRequest): string {
  // 不接受多份凭证，避免代理与应用对重复头的解释不一致。
  let authorizationHeaders = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === 'authorization') authorizationHeaders += 1;
  }
  const header = request.headers.authorization;
  if (authorizationHeaders !== 1 || typeof header !== 'string') throw unauthenticated();
  const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i.exec(header);
  if (!match?.[1] || match[0] !== header) throw unauthenticated();
  return match[1];
}

export function createAgentAccess(
  config: AgentConfig,
  platformAdapter?: PlatformIdentityAdapter,
): AgentAccess {
  // createApp 的显式配置和 readConfig 一样校验，不能绕过开发身份的环境限制。
  assertAuthConfiguration(config);
  if (config.auth.mode === 'development' && platformAdapter) {
    throw new Error('Agent 开发身份与平台身份适配器不能同时装配');
  }
  const developmentIdentity =
    config.auth.mode === 'development'
      ? {
          userId: config.auth.userId,
          tokenDigest: createHash('sha256').update(config.auth.bearerToken).digest(),
        }
      : null;

  return {
    async authenticate(request) {
      const bearer = readBearer(request);
      if (developmentIdentity) {
        const actualDigest = createHash('sha256').update(bearer).digest();
        if (!timingSafeEqual(actualDigest, developmentIdentity.tokenDigest))
          throw unauthenticated();
        return Object.freeze({ userId: developmentIdentity.userId, source: 'development' });
      }
      if (!platformAdapter) throw unavailable();
      let identity: { userId: string } | null;
      try {
        identity = await platformAdapter.authenticateBearer(bearer);
      } catch {
        // 平台异常不等同于验证通过，也不把凭证或上游异常暴露给页面和日志。
        throw unavailable();
      }
      if (!identity) throw unauthenticated();
      if (!isValidUserId(identity.userId)) throw unavailable();
      return Object.freeze({ userId: identity.userId, source: 'platform' });
    },
  };
}

export interface OwnedConversation {
  ownerUserId: string;
  deletedAt: Date | string | null;
}

/** 从可信存储加载后校验；不存在、不归属、已删除统一 404，不泄漏真实归属。 */
export function requireOwnedConversation<T extends OwnedConversation>(
  principal: AgentPrincipal,
  conversation: T | null | undefined,
): T {
  if (
    !conversation ||
    conversation.ownerUserId !== principal.userId ||
    conversation.deletedAt !== null
  ) {
    throw new AgentAccessError(404, 'RESOURCE_NOT_FOUND', '资源不存在或不可访问');
  }
  return conversation;
}
