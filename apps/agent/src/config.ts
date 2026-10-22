import { isIP } from 'node:net';

export interface AgentConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
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

  return { env, host, port };
}
