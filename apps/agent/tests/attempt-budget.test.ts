import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentContract } from '@tyde/shared/agent';
import {
  AttemptBudget,
  AttemptBudgetError,
  DEFAULT_ATTEMPT_LIMITS,
  type AttemptBudgetClock,
} from '../src/execution/attempt-budget.js';

const epoch = Date.parse('2026-10-22T08:00:00Z');

class VirtualClock implements AttemptBudgetClock {
  current = epoch;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.current;

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  advanceTo(elapsedMs: number): void {
    this.current = epoch + elapsedMs;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.current || !this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof AttemptBudgetError && error.code === code;
}

test('新 Attempt 未开始时有真实零授权且无期限，开始后固定期限和策略', () => {
  const clock = new VirtualClock();
  const changes: unknown[] = [];
  const budget = new AttemptBudget({ clock, onChange: (view) => changes.push(view) });
  assert.deepEqual(budget.view(), {
    ...DEFAULT_ATTEMPT_LIMITS,
    execution_deadline_at: null,
    model_requests_used: 0,
    tool_calls_used: 0,
    limit_exceeded_kind: null,
    limit_exceeded_at: null,
  });
  assert.throws(() => budget.authorizeModel('request-1'), hasCode('ATTEMPT_NOT_STARTED'));
  budget.start();
  assert.equal(budget.view().execution_deadline_at, '2026-10-22T08:10:00.000Z');
  assert.equal(budget.remainingMs(), 600000);
  assert.equal(validateAgentContract('AttemptBudgetView', budget.view()), true);
  assert.throws(() => budget.start(), /ATTEMPT_ALREADY_STARTED/);
  assert.equal(changes.length, 1);
  budget.finish();
  assert.equal(clock.timers.size, 0);
});

test('599999ms仍可授权，600000ms主动取消，600001ms不覆盖首因', () => {
  const clock = new VirtualClock();
  const limits: string[] = [];
  const budget = new AttemptBudget({ clock, onLimit: (error) => limits.push(error.code) });
  budget.start();
  clock.advanceTo(599999);
  assert.equal(budget.authorizeModel('last-millisecond'), true);
  assert.equal(budget.remainingMs(), 1);
  clock.advanceTo(600000);
  assert.equal(budget.signal.aborted, true);
  assert.equal(budget.view().limit_exceeded_kind, 'duration');
  assert.equal(budget.view().limit_exceeded_at, '2026-10-22T08:10:00.000Z');
  clock.advanceTo(600001);
  assert.throws(
    () => budget.authorizeTool('late-tool'),
    hasCode('ATTEMPT_DURATION_LIMIT_EXCEEDED'),
  );
  assert.equal(budget.view().tool_calls_used, 0);
  assert.equal(limits.length, 1);
});

test('调度器迟到时，发送与交付门禁仍按原deadline阻断', () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  clock.current = epoch + 600001;
  assert.throws(() => budget.complete(), hasCode('ATTEMPT_DURATION_LIMIT_EXCEEDED'));
  assert.equal(budget.view().limit_exceeded_kind, 'duration');
  assert.equal(budget.view().model_requests_used, 0);
  assert.equal(clock.timers.size, 0);
});

test('第11及12次模型授权可完整完成，第13次才锁存且不递增', () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  for (let index = 1; index <= 12; index++)
    assert.equal(budget.authorizeModel(`request-${index}`), true);
  assert.equal(budget.view().model_requests_used, 12);
  assert.equal(budget.authorizeModel('request-12'), false);
  assert.equal(budget.limitError, null);
  budget.complete();
  clock.advanceTo(600001);
  assert.equal(budget.limitError, null);
  assert.equal(budget.signal.aborted, false);

  const second = new AttemptBudget({ clock });
  second.start();
  for (let index = 1; index <= 12; index++) second.authorizeModel(`request-${index}`);
  assert.throws(
    () => second.authorizeModel('request-13'),
    hasCode('ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'),
  );
  assert.equal(second.view().model_requests_used, 12);
  assert.equal(second.signal.aborted, true);
  assert.throws(() => second.complete(), hasCode('ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'));
});

test('工具第9及10次可执行并用模型总结，第11次阻断所有后续动作', () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  for (let index = 1; index <= 10; index++) budget.authorizeTool(`tool-${index}`);
  assert.equal(budget.authorizeTool('tool-10'), false);
  assert.equal(budget.authorizeModel('summary-request'), true);
  assert.equal(budget.view().tool_calls_used, 10);
  assert.throws(() => budget.authorizeTool('tool-11'), hasCode('ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED'));
  assert.throws(
    () => budget.authorizeModel('hidden-summary'),
    hasCode('ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED'),
  );
  assert.equal(budget.view().model_requests_used, 1);
});

test('同宿主重复回调不重复派发，并发请求不能超领，失败不退预占', async () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  const dispatches: string[] = [];
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      if (budget.authorizeModel('stable-request-id')) dispatches.push('sent');
    }),
  );
  assert.deepEqual(dispatches, ['sent']);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, async (_, index) => budget.authorizeModel(`new-${index}`)),
  );
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 11);
  assert.equal(budget.view().model_requests_used, 12);
  budget.finish();
  assert.equal(budget.view().model_requests_used, 12);
});

test('到期与次数同命中时先判期限，首个限制不被后续时钟覆盖', () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  for (let index = 0; index < 12; index++) budget.authorizeModel(String(index));
  clock.current = epoch + 600000;
  assert.throws(
    () => budget.authorizeModel('thirteenth'),
    hasCode('ATTEMPT_DURATION_LIMIT_EXCEEDED'),
  );

  const earlier = new VirtualClock();
  const countBudget = new AttemptBudget({ clock: earlier });
  countBudget.start();
  for (let index = 0; index < 12; index++) countBudget.authorizeModel(String(index));
  assert.throws(
    () => countBudget.authorizeModel('thirteenth'),
    hasCode('ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'),
  );
  earlier.advanceTo(600001);
  assert.equal(countBudget.view().limit_exceeded_kind, 'model_requests');
  assert.equal(countBudget.view().limit_exceeded_at, '2026-10-22T08:00:00.000Z');
});

test('用户停止先受理后不转成预算失败；限制先锁存则停止不能改写首因', () => {
  const clock = new VirtualClock();
  const budget = new AttemptBudget({ clock });
  budget.start();
  budget.authorizeModel('reserved-before-stop');
  assert.equal(budget.requestStop(), true);
  assert.equal(budget.requestStop(), false);
  assert.throws(() => budget.assertCanProceed(), hasCode('ATTEMPT_STOPPED'));
  assert.throws(() => budget.complete(), hasCode('ATTEMPT_STOPPED'));
  clock.advanceTo(600001);
  assert.equal(budget.limitError, null);
  assert.equal(budget.view().model_requests_used, 1);
  budget.finish();

  const expired = new AttemptBudget({ clock });
  expired.start(epoch);
  assert.equal(expired.requestStop(), false);
  assert.equal(expired.view().limit_exceeded_kind, 'duration');
});

test('完成先裁决后计时器不改结局，新Attempt预算独立且不受旧停止影响', () => {
  const clock = new VirtualClock();
  const old = new AttemptBudget({ clock });
  old.start();
  old.authorizeModel('request-1');
  old.complete();
  const next = new AttemptBudget({ clock });
  next.start();
  assert.equal(old.requestStop(), false);
  assert.equal(next.authorizeModel('request-1'), true);
  assert.equal(next.view().model_requests_used, 1);
  assert.equal(next.limitError, null);
  assert.throws(() => old.authorizeTool('late-tool'), hasCode('ATTEMPT_ENDED'));
  next.finish();
  clock.advanceTo(600001);
  assert.equal(old.limitError, null);
  assert.equal(next.limitError, null);
});

test('策略及公开视图副本不能改写冻结上限，授权与限制按同步顺序发布', () => {
  const clock = new VirtualClock();
  const limits = { ...DEFAULT_ATTEMPT_LIMITS, max_model_requests: 1 };
  const events: string[] = [];
  const budget = new AttemptBudget({
    clock,
    limits,
    onChange: (view) =>
      events.push(`change:${view.model_requests_used}:${view.limit_exceeded_kind}`),
    onLimit: (error) => events.push(`cancel:${error.code}`),
  });
  limits.max_model_requests = 100;
  budget.view().max_model_requests = 100;
  budget.start();
  budget.authorizeModel('request-1');
  assert.throws(
    () => budget.authorizeModel('request-2'),
    hasCode('ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'),
  );
  assert.deepEqual(events, [
    'change:0:null',
    'change:1:null',
    'change:1:model_requests',
    'cancel:ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED',
  ]);
});
