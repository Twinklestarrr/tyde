import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandRequest, ReadCursor, SnapshotData } from '@tyde/shared/agent';
import type { RawSseEvent } from '../src/agent-events';
import { AgentClient } from '../src/services/agent-client';
import { ChatController } from '../src/services/chat-controller';
import {
  conversationId,
  deferred,
  readError,
  requestId,
  response,
  runningTask,
  sample,
  secondConversationId,
  raw,
  snapshot,
  toolExecution,
} from './chat-fixtures';

const savedMessage = sample('message.updated').payload.message;
const savedTool = toolExecution('succeeded');

function savedSnapshot(): SnapshotData {
  const data = snapshot();
  data.messages = [structuredClone(savedMessage)];
  data.tool_executions = [structuredClone(savedTool)];
  data.page.upper_message_seq = savedMessage.message_seq;
  return data;
}

function commandApplied(command: CommandRequest): Response {
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
        outcome_code: 'TASK_CREATED',
        processed_at: '2026-10-22T08:00:00Z',
      },
      decision: {
        conversation_id: conversationId,
        task_id: runningTask().id,
        target_attempt_id: null,
        result_attempt_id: runningTask().latest_attempt.id,
        task_status_at_decision: 'running',
        task_version_at_decision: '1',
        result_attempt_outcome_at_decision: null,
        input_state_at_decision: 'pending',
        user_message_id: '60000000-0000-4000-8000-000000000001',
      },
      error: null,
    },
    { status: 202 },
  );
}

function clientWithSnapshots(
  read: (path: string) => Response | Promise<Response>,
  onCommand?: (command: CommandRequest) => Response,
  metadata: () => Response | Promise<Response> = () => Response.json({ storage_mode: 'postgres' }),
  list: () => Response | Promise<Response> = () =>
    response({ items: [], has_more: false, next_cursor: null }),
) {
  return new AgentClient('controlled-test-identity', async (url, init) => {
    const path = String(url);
    if (path === '/agent-api/api/agent/v1/runtime') return metadata();
    if (path.includes('/snapshot?')) return read(path);
    if (path.endsWith('/commands') && onCommand)
      return onCommand(JSON.parse(String(init?.body)) as CommandRequest);
    if (path.startsWith('/agent-api/api/agent/v1/conversations?')) return list();
    throw new Error(`Unexpected controlled request: ${path}`);
  });
}

function streams(client: AgentClient) {
  const calls: {
    cursor: ReadCursor;
    signal: AbortSignal;
    frame(frame: RawSseEvent): Promise<void>;
  }[] = [];
  client.events = async (_id, cursor, frame, signal) => {
    calls.push({ cursor, signal, frame });
    await frame({
      event: 'control',
      data: JSON.stringify({
        schema_version: 1,
        frame_kind: 'control',
        code: 'ready',
        stream_id: cursor.stream_id,
        accepted_after_seq: cursor.event_seq,
        observed_head_seq: cursor.event_seq,
        pruned_through_seq: '0',
      }),
    });
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  return calls;
}

async function connected(controller: ChatController) {
  assert.equal(await controller.refreshStorageMode(), true);
  await controller.select(conversationId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().connection, 'connected');
}

function assertSavedChat(controller: ChatController) {
  const view = controller.getSnapshot().view;
  assert.ok(view, 'a same-conversation read must retain the loaded chat');
  assert.deepEqual(view.messages.get(savedMessage.id), savedMessage);
  assert.deepEqual(view.toolExecutions.get(savedTool.id), savedTool);
}

test('same conversation retains reliable messages and tools while its replacement snapshot waits', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  let reads = 0;
  let commands = 0;
  const client = clientWithSnapshots(
    () => {
      if (++reads === 1) return response(savedSnapshot());
      waiting.resolve();
      return release.promise;
    },
    (command) => {
      commands += 1;
      return commandApplied(command);
    },
  );
  const subscriptions = streams(client);
  const controller = new ChatController(client);
  let refresh: Promise<void> | undefined;
  try {
    await connected(controller);
    refresh = controller.select(conversationId);
    await waiting.promise;
    assertSavedChat(controller);
    assert.equal(await controller.send('The retained view is display-only.'), false);
    assert.equal(commands, 0);
    assert.equal(subscriptions[0]!.signal.aborted, true);
    assert.equal(subscriptions.length, 1, 'no subscription starts before the complete snapshot');
    const replacement = savedSnapshot();
    replacement.read_cursor.event_seq = '12';
    release.resolve(response(replacement));
    await refresh;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertSavedChat(controller);
    assert.equal(subscriptions[1]?.cursor.event_seq, '12');
  } finally {
    release.resolve(response(savedSnapshot()));
    controller.dispose();
    await refresh;
  }
});

test('a retained running attempt cannot dispatch stop before the replacement snapshot is installed', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  const data = savedSnapshot();
  data.focus_task = runningTask();
  let reads = 0;
  let commands = 0;
  const client = clientWithSnapshots(
    () => {
      if (++reads === 1) return response(data);
      waiting.resolve();
      return release.promise;
    },
    (command) => {
      commands += 1;
      return commandApplied(command);
    },
  );
  streams(client);
  const controller = new ChatController(client);
  let refresh: Promise<void> | undefined;
  try {
    await connected(controller);
    refresh = controller.select(conversationId);
    await waiting.promise;
    assert.equal(
      controller.getSnapshot().view?.focusTask?.active_attempt_id,
      data.focus_task.active_attempt_id,
    );
    assert.equal(await controller.stop(), false);
    assert.equal(commands, 0);
    release.resolve(response(data));
    await refresh;
  } finally {
    release.resolve(response(data));
    controller.dispose();
    await refresh;
  }
});

test('an applied send never drops the current reliable chat while confirmation reloads its snapshot', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  let reads = 0;
  let commands = 0;
  const client = clientWithSnapshots(
    () => {
      if (++reads === 1) return response(savedSnapshot());
      waiting.resolve();
      return release.promise;
    },
    (command) => {
      commands += 1;
      return commandApplied(command);
    },
  );
  streams(client);
  const controller = new ChatController(client);
  let sending: Promise<boolean> | undefined;
  let unsubscribe = () => {};
  const emptyTransitions: string[] = [];
  try {
    await connected(controller);
    unsubscribe = controller.subscribe(() => {
      const state = controller.getSnapshot();
      if (state.selectedId === conversationId && !state.view)
        emptyTransitions.push(state.connection);
    });
    sending = controller.send('A new controlled question.');
    await waiting.promise;
    assertSavedChat(controller);
    assert.deepEqual(emptyTransitions, [], 'command confirmation must not flash an empty page');
    const replacement = savedSnapshot();
    replacement.focus_task = runningTask();
    release.resolve(response(replacement));
    assert.equal(await sending, true);
    assert.equal(controller.getSnapshot().view?.focusTask?.id, runningTask().id);
    assert.equal(commands, 1);
    assert.deepEqual(emptyTransitions, []);
  } finally {
    unsubscribe();
    release.resolve(response(savedSnapshot()));
    controller.dispose();
    await sending;
  }
});

test('switching to another conversation clears the previous private view while loading', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  const client = clientWithSnapshots((path) => {
    if (path.includes(secondConversationId)) {
      waiting.resolve();
      return release.promise;
    }
    return response(savedSnapshot());
  });
  streams(client);
  const controller = new ChatController(client);
  let switching: Promise<void> | undefined;
  try {
    await connected(controller);
    switching = controller.select(secondConversationId);
    await waiting.promise;
    const state = controller.getSnapshot();
    assert.equal(state.selectedId, secondConversationId);
    assert.equal(state.connection, 'loading');
    assert.equal(state.view, null, 'a real switch must not show the other conversation');
    release.resolve(response(snapshot(secondConversationId)));
    await switching;
    assert.equal(controller.getSnapshot().view?.conversation.id, secondConversationId);
    assert.equal(controller.getSnapshot().view?.messages.size, 0);
  } finally {
    release.resolve(response(snapshot(secondConversationId)));
    controller.dispose();
    await switching;
  }
});

test('a late same-conversation refresh and its old stream cannot overwrite a newer selection', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  let firstReads = 0;
  const client = clientWithSnapshots((path) => {
    if (path.includes(secondConversationId)) return response(snapshot(secondConversationId));
    if (++firstReads === 1) return response(savedSnapshot());
    waiting.resolve();
    return release.promise;
  });
  const subscriptions = streams(client);
  const controller = new ChatController(client);
  let refresh: Promise<void> | undefined;
  try {
    await connected(controller);
    refresh = controller.select(conversationId);
    await waiting.promise;
    await controller.select(secondConversationId);
    await subscriptions[0]!.frame(raw(sample('message.updated')));
    release.resolve(response(savedSnapshot()));
    await refresh;
    const view = controller.getSnapshot().view;
    assert.ok(view);
    assert.equal(view.conversation.id, secondConversationId);
    assert.equal(view.messages.size, 0);
    assert.equal(view.toolExecutions.size, 0);
    assert.equal(controller.getSnapshot().error, null);
  } finally {
    release.resolve(response(savedSnapshot()));
    controller.dispose();
    await refresh;
  }
});

test('a transient snapshot failure keeps reliable chat read-only and prevents command dispatch', async () => {
  let reads = 0;
  let commands = 0;
  const client = clientWithSnapshots(
    () => {
      if (++reads === 1) return response(savedSnapshot());
      throw new TypeError('Controlled snapshot transport unavailable.');
    },
    (command) => {
      commands += 1;
      return commandApplied(command);
    },
  );
  streams(client);
  const controller = new ChatController(client);
  try {
    await connected(controller);
    await controller.select(conversationId);
    assertSavedChat(controller);
    assert.equal(controller.getSnapshot().connection, 'blocked');
    assert.equal(await controller.send('Must not dispatch during a blocked refresh.'), false);
    assert.equal(commands, 0);
    assert.match(controller.getSnapshot().error ?? '', /snapshot transport unavailable/);
  } finally {
    controller.dispose();
  }
});

for (const failure of [
  { name: '401', reply: () => readError(401) },
  { name: '403', reply: () => readError(403) },
  { name: '404', reply: () => readError(404) },
  { name: 'invalid response', reply: () => Response.json({ not_a_snapshot: true }) },
]) {
  test(`a ${failure.name} snapshot response removes the retained private chat`, async () => {
    let reads = 0;
    const client = clientWithSnapshots(() =>
      ++reads === 1 ? response(savedSnapshot()) : failure.reply(),
    );
    const subscriptions = streams(client);
    const controller = new ChatController(client);
    try {
      await connected(controller);
      await controller.select(conversationId);
      assert.equal(controller.getSnapshot().view, null);
      assert.equal(controller.getSnapshot().connection, 'blocked');
      assert.equal(subscriptions[0]!.signal.aborted, true);
      assert.equal(controller.getSnapshot().pending, null);
    } finally {
      controller.dispose();
    }
  });
}

test('an applied send keeps its pending intent during metadata verification and rejects another send', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  let holdMetadata = false;
  let reads = 0;
  let commands = 0;
  const client = clientWithSnapshots(
    () => {
      const data = savedSnapshot();
      if (++reads > 1) data.focus_task = runningTask();
      return response(data);
    },
    (command) => {
      commands += 1;
      holdMetadata = true;
      return commandApplied(command);
    },
    () => {
      if (!holdMetadata) return Response.json({ storage_mode: 'postgres' });
      waiting.resolve();
      return release.promise;
    },
  );
  streams(client);
  const controller = new ChatController(client);
  let sending: Promise<boolean> | undefined;
  let duplicate: Promise<boolean> | undefined;
  try {
    await connected(controller);
    sending = controller.send('The original controlled intent.');
    await waiting.promise;
    assertSavedChat(controller);
    assert.equal(controller.getSnapshot().pending?.status, 'submitting');
    duplicate = controller.send('A second intent must remain blocked.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(commands, 1, 'metadata verification must not reopen command admission');
    holdMetadata = false;
    release.resolve(Response.json({ storage_mode: 'postgres' }));
    assert.equal(await sending, true);
    assert.equal(await duplicate, false);
    assert.equal(controller.getSnapshot().pending, null);
  } finally {
    holdMetadata = false;
    release.resolve(Response.json({ storage_mode: 'postgres' }));
    controller.dispose();
    await Promise.all([sending, duplicate]);
  }
});

test('reauthentication failure during metadata verification clears private chat and aborts its stream', async () => {
  let denyMetadata = false;
  const client = clientWithSnapshots(
    () => response(savedSnapshot()),
    undefined,
    () => (denyMetadata ? readError(401) : Response.json({ storage_mode: 'postgres' })),
  );
  const subscriptions = streams(client);
  const controller = new ChatController(client);
  try {
    await connected(controller);
    assertSavedChat(controller);
    assert.equal(controller.getSnapshot().conversations.length, 1);
    denyMetadata = true;
    await controller.select(conversationId);
    const state = controller.getSnapshot();
    assert.equal(state.view, null);
    assert.equal(state.pending, null);
    assert.equal(state.conversations.length, 0);
    assert.equal(state.connection, 'blocked');
    assert.equal(subscriptions[0]!.signal.aborted, true);
  } finally {
    controller.dispose();
  }
});

test('a late list response cannot restore private titles after metadata reauthentication fails', async () => {
  const waiting = deferred<void>();
  const release = deferred<Response>();
  let denyMetadata = false;
  const client = clientWithSnapshots(
    () => response(savedSnapshot()),
    undefined,
    () => (denyMetadata ? readError(401) : Response.json({ storage_mode: 'postgres' })),
    () => {
      waiting.resolve();
      return release.promise;
    },
  );
  streams(client);
  const controller = new ChatController(client);
  let readingList: Promise<void> | undefined;
  try {
    await connected(controller);
    readingList = controller.refreshList();
    await waiting.promise;
    assert.equal(controller.getSnapshot().listLoading, true);
    denyMetadata = true;
    await controller.select(conversationId);
    assert.equal(controller.getSnapshot().view, null);
    assert.equal(controller.getSnapshot().conversations.length, 0);
    assert.equal(controller.getSnapshot().listCursor, null);
    assert.equal(controller.getSnapshot().listLoading, false);
    const stale = savedSnapshot();
    release.resolve(
      response({
        items: [{ conversation: stale.conversation, read_cursor: stale.read_cursor }],
        has_more: false,
        next_cursor: null,
      }),
    );
    await readingList;
    assert.equal(controller.getSnapshot().view, null);
    assert.equal(controller.getSnapshot().conversations.length, 0);
    assert.equal(controller.getSnapshot().listLoading, false);
    assert.equal(controller.getSnapshot().connection, 'blocked');
  } finally {
    release.resolve(response({ items: [], has_more: false, next_cursor: null }));
    controller.dispose();
    await readingList;
  }
});
