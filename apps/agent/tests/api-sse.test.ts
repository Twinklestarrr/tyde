import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateAgentContract, type ProductFrame } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config.js';
import { AgentMemoryRuntime } from '../src/runtime/memory-runtime.js';
import type { PiPromptResult } from '../src/pi/session.js';

const bearer = 'isolated-sse-test-credential';
const headers = { authorization: `Bearer ${bearer}` };
const principal = { userId: 'isolated-sse-test-user', source: 'platform' as const };
const base = '/api/agent/v1/conversations';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface WireFrame {
  event: string;
  data: Record<string, unknown>;
}

/** 真 TCP 数据按 SSE 帧边界读取；每个测试自行决定已成功应用的位置。 */
async function openStream(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const frames: WireFrame[] = [];
  const next = async (): Promise<WireFrame | null> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (!event || !data) continue;
        const frame = { event, data: JSON.parse(data) as Record<string, unknown> };
        frames.push(frame);
        return frame;
      }
      if (done) return null;
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done });
    }
  };
  return {
    frames,
    next,
    async until(predicate: (frame: WireFrame) => boolean): Promise<WireFrame> {
      for (;;) {
        const frame = await next();
        assert.ok(frame, 'SSE 在目标帧之前结束');
        if (predicate(frame)) return frame;
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
  };
}

async function setup(asyncLive = false) {
  let authorized = true;
  let starts = 0;
  let stops = 0;
  let finish: ((result: PiPromptResult) => void) | undefined;
  const runtime = new AgentMemoryRuntime({
    createSession: async (_id, barriers) => ({
      prompt: async () => {
        starts += 1;
        await barriers.beforeModel?.({ header: null, entries: [], leafId: null });
        await barriers.beforeModelDispatch?.();
        return new Promise<PiPromptResult>((resolve) => {
          finish = resolve;
        });
      },
      stop: async () => {
        stops += 1;
        finish?.({ status: 'stopped', text: '', error: null, observations: [] });
      },
      dispose() {},
    }),
  });
  const app = await createApp(readConfig({ NODE_ENV: 'test' }), {
    runtime: asyncLive
      ? new Proxy(runtime, {
          get(target, property) {
            if (property === 'subscribe')
              return async (...args: Parameters<AgentMemoryRuntime['subscribe']>) => {
                const result = target.subscribe(...args);
                args[2].onFrame({
                  schema_version: 1,
                  frame_kind: 'delta',
                  conversation_id: args[1],
                  stream_id: args[2].streamId,
                  attempt_id: randomUUID(),
                  message_id: randomUUID(),
                  output_stream_id: randomUUID(),
                  delta_index: 1,
                  text: 'isolated async subscription callback',
                });
                await tick();
                return result;
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : runtime,
    identityAdapter: {
      authenticateBearer: async (token) =>
        authorized && token === bearer ? { userId: principal.userId } : null,
    },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const created = runtime.createConversation(principal, { schema_version: 1 });
  const id = created.conversation.id;
  const streamId = created.read_cursor.stream_id;
  const streamUrl = (after: string) =>
    `${address}${base}/${id}/events?stream_id=${streamId}&after_seq=${after}`;
  return {
    app,
    runtime,
    address,
    id,
    streamId,
    streamUrl,
    starts: () => starts,
    stops: () => stops,
    revoke: () => {
      authorized = false;
    },
    start: () =>
      runtime.submitCommand(principal, id, {
        schema_version: 1,
        request_key: randomUUID(),
        kind: 'start_task',
        task_kind: 'business_query',
        input: { text: '隔离 TCP 问答' },
      }),
    finish: () =>
      finish?.({ status: 'completed', text: '隔离 TCP 回答', error: null, observations: [] }),
  };
}

function reliable(frames: WireFrame[]): ProductFrame[] {
  return frames
    .filter((frame) => frame.event === 'product')
    .map((frame) => {
      assert.equal(validateAgentContract('ProductFrame', frame.data), true);
      return frame.data as unknown as ProductFrame;
    });
}

test('真 TCP 已开流授权撤销后停止私有事件推送，发送 reauthenticate 并关闭', async (t) => {
  const fixture = await setup();
  const stream = await openStream(fixture.streamUrl('0'));
  t.after(async () => {
    await stream.close();
    await fixture.app.close();
  });
  await stream.until((frame) => frame.event === 'control' && frame.data.code === 'ready');
  fixture.revoke();
  const response = await fetch(`${fixture.address}${base}/${fixture.id}/snapshot`, { headers });
  assert.equal(response.status, 401);
  fixture.start();
  await stream.until((frame) => frame.event === 'control' && frame.data.code === 'reauthenticate');
  assert.equal(await stream.next(), null);
  assert.equal(
    stream.frames.some((frame) => ['product', 'delta'].includes(frame.event)),
    false,
  );
});

test('真 TCP 快照和开流间的产品变化全部补读，水位连续且不会重复执行', async (t) => {
  const fixture = await setup();
  const resource: { stream?: Awaited<ReturnType<typeof openStream>> } = {};
  t.after(async () => {
    await resource.stream?.close();
    await fixture.app.close();
  });
  const response = await fetch(`${fixture.address}${base}/${fixture.id}/snapshot`, { headers });
  const snapshot = await response.json();
  assert.equal(validateAgentContract('SnapshotResponse', snapshot), true);
  assert.equal(snapshot.data.read_cursor.event_seq, '0');
  fixture.start();
  await tick();
  const head = fixture.runtime.getSnapshot(principal, fixture.id).read_cursor.event_seq;
  assert.ok(BigInt(head) > 0n);
  const stream = await openStream(fixture.streamUrl(snapshot.data.read_cursor.event_seq));
  resource.stream = stream;
  const ready = await stream.until(
    (frame) => frame.event === 'control' && frame.data.code === 'ready',
  );
  assert.equal(ready.data.accepted_after_seq, '0');
  await stream.until((frame) => frame.event === 'product' && frame.data.event_seq === head);
  const replay = reliable(stream.frames);
  assert.equal(replay.length, Number(head));
  assert.deepEqual(
    replay.map((frame) => frame.event_seq),
    replay.map((_, index) => String(index + 1)),
  );
  assert.equal(fixture.starts(), 1);
  fixture.finish();
  await stream.until(
    (frame) => frame.event === 'product' && frame.data.event_type === 'task.completed',
  );
  const all = reliable(stream.frames);
  assert.deepEqual(
    all.map((frame) => frame.event_seq),
    all.map((_, index) => String(index + 1)),
  );
  assert.equal(fixture.starts(), 1);
});

test('真 TCP 断开订阅不停止任务，重连仅按已应用 after_seq 补读同进程事件', async (t) => {
  const fixture = await setup();
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  t.after(async () => {
    await stream?.close();
    await fixture.app.close();
  });
  stream = await openStream(fixture.streamUrl('0'));
  await stream.until((frame) => frame.event === 'control' && frame.data.code === 'ready');
  fixture.start();
  await stream.until(
    (frame) => frame.event === 'product' && frame.data.event_type === 'input.updated',
  );
  const applied = reliable(stream.frames).at(-1)!.event_seq;
  await stream.close();
  stream = undefined;
  await tick();
  assert.equal(fixture.stops(), 0);
  assert.equal(fixture.runtime.getSnapshot(principal, fixture.id).focus_task!.status, 'running');
  fixture.finish();
  await tick();
  stream = await openStream(fixture.streamUrl(applied));
  const ready = await stream.until(
    (frame) => frame.event === 'control' && frame.data.code === 'ready',
  );
  assert.equal(ready.data.accepted_after_seq, applied);
  await stream.until(
    (frame) => frame.event === 'product' && frame.data.event_type === 'task.completed',
  );
  const replay = reliable(stream.frames);
  assert.ok(replay.length > 0);
  assert.equal(replay[0]!.event_seq, String(BigInt(applied) + 1n));
  assert.deepEqual(
    replay.map((frame) => frame.event_seq),
    replay.map((_, index) => String(BigInt(applied) + 1n + BigInt(index))),
  );
  assert.equal(fixture.starts(), 1);
  assert.equal(fixture.stops(), 0);
});

test('async persistent subscription callbacks cannot overtake ready and replay', async () => {
  const harness = await setup(true);
  const stream = await openStream(harness.streamUrl('0'));
  try {
    const first = await stream.next();
    assert.equal(first?.data.frame_kind, 'control');
    assert.equal(first?.data.code, 'ready');
    const second = await stream.next();
    assert.equal(second?.data.frame_kind, 'delta');
    assert.equal(harness.starts(), 0);
  } finally {
    await stream.close();
    await harness.app.close();
  }
});
