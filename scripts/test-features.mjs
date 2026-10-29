import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString();
const directory = resolve(
  root,
  'artifacts/feature-tests',
  `${startedAt.replaceAll(':', '-')}-${process.pid}`,
);
const ports = [5176, 5177];
const checks = [];
const owned = new Map();
let active;
let interrupted = false;
let stopTimer;
let frontend;

/** 记录出生时间，清理仅限本次命令的后代，避免误杀用户进程或复用的 PID。 */
function processes() {
  if (process.platform === 'win32') {
    const rows = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8' },
      ),
    );
    return rows.map((row) => ({
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      birth: row.CreationDate,
    }));
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [, pid, parent, birth] = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      return { pid: Number(pid), parent: Number(parent), birth };
    });
}

function track() {
  const rows = processes();
  const parents = new Set(
    rows.filter((row) => owned.get(row.pid) === row.birth).map((row) => row.pid),
  );
  if (active?.pid) parents.add(active.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if ((parents.has(row.parent) || row.pid === active?.pid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        changed = true;
      }
      if (parents.has(row.pid)) owned.set(row.pid, row.birth);
    }
  }
}

function signalOwned(signal) {
  for (const row of processes().reverse()) {
    if (owned.get(row.pid) !== row.birth) continue;
    try {
      process.kill(row.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function cleanup() {
  track();
  signalOwned('SIGTERM');
  await delay(500);
  track();
  signalOwned('SIGKILL');
  await delay(100);
  const remaining = processes().filter((row) => owned.get(row.pid) === row.birth);
  if (remaining.length)
    throw new Error(`测试进程未完全退出：${remaining.map((row) => row.pid).join(', ')}`);
  owned.clear();
}

async function freePorts() {
  for (const port of ports)
    await new Promise((accept, reject) => {
      const probe = createServer();
      probe.once('error', () =>
        reject(new Error(`测试端口 ${port} 被占用；请先关闭对应服务。本命令不会停止已有服务。`)),
      );
      probe.listen(port, '127.0.0.1', () => probe.close(accept));
    });
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    track();
    if (!active?.pid) return;
    // 将中断直接交给 Playwright，先让它执行浏览器与 webServer 的正常清理。
    if (process.platform !== 'win32') {
      try {
        process.kill(-active.pid, 'SIGINT');
      } catch {
        /* already exited */
      }
    } else signalOwned('SIGTERM');
    stopTimer ??= setTimeout(() => signalOwned('SIGKILL'), 10_000);
    stopTimer.unref();
  });

await mkdir(directory, { recursive: true });
const steps = [
  ['core', '核心与客户端接口契约', ['test:core']],
  [
    'server-unit',
    '后端单元测试（排除数据库集成）',
    ['--filter', '@tyde/server', 'test', '--maxWorkers=2'],
  ],
  ['web-build', '共享 Web 类型检查与构建', ['build:web']],
  ['electron-build', 'Electron 构建', ['--filter', '@tyde/electron', 'build']],
  [
    'frontend',
    '全部已接入页面与双端回归',
    [
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.frontend.config.ts',
      '--output',
      resolve(directory, 'browser'),
    ],
  ],
  ['agent-contracts', 'Agent 共享契约一致性', ['check:agent-contracts']],
  ['agent-build', 'Agent 服务类型检查与构建', ['build:agent']],
  [
    'agent-unit',
    'Agent 隔离服务测试（排除数据库集成）',
    [
      '--filter',
      '@tyde/agent',
      'exec',
      'node',
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=2',
    ],
  ],
  ['agent-web-build', 'Agent Web 类型检查与构建', ['build:agent-web']],
  ['agent-web-unit', 'Agent Web 控制器与组件测试', ['--filter', '@tyde/agent-web', 'test']],
];
const notExecuted = [
  'PostgreSQL 数据库集成与迁移',
  '真实业务后端 HTTP/OSS 联调',
  '真实模型与业务 Agent 联调',
  '部署与发布',
];
let failure;
let timer;
try {
  if (process.argv.length > 2)
    throw new Error('用法：pnpm test:features（无需参数，不连接或迁移数据库）。');
  await freePorts();
  processes();
  // 单独进程树之外的 PostgreSQL、开发页面和用户 Electron 均不属于清理范围。
  timer = setInterval(track, 250);
  for (const [id, label, args] of steps) {
    if (interrupted) break;
    const commandArgs = [...args];
    if (id === 'agent-unit') {
      const files = (await readdir(resolve(root, 'apps/agent/tests')))
        .filter((name) => name.endsWith('.test.ts') && !name.endsWith('.integration.test.ts'))
        .sort();
      if (!files.length) throw new Error('没有找到 Agent 隔离服务测试，不能视为通过。');
      commandArgs.push(...files.map((name) => `tests/${name}`));
    }
    console.info(`\n[功能回归] ${label}`);
    const begin = Date.now();
    const log = createWriteStream(resolve(directory, `${id}.log`));
    let outcome;
    let closed;
    try {
      outcome = await new Promise((accept, reject) => {
        const env = {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(directory, 'frontend.json'),
        };
        delete env.AGENT_TEST_DATABASE_URL;
        active = spawn('pnpm', commandArgs, {
          cwd: root,
          detached: process.platform !== 'win32',
          shell: process.platform === 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
        for (const [stream, output] of [
          [active.stdout, process.stdout],
          [active.stderr, process.stderr],
        ])
          stream.on('data', (chunk) => {
            output.write(chunk);
            log.write(chunk);
          });
        active.once('error', reject);
        closed = new Promise((done) => active.once('close', done));
        active.once('exit', (code, signal) => {
          track();
          active = undefined;
          accept({ code, signal });
        });
        track();
      });
    } finally {
      try {
        await cleanup();
        await closed;
      } finally {
        await new Promise((accept) => log.end(accept));
      }
    }
    const row = {
      id,
      label,
      command: ['pnpm', ...commandArgs],
      ...outcome,
      status: interrupted ? 'interrupted' : outcome.code === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - begin,
      log: `${id}.log`,
    };
    checks.push(row);
    if (id === 'frontend') {
      try {
        const stats = JSON.parse(await readFile(resolve(directory, 'frontend.json'), 'utf8')).stats;
        if (
          !stats ||
          !['expected', 'unexpected', 'skipped', 'flaky'].every(
            (key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0,
          )
        )
          throw new Error('页面报告计数无效');
        frontend = stats;
        if (stats.expected < 1 || stats.unexpected !== 0) throw new Error('页面用例未通过');
      } catch {
        if (row.status === 'passed') {
          row.status = 'failed';
          failure = '页面测试未生成有效的通过报告，请查看 frontend.log。';
        }
      }
    }
    if (row.status !== 'passed') break;
  }
} catch (error) {
  failure = error.message;
  console.error(failure);
} finally {
  if (timer) clearInterval(timer);
  if (stopTimer) clearTimeout(stopTimer);
  try {
    await cleanup();
  } catch (error) {
    failure = error.message;
  }
  // 只检查端口，不按端口杀进程；出现并发用户服务时如实报告清理未通过。
  try {
    await freePorts();
  } catch (error) {
    failure = error.message;
  }
  const result =
    !failure &&
    !interrupted &&
    checks.length === steps.length &&
    checks.every((row) => row.status === 'passed')
      ? 'passed'
      : interrupted
        ? 'interrupted'
        : 'failed';
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    result,
    database: 'not-accessed',
    ports,
    failure,
    checks,
    frontend,
    notRun: steps.filter(([id]) => !checks.some((row) => row.id === id)).map(([id]) => id),
    notExecuted,
  };
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    resolve(directory, 'report.md'),
    `# 已接入功能自动化回归\n\n结果：${result}\n\n运行隔离接口、业务与 Agent 单元测试、构建及 Web/Electron 页面，不操作数据库、不调用真实模型或业务 Agent。Agent Web 验证控制器与组件，不代表真实浏览器联调。\n\n| 检查 | 结果 | 耗时 |\n| --- | --- | --- |\n${checks.map((row) => `| ${row.label} | ${row.status} | ${(row.durationMs / 1000).toFixed(1)}s |`).join('\n')}\n\n${frontend ? `页面：${frontend.expected} 通过，${frontend.unexpected} 失败，${frontend.skipped} 跳过，${frontend.flaky} 重试后通过。\n\n` : ''}${failure ? `错误：${failure}\n\n` : ''}未运行阶段：${report.notRun.join('、') || '无'}。\n\n本命令不执行：${notExecuted.join('、')}。这些能力不计入本次通过结果。详细日志和页面截图、trace 位于本目录。\n`,
  );
  await writeFile(
    resolve(root, 'artifacts/feature-tests/latest.json'),
    JSON.stringify(
      {
        result,
        report: relative(root, resolve(directory, 'report.md')),
        summary: relative(root, resolve(directory, 'summary.json')),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(`\n[功能回归] ${result}；报告：${relative(root, resolve(directory, 'report.md'))}`);
  process.exitCode = result === 'passed' ? 0 : interrupted ? 130 : 1;
}
