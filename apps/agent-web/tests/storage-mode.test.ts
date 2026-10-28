import assert from 'node:assert/strict';
import test from 'node:test';
import { storageModeCopy } from '../src/lib/storage-mode';
import { AgentClient } from '../src/services/agent-client';
import { ChatController } from '../src/services/chat-controller';

test('storage mode text distinguishes persistence, explicit memory, and unconfirmed metadata', () => {
  assert.match(storageModeCopy('postgres').description, /重启后保留历史/);
  assert.match(storageModeCopy('postgres').description, /不会自动继续执行/);
  assert.doesNotMatch(storageModeCopy('postgres').hint, /清空/);
  assert.match(storageModeCopy('memory').hint, /重启会清空历史/);
  assert.match(storageModeCopy(null).label, /尚未确认/);
});

test('server mode changes and unavailable metadata cannot retain a false PostgreSQL claim or execute', async () => {
  let mode: 'postgres' | 'memory' | null = 'postgres';
  const calls: string[] = [];
  const client = new AgentClient('controlled-identity', async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    return mode === null
      ? Response.json({}, { status: 503 })
      : Response.json({ storage_mode: mode });
  });
  const controller = new ChatController(client);
  assert.equal(controller.getSnapshot().storageMode, null);
  assert.equal(await controller.refreshStorageMode(), true);
  assert.equal(controller.getSnapshot().storageMode, 'postgres');
  mode = 'memory';
  assert.equal(await controller.refreshStorageMode(), true);
  assert.equal(controller.getSnapshot().storageMode, 'memory');
  mode = null;
  assert.equal(await controller.refreshStorageMode(), false);
  assert.equal(controller.getSnapshot().storageMode, null);
  assert.match(controller.getSnapshot().error ?? '', /存储模式尚未确认/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call === 'GET /agent-api/api/agent/v1/runtime'));
  controller.dispose();
});

test('late metadata cannot overwrite a newer unknown mode', async () => {
  let resolveFirst!: (value: Response) => void;
  let first = true;
  const client = new AgentClient('controlled-identity', async () => {
    if (first) {
      first = false;
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Response.json({}, { status: 503 });
  });
  const controller = new ChatController(client);
  const old = controller.refreshStorageMode();
  assert.equal(await controller.refreshStorageMode(), false);
  resolveFirst(Response.json({ storage_mode: 'postgres' }));
  assert.equal(await old, false);
  assert.equal(controller.getSnapshot().storageMode, null);
  controller.dispose();
});

test('select rechecks a changed server mode before reading old conversation state', async () => {
  let mode: 'postgres' | 'memory' = 'postgres';
  const urls: string[] = [];
  const client = new AgentClient('controlled-identity', async (url) => {
    urls.push(String(url));
    assert.equal(url, '/agent-api/api/agent/v1/runtime');
    return Response.json({ storage_mode: mode });
  });
  const controller = new ChatController(client);
  await controller.refreshStorageMode();
  mode = 'memory';
  await controller.select('10000000-0000-4000-8000-000000000001');
  assert.equal(controller.getSnapshot().storageMode, 'memory');
  assert.equal(controller.getSnapshot().view, null);
  assert.equal(controller.getSnapshot().connection, 'blocked');
  assert.match(controller.getSnapshot().error ?? '', /模式已变更/);
  assert.equal(urls.length, 2);
  controller.dispose();
});
