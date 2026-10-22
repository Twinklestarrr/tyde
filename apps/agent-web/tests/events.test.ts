import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  validateAgentContract,
  type ControlFrame,
  type EphemeralFrame,
  type ProductFrame,
} from '@tyde/shared/agent';
import {
  AgentEventCursor,
  AgentEventError,
  decodeAgentEvent,
  SseParser,
  type EventBaseline,
  type RawSseEvent,
} from '../src/agent-events';

interface EventSamples {
  baseline: EventBaseline;
  product: ProductFrame[];
  control: ControlFrame[];
  delta: EphemeralFrame[];
}

const samples = JSON.parse(
  readFileSync(new URL('../fixtures/events-v1.json', import.meta.url), 'utf8'),
) as EventSamples;
const encoder = new TextEncoder();

function raw(frame: ProductFrame | ControlFrame | EphemeralFrame): RawSseEvent {
  const result: RawSseEvent = { event: frame.frame_kind, data: JSON.stringify(frame) };
  if (frame.frame_kind === 'product') result.id = `${frame.stream_id}:${frame.event_seq}`;
  return result;
}

function product(index = 0, sequence?: string): ProductFrame {
  const frame = structuredClone(samples.product[index]);
  assert.ok(frame);
  if (sequence !== undefined) frame.event_seq = sequence;
  return frame;
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentEventError && error.code === code;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('test fixtures cover all seven public product events and every control variant', () => {
  assert.deepEqual(
    new Set(samples.product.map((frame) => frame.event_type)),
    new Set([
      'conversation.updated',
      'task.updated',
      'task.completed',
      'message.created',
      'message.updated',
      'input.updated',
      'operation.updated',
    ]),
  );
  assert.deepEqual(
    new Set(samples.control.map((frame) => frame.code)),
    new Set(['ready', 'resync_required', 'reauthenticate', 'server_retry', 'slow_consumer']),
  );
  for (const frame of samples.product) {
    assert.equal(validateAgentContract('ProductFrame', frame), true);
    assert.deepEqual(decodeAgentEvent(raw(frame)), frame);
  }
  for (const frame of samples.control) {
    assert.equal(validateAgentContract('ControlFrame', frame), true);
    assert.deepEqual(decodeAgentEvent(raw(frame)), frame);
  }
  for (const frame of samples.delta) {
    assert.equal(validateAgentContract('EphemeralFrame', frame), true);
    assert.deepEqual(decodeAgentEvent(raw(frame)), frame);
  }
});

test('UTF-8, BOM, CR/LF and multiline data work across every byte boundary', () => {
  const delta = samples.delta[0];
  assert.ok(delta);
  const json = JSON.stringify(delta);
  const split = json.indexOf(',') + 1;
  const source = `\uFEFF: 心跳\r\nevent: delta\rdata: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n`;
  const parser = new SseParser();
  const events: RawSseEvent[] = [];
  for (const byte of encoder.encode(source)) events.push(...parser.feed(Uint8Array.of(byte)));
  events.push(...parser.finish());
  assert.equal(events.length, 1);
  assert.deepEqual(decodeAgentEvent(events[0]!), delta);
  assert.ok(events[0]!.data.includes('\n'));
});

test('SSE fixture can be decoded one byte at a time without inherited ids', () => {
  const bytes = readFileSync(new URL('../fixtures/events-v1.sse', import.meta.url));
  const parser = new SseParser();
  const events: RawSseEvent[] = [];
  for (const byte of bytes) events.push(...parser.feed(Uint8Array.of(byte)));
  events.push(...parser.finish());
  assert.equal(events.length, 9);
  assert.equal(events.at(-1)?.event, 'delta');
  assert.equal(events.at(-1)?.id, undefined);
  for (const event of events) decodeAgentEvent(event);
});

test('comments and id-only blocks do not create frames or leak an id to later data', () => {
  const parser = new SseParser();
  const events = parser.feed(
    encoder.encode(
      ': heartbeat\nid: old\n\nevent: control\ndata: {}\n\ndata:\n\nid: ignored\0\ndata: body\n\n',
    ),
  );
  assert.deepEqual(events, [
    { event: 'control', data: '{}' },
    { event: 'message', data: '' },
    { event: 'message', data: 'body' },
  ]);
});

test('EOF does not dispatch a partial event and oversized frames stop parsing', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed(encoder.encode('event: product\ndata: {"partial":true}\n')), []);
  assert.deepEqual(parser.finish(), []);
  assert.throws(() => parser.feed(encoder.encode('\n')), /已经关闭/);
  const bounded = new SseParser(10);
  assert.throws(() => bounded.feed(encoder.encode('data: too long')), /缓冲上限/);
  assert.throws(() => bounded.feed(encoder.encode('\n\n')), /已经关闭/);
});

test('SSE envelope, schema version and reliable event identity must agree', () => {
  const valid = raw(product());
  assert.throws(() => decodeAgentEvent({ ...valid, id: undefined }), errorCode('INVALID_FRAME'));
  assert.throws(
    () => decodeAgentEvent({ ...valid, id: `${samples.baseline.streamId}:12` }),
    errorCode('INVALID_FRAME'),
  );
  assert.throws(() => decodeAgentEvent({ ...valid, event: 'delta' }), errorCode('INVALID_FRAME'));
  assert.throws(() => decodeAgentEvent({ ...valid, data: '{' }), errorCode('INVALID_FRAME'));
  assert.throws(
    () => decodeAgentEvent({ ...valid, event: 'unrecognized' }),
    errorCode('UNSUPPORTED_EVENT'),
  );
  for (const replacement of [
    { schema_version: 2 },
    { event_type: 'internal.pi.updated' },
    { owner_user_id: 'not-public' },
    { event_seq: '011' },
    { event_seq: 11 },
  ]) {
    assert.throws(
      () => decodeAgentEvent({ ...valid, data: JSON.stringify({ ...product(), ...replacement }) }),
      errorCode('INVALID_FRAME'),
    );
  }
  for (const frame of [...samples.control, ...samples.delta]) {
    assert.throws(
      () => decodeAgentEvent({ ...raw(frame), id: valid.id }),
      errorCode('INVALID_FRAME'),
    );
  }
});

test('cross-conversation objects and inconsistent completion groups are rejected', () => {
  const foreign = product();
  assert.equal(foreign.event_type, 'message.created');
  if (foreign.event_type === 'message.created') {
    foreign.payload.message.conversation_id = '10000000-0000-4000-8000-000000000099';
  }
  assert.throws(() => decodeAgentEvent(raw(foreign)), errorCode('INVALID_FRAME'));
  const completion = product(5);
  assert.equal(completion.event_type, 'task.completed');
  if (completion.event_type === 'task.completed') {
    completion.payload.message.result_id = '90000000-0000-4000-8000-000000000099';
  }
  assert.throws(() => decodeAgentEvent(raw(completion)), errorCode('INVALID_FRAME'));
});

test('only ordered application advances the reliable cursor; replays do not reapply', async () => {
  const cursor = new AgentEventCursor(samples.baseline);
  const applied: string[] = [];
  const handlers = {
    applyProduct: (frame: ProductFrame) => {
      applied.push(frame.event_seq);
    },
  };
  for (const frame of samples.product) {
    assert.equal(await cursor.apply(raw(frame), cursor.generation, handlers), 'applied');
  }
  assert.equal(cursor.lastApplied.eventSeq, '17');
  assert.equal(await cursor.apply(raw(product(0)), cursor.generation, handlers), 'duplicate');
  assert.deepEqual(applied, ['11', '12', '13', '14', '15', '16', '17']);
});

test('bigint cursor comparisons are exact beyond Number precision and across digit lengths', async () => {
  for (const [previous, next] of [
    ['9', '10'],
    ['9007199254740992', '9007199254740993'],
  ]) {
    assert.ok(previous && next);
    const cursor = new AgentEventCursor({ ...samples.baseline, eventSeq: previous });
    assert.equal(
      await cursor.apply(raw(product(0, next)), cursor.generation, {
        applyProduct: () => undefined,
      }),
      'applied',
    );
    assert.equal(cursor.lastApplied.eventSeq, next);
  }
});

test('asynchronous applications remain serial and do not acknowledge receipt early', async () => {
  const cursor = new AgentEventCursor(samples.baseline);
  const started = deferred();
  const release = deferred();
  const applied: string[] = [];
  const handlers = {
    applyProduct: async (frame: ProductFrame) => {
      applied.push(frame.event_seq);
      if (frame.event_seq === '11') {
        started.resolve();
        await release.promise;
      }
    },
  };
  const first = cursor.apply(raw(product(0)), cursor.generation, handlers);
  const second = cursor.apply(raw(product(1)), cursor.generation, handlers);
  await started.promise;
  assert.equal(cursor.lastApplied.eventSeq, '10');
  assert.deepEqual(applied, ['11']);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['applied', 'applied']);
  assert.equal(cursor.lastApplied.eventSeq, '12');
});

test('failed application preserves the cursor and prevents later frames being skipped', async () => {
  const cursor = new AgentEventCursor(samples.baseline);
  const handlers = {
    applyProduct: () => {
      throw new Error('cache update failed');
    },
  };
  await assert.rejects(
    cursor.apply(raw(product()), cursor.generation, handlers),
    errorCode('APPLICATION_FAILED'),
  );
  assert.equal(cursor.lastApplied.eventSeq, '10');
  await assert.rejects(
    cursor.apply(raw(product(1)), cursor.generation, handlers),
    errorCode('BASELINE_REQUIRED'),
  );
});

test('sequence gaps and changed streams block the baseline without jumping to head', async () => {
  for (const replacement of [
    { event_seq: '12' },
    { stream_id: 'a0000000-0000-4000-8000-000000000099' },
  ]) {
    const cursor = new AgentEventCursor(samples.baseline);
    const frame = { ...product(), ...replacement } as ProductFrame;
    const handlers = {
      applyProduct: () => {
        assert.fail('must not apply');
      },
    };
    await assert.rejects(
      cursor.apply(raw(frame), cursor.generation, handlers),
      errorCode('stream_id' in replacement ? 'STREAM_CHANGED' : 'EVENT_GAP'),
    );
    assert.equal(cursor.lastApplied.eventSeq, '10');
    await assert.rejects(
      cursor.apply(raw(product()), cursor.generation, handlers),
      errorCode('BASELINE_REQUIRED'),
    );
  }
});

test('control and delta callbacks never acknowledge the observed head or a transient fragment', async () => {
  for (const frame of [...samples.control, ...samples.delta]) {
    const cursor = new AgentEventCursor(samples.baseline);
    let notifications = 0;
    const result = await cursor.apply(raw(frame), cursor.generation, {
      applyProduct: () => {
        assert.fail('not a reliable product');
      },
      onControl: () => {
        notifications += 1;
      },
      onDelta: () => {
        notifications += 1;
      },
    });
    assert.equal(result, frame.frame_kind);
    assert.equal(notifications, 1);
    assert.equal(cursor.lastApplied.eventSeq, '10');
  }
});

test('resync_required blocks further application until a new complete snapshot baseline', async () => {
  const reset = samples.control.find((frame) => frame.code === 'resync_required');
  assert.ok(reset);
  const cursor = new AgentEventCursor(samples.baseline);
  const handlers = { applyProduct: () => undefined };
  assert.equal(await cursor.apply(raw(reset), cursor.generation, handlers), 'control');
  await assert.rejects(
    cursor.apply(raw(product()), cursor.generation, handlers),
    errorCode('BASELINE_REQUIRED'),
  );
  cursor.reset(samples.baseline);
  assert.equal(await cursor.apply(raw(product()), cursor.generation, handlers), 'applied');
});

test('stale generations are ignored before JSON parsing and cannot advance a new baseline', async () => {
  const cursor = new AgentEventCursor(samples.baseline);
  const oldGeneration = cursor.generation;
  const started = deferred();
  const release = deferred();
  const pending = cursor.apply(raw(product()), oldGeneration, {
    applyProduct: async (_frame, context) => {
      started.resolve();
      await release.promise;
      assert.equal(context.isCurrent(), false);
    },
  });
  await started.promise;
  cursor.reset({ ...samples.baseline, eventSeq: '100' });
  release.resolve();
  assert.equal(await pending, 'stale');
  assert.equal(
    await cursor.apply({ event: 'unknown', data: '{' }, oldGeneration, {
      applyProduct: () => undefined,
    }),
    'stale',
  );
  assert.equal(cursor.lastApplied.eventSeq, '100');
});

test('unknown reliable events block application instead of being silently ignored', async () => {
  const cursor = new AgentEventCursor(samples.baseline);
  const unknown = { ...product(), event_type: 'future.product.updated' };
  await assert.rejects(
    cursor.apply({ ...raw(product()), data: JSON.stringify(unknown) }, cursor.generation, {
      applyProduct: () => assert.fail('unknown event'),
    }),
    errorCode('INVALID_FRAME'),
  );
  assert.equal(cursor.lastApplied.eventSeq, '10');
});
