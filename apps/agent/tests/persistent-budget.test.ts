import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ATTEMPT_LIMITS } from '../src/execution/attempt-budget.js';
import { budgetProducerKey, decidePersistentBudget } from '../src/execution/persistent-budget.js';

const limits = DEFAULT_ATTEMPT_LIMITS;
const running = {
  startedAtMs: 0,
  deadlineMs: 600000,
  modelRequestsUsed: 0,
  toolCallsUsed: 0,
  limitKind: null,
  stopped: false,
  ended: false,
};

test('持久授权规则：599999可预占，600000/600001时间优先且不延长期限', () => {
  assert.deepEqual(decidePersistentBudget(running, limits, 599999, 'model'), {
    code: null,
    latch: null,
  });
  for (const now of [600000, 600001]) {
    assert.deepEqual(
      decidePersistentBudget(
        { ...running, modelRequestsUsed: 12, toolCallsUsed: 10 },
        limits,
        now,
        'model',
      ),
      { code: 'ATTEMPT_DURATION_LIMIT_EXCEEDED', latch: 'duration' },
    );
  }
});

test('持久授权规则：模型11/12/13、工具9/10/11，精确N可交付', () => {
  for (const used of [10, 11])
    assert.equal(
      decidePersistentBudget({ ...running, modelRequestsUsed: used }, limits, 1, 'model').code,
      null,
    );
  assert.deepEqual(
    decidePersistentBudget({ ...running, modelRequestsUsed: 12 }, limits, 1, 'model'),
    { code: 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED', latch: 'model_requests' },
  );
  for (const used of [8, 9])
    assert.equal(
      decidePersistentBudget({ ...running, toolCallsUsed: used }, limits, 1, 'tool').code,
      null,
    );
  assert.deepEqual(decidePersistentBudget({ ...running, toolCallsUsed: 10 }, limits, 1, 'tool'), {
    code: 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED',
    latch: 'tool_calls',
  });
  assert.deepEqual(
    decidePersistentBudget({ ...running, modelRequestsUsed: 12, toolCallsUsed: 10 }, limits, 1),
    { code: null, latch: null },
  );
});

test('持久授权规则：停止、结束与首次限制固定，不把未知历史补成0', () => {
  assert.equal(
    decidePersistentBudget({ ...running, stopped: true }, limits, 600001, 'model').code,
    'ATTEMPT_STOPPED',
  );
  assert.deepEqual(
    decidePersistentBudget({ ...running, limitKind: 'tool_calls', stopped: true }, limits, 600001),
    { code: 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED', latch: null },
  );
  assert.equal(
    decidePersistentBudget({ ...running, ended: true }, limits, 600001, 'model').code,
    'ATTEMPT_ENDED',
  );
  assert.equal(
    decidePersistentBudget({ ...running, modelRequestsUsed: null }, limits, 1, 'model').code,
    'ATTEMPT_BUDGET_UNTRACKED',
  );
  assert.equal(
    decidePersistentBudget({ ...running, startedAtMs: null, deadlineMs: null }, limits, 1).code,
    'ATTEMPT_NOT_STARTED',
  );
});

test('稳定producer key分别绑定Attempt、model request及完整tool来源，分隔符无碰撞', () => {
  const model = { kind: 'model', modelRequestId: 'request-1' } as const;
  assert.equal(budgetProducerKey('a1', model), budgetProducerKey('a1', { ...model }));
  assert.notEqual(budgetProducerKey('a1', model), budgetProducerKey('a2', model));
  assert.notEqual(
    budgetProducerKey('a1', model),
    budgetProducerKey('a1', { kind: 'model', modelRequestId: 'request-2' }),
  );
  const first = budgetProducerKey('a1', {
    kind: 'tool',
    sourceNativeEntryId: 'entry:call',
    toolCallId: 'one',
  });
  assert.notEqual(
    first,
    budgetProducerKey('a1', { kind: 'tool', sourceNativeEntryId: 'entry', toolCallId: 'call:one' }),
  );
  assert.throws(
    () => budgetProducerKey('a1', { kind: 'tool', sourceNativeEntryId: '', toolCallId: 'one' }),
    /INVALID_AUTHORIZATION_ID/,
  );
});
