import assert from 'node:assert/strict';
import test from 'node:test';
import type { AttemptBudgetView } from '@tyde/shared/agent';
import { taskExecutionPhase } from '../src/lib/task-state';
import { runningTask } from './chat-fixtures';

function trackedBudget(kind: AttemptBudgetView['limit_exceeded_kind']): AttemptBudgetView {
  return {
    policy_version: 1,
    max_duration_ms: 600000,
    max_model_requests: 12,
    max_tool_calls: 10,
    execution_deadline_at: '2026-10-22T08:10:00Z',
    model_requests_used: 1,
    tool_calls_used: 0,
    limit_exceeded_kind: kind,
    limit_exceeded_at: kind === null ? null : '2026-10-22T08:10:00Z',
  };
}

test('a latched execution limit is closing while the authoritative task remains running', () => {
  for (const kind of ['duration', 'model_requests', 'tool_calls'] as const) {
    const task = runningTask();
    task.latest_attempt.budget = trackedBudget(kind);
    assert.equal(taskExecutionPhase(task), 'budget_closing');
    assert.equal(task.status, 'running');
    assert.equal(task.latest_attempt.stop_requested_at, null);
    task.status = 'failed';
    task.latest_attempt.outcome = 'failed';
    assert.equal(taskExecutionPhase(task), 'failed');
  }
});

test('an unused or exhausted counter does not itself imply a latched limit', () => {
  const task = runningTask();
  task.latest_attempt.budget = trackedBudget(null);
  task.latest_attempt.budget.model_requests_used = task.latest_attempt.budget.max_model_requests;
  assert.equal(taskExecutionPhase(task), 'running');
  task.status = 'stopping';
  assert.equal(taskExecutionPhase(task), 'stopping');
  task.status = 'stopped';
  assert.equal(taskExecutionPhase(task), 'stopped');
  task.latest_attempt.budget = null;
  assert.equal(taskExecutionPhase(task), 'stopped');
  assert.equal(taskExecutionPhase(null), null);
});
