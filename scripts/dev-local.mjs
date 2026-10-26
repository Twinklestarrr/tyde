import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, 'apps/server/.env');
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        // Electron 的 wrapper 收到信号后负责清理其独立的页面和桌面进程组。
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* process already exited */
      }
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());

function start(command, args, env = process.env, watch = false) {
  if (stopping) return;
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32' && command === 'npm',
  });
  children.add(child);
  child.once('error', () => {
    children.delete(child);
    if (watch && !stopping) {
      console.error('开发进程启动失败，请检查 Node.js、npm 和依赖安装。');
      stop(1);
    }
  });
  child.once('exit', (code) => {
    children.delete(child);
    if (watch && !stopping) {
      if (watch === 'desktop' && code === 0)
        console.info('[本地启动] Electron 已退出或已在运行；本次后端保留，Ctrl+C 停止。');
      else stop(code ?? 1);
    }
  });
  return child;
}

function developmentConfig() {
  let config;
  try {
    config = parseEnv(readFileSync(envFile, 'utf8'));
  } catch {
    throw new Error('请先在 apps/server/.env 配置开发数据库和后端环境变量。');
  }
  try {
    const database = new URL(config.DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      !database.hostname ||
      !database.pathname.slice(1) ||
      /_test$/i.test(decodeURIComponent(database.pathname)) ||
      database.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      'apps/server/.env 的 DATABASE_URL 必须是有效的 PostgreSQL 开发库，不能使用 _test 库。',
    );
  }
  const port = Number(config.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('apps/server/.env 的 PORT 必须是有效端口。');
  return {
    ...process.env,
    ...config,
    APP_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    WEB_ORIGINS: 'http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:4173',
    DESKTOP_ORIGINS: 'tyde-app://app,http://127.0.0.1:5174',
    COOKIE_SECURE: 'false',
  };
}

async function apiReady(api) {
  let live;
  try {
    live = await fetch(`${api}/api/v1/health/live`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return false;
  }
  const identity = await live.json().catch(() => null);
  if (!live.ok || identity?.application !== 'tyde' || identity.status !== 'ok')
    throw new Error('后端端口被其他服务占用，请释放 apps/server/.env 的 PORT 后重试。');
  const ready = await fetch(`${api}/api/v1/health/ready`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  return ready?.ok && (await ready.json().catch(() => null))?.status === 'ready';
}

async function requireFreePort(port) {
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error('后端端口已被其他服务占用，请先停止原服务，再启动以加载 apps/server/.env。'),
      ),
    );
    probe.listen(port, '127.0.0.1', () => probe.close(accept));
  });
}

async function startLocalDatabase(env) {
  const database = new URL(env.DATABASE_URL);
  if (
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    (database.port && database.port !== '5432')
  )
    return;
  const listening = await new Promise((accept) => {
    const socket = createConnection({
      host: database.hostname,
      port: 5432,
    });
    const finish = (connected) => {
      socket.destroy();
      accept(connected);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  if (listening || stopping) return;
  console.info('[本地启动] 启动已有 PostgreSQL 实例，不初始化或迁移数据库。');
  await new Promise((accept, reject) => {
    const child = start(
      process.execPath,
      ['scripts/postgres-local.mjs', 'start', '--existing-only'],
      env,
    );
    if (!child) return accept();
    child.once('error', () => reject(new Error('本地 PostgreSQL 启动失败，请检查安装与 PG_BIN。')));
    child.once('exit', (code) =>
      code === 0 || stopping
        ? accept()
        : reject(new Error('本地 PostgreSQL 启动失败，请检查上方日志；未启动应用。')),
    );
  });
}

try {
  // .env 覆盖父进程的旧数据库配置；一键启动只管理本机开发进程。
  const env = developmentConfig();
  const api = `http://127.0.0.1:${env.PORT}`;
  await requireFreePort(Number(env.PORT));
  await startLocalDatabase(env);
  console.info(`[本地启动] 使用 apps/server/.env 的数据库配置，启动后端 ${api}`);
  start('npm', ['--prefix', 'apps/server', 'run', 'dev'], env, 'server');
  const deadline = Date.now() + 90_000;
  while (!stopping && !(await apiReady(api))) {
    if (Date.now() > deadline) throw new Error('等待本地后端就绪超时，请检查上方日志。');
    await delay(400);
  }
  if (!stopping) {
    console.info('[本地启动] 后端就绪，启动 Electron；Ctrl+C 停止本次开发进程。');
    start(
      process.execPath,
      ['scripts/dev-electron.mjs'],
      { ...process.env, TYDE_API_BASE_URL: api, API_PROXY_TARGET: api },
      'desktop',
    );
  }
} catch (error) {
  if (!stopping) {
    console.error(error.message);
    stop(1);
  }
}
