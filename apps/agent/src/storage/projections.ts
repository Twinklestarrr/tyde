import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import type {
  ConversationView,
  MessageView,
  ProductFrame,
  ResultView,
  TaskView,
  InputReceipt,
} from '@tyde/shared/agent';

export const digest = (value: unknown): string => {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('INVALID_CANONICAL_VALUE');
  return createHash('sha256').update(text).digest('hex');
};
export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export async function projectConversation(
  client: PoolClient,
  id: string,
): Promise<ConversationView> {
  const {
    rows: [c],
  } = await client.query('SELECT * FROM agent_conversations WHERE id=$1', [id]);
  if (!c) throw new Error('CONVERSATION_MISSING');
  return {
    id: c.id,
    title: c.title,
    row_version: c.row_version,
    created_at: iso(c.created_at)!,
    activity: { last_activity_at: iso(c.last_activity_at)!, last_message_seq: c.last_message_seq },
  };
}

export async function projectTask(client: PoolClient, id: string): Promise<TaskView> {
  const {
    rows: [t],
  } = await client.query('SELECT * FROM agent_tasks WHERE id=$1', [id]);
  const {
    rows: [a],
  } = await client.query(
    'SELECT * FROM agent_attempts WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1',
    [id],
  );
  const {
    rows: [s],
  } = await client.query('SELECT execution_policy FROM agent_execution_snapshots WHERE id=$1', [
    t.execution_snapshot_id,
  ]);
  const {
    rows: [d],
  } = await client.query('SELECT id FROM agent_results WHERE task_id=$1', [id]);
  const limits = s.execution_policy.attempt_limits;
  return {
    id: t.id,
    conversation_id: t.conversation_id,
    task_kind: t.task_kind,
    goal_text: t.goal_text,
    business_scope: t.business_scope,
    scope_locked_at: iso(t.scope_locked_at),
    status: t.status,
    row_version: t.row_version,
    created_at: iso(t.created_at)!,
    updated_at: iso(t.updated_at)!,
    completed_at: iso(t.completed_at),
    active_attempt_id: a.ended_at === null ? a.id : null,
    result_id: d?.id ?? null,
    latest_attempt: {
      id: a.id,
      attempt_no: a.attempt_no,
      previous_attempt_id: a.previous_attempt_id,
      start_reason: a.start_reason,
      outcome: a.outcome,
      created_at: iso(a.created_at)!,
      started_at: iso(a.started_at),
      stop_requested_at: iso(a.stop_requested_at),
      ended_at: iso(a.ended_at),
      error: a.error_code ? { code: a.error_code, summary: a.error_summary } : null,
      budget:
        a.model_requests_used === null || !limits
          ? null
          : {
              ...limits,
              execution_deadline_at: iso(a.execution_deadline_at),
              model_requests_used: a.model_requests_used,
              tool_calls_used: a.tool_calls_used,
              limit_exceeded_kind: a.limit_exceeded_kind,
              limit_exceeded_at: iso(a.limit_exceeded_at),
            },
    },
  } as TaskView;
}

export function projectMessage(m: Record<string, unknown>): MessageView {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    task_id: m.task_id,
    attempt_id: m.attempt_id,
    message_seq: m.message_seq,
    message_type: m.message_type,
    status: m.status,
    content_schema_version: m.content_schema_version,
    content: m.content,
    row_version: m.row_version,
    source_command_id: m.source_command_id,
    result_id: m.result_id,
    created_at: iso(m.created_at as Date)!,
    updated_at: iso(m.updated_at as Date)!,
  } as MessageView;
}
export function projectResult(d: Record<string, unknown>): ResultView {
  return {
    id: d.id,
    conversation_id: d.conversation_id,
    task_id: d.task_id,
    delivery_attempt_id: d.delivery_attempt_id,
    result_type: d.result_type,
    payload_schema_version: d.payload_schema_version,
    payload: d.payload,
    verification_summary: d.verification,
    verified_at: iso(d.verified_at as Date)!,
    created_at: iso(d.created_at as Date)!,
  } as ResultView;
}
export function projectInput(q: Record<string, unknown>, messageId: string): InputReceipt {
  return {
    command_id: q.id,
    user_message_id: messageId,
    task_id: q.task_id,
    input_state: q.input_state,
    input_attempt_id: q.input_attempt_id,
    handling_summary: q.input_handling_result,
  } as InputReceipt;
}

/** Caller holds the conversation coordination lock. Payload freezes the entire public frame. */
export async function appendEvent(
  client: PoolClient,
  event: {
    conversationId: string;
    eventType: ProductFrame['event_type'];
    payload: unknown;
    producerKey: string;
    taskId?: string;
    attemptId?: string;
    commandId?: string;
    messageId?: string;
    resultId?: string;
  },
): Promise<ProductFrame> {
  const {
    rows: [c],
  } = await client.query(
    'UPDATE agent_conversations SET last_event_seq=last_event_seq+1 WHERE id=$1 RETURNING *',
    [event.conversationId],
  );
  const frame = {
    schema_version: 1,
    frame_kind: 'product',
    event_id: randomUUID(),
    conversation_id: c.id,
    stream_id: c.event_stream_id,
    event_seq: c.last_event_seq,
    event_type: event.eventType,
    occurred_at: new Date().toISOString(),
    activity: { last_activity_at: iso(c.last_activity_at)!, last_message_seq: c.last_message_seq },
    payload: event.payload,
  } as ProductFrame;
  await client.query(
    `INSERT INTO agent_outbox_events(id,conversation_id,stream_id,event_seq,event_type,schema_version,payload,producer_key,payload_hash,task_id,attempt_id,command_id,message_id,result_id,operation_id,created_at)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14)`,
    [
      frame.event_id,
      c.id,
      c.event_stream_id,
      c.last_event_seq,
      frame.event_type,
      JSON.stringify(frame),
      event.producerKey,
      digest(frame),
      event.taskId ?? null,
      event.attemptId ?? null,
      event.commandId ?? null,
      event.messageId ?? null,
      event.resultId ?? null,
      frame.occurred_at,
    ],
  );
  return frame;
}
