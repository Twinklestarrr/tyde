import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { validateAgentContract } from '@tyde/shared/agent';
import { projectTool } from '../src/storage/projections.js';
import { settleRunningTools } from '../src/storage/tool-executions.js';

function terminalRow() {
  return {
    id: randomUUID(),
    conversation_id: randomUUID(),
    task_id: randomUUID(),
    attempt_id: randomUUID(),
    model_request_id: randomUUID(),
    tool_call_id: 'isolated-call',
    tool_name: 'isolated_readonly',
    status: 'cancelled',
    row_version: '2',
    started_at: new Date('2026-10-23T01:00:00.000Z'),
    ended_at: new Date('2026-10-23T01:00:01.000Z'),
    is_demo: true,
    display_label: '合成隔离测试数据',
    input_summary: '查询固定测试值',
    result_summary: null,
    result_ref: null,
    error: { code: 'cancelled', message: '工具已取消，迟到结果不会恢复执行' },
    pi_session_id: randomUUID(),
    source_native_entry_id: 'native-assistant',
    source_revision_id: randomUUID(),
    result_native_entry_id: 'native-tool-result',
    result_revision_id: randomUUID(),
    raw_arguments: { fixturePrivate: 'never-public' },
    raw_receipt: { fixturePrivate: 'never-public' },
  };
}

test('工具产品投影只输出契约白名单，不泄露原生关联或完整参数结果', () => {
  const row = terminalRow();
  const publicTool = projectTool(row);
  assert.equal(validateAgentContract('ToolExecutionSummary', publicTool), true);
  for (const key of [
    'pi_session_id',
    'source_native_entry_id',
    'source_revision_id',
    'result_native_entry_id',
    'result_revision_id',
    'raw_arguments',
    'raw_receipt',
  ])
    assert.equal(key in publicTool, false);
  assert.equal(JSON.stringify(publicTool).includes('never-public'), false);
});

test('隔离恢复只收敛仍运行过程并保存冻结事件，重复收敛不新增事件或调度执行', async () => {
  const row = terminalRow();
  const events: unknown[][] = [];
  let updates = 0;
  const client = {
    async query(sql: string, values: unknown[]) {
      if (sql.startsWith('UPDATE agent_tool_executions')) {
        updates++;
        assert.deepEqual(values.slice(0, 3), [row.conversation_id, row.task_id, row.attempt_id]);
        assert.equal(values[3], 'cancelled');
        return { rows: updates === 1 ? [row] : [] };
      }
      if (sql.startsWith('UPDATE agent_conversations'))
        return {
          rows: [
            {
              id: row.conversation_id,
              event_stream_id: randomUUID(),
              last_event_seq: '1',
              last_activity_at: row.ended_at,
              last_message_seq: '2',
            },
          ],
        };
      assert.ok(sql.includes('INSERT INTO agent_outbox_events'));
      events.push(values);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const authority = {
    conversationId: row.conversation_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
  };
  await settleRunningTools(client, authority, 'cancelled');
  await settleRunningTools(client, authority, 'cancelled');
  assert.equal(events.length, 1);
  const frame = JSON.parse(String(events[0]![5]));
  assert.equal(validateAgentContract('ProductFrame', frame), true);
  assert.equal(frame.event_type, 'tool.updated');
  assert.deepEqual(frame.payload.tool_execution, projectTool(row));
  assert.equal(events[0]![6], `tool:${row.id}:2`);
  assert.equal(JSON.stringify(frame).includes('never-public'), false);
});
