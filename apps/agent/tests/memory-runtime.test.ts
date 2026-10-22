import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  validateAgentContract,
  type CommandRequest,
  type ResponseEnvelope,
} from '@tyde/shared/agent';
import {
  AgentMemoryRuntime,
  type RuntimeFrame,
  type RuntimeSession,
} from '../src/runtime/memory-runtime.js';
import type { AgentPrincipal } from '../src/auth/access.js';
import type { AttemptBudgetClock } from '../src/execution/attempt-budget.js';
import type { PiMemoryBarriers, PiPromptResult } from '../src/pi/session.js';
import { createPiDirectModelSession } from '../src/pi/session.js';
import { readDirectModelConfig } from '../src/maas/direct-model.js';

const principal: AgentPrincipal = { userId: 'runtime-owner', source: 'development' };
const stranger: AgentPrincipal = { userId: 'runtime-other', source: 'platform' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const prompt = (text = '自由输入的问题'): CommandRequest => ({
  schema_version: 1,
  kind: 'start_task',
  request_key: randomUUID(),
  task_kind: 'business_query',
  input: { text },
});
function stopCommand(body: ResponseEnvelope): CommandRequest {
  assert.ok(body.decision?.task_id);
  assert.ok(body.decision.result_attempt_id);
  return {
    schema_version: 1,
    kind: 'stop_attempt',
    request_key: randomUUID(),
    task_id: body.decision.task_id,
    target_attempt_id: body.decision.result_attempt_id,
  };
}

class ControlledSession implements RuntimeSession {
  prompts: string[] = [];
  callbacks: ((text: string) => void)[] = [];
  pending?: (result: PiPromptResult) => void;
  stops = 0;
  disposed = false;
  settleOnStop = true;
  constructor(readonly barriers: PiMemoryBarriers) {}
  async prompt(text: string, onText?: (text: string) => void): Promise<PiPromptResult> {
    this.prompts.push(text);
    if (onText) this.callbacks.push(onText);
    await this.barriers.beforeModel?.({ header: null, entries: [], leafId: null });
    await this.barriers.beforeModelDispatch?.();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
  reply(text: string, status: PiPromptResult['status'] = 'completed') {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({
      status,
      text,
      error: status === 'failed' ? { code: 'ISOLATED_FAILURE' } : null,
      observations: [],
    });
  }
  async stop() {
    this.stops += 1;
    if (this.settleOnStop) this.reply('', 'stopped');
  }
  dispose() {
    this.disposed = true;
  }
}

function harness(options: { eventLimit?: number; clock?: AttemptBudgetClock } = {}) {
  const sessions = new Map<string, ControlledSession>();
  const runtime = new AgentMemoryRuntime({
    budgetClock: options.clock,
    maxEventsPerConversation: options.eventLimit,
    createSession: async (conversationId, barriers) => {
      const session = new ControlledSession(barriers);
      sessions.set(conversationId, session);
      return session;
    },
  });
  const conversation = runtime.createConversation(principal, { schema_version: 1 });
  return { runtime, sessions, id: conversation.conversation.id, conversation };
}

test('空会话不分配 Pi、查询不执行、标题及归属均按契约校验', async () => {
  const { runtime, sessions, id, conversation } = harness();
  try {
    assert.equal(validateAgentContract('CreateConversationData', conversation), true);
    assert.equal(sessions.size, 0);
    assert.equal(runtime.getSnapshot(principal, id).read_cursor.event_seq, '0');
    assert.deepEqual(runtime.getSnapshot(principal, id).messages, []);
    assert.equal(runtime.getConversation(principal, id).focus_task, null);
    assert.equal(runtime.listConversations(stranger).items.length, 0);
    assert.throws(() => runtime.getSnapshot(stranger, id), { statusCode: 404 });
    assert.throws(() => runtime.createConversation(principal, { schema_version: 1, title: ' ' }), {
      statusCode: 422,
    });
    assert.equal(sessions.size, 0);
  } finally {
    await runtime.close();
  }
});

test('并发同 key 只创建一次，冻结裁决重放不受后来完成影响，同 key 异意图拒绝', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const request = prompt();
    const responses = await Promise.all(
      Array.from({ length: 10 }, async () => runtime.submitCommand(principal, id, request)),
    );
    assert.equal(responses.filter((entry) => !entry.body.replayed).length, 1);
    assert.ok(responses.every((entry) => entry.statusCode === 202));
    assert.equal(new Set(responses.map((entry) => entry.body.command?.id)).size, 1);
    await tick();
    assert.equal(sessions.get(id)!.prompts.length, 1);
    sessions.get(id)!.reply('真实隔离回答');
    await tick();
    const replay = runtime.submitCommand(principal, id, request);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.body.decision, responses[0]!.body.decision);
    const conflict = runtime.submitCommand(principal, id, {
      ...request,
      input: { text: '改变正文' },
    });
    assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(conflict.body.command, null);
    assert.equal(runtime.getSnapshot(principal, id).messages.length, 2);
    assert.equal(validateAgentContract('ResponseEnvelope', replay.body), true);
  } finally {
    await runtime.close();
  }
});

test('不同 key 同一会话执行互斥；拒绝裁决保存并可核实，跨用户 key 不串用', async () => {
  const { runtime, id } = harness();
  try {
    const request = prompt();
    runtime.submitCommand(principal, id, request);
    const blocked = prompt('新问题不得插队');
    const rejection = runtime.submitCommand(principal, id, blocked);
    assert.equal(rejection.statusCode, 409);
    assert.equal(rejection.body.error?.code, 'UNFINISHED_TASK_EXISTS');
    assert.equal(rejection.body.decision?.task_id, null);
    assert.equal(rejection.body.decision?.task_status_at_decision, null);
    assert.equal(rejection.body.decision?.task_version_at_decision, null);
    assert.equal(
      runtime.getCommand(principal, id, blocked.request_key).receipt.command.status,
      'rejected',
    );
    assert.equal(runtime.submitCommand(principal, id, blocked).body.replayed, true);
    assert.throws(() => runtime.getCommand(stranger, id, request.request_key), { statusCode: 404 });
    const other = runtime.createConversation(stranger, { schema_version: 1 }).conversation.id;
    assert.equal(runtime.submitCommand(stranger, other, request).statusCode, 202);
    assert.equal(
      validateAgentContract(
        'CommandLookupData',
        runtime.getCommand(principal, id, blocked.request_key),
      ),
      true,
    );
  } finally {
    await runtime.close();
  }
});

test('同用户跨会话 key 冲突，跨路径 Task 与结果读取统一 404', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const second = runtime.createConversation(principal, { schema_version: 1 }).conversation.id;
    const request = prompt();
    const first = runtime.submitCommand(principal, id, request);
    assert.equal(
      runtime.submitCommand(principal, second, request).body.error?.code,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    assert.throws(() => runtime.getCommand(principal, second, request.request_key), {
      statusCode: 404,
    });
    assert.throws(() => runtime.submitCommand(principal, second, stopCommand(first.body)), {
      statusCode: 404,
    });
    await tick();
    sessions.get(id)!.reply('完成');
    await tick();
    const result = runtime.getSnapshot(principal, id).results[0]!;
    assert.throws(() => runtime.getResult(principal, second, result.id), { statusCode: 404 });
  } finally {
    await runtime.close();
  }
});

test('完成后追问创建后续 Task，复用固定 Pi；多会话原生上下文独立', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const first = runtime.submitCommand(principal, id, prompt('记住第一轮'));
    await tick();
    const session = sessions.get(id)!;
    session.reply('已记住');
    await tick();
    const second = runtime.submitCommand(principal, id, prompt('继续追问'));
    await tick();
    assert.notEqual(first.body.decision!.task_id, second.body.decision!.task_id);
    assert.equal(sessions.get(id), session);
    assert.deepEqual(session.prompts, ['记住第一轮', '继续追问']);
    const otherId = runtime.createConversation(principal, { schema_version: 1 }).conversation.id;
    runtime.submitCommand(principal, otherId, prompt('另一会话'));
    await tick();
    assert.notEqual(sessions.get(otherId), session);
    assert.deepEqual(sessions.get(otherId)!.prompts, ['另一会话']);
    session.reply('已完成第二轮');
    await tick();
    const snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.latest_attempt.budget!.model_requests_used, 1);
    assert.equal(snapshot.results.length, 2);
    assert.equal(validateAgentContract('SnapshotData', snapshot), true);
  } finally {
    await runtime.close();
  }
});

test('先应用快照 H 再订阅不漏竞争事件；冻结回放连续且 delta 不进入可靠日志', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const snapshot = runtime.getSnapshot(principal, id);
    runtime.submitCommand(principal, id, prompt());
    const live: RuntimeFrame[] = [];
    const subscription = runtime.subscribe(principal, id, {
      streamId: snapshot.read_cursor.stream_id,
      afterEventSeq: snapshot.read_cursor.event_seq,
      onFrame: (frame) => live.push(frame),
    });
    assert.equal(subscription.replay.length, 3);
    assert.equal(subscription.replay[0]!.event_seq, '1');
    const frozenFirstTask = subscription.replay.find(
      (frame) => frame.event_type === 'task.updated',
    )!;
    await tick();
    sessions.get(id)!.callbacks[0]!('流式文字');
    sessions.get(id)!.reply('流式文字完成');
    await tick();
    assert.equal(frozenFirstTask.event_type, 'task.updated');
    if (frozenFirstTask.event_type === 'task.updated')
      assert.equal(frozenFirstTask.payload.task.status, 'queued');
    assert.ok(live.some((frame) => frame.frame_kind === 'delta'));
    const reliable = [
      ...subscription.replay,
      ...live.filter((frame) => frame.frame_kind === 'product'),
    ];
    for (const [index, frame] of reliable.entries()) {
      assert.equal(frame.event_seq, String(index + 1));
      assert.equal(validateAgentContract('ProductFrame', frame), true, JSON.stringify(frame));
    }
    const all = runtime.subscribe(principal, id, {
      streamId: snapshot.read_cursor.stream_id,
      afterEventSeq: '0',
      onFrame() {},
    });
    assert.equal(all.replay.length, reliable.length);
    assert.equal(
      all.replay.some((frame) => frame.frame_kind !== 'product'),
      false,
    );
    all.close();
    subscription.close();
    assert.equal(sessions.get(id)!.stops, 0);
  } finally {
    await runtime.close();
  }
});

test('临时流完整结果收敛为单条结果消息，刷新和重新订阅不增加模型执行', async () => {
  const { runtime, sessions, id, conversation } = harness();
  try {
    const request = prompt();
    runtime.submitCommand(principal, id, request);
    await tick();
    const session = sessions.get(id)!;
    session.callbacks[0]!('临时');
    session.callbacks[0]!('正文');
    session.reply('完整正文');
    await tick();
    const snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.messages.length, 2);
    assert.deepEqual(snapshot.messages[1]!.content.blocks, []);
    assert.equal(snapshot.messages[1]!.result_id, snapshot.results[0]!.id);
    const lookup = runtime.getCommand(principal, id, request.request_key);
    assert.equal(lookup.input_receipt?.input_state, 'consumed');
    assert.equal(lookup.receipt.decision.input_state_at_decision, 'pending');
    const sub = runtime.subscribe(principal, id, {
      streamId: conversation.read_cursor.stream_id,
      afterEventSeq: snapshot.read_cursor.event_seq,
      onFrame() {},
    });
    assert.equal(sub.replay.length, 0);
    runtime.getSnapshot(principal, id);
    runtime.getConversation(principal, id);
    assert.equal(session.prompts.length, 1);
    assert.equal(session.stops, 0);
    sub.close();
  } finally {
    await runtime.close();
  }
});

test('停止受理与实际收敛分开，停止先行阻止完成、迟到文字不恢复执行', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const start = runtime.submitCommand(principal, id, prompt());
    await tick();
    const session = sessions.get(id)!;
    session.settleOnStop = false;
    session.callbacks[0]!('中途正文');
    const stop = runtime.submitCommand(principal, id, stopCommand(start.body));
    assert.equal(stop.statusCode, 202);
    assert.equal(runtime.getSnapshot(principal, id).focus_task!.status, 'stopping');
    assert.equal(
      runtime.submitCommand(principal, id, stopCommand(start.body)).body.command?.outcome_code,
      'STOP_ALREADY_REQUESTED',
    );
    session.callbacks[0]!('停止后的迟到文字');
    session.reply('迟到完成');
    await tick();
    const snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.status, 'stopped');
    assert.deepEqual(snapshot.messages[1]!.content.blocks, [{ type: 'text', text: '中途正文' }]);
    assert.equal(snapshot.results.length, 0);
    session.callbacks[0]!('结束后仍迟到');
    assert.equal(runtime.getSnapshot(principal, id).focus_task!.status, 'stopped');
    assert.equal(
      runtime.submitCommand(principal, id, prompt('绕过未完成目标')).body.error?.code,
      'UNFINISHED_TASK_EXISTS',
    );
    assert.equal(
      runtime.submitCommand(principal, id, stopCommand(start.body)).body.command?.outcome_code,
      'TARGET_ALREADY_ENDED',
    );
  } finally {
    await runtime.close();
  }
});

test('完成先行，旧停止不影响后续 Task；排队即停止不创建 Pi、不消费输入', async () => {
  const { runtime, sessions, id } = harness();
  try {
    const first = runtime.submitCommand(principal, id, prompt());
    await tick();
    sessions.get(id)!.reply('完成');
    await tick();
    runtime.submitCommand(principal, id, prompt('后续问题'));
    await tick();
    const previousStop = runtime.submitCommand(principal, id, stopCommand(first.body));
    assert.equal(previousStop.body.command?.outcome_code, 'TARGET_ALREADY_ENDED');
    assert.equal(runtime.getSnapshot(principal, id).focus_task!.status, 'running');
    assert.equal(sessions.get(id)!.stops, 0);
    const empty = runtime.createConversation(principal, { schema_version: 1 }).conversation.id;
    const request = prompt();
    const queued = runtime.submitCommand(principal, empty, request);
    runtime.submitCommand(principal, empty, stopCommand(queued.body));
    await tick();
    assert.equal(sessions.has(empty), false);
    assert.equal(runtime.getSnapshot(principal, empty).focus_task!.status, 'stopped');
    assert.equal(
      runtime.getCommand(principal, empty, request.request_key).input_receipt?.input_state,
      'pending',
    );
  } finally {
    await runtime.close();
  }
});

test('模型失败保留真实失败与中断正文，不生成结果或偷偷新建 Task', async () => {
  const { runtime, sessions, id } = harness();
  try {
    runtime.submitCommand(principal, id, prompt());
    await tick();
    sessions.get(id)!.callbacks[0]!('已收到部分文字');
    sessions.get(id)!.reply('', 'failed');
    await tick();
    const snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.status, 'failed');
    assert.equal(snapshot.focus_task!.latest_attempt.error!.code, 'ISOLATED_FAILURE');
    assert.equal(snapshot.results.length, 0);
    assert.equal(snapshot.messages[1]!.status, 'interrupted');
    assert.equal(snapshot.focus_task!.latest_attempt.budget!.model_requests_used, 1);
    assert.equal(
      runtime.submitCommand(principal, id, prompt()).body.error?.code,
      'UNFINISHED_TASK_EXISTS',
    );
  } finally {
    await runtime.close();
  }
});

test('未实现命令和草案能力显式拒绝，客户端预算覆盖字段不进入执行', async () => {
  const { runtime, id } = harness();
  try {
    const request = prompt();
    assert.equal(runtime.submitCommand(principal, id, { ...request, budget: {} }).statusCode, 422);
    assert.equal(
      runtime.submitCommand(principal, id, { ...request, task_kind: 'scheduling_draft' })
        .statusCode,
      422,
    );
    for (const kind of ['continue_task', 'retry_task', 'provide_input']) {
      const result = runtime.submitCommand(principal, id, {
        schema_version: 1,
        request_key: randomUUID(),
        kind,
        task_id: randomUUID(),
        target_attempt_id: randomUUID(),
        expected_task_version: '1',
        ...(kind === 'provide_input' ? { input: { text: '补充' } } : {}),
      });
      assert.equal(result.statusCode, 422);
      assert.equal(result.body.command, null);
      assert.equal(validateAgentContract('ResponseEnvelope', result.body), true);
    }
    assert.equal(runtime.getSnapshot(principal, id).focus_task, null);
  } finally {
    await runtime.close();
  }
});

test('不支持的公开版本返回 UNSUPPORTED_SCHEMA_VERSION 且不消耗命令 key', async () => {
  const { runtime, id } = harness();
  try {
    for (const schema_version of [2, 0, '1', null]) {
      assert.throws(() => runtime.createConversation(principal, { schema_version }), {
        statusCode: 422,
        code: 'UNSUPPORTED_SCHEMA_VERSION',
      });
    }
    assert.equal(runtime.listConversations(principal).items.length, 1);
    const request = prompt();
    const unsupported = runtime.submitCommand(principal, id, { ...request, schema_version: 2 });
    assert.equal(unsupported.statusCode, 422);
    assert.equal(unsupported.body.error?.code, 'UNSUPPORTED_SCHEMA_VERSION');
    assert.equal(unsupported.body.command, null);
    assert.equal(validateAgentContract('ResponseEnvelope', unsupported.body), true);
    assert.throws(() => runtime.getCommand(principal, id, request.request_key), {
      statusCode: 404,
    });
    assert.equal(runtime.submitCommand(principal, id, request).statusCode, 202);
  } finally {
    await runtime.close();
  }
});

test('事件前缀裁剪与换流、超前游标均明确要求重建，等于裁剪水位合法', async () => {
  const { runtime, id, conversation } = harness({ eventLimit: 2 });
  try {
    runtime.submitCommand(principal, id, prompt());
    const subscribe = (afterEventSeq: string, streamId = conversation.read_cursor.stream_id) =>
      runtime.subscribe(principal, id, { streamId, afterEventSeq, onFrame() {} });
    assert.throws(() => subscribe('0'), { code: 'CURSOR_EXPIRED', statusCode: 410 });
    const valid = subscribe('1');
    assert.equal(valid.replay.length, 2);
    valid.close();
    assert.throws(() => subscribe('999'), { code: 'CURSOR_AHEAD', statusCode: 409 });
    assert.throws(() => subscribe('1', randomUUID()), { code: 'STREAM_CHANGED', statusCode: 409 });
    assert.throws(() => subscribe('01'), { code: 'INVALID_REQUEST' });
  } finally {
    await runtime.close();
  }
});

test('消息历史稳定边界、快照返回副本、列表游标签名和用户条件不能伪造', async () => {
  const { runtime, sessions, id } = harness();
  try {
    for (let index = 0; index < 3; index++) {
      runtime.submitCommand(principal, id, prompt(`第${index}问`));
      await tick();
      sessions.get(id)!.reply(`回答${index}`);
      await tick();
    }
    const snapshot = runtime.getSnapshot(principal, id, 2);
    assert.equal(snapshot.messages[0]!.message_seq, '5');
    assert.equal(snapshot.page.next_before_message_seq, '5');
    const history = runtime.listMessages(principal, id, {
      streamId: snapshot.read_cursor.stream_id,
      upperMessageSeq: '6',
      beforeMessageSeq: '5',
      limit: 2,
    });
    assert.deepEqual(
      history.messages.map((message) => message.message_seq),
      ['3', '4'],
    );
    assert.equal(validateAgentContract('MessageHistoryData', history), true);
    snapshot.messages[0]!.content.blocks = [];
    assert.equal(runtime.getSnapshot(principal, id).messages[4]!.content.blocks.length, 1);
    runtime.createConversation(principal, { schema_version: 1, title: '另一个' });
    const first = runtime.listConversations(principal, { limit: 1 });
    assert.equal(first.has_more, true);
    const second = runtime.listConversations(principal, { limit: 1, cursor: first.next_cursor! });
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0]!.conversation.id, second.items[0]!.conversation.id);
    assert.throws(
      () => runtime.listConversations(stranger, { limit: 1, cursor: first.next_cursor! }),
      { code: 'INVALID_CURSOR' },
    );
    assert.throws(
      () => runtime.listConversations(principal, { limit: 2, cursor: first.next_cursor! }),
      { code: 'INVALID_CURSOR' },
    );
  } finally {
    await runtime.close();
  }
});

class VirtualClock implements AttemptBudgetClock {
  time = 1_000_000;
  timers = new Set<{ callback: () => void; at: number }>();
  now = () => this.time;
  setTimeout(callback: () => void, delay: number) {
    const timer = { callback, at: this.time + delay };
    this.timers.add(timer);
    return timer;
  }
  clearTimeout(timer: unknown) {
    this.timers.delete(timer as { callback: () => void; at: number });
  }
  advance(ms: number) {
    this.time += ms;
    for (const timer of [...this.timers])
      if (timer.at <= this.time) {
        this.timers.delete(timer);
        timer.callback();
      }
  }
}

test('预算超限先锁存仍为 running，停止返回冲突，收敛后失败且不把超限当用户停止', async () => {
  const clock = new VirtualClock();
  const { runtime, sessions, id } = harness({ clock });
  try {
    const start = runtime.submitCommand(principal, id, prompt());
    await tick();
    const session = sessions.get(id)!;
    session.settleOnStop = false;
    clock.advance(599_999);
    await session.barriers.beforeModelDispatch!();
    clock.advance(1);
    let snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.status, 'running');
    assert.equal(snapshot.focus_task!.latest_attempt.budget!.limit_exceeded_kind, 'duration');
    const refusal = runtime.submitCommand(principal, id, stopCommand(start.body));
    assert.equal(refusal.body.error?.code, 'TASK_STATE_CONFLICT');
    assert.equal(refusal.body.decision?.target_attempt_id, start.body.decision!.result_attempt_id);
    assert.equal(refusal.body.decision?.result_attempt_id, null);
    assert.equal(refusal.body.decision?.result_attempt_outcome_at_decision, null);
    await tick();
    assert.equal(session.stops, 1);
    session.reply('不能交付的迟到回答');
    await tick();
    snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.status, 'failed');
    assert.equal(
      snapshot.focus_task!.latest_attempt.error!.code,
      'ATTEMPT_DURATION_LIMIT_EXCEEDED',
    );
    assert.equal(snapshot.focus_task!.latest_attempt.stop_requested_at, null);
    assert.equal(snapshot.results.length, 0);
  } finally {
    await runtime.close();
  }
});

test('第 12 次模型授权可交付，第 13 次被拒且按真实计数失败', async () => {
  const { runtime, sessions, id } = harness();
  try {
    runtime.submitCommand(principal, id, prompt());
    await tick();
    const session = sessions.get(id)!;
    for (let index = 1; index < 12; index++)
      await session.barriers.beforeModel!({ header: null, entries: [], leafId: null });
    assert.equal(
      runtime.getSnapshot(principal, id).focus_task!.latest_attempt.budget!.model_requests_used,
      12,
    );
    session.reply('最后一次合法回答');
    await tick();
    assert.equal(runtime.getSnapshot(principal, id).focus_task!.status, 'completed');
    runtime.submitCommand(principal, id, prompt('下轮'));
    await tick();
    for (let index = 1; index < 12; index++)
      await session.barriers.beforeModel!({ header: null, entries: [], leafId: null });
    await assert.rejects(
      session.barriers.beforeModel!({ header: null, entries: [], leafId: null }),
      { code: 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED' },
    );
    await tick();
    const snapshot = runtime.getSnapshot(principal, id);
    assert.equal(snapshot.focus_task!.status, 'failed');
    assert.equal(snapshot.focus_task!.latest_attempt.budget!.model_requests_used, 12);
    assert.equal(
      snapshot.focus_task!.latest_attempt.error!.code,
      'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED',
    );
  } finally {
    await runtime.close();
  }
});

test('实际 Pi SDK 的两轮上下文和产品结果接通；模型用量缺失不参与伪计数', async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'http://127.0.0.1/model/v1',
    AGENT_MODEL_API_KEY: 'isolated-key',
    AGENT_MODEL_ID: 'isolated-model',
  });
  const runtime = new AgentMemoryRuntime({
    createSession: async (_id, barriers) =>
      createPiDirectModelSession({
        config,
        barriers,
        fetch: async (_input, init) => {
          payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const chunk = (delta: Record<string, unknown>, finish: string | null) =>
            JSON.stringify({
              id: 'isolated',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'isolated-model',
              choices: [{ index: 0, delta, finish_reason: finish }],
            });
          const text = payloads.length === 1 ? '记住了' : '召回成功';
          return new Response(
            `data: ${chunk({ role: 'assistant', content: text }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      }),
  });
  try {
    const id = runtime.createConversation(principal, { schema_version: 1 }).conversation.id;
    for (const text of ['记住海风', '刚才记住了什么']) {
      runtime.submitCommand(principal, id, prompt(text));
      for (
        let index = 0;
        index < 100 && runtime.getSnapshot(principal, id).focus_task!.status !== 'completed';
        index++
      )
        await tick();
      assert.equal(runtime.getSnapshot(principal, id).focus_task!.status, 'completed');
    }
    assert.equal(payloads.length, 2);
    assert.ok(JSON.stringify(payloads[1]!.messages).includes('记住海风'));
    assert.ok(JSON.stringify(payloads[1]!.messages).includes('记住了'));
    assert.equal(
      runtime.getSnapshot(principal, id).focus_task!.latest_attempt.budget!.model_requests_used,
      1,
    );
  } finally {
    await runtime.close();
  }
});

test('关闭服务撤销执行资格并停止 Pi、释放计时器；迟到输出不能更新状态', async () => {
  const { runtime, sessions, id } = harness();
  runtime.submitCommand(principal, id, prompt());
  await tick();
  const session = sessions.get(id)!;
  await runtime.close();
  assert.equal(session.stops, 1);
  assert.equal(session.disposed, true);
  session.callbacks[0]!('迟到');
  assert.throws(() => runtime.getSnapshot(principal, id), { code: 'SERVICE_UNAVAILABLE' });
});

test('实际 Pi 在 Attempt 到期时取消正在读取的模型流，以预算失败收敛', async () => {
  const clock = new VirtualClock();
  let sends = 0;
  let cancelled = false;
  const config = readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'http://127.0.0.1/model/v1',
    AGENT_MODEL_API_KEY: 'isolated-key',
    AGENT_MODEL_ID: 'isolated-model',
  });
  const runtime = new AgentMemoryRuntime({
    budgetClock: clock,
    createSession: async (_id, barriers) =>
      createPiDirectModelSession({
        config,
        barriers,
        fetch: async () => {
          sends += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const body = {
                  id: 'isolated',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'isolated-model',
                  choices: [{ index: 0, delta: { content: '尚未结束' }, finish_reason: null }],
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(body)}\n\n`));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      }),
  });
  try {
    const id = runtime.createConversation(principal, { schema_version: 1 }).conversation.id;
    runtime.submitCommand(principal, id, prompt());
    for (let index = 0; index < 100 && sends === 0; index++) await tick();
    assert.equal(sends, 1);
    clock.advance(600_000);
    for (
      let index = 0;
      index < 100 && runtime.getSnapshot(principal, id).focus_task!.status === 'running';
      index++
    )
      await tick();
    const task = runtime.getSnapshot(principal, id).focus_task!;
    assert.equal(task.status, 'failed');
    assert.equal(task.latest_attempt.error!.code, 'ATTEMPT_DURATION_LIMIT_EXCEEDED');
    assert.equal(task.latest_attempt.stop_requested_at, null);
    assert.equal(task.latest_attempt.budget!.model_requests_used, 1);
    assert.equal(cancelled, true);
    assert.equal(sends, 1);
  } finally {
    await runtime.close();
  }
});

test('实际 Pi 最终发送门禁拒绝时不发送模型 HTTP，也不启用隐式重试', async () => {
  let sends = 0;
  const session = await createPiDirectModelSession({
    config: readDirectModelConfig({
      AGENT_MODEL_BASE_URL: 'http://127.0.0.1/model/v1',
      AGENT_MODEL_API_KEY: 'isolated-key',
      AGENT_MODEL_ID: 'isolated-model',
    }),
    barriers: {
      beforeModelDispatch: async () => {
        throw new Error('ISOLATED_REVOKED');
      },
    },
    fetch: async () => {
      sends += 1;
      throw new Error('不得发送');
    },
  });
  try {
    const result = await session.prompt('门禁测试');
    assert.equal(result.status, 'failed');
    assert.equal(sends, 0);
  } finally {
    session.dispose();
  }
});

test('实际 Pi 单请求超时取 Attempt 剩余时间，长配置不会延长该上限', async () => {
  let cancelled = false;
  const session = await createPiDirectModelSession({
    config: readDirectModelConfig({
      AGENT_MODEL_BASE_URL: 'http://127.0.0.1/model/v1',
      AGENT_MODEL_API_KEY: 'isolated-key',
      AGENT_MODEL_ID: 'isolated-model',
    }),
    barriers: { executionRemainingMs: () => 25 },
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('ISOLATED_CANCELLED'));
          },
          { once: true },
        );
      }),
  });
  const started = Date.now();
  try {
    const result = await session.prompt('有界单次请求');
    assert.equal(result.status, 'failed');
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started < 1500);
    assert.equal(result.observations[0]!.usage.totalTokens, null);
  } finally {
    session.dispose();
  }
});
