import { readFileConfig, type FileConfig } from './files.js';

export interface Config {
  files: FileConfig;
  autoGradingSecret: string;
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  codeSecret: string;
  smsProvider: 'mock';
  webOrigins: string[];
  desktopOrigins: string[];
  cookieSecure: boolean;
  trustProxy: false | string[];
  logLevel: string;
}
export function readConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = source.APP_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(env)) throw new Error('APP_ENV 配置无效');
  const codeSecret = source.CODE_HMAC_SECRET ?? '';
  if (codeSecret.length < 32 || codeSecret.includes('REPLACE_'))
    throw new Error('请配置至少 32 位随机 CODE_HMAC_SECRET');
  const databaseUrl = source.DATABASE_URL ?? '';
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl) || databaseUrl.includes('CHANGE_ME'))
    throw new Error('请配置 DATABASE_URL');
  if (source.SMS_PROVIDER !== 'mock')
    throw new Error('真实短信服务尚未接入，请在开发/测试显式设置 SMS_PROVIDER=mock');
  if (env === 'production')
    throw new Error('尚未接入真实短信 provider，禁止以 production 模式启动 mock 认证');
  const origins = (source.WEB_ORIGINS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    !origins.length ||
    origins.some((x) => {
      try {
        return new URL(x).origin !== x;
      } catch {
        return true;
      }
    })
  )
    throw new Error('WEB_ORIGINS 必须是逗号分隔的完整源地址');
  const secure = source.COOKIE_SECURE === 'true';
  if (
    !secure &&
    origins.some((x) => {
      const u = new URL(x);
      return !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    })
  )
    throw new Error('非回环 Web 环境必须使用 HTTPS 和 Secure Cookie');
  if (secure && origins.some((x) => new URL(x).protocol !== 'https:'))
    throw new Error('Secure Cookie 环境必须使用 HTTPS');
  const desktopOrigins = (source.DESKTOP_ORIGINS ?? 'tyde-app://app')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    !desktopOrigins.length ||
    desktopOrigins.some((origin) => {
      if (origin === 'tyde-app://app') return false;
      try {
        const url = new URL(origin);
        return (
          url.origin !== origin ||
          !['http:', 'https:'].includes(url.protocol) ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('DESKTOP_ORIGINS 仅允许 tyde-app://app 或完整的回环 HTTP(S) 源地址');
  const port = Number(source.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 配置无效');
  const proxy = source.TRUST_PROXY;
  if (proxy === 'true') throw new Error('TRUST_PROXY 不允许 true，请设置 false 或可信代理 IP/CIDR');
  const autoGradingSecret = source.AUTO_GRADING_HMAC_SECRET ?? '';
  if (
    autoGradingSecret &&
    (autoGradingSecret.length < 32 ||
      autoGradingSecret === codeSecret ||
      autoGradingSecret.includes('REPLACE_'))
  )
    throw new Error('AUTO_GRADING_HMAC_SECRET须至少32位且独立于认证密钥');
  return {
    autoGradingSecret,
    files: readFileConfig(source),
    env: env as Config['env'],
    host: source.HOST ?? '127.0.0.1',
    port,
    databaseUrl,
    codeSecret,
    smsProvider: 'mock',
    webOrigins: origins,
    desktopOrigins,
    cookieSecure: secure,
    trustProxy: !proxy || proxy === 'false' ? false : proxy.split(',').map((x) => x.trim()),
    logLevel: source.LOG_LEVEL ?? 'info',
  };
}
