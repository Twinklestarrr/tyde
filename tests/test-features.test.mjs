import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages = ['core', 'server-unit', 'web-build', 'electron-build', 'frontend'];
const stats = { expected: 2, unexpected: 0, skipped: 0, flaky: 0 };
const fakePnpm = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const record = (event, extra = {}) => appendFileSync(process.env.FIXTURE_EVENTS,
  JSON.stringify({ event, pid: process.pid, ...extra }) + '\n');
const worker = process.argv[2];
if (worker === 'child' || worker === 'grandchild') {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  record(worker);
  if (worker === 'child') spawn(process.execPath, [fileURLToPath(import.meta.url), 'grandchild'],
    { stdio: process.env.FIXTURE_LEAVE_DESCENDANTS === '1' ? 'inherit' : 'ignore', detached: true });
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const id = args[0] === 'test:core' ? 'core' : args.includes('@tyde/server') ? 'server-unit'
    : args[0] === 'build:web' ? 'web-build' : args.includes('@tyde/electron') ? 'electron-build'
    : args.includes('playwright') ? 'frontend' : 'unexpected-command';
  record('stage', { id, args });
  console.log('fixture stdout ' + id);
  console.error('fixture stderr ' + id);
  if (id === 'frontend' && process.env.FIXTURE_HOLD === '1') {
    process.on('SIGINT', () => {});
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  } else if (process.env.FIXTURE_FAIL === id && process.env.FIXTURE_LEAVE_DESCENDANTS === '1') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], { stdio: 'inherit' });
    // 留给 runner 的进程快照记录后代；显式退出，但后代继续持有 stdout/stderr 管道。
    setTimeout(() => process.exit(7), 600);
  } else {
    if (id === 'frontend' && process.env.FIXTURE_NO_REPORT !== '1')
      writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
        JSON.stringify({ stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 } }));
    process.exitCode = process.env.FIXTURE_FAIL === id ? 7 : id === 'unexpected-command' ? 9 : 0;
  }
}
`;

async function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw new Error(message);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return server.address().port;
}

async function fixture(t, occupied = false) {
  const root = await mkdtemp(join(tmpdir(), 'tyde-test-features-'));
  const eventsFile = join(root, 'events.jsonl');
  const probes = [
    createServer((request, response) => response.end('external fixture service')),
    createServer(),
  ];
  const ports = await Promise.all(probes.map(listen));
  const external = occupied ? probes[0] : undefined;
  for (const probe of probes)
    if (probe !== external) await new Promise((accept) => probe.close(accept));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'bin'));
  await writeFile(eventsFile, '');
  const source = await readFile(join(project, 'scripts/test-features.mjs'), 'utf8');
  assert.match(source, /const ports = \[5176, 5177\];/, '仅替换临时副本的测试端口');
  await writeFile(
    join(root, 'scripts/test-features.mjs'),
    source.replace('const ports = [5176, 5177];', `const ports = ${JSON.stringify(ports)};`),
  );
  if (process.platform === 'win32') {
    await writeFile(join(root, 'bin/pnpm.mjs'), fakePnpm);
    await writeFile(join(root, 'bin/pnpm.cmd'), `@"${process.execPath}" "%~dp0pnpm.mjs" %*\r\n`);
  } else await writeFile(join(root, 'bin/pnpm'), fakePnpm, { mode: 0o755 });
  const runs = [];
  const outsiders = [];
  const events = async () =>
    (await readFile(eventsFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  t.after(async () => {
    for (const run of runs) if (alive(run.child.pid)) run.child.kill('SIGKILL');
    for (const row of await events()) {
      if (!alive(row.pid)) continue;
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    for (const child of outsiders) if (alive(child.pid)) child.kill('SIGKILL');
    await Promise.allSettled(runs.map((run) => run.done));
    if (external) await new Promise((accept) => external.close(accept));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    ports,
    events,
    async report() {
      const latest = JSON.parse(
        await readFile(join(root, 'artifacts/feature-tests/latest.json'), 'utf8'),
      );
      const summary = JSON.parse(await readFile(join(root, latest.summary), 'utf8'));
      const markdown = await readFile(join(root, latest.report), 'utf8');
      return { latest, summary, markdown, directory: dirname(join(root, latest.summary)) };
    },
    launch(extraEnv = {}) {
      let output = '';
      const child = spawn(process.execPath, ['scripts/test-features.mjs'], {
        cwd: root,
        env: {
          ...process.env,
          PATH: join(root, 'bin') + delimiter + process.env.PATH,
          FIXTURE_EVENTS: eventsFile,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const done = new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => accept({ code, signal, output }));
      });
      const run = {
        child,
        done,
        async finish() {
          await waitFor(
            () => child.exitCode !== null || child.signalCode !== null,
            '隔离 runner 未退出：' + output,
          );
          return done;
        },
      };
      runs.push(run);
      return run;
    },
    async outsider() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      outsiders.push(child);
      await new Promise((accept, reject) => {
        child.once('spawn', accept);
        child.once('error', reject);
      });
      return child;
    },
  };
}

test('feature runner executes five isolated stages in order and records real report stats', async (t) => {
  const local = await fixture(t);
  const result = await local.launch().finish();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    (await local.events()).map((row) => row.id),
    stages,
  );
  const { latest, summary, markdown, directory } = await local.report();
  assert.equal(latest.result, 'passed');
  assert.equal(summary.result, 'passed');
  assert.equal(summary.database, 'not-accessed');
  assert.deepEqual(summary.ports, local.ports);
  assert.deepEqual(
    summary.checks.map((row) => row.id),
    stages,
  );
  assert.ok(summary.checks.every((row) => row.status === 'passed' && row.code === 0));
  assert.deepEqual(summary.frontend, stats);
  assert.deepEqual(summary.notRun, []);
  assert.match(markdown, /2 通过，0 失败/);
  for (const stage of stages) {
    const log = await readFile(join(directory, stage + '.log'), 'utf8');
    assert.ok(log.includes('fixture stdout ' + stage));
    assert.ok(log.includes('fixture stderr ' + stage));
  }
});

test('a failed stage prevents every later command and reports its exit code', async (t) => {
  const local = await fixture(t);
  const external = await local.outsider();
  const result = await local
    .launch({ FIXTURE_FAIL: 'web-build', FIXTURE_LEAVE_DESCENDANTS: '1' })
    .finish();
  assert.equal(result.code, 1, result.output);
  const events = await local.events();
  assert.deepEqual(
    events.filter(({ event }) => event === 'stage').map((row) => row.id),
    stages.slice(0, 3),
  );
  assert.ok(events.some(({ event }) => event === 'child'));
  assert.ok(events.some(({ event }) => event === 'grandchild'));
  await waitFor(() => events.every(({ pid }) => !alive(pid)), '失败阶段遗留继承管道的后代');
  assert.ok(alive(external.pid), '阶段失败不能终止外部进程');
  const { summary } = await local.report();
  assert.equal(summary.result, 'failed');
  assert.deepEqual(summary.notRun, ['electron-build', 'frontend']);
  assert.deepEqual(
    summary.checks.map(({ id, status, code }) => ({ id, status, code })),
    [
      { id: 'core', status: 'passed', code: 0 },
      { id: 'server-unit', status: 'passed', code: 0 },
      { id: 'web-build', status: 'failed', code: 7 },
    ],
  );
});

test('occupied test ports fail before commands without stopping the existing service', async (t) => {
  const local = await fixture(t, true);
  const result = await local.launch().finish();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(await local.events(), []);
  assert.equal(
    await (await fetch(`http://127.0.0.1:${local.ports[0]}`)).text(),
    'external fixture service',
  );
  const { summary } = await local.report();
  assert.equal(summary.result, 'failed');
  assert.match(summary.failure, new RegExp(`测试端口 ${local.ports[0]} 被占用`));
  assert.deepEqual(summary.notRun, stages);
});

test(
  'SIGINT cleans owned children and detached grandchildren while preserving external processes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const local = await fixture(t);
    const external = await local.outsider();
    const run = local.launch({ FIXTURE_HOLD: '1' });
    await waitFor(
      async () => (await local.events()).some(({ event }) => event === 'grandchild'),
      '前端替身未启动 detached 孙进程',
    );
    await delay(350);
    const owned = (await local.events()).map(({ pid }) => pid);
    run.child.kill('SIGINT');
    const result = await run.finish();
    assert.equal(result.code, 130, result.output);
    await waitFor(() => owned.every((pid) => !alive(pid)), 'runner 遗留本次测试进程');
    assert.ok(alive(external.pid), '清理不能终止 runner 进程树之外的进程');
    const { summary } = await local.report();
    assert.equal(summary.result, 'interrupted');
    assert.notEqual(summary.result, 'passed');
  },
);

test('an exit-zero frontend command without its JSON stats cannot pass', async (t) => {
  const local = await fixture(t);
  const result = await local.launch({ FIXTURE_NO_REPORT: '1' }).finish();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(
    (await local.events()).map((row) => row.id),
    stages,
  );
  const { summary } = await local.report();
  assert.equal(summary.result, 'failed');
  assert.ok(summary.failure, '缺失页面执行报告必须给出原因');
});
