import assert from 'node:assert/strict';
import test from 'node:test';
import { runDirectModelSmoke } from '../src/cli/model-smoke.js';
import type { PiMemorySession, PiPromptResult } from '../src/pi/index.js';

const environment = {
  NODE_ENV: 'test',
  AGENT_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
  AGENT_MODEL_API_KEY: 'isolated-direct-model-key',
};
const completed = (text: string): PiPromptResult => ({
  status: 'completed',
  text,
  error: null,
  observations: [],
});
const memoryState = () => ({ header: null, entries: [], leafId: null });

test('URL＋Key 配置预检不要求平台字段，不请求模型，不输出 Key', async () => {
  let output = '';
  let created = 0;
  await runDirectModelSmoke({
    args: ['--check-config'],
    env: { ...environment, AGENT_MAAS_IDENTITY_MODULE: '/missing/unused-platform-module.mjs' },
    write: (text) => {
      output += text;
    },
    createSession: async () => {
      created++;
      throw new Error('must not create');
    },
  });
  assert.equal(created, 0);
  assert.match(output, /deepseek-flash/);
  assert.match(output, /尚未发送模型请求或验证 Key/);
  assert(!output.includes(environment.AGENT_MODEL_API_KEY));
});

test('直连命令使用同一原生会话验收两轮，不构造平台身份', async () => {
  let output = '';
  let calls = 0;
  let disposed = false;
  let marker = '';
  await runDirectModelSmoke({
    args: [],
    env: environment,
    write: (text) => {
      output += text;
    },
    createSession: async (options) => {
      assert.deepEqual(Object.keys(options), ['config']);
      assert.equal(options.config.apiKey, environment.AGENT_MODEL_API_KEY);
      const session: PiMemorySession = {
        prompt: async (text, onText) => {
          calls++;
          if (calls === 1) marker = /W2-[a-f0-9-]+/.exec(text)![0];
          const response = calls === 1 ? '已记住' : marker;
          onText?.(response);
          return completed(response);
        },
        stop: async () => {},
        dispose: () => {
          disposed = true;
        },
        captureNativeState: memoryState,
      };
      return session;
    },
  });
  assert.equal(calls, 2);
  assert(disposed);
  assert.match(output, /模型直连两轮与口令召回通过/);
  assert(!output.includes(environment.AGENT_MODEL_API_KEY));
});

test('直连停止发生在未收到模型增量时不能被验收为成功', async () => {
  const previousExitCode = process.exitCode;
  let stopped!: () => void;
  const waiting = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  let disposed = false;
  try {
    await assert.rejects(
      runDirectModelSmoke({
        args: ['--stop-after-ms', '1'],
        env: environment,
        write: () => {},
        createSession: async () => ({
          prompt: async () => {
            await waiting;
            return { status: 'stopped', text: '', error: null, observations: [] };
          },
          stop: async () => {
            stopped();
          },
          captureNativeState: memoryState,
          dispose: () => {
            disposed = true;
          },
        }),
      }),
      /未验证到流式停止/,
    );
    assert(disposed);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('直连入口拒绝不合法停止时机，模型失败保持失败且清理会话', async () => {
  await assert.rejects(
    runDirectModelSmoke({ args: ['--stop-after-ms', '0'], env: environment, write: () => {} }),
    /stop-after-ms/,
  );
  const previousExitCode = process.exitCode;
  let disposed = false;
  try {
    await runDirectModelSmoke({
      args: [],
      env: environment,
      write: () => {},
      createSession: async () => ({
        prompt: async () => ({
          status: 'failed',
          text: '',
          error: { code: 'MAAS_HTTP_ERROR' },
          observations: [],
        }),
        stop: async () => {},
        captureNativeState: memoryState,
        dispose: () => {
          disposed = true;
        },
      }),
    });
    assert.equal(process.exitCode, 1);
    assert(disposed);
  } finally {
    process.exitCode = previousExitCode;
  }
});
