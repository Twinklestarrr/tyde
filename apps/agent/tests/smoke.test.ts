import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadSmokeIdentity, runSmoke, runSmokePreparation } from '../src/cli/smoke.js';

function isolatedEnvironment(modulePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_MAAS_BASE_URL: 'http://127.0.0.1:1/internal/agent-maas/v1',
    AGENT_MAAS_MODEL_ID: 'isolated-model',
    AGENT_MAAS_ACTUAL_MODEL_IDS: '["isolated-model"]',
    AGENT_MAAS_ROUTE_VERSION: 'isolated-route',
    AGENT_MAAS_SERVICE_TOKEN: 'isolated-service-token',
    AGENT_MAAS_CONTEXT_WINDOW: '8192',
    AGENT_MAAS_MAX_TOKENS: '512',
    AGENT_MAAS_COMPAT: JSON.stringify({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      thinkingFormat: 'openai',
    }),
    AGENT_MAAS_IDENTITY_MODULE: modulePath,
    AGENT_MAAS_TOTAL_TIMEOUT_MS: '1000',
  };
}

test('真实冒烟必须显式提供服务端身份模块，不使用开发身份或默认主体', async () => {
  await assert.rejects(loadSmokeIdentity(undefined), /AGENT_MAAS_IDENTITY_MODULE/);
  await assert.rejects(loadSmokeIdentity('relative.mjs'), /绝对文件路径/);
});

test('身份模块每次重新验证平台授权，异常内容不泄漏', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-identity-'));
  try {
    const modulePath = join(directory, 'identity.mjs');
    await writeFile(
      modulePath,
      `
let calls = 0;
export async function resolveIdentity() {
  if (++calls === 3) throw new Error('private upstream diagnostic');
  return {platformSubjectRef: 'platform-subject', source: 'platform'};
}`,
    );
    const resolve = await loadSmokeIdentity(modulePath);
    assert.deepEqual(await resolve(), { platformSubjectRef: 'platform-subject' });
    assert.deepEqual(await resolve(), { platformSubjectRef: 'platform-subject' });
    await assert.rejects(resolve(), { message: '平台原主体授权验证失败' });
    const developmentPath = join(directory, 'development.mjs');
    await writeFile(
      developmentPath,
      `export const resolveIdentity = async () => ({platformSubjectRef:'dev-user',source:'development'});`,
    );
    await assert.rejects((await loadSmokeIdentity(developmentPath))(), /未返回有效可信主体/);
    const brokenPath = join(directory, 'broken.mjs');
    await writeFile(brokenPath, `throw new Error('private module diagnostic');`);
    await assert.rejects(loadSmokeIdentity(brokenPath), {
      message: '无法加载 MaaS 服务端身份模块',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('首次身份校验同样拒绝非法服务凭据覆盖，check-config 不误报通过', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-identity-token-'));
  try {
    for (const [index, token] of ['', 'bad token', 'line\nvalue'].entries()) {
      const modulePath = join(directory, `${index}.mjs`);
      await writeFile(
        modulePath,
        `export async function resolveIdentity(){return {platformSubjectRef:'platform-subject',serviceToken:${JSON.stringify(token)}}}`,
      );
      await assert.rejects((await loadSmokeIdentity(modulePath))(), /未返回有效可信主体/);
      let created = false;
      await assert.rejects(
        runSmoke({
          args: ['--check-config'],
          env: isolatedEnvironment(modulePath),
          createSession: async () => {
            created = true;
            throw new Error('must not create');
          },
          write: () => {},
        }),
        /未返回有效可信主体/,
      );
      assert.equal(created, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('模块导入与首次 resolver 共用准备预算，永久等待以受控超时结束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-smoke-budget-'));
  try {
    const stuckImport = join(directory, 'stuck-import.mjs');
    const stuckResolver = join(directory, 'stuck-resolver.mjs');
    await writeFile(
      stuckImport,
      'await new Promise(() => {}); export async function resolveIdentity(){return {platformSubjectRef:"platform-subject"}}',
    );
    await writeFile(
      stuckResolver,
      'export async function resolveIdentity(){return new Promise(() => {})}',
    );
    for (const path of [stuckImport, stuckResolver]) {
      let created = false;
      const env = { ...isolatedEnvironment(path), AGENT_MAAS_TOTAL_TIMEOUT_MS: '20' };
      await assert.rejects(
        runSmoke({
          args: ['--check-config'],
          env,
          createSession: async () => {
            created = true;
            throw new Error('must not create');
          },
          write: () => {},
        }),
        { code: 'SMOKE_PREPARATION_TIMEOUT' },
      );
      assert.equal(created, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('准备阶段取消立即收敛，迟到授权不能启动模型或报告配置通过', async () => {
  const abort = new AbortController();
  let release!: () => void;
  const pendingIdentity = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const pending = runSmokePreparation(
    async (signal) => {
      await pendingIdentity;
      signal.throwIfAborted();
      calls += 1;
    },
    { signal: abort.signal, timeoutMs: 1000 },
  );
  abort.abort();
  await assert.rejects(pending, { code: 'SMOKE_INTERRUPTED' });
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('可信身份模块可取得并遵守准备阶段的 AbortSignal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-identity-signal-'));
  const modulePath = join(directory, 'identity.mjs');
  await writeFile(
    modulePath,
    `export async function resolveIdentity(signal) {
    if (!(signal instanceof AbortSignal)) throw new Error('missing-signal');
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({platformSubjectRef:'platform-subject'}), {once:true}));
  }`,
  );
  const controller = new AbortController();
  try {
    const resolve = await loadSmokeIdentity(modulePath);
    const pending = resolve(controller.signal);
    controller.abort(new Error('controlled-stop'));
    await assert.rejects(pending, { message: 'controlled-stop' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('第一轮完成边界的命令取消被锁存，不能开始第二轮冒烟', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-smoke-turn-stop-'));
  const modulePath = join(directory, 'identity.mjs');
  await writeFile(
    modulePath,
    'export async function resolveIdentity(){return {platformSubjectRef:"platform-subject"}}',
  );
  let prompts = 0;
  let stops = 0;
  let disposals = 0;
  try {
    await assert.rejects(
      runSmoke({
        args: [],
        env: isolatedEnvironment(modulePath),
        write: () => {},
        createSession: async () => ({
          prompt: async () => {
            prompts += 1;
            process.emit('SIGINT');
            return { status: 'completed', text: 'first turn', error: null, observations: [] };
          },
          stop: async () => {
            stops += 1;
          },
          captureNativeState: () => ({ header: null, entries: [], leafId: null }),
          dispose: () => {
            disposals += 1;
          },
        }),
      }),
      { code: 'SMOKE_INTERRUPTED', exitCode: 130 },
    );
    assert.equal(prompts, 1);
    assert.equal(stops, 1);
    assert.equal(disposals, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI 的超时、取消、普通失败和成功均不会被模块活动句柄无限阻止退出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-w2-smoke-process-'));
  try {
    for (const stage of ['resolver', 'import', 'rejected', 'completed'] as const) {
      const modulePath = join(directory, `${stage}.mjs`);
      await writeFile(
        modulePath,
        stage === 'resolver'
          ? 'export async function resolveIdentity(){process.stdout.write("identity-awaiting\\n");setInterval(()=>{},1000);return new Promise(() => {})}'
          : stage === 'import'
            ? 'process.stdout.write("identity-awaiting\\n");setInterval(()=>{},1000);await new Promise(() => {});export async function resolveIdentity(){return {platformSubjectRef:"platform-subject"}}'
            : stage === 'rejected'
              ? 'setInterval(()=>{},1000);export async function resolveIdentity(){throw new Error("private module diagnostic")}'
              : 'setInterval(()=>{},1000);export async function resolveIdentity(){return {platformSubjectRef:"platform-subject"}}',
      );
      for (const interrupt of stage === 'resolver' || stage === 'import'
        ? [false, true]
        : [false]) {
        const env = {
          ...isolatedEnvironment(modulePath),
          AGENT_MAAS_TOTAL_TIMEOUT_MS:
            interrupt || stage === 'rejected' || stage === 'completed' ? '5000' : '25',
        };
        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stdout: string;
          stderr: string;
          terminalDelayMs: number;
        }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              fileURLToPath(new URL('../src/cli/smoke.ts', import.meta.url)),
              '--check-config',
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' },
          );
          let stdout = '';
          let stderr = '';
          let signalled = false;
          let terminalAt: number | undefined;
          child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
            if (stdout.includes('校验通过')) terminalAt ??= Date.now();
            if (interrupt && !signalled && stdout.includes('identity-awaiting')) {
              signalled = true;
              child.kill('SIGINT');
            }
          });
          child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            if (
              stderr.includes('准备超时') ||
              stderr.includes('验证已中断') ||
              stderr.includes('平台原主体授权验证失败')
            )
              terminalAt ??= Date.now();
          });
          child.once('error', reject);
          child.once('close', (code, signal) => {
            resolve({
              code,
              signal,
              stdout,
              stderr,
              terminalDelayMs: terminalAt === undefined ? Infinity : Date.now() - terminalAt,
            });
          });
        });
        assert.equal(outcome.signal, null, JSON.stringify(outcome));
        assert.equal(
          outcome.code,
          stage === 'completed' ? 0 : interrupt ? 130 : 1,
          JSON.stringify(outcome),
        );
        if (stage === 'completed') assert.equal(outcome.stderr, '');
        else
          assert.match(
            outcome.stderr,
            stage === 'rejected' ? /平台原主体授权验证失败/ : interrupt ? /验证已中断/ : /准备超时/,
          );
        assert.ok(outcome.terminalDelayMs < 3500, JSON.stringify(outcome));
        assert.equal(outcome.stdout.includes('校验通过'), stage === 'completed');
        assert.ok(!outcome.stdout.includes('turn '));
        assert.ok(!outcome.stderr.includes('private module diagnostic'));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
