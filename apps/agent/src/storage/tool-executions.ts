import type { PoolClient } from 'pg';
import { validateAgentContract, type ToolExecutionSummary } from '@tyde/shared/agent';
import { appendEvent, projectTool } from './projections.js';

export function toolErrorMessage(code: NonNullable<ToolExecutionSummary['error']>['code']): string {
  return {
    invalid_arguments: '工具参数不符合声明，未执行查询',
    tool_failed: '工具执行失败，未产生可用结果',
    cancelled: '工具已取消，迟到结果不会恢复执行',
    budget_exceeded: '执行预算限制已触发，工具已取消',
    timeout: '工具执行超时，未接受迟到结果',
  }[code];
}

/** The caller holds C/T/P/A coordination locks; this never schedules tool or model execution. */
export async function settleRunningTools(
  client: PoolClient,
  authority: { conversationId: string; taskId: string; attemptId: string },
  code: 'tool_failed' | 'cancelled' | 'budget_exceeded',
): Promise<void> {
  const { rows } = await client.query(
    `UPDATE agent_tool_executions SET status=$4,ended_at=GREATEST(started_at,clock_timestamp()),
      error=$5,row_version=row_version+1
      WHERE conversation_id=$1 AND task_id=$2 AND attempt_id=$3 AND status='running' RETURNING *`,
    [
      authority.conversationId,
      authority.taskId,
      authority.attemptId,
      code === 'tool_failed' ? 'failed' : 'cancelled',
      JSON.stringify({ code, message: toolErrorMessage(code) }),
    ],
  );
  for (const row of rows) await appendToolEvent(client, projectTool(row));
}

export async function appendToolEvent(
  client: PoolClient,
  tool: ToolExecutionSummary,
): Promise<void> {
  if (!validateAgentContract('ToolExecutionSummary', tool))
    throw new Error('INVALID_TOOL_PROJECTION');
  await appendEvent(client, {
    conversationId: tool.conversation_id,
    eventType: 'tool.updated',
    payload: { tool_execution: tool },
    producerKey: `tool:${tool.id}:${tool.row_version}`,
    taskId: tool.task_id,
    attemptId: tool.attempt_id,
  });
}
