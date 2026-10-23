import { isIP } from 'node:net';

export interface AgentConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  auth: AgentAuthConfig;
  storage?: { mode: 'memory' } | { mode: 'postgres'; databaseUrl?: string };
}

export type AgentAuthConfig =
  { mode: 'disabled' } | { mode: 'development'; userId: string; bearerToken: string };

export function assertAuthConfiguration(config: AgentConfig): void {
  if (config.auth.mode !== 'development') return;
  if (config.env === 'production') {
    throw new Error('production 环境禁止启用 Agent 开发测试身份');
  }
  if (config.host !== '127.0.0.1' && config.host !== '::1') {
    throw new Error('Agent 开发测试身份仅允许 AGENT_HOST=127.0.0.1 或 ::1');
  }
  if (!isValidUserId(config.auth.userId)) {
    throw new Error('AGENT_TEST_USER_ID 必须是 1 至 128 字符、不含空白或控制字符的稳定用户标识');
  }
  if (
    config.auth.bearerToken.trim() !== config.auth.bearerToken ||
    !/^[A-Za-z0-9._~+/-]{32,}={0,2}$/.test(config.auth.bearerToken)
  ) {
    throw new Error('AGENT_TEST_BEARER_TOKEN 必须是至少 32 字符的 Bearer 凭证，不含空白');
  }
}

export function isValidUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    [...value].length >= 1 &&
    [...value].length <= 128 &&
    !/[\s\p{Cc}\p{Cs}]/u.test(value)
  );
}

export function readConfig(source: NodeJS.ProcessEnv = process.env): AgentConfig {
  const env = source.NODE_ENV ?? 'development';
  if (env !== 'development' && env !== 'test' && env !== 'production') {
    throw new Error('NODE_ENV 必须是 development、test 或 production');
  }

  const host = source.AGENT_HOST ?? '127.0.0.1';
  const validHostname =
    host.length <= 253 &&
    host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (!isIP(host) && !validHostname) {
    throw new Error('AGENT_HOST 必须是有效 IP 或主机名，不含协议和端口');
  }

  const rawPort = source.AGENT_PORT ?? '3002';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('AGENT_PORT 必须是 1 至 65535 的整数');
  }

  const authMode = source.AGENT_AUTH_MODE ?? 'disabled';
  if (authMode !== 'disabled' && authMode !== 'development') {
    throw new Error('AGENT_AUTH_MODE 必须是 disabled 或 development');
  }
  const auth: AgentAuthConfig =
    authMode === 'development'
      ? {
          mode: 'development',
          userId: source.AGENT_TEST_USER_ID ?? '',
          bearerToken: source.AGENT_TEST_BEARER_TOKEN ?? '',
        }
      : { mode: 'disabled' };
  const storageMode = source.AGENT_STORAGE_MODE ?? 'postgres';
  if (storageMode !== 'postgres' && storageMode !== 'memory')
    throw new Error('AGENT_STORAGE_MODE 必须是 postgres 或 memory');
  if (storageMode === 'memory' && env === 'production')
    throw new Error('production 禁止开发内存模式');
  const storage: NonNullable<AgentConfig['storage']> =
    storageMode === 'memory'
      ? { mode: 'memory' }
      : {
          mode: 'postgres',
          ...(source.AGENT_DATABASE_URL ? { databaseUrl: source.AGENT_DATABASE_URL } : {}),
        };
  const config: AgentConfig = { env, host, port, auth, storage };
  assertAuthConfiguration(config);
  return config;
}
