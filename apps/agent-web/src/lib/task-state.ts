import type { TaskStatus, TaskView } from '@tyde/shared/agent';

export type TaskExecutionPhase = TaskStatus | 'budget_closing';

/** A latched limit revokes execution before its final failure projection arrives. */
export function taskExecutionPhase(task: TaskView | null | undefined): TaskExecutionPhase | null {
  if (!task) return null;
  if (task.status === 'running' && task.latest_attempt.budget?.limit_exceeded_kind != null) {
    return 'budget_closing';
  }
  return task.status;
}
