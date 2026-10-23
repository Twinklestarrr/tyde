import type { Pool } from 'pg';
import type { TaskView } from '@tyde/shared/agent';
import { appendEvent, projectMessage, projectTask } from '../storage/projections.js';
import type { ExecutionAuthority } from './persistent-budget.js';
import { assertLocalProcessExited } from './process-identity.js';

export interface InterruptedRecoveryResult {
  task: TaskView;
  replayed: boolean;
  /** This adapter restores display/coordination only. It cannot grant a dispatch permit. */
  executionGranted: false;
}

/**
 * Internal W5 adapter, not a public continue/retry command. Only an exact owner belonging
 * to a demonstrably absent process on this host may be isolated. No Pi/input/Operation
 * history is changed, no task is scheduled, and no new Attempt or Session is created.
 */
export async function recoverInterruptedAttempt(
  pool: Pool,
  authority: Readonly<ExecutionAuthority>,
): Promise<InterruptedRecoveryResult> {
  authority = Object.freeze({ ...authority });
  assertLocalProcessExited(authority.ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [conversation],
    } = await client.query('SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE', [
      authority.conversationId,
    ]);
    const {
      rows: [task],
    } = await client.query('SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [authority.taskId]);
    const {
      rows: [session],
    } = await client.query('SELECT * FROM pi_sessions WHERE id=$1 FOR UPDATE', [
      authority.piSessionId,
    ]);
    const {
      rows: [attempt],
    } = await client.query('SELECT * FROM agent_attempts WHERE id=$1 FOR UPDATE', [
      authority.attemptId,
    ]);
    if (
      !conversation ||
      conversation.deleted_at !== null ||
      conversation.pi_session_id !== authority.piSessionId ||
      !task ||
      task.conversation_id !== authority.conversationId ||
      task.pi_session_id !== authority.piSessionId ||
      !session ||
      session.conversation_id !== authority.conversationId ||
      !attempt ||
      attempt.task_id !== authority.taskId ||
      attempt.pi_session_id !== authority.piSessionId ||
      attempt.execution_owner_id !== authority.ownerId ||
      attempt.execution_generation !== authority.generation
    )
      throw new Error('AGENT_RECOVERY_AUTHORITY_MISMATCH');
    // Re-read after taking the same C/T/P/A locks used by normal coordination.
    assertLocalProcessExited(authority.ownerId);
    if (attempt.ended_at !== null) {
      if (attempt.outcome !== 'interrupted') throw new Error('AGENT_RECOVERY_ALREADY_ENDED');
      const view = await projectTask(client, authority.taskId);
      await client.query('COMMIT');
      return { task: view, replayed: true, executionGranted: false };
    }
    if (
      session.active_attempt_id !== authority.attemptId ||
      session.writer_owner_id !== authority.ownerId ||
      session.execution_generation !== authority.generation ||
      session.head_revision_id !== authority.expectedHeadRevisionId
    )
      throw new Error('AGENT_RECOVERY_AUTHORITY_MISMATCH');
    // An already durable budget restriction requires its own failed reconciliation path.
    if (attempt.limit_exceeded_kind !== null)
      throw new Error('AGENT_RECOVERY_LIMIT_RECONCILIATION_REQUIRED');
    if (task.status === 'completed') throw new Error('AGENT_RECOVERY_ALREADY_COMPLETED');
    const { rows: messages } = await client.query(
      `UPDATE agent_messages SET status='interrupted',row_version=row_version+1,updated_at=clock_timestamp()
        WHERE conversation_id=$1 AND task_id=$2 AND attempt_id=$3 AND status='in_progress' RETURNING *`,
      [authority.conversationId, authority.taskId, authority.attemptId],
    );
    await client.query(
      `UPDATE agent_attempts SET outcome='interrupted',ended_at=clock_timestamp(),
      error_code='EXECUTION_PROCESS_CONFIRMED_EXITED',error_summary='原执行进程已确认退出，等待用户后续处理' WHERE id=$1`,
      [authority.attemptId],
    );
    await client.query(
      `UPDATE agent_tasks SET status='interrupted',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [authority.taskId],
    );
    await client.query(
      `UPDATE pi_sessions SET active_attempt_id=NULL,writer_owner_id=NULL,
      execution_generation=execution_generation+1,updated_at=clock_timestamp() WHERE id=$1`,
      [authority.piSessionId],
    );
    for (const message of messages)
      await appendEvent(client, {
        conversationId: authority.conversationId,
        eventType: 'message.updated',
        payload: { message: projectMessage(message), input_receipt: null },
        producerKey: `process-isolated:message:${authority.attemptId}:${message.id}`,
        taskId: authority.taskId,
        attemptId: authority.attemptId,
        messageId: message.id,
      });
    const view = await projectTask(client, authority.taskId);
    await appendEvent(client, {
      conversationId: authority.conversationId,
      eventType: 'task.updated',
      payload: { task: view },
      producerKey: `process-isolated:task:${authority.attemptId}`,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
    });
    await client.query('COMMIT');
    return { task: view, replayed: false, executionGranted: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
