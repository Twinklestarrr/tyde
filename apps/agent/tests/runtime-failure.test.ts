import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { AgentPostgresRuntime } from '../src/runtime/postgres-runtime.js';

test('数据库查询失败在ROLLBACK仍未返回时立即取消活动执行', async () => {
  let releaseRollback!: () => void;
  let reachedRollback!: () => void;
  const rollback = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reachedRollback = resolve;
  });
  const client = {
    query: async (text: string) => {
      if (text.startsWith('BEGIN')) return { rows: [] };
      if (text === 'ROLLBACK') {
        reachedRollback();
        await rollback;
        return { rows: [] };
      }
      throw new Error('controlled database failure');
    },
    release() {},
  };
  const runtime = new AgentPostgresRuntime({
    pool: { connect: async () => client } as unknown as Pool,
    executionConfig: {},
    createSession: async () => {
      throw new Error('failure probe must not start Pi');
    },
  });
  const controller = new AbortController();
  const active = Reflect.get(runtime, 'active') as Map<string, unknown>;
  active.set('controlled-probe', {
    controller,
    session: { stop: async () => undefined, dispose() {} },
  });
  const pending = runtime
    .getConversation({ userId: 'controlled-review', source: 'development' }, randomUUID())
    .catch(() => undefined);
  try {
    await reached;
    assert.equal(controller.signal.aborted, true);
  } finally {
    releaseRollback();
    await pending;
    active.clear();
    await runtime.close();
  }
});
