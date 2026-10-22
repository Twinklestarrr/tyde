import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandRequest, ReadCursor } from '@tyde/shared/agent';
import type { RawSseEvent } from '../src/agent-events';
import { AgentClient } from '../src/services/agent-client';
import { ChatController } from '../src/services/chat-controller';
import {
  conversationId,
  deferred,
  raw,
  readError,
  requestId,
  response,
  runningTask,
  sample,
  secondConversationId,
  snapshot,
} from './chat-fixtures';

type Subscription = {
  id: string;
  cursor: ReadCursor;
  frame(frame: RawSseEvent): Promise<void>;
  fail(error: Error): void;
  signal: AbortSignal;
};
function subscriptions(client: AgentClient): Subscription[] {
  const calls: Subscription[] = [];
  client.events = (id, cursor, frame, signal) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ id, cursor, frame, signal, fail: reject });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return calls;
}
function applied(command: CommandRequest) {
  return Response.json(
    {
      schema_version: 1,
      request_id: requestId,
      replayed: false,
      command: {
        id: requestId,
        request_key: command.request_key,
        kind: command.kind,
        status: 'applied',
        outcome_code: command.kind === 'stop_attempt' ? 'STOP_REQUESTED' : 'TASK_CREATED',
        processed_at: '2026-10-22T08:00:00Z',
      },
      decision: {
        conversation_id: conversationId,
        task_id: runningTask().id,
        target_attempt_id: command.kind === 'stop_attempt' ? command.target_attempt_id : null,
        result_attempt_id: runningTask().latest_attempt.id,
        task_status_at_decision: 'running',
        task_version_at_decision: '1',
        result_attempt_outcome_at_decision: null,
        input_state_at_decision: command.kind === 'stop_attempt' ? 'none' : 'pending',
        user_message_id:
          command.kind === 'stop_attempt' ? null : '60000000-0000-4000-8000-000000000001',
      },
      error: null,
    },
    { status: 202 },
  );
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('old snapshot and subscription callbacks cannot overwrite a switched conversation', async () => {
  const first = deferred<Response>();
  let firstRead = true;
  const client = new AgentClient('credential', async (url) => {
    if (!String(url).includes(conversationId)) return response(snapshot(secondConversationId));
    if (firstRead) {
      firstRead = false;
      return first.promise;
    }
    return response(snapshot());
  });
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  const stale = controller.select(conversationId);
  await controller.select(secondConversationId);
  first.resolve(response(snapshot()));
  await stale;
  assert.equal(controller.getSnapshot().view?.conversation.id, secondConversationId);
  assert.equal(calls.length, 1);
  await controller.select(conversationId);
  const oldStream = calls[1]!;
  await controller.select(secondConversationId);
  await oldStream.frame(raw(sample('message.created')));
  oldStream.fail(new Error('旧连接报错'));
  await tick();
  assert.equal(controller.getSnapshot().view?.conversation.id, secondConversationId);
  assert.equal(controller.getSnapshot().view?.messages.size, 0);
  assert.equal(controller.getSnapshot().error, null);
  controller.dispose();
});

test('snapshot H is installed before subscription; duplicate reliable events do not repeat messages', async () => {
  const client = new AgentClient('credential', async () => response(snapshot()));
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  assert.equal(calls[0]?.cursor.event_seq, '10');
  assert.equal(controller.getSnapshot().view?.messages.size, 0);
  const frame = sample('message.created');
  frame.event_seq = '11';
  await calls[0]!.frame(raw(frame));
  await calls[0]!.frame(raw(frame));
  assert.equal(controller.getSnapshot().view?.messages.size, 1);
  controller.dispose();
});

test('a reliable title update reaches the sidebar and survives a late list response', async () => {
  const baseline = snapshot();
  baseline.conversation.title = '新会话';
  baseline.conversation.row_version = '1';
  const lateList = deferred<Response>();
  const client = new AgentClient('credential', async (url) =>
    String(url).includes('/snapshot') ? response(baseline) : lateList.promise,
  );
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  const readingList = controller.refreshList();
  const frame = sample('conversation.updated');
  frame.event_seq = '11';
  frame.payload.conversation.title = '第一条消息作为标题';
  frame.payload.conversation.row_version = '2';
  await calls[0]!.frame(raw(frame));
  assert.equal(controller.getSnapshot().view?.conversation.title, '第一条消息作为标题');
  assert.equal(controller.getSnapshot().conversations[0]?.conversation.title, '第一条消息作为标题');
  lateList.resolve(
    response({
      items: [{ conversation: baseline.conversation, read_cursor: baseline.read_cursor }],
      has_more: false,
      next_cursor: null,
    }),
  );
  await readingList;
  const item = controller.getSnapshot().conversations[0]!;
  assert.equal(item.conversation.title, '第一条消息作为标题');
  assert.equal(item.conversation.row_version, '2');
  assert.equal(item.read_cursor.event_seq, '11');
  client.list = async () => ({
    schema_version: 1,
    request_id: requestId,
    data: { items: [], has_more: false, next_cursor: null },
    error: null,
  });
  await controller.refreshList();
  assert.equal(controller.getSnapshot().conversations[0]?.conversation.title, '第一条消息作为标题');
  controller.dispose();
});

test('event gap rebuilds the snapshot without posting commands', async () => {
  let reads = 0;
  const client = new AgentClient('credential', async (_url, init) => {
    assert.equal(init?.method, 'GET');
    reads += 1;
    return response(snapshot(conversationId, reads === 1 ? '10' : '12'));
  });
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  const frame = sample('message.created');
  frame.event_seq = '12';
  await calls[0]!.frame(raw(frame)).catch(() => undefined);
  // A real reader rejects its events() promise when the awaited callback fails.
  calls[0]!.fail(new (await import('../src/agent-events')).AgentEventError('EVENT_GAP', '缺号'));
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(reads, 2);
  assert.equal(calls[1]?.cursor.event_seq, '12');
  controller.dispose();
});

test('network reconnect resumes only after the last applied reliable cursor', async () => {
  let gets = 0;
  const client = new AgentClient('credential', async (_url, init) => {
    assert.equal(init?.method, 'GET');
    gets += 1;
    return response(snapshot());
  });
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  const frame = sample('message.created');
  frame.event_seq = '11';
  await calls[0]!.frame(raw(frame));
  calls[0]!.fail(new Error('断网'));
  await new Promise((resolve) => setTimeout(resolve, 530));
  assert.equal(calls[1]?.cursor.event_seq, '11');
  assert.equal(gets, 1);
  assert.equal(controller.getSnapshot().view?.messages.size, 1);
  controller.dispose();
});

test('a lost command response is verified; resend freezes key and original text', async () => {
  const commands: CommandRequest[] = [];
  let lookups = 0;
  const client = new AgentClient('credential', async (url, init) => {
    if (String(url).endsWith('/commands')) {
      const command = JSON.parse(String(init?.body)) as CommandRequest;
      commands.push(command);
      if (commands.length === 1) throw new TypeError('响应丢失');
      return applied(command);
    }
    if (String(url).includes('/commands/by-key/')) {
      lookups += 1;
      return readError();
    }
    if (String(url).includes('/snapshot')) return response(snapshot());
    return response({ items: [], has_more: false, next_cursor: null });
  });
  subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  assert.equal(await controller.send('  原始需求 🐚  '), false);
  assert.equal(lookups, 1);
  assert.equal(controller.getSnapshot().pending?.status, 'unknown');
  assert.equal(await controller.send('另一种意图'), false);
  assert.equal(await controller.resendPending(), true);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(controller.getSnapshot().pending, null);
  controller.dispose();
});

test('concurrent send clicks share one pending intent rather than dispatch twice', async () => {
  const commandReply = deferred<Response>();
  let posts = 0;
  const client = new AgentClient('credential', async (url, init) => {
    if (String(url).endsWith('/commands')) {
      posts += 1;
      const command = JSON.parse(String(init?.body)) as CommandRequest;
      void commandReply.promise.then(() => undefined);
      await commandReply.promise;
      return applied(command);
    }
    return String(url).includes('/snapshot')
      ? response(snapshot())
      : response({ items: [], has_more: false, next_cursor: null });
  });
  subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  const first = controller.send('第一次');
  assert.equal(await controller.send('重复点击'), false);
  commandReply.resolve(new Response());
  assert.equal(await first, true);
  assert.equal(posts, 1);
  controller.dispose();
});

test('lost create response never automatically repeats the non-idempotent POST', async () => {
  let creates = 0;
  const client = new AgentClient('credential', async (_url, init) => {
    if (init?.method === 'POST') {
      creates += 1;
      throw new TypeError('创建回包丢失');
    }
    return response({ items: [], has_more: false, next_cursor: null });
  });
  const controller = new ChatController(client);
  await controller.create();
  assert.equal(creates, 1);
  assert.match(controller.getSnapshot().error ?? '', /不会自动重发/);
  controller.dispose();
});

test('stop is accepted separately from actual stopped; stopped goals cannot start another task', async () => {
  const data = snapshot();
  data.focus_task = runningTask();
  const client = new AgentClient('credential', async (url, init) => {
    if (String(url).endsWith('/commands')) {
      const command = JSON.parse(String(init?.body)) as CommandRequest;
      data.focus_task = {
        ...data.focus_task!,
        status: 'stopping',
        row_version: '8',
        latest_attempt: {
          ...data.focus_task!.latest_attempt,
          stop_requested_at: '2026-10-22T08:00:00Z',
        },
      };
      return applied(command);
    }
    return String(url).includes('/snapshot')
      ? response(data)
      : response({ items: [], has_more: false, next_cursor: null });
  });
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  assert.equal(await controller.stop(), true);
  assert.equal(controller.getSnapshot().view?.focusTask?.status, 'stopping');
  const ended = sample('task.updated');
  ended.event_seq = '11';
  ended.payload.task = {
    ...data.focus_task!,
    status: 'stopped',
    row_version: '9',
    active_attempt_id: null,
    latest_attempt: {
      ...data.focus_task!.latest_attempt,
      outcome: 'stopped',
      ended_at: '2026-10-22T08:00:01Z',
    },
  };
  await calls.at(-1)!.frame(raw(ended));
  assert.equal(controller.getSnapshot().view?.focusTask?.status, 'stopped');
  assert.equal(await controller.send('绕过旧目标'), false);
  controller.dispose();
});

test('refresh and disconnect only read state; disposing does not issue stop', async () => {
  const methods: string[] = [];
  const client = new AgentClient('credential', async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return response(snapshot());
  });
  subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  await controller.select(conversationId);
  controller.dispose();
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('local input validation never creates an unknown command or network write', async () => {
  let requests = 0;
  const client = new AgentClient('credential', async () => {
    requests += 1;
    return response(snapshot());
  });
  subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  assert.equal(await controller.send('  \n '), false);
  assert.equal(await controller.send('🐚'.repeat(16001)), false);
  assert.equal(requests, 1);
  assert.equal(controller.getSnapshot().pending, null);
  assert.match(controller.getSnapshot().error ?? '', /16000/);
  controller.dispose();
});

test('reauthenticate control clears the current private view and pauses instead of retrying', async () => {
  const client = new AgentClient('credential', async () => response(snapshot()));
  const calls = subscriptions(client);
  const controller = new ChatController(client);
  await controller.select(conversationId);
  const frame = {
    event: 'control',
    data: JSON.stringify({ schema_version: 1, frame_kind: 'control', code: 'reauthenticate' }),
  };
  await assert.rejects(calls[0]!.frame(frame), /身份已失效/);
  calls[0]!.fail(
    new (await import('../src/services/agent-client')).AgentApiError(
      '身份已失效',
      401,
      'UNAUTHENTICATED',
    ),
  );
  await tick();
  assert.equal(controller.getSnapshot().view, null);
  assert.equal(controller.getSnapshot().connection, 'blocked');
  assert.equal(calls.length, 1);
  controller.dispose();
});
