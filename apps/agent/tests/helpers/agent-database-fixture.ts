import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Isolated internal storage fixture. It never enters the browser/tool registry. */
export async function createAgentDatabaseFixture(
  pool: Pool,
  options: { startedAt?: Date; owner?: string } = {},
) {
  const ids = {
    conversation: randomUUID(),
    pi: randomUUID(),
    revision: randomUUID(),
    task: randomUUID(),
    command: randomUUID(),
    attempt: randomUUID(),
    message: randomUUID(),
    snapshot: randomUUID(),
    stream: randomUUID(),
    nativeSession: randomUUID(),
  };
  const owner = options.owner ?? `fixture-process/${randomUUID()}`;
  const user = `fixture-user/${randomUUID()}`;
  const now = options.startedAt ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agent.agent_execution_snapshots VALUES($1,1,'business_query',$2,$3,$4,$5,$6,$7,$8)`,
      [
        ids.snapshot,
        randomUUID(),
        { sdk_version: '1.3.0', native_format_version: 3, runtime_version: 'tyde-pi-native-v1' },
        {},
        { tools: [] },
        {
          attempt_limits: {
            policy_version: 1,
            max_duration_ms: 600000,
            max_model_requests: 12,
            max_tool_calls: 10,
          },
        },
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        now,
      ],
    );
    await client.query(
      `INSERT INTO agent.agent_conversations VALUES($1,$2,'Isolated storage fixture',NULL,0,0,$3,0,0,$4,$4,$4,NULL)`,
      [ids.conversation, user, ids.stream, now],
    );
    await client.query('SET CONSTRAINTS agent.fk_agent_17_p_r DEFERRED');
    await client.query(
      `INSERT INTO agent.pi_sessions VALUES($1,$2,$3,$4,NULL,NULL,0,NULL,NULL,NULL,NULL,$5,$5)`,
      [ids.pi, ids.conversation, ids.nativeSession, ids.revision, now],
    );
    await client.query(
      `INSERT INTO agent.pi_session_revisions VALUES($1,$2,0,NULL,0,NULL,$3,'1.3.0',3,NULL,NULL,NULL,0,$4,1,$5,'initialization',$6)`,
      [
        ids.revision,
        ids.pi,
        {
          type: 'session',
          version: 3,
          id: ids.nativeSession,
          timestamp: now.toISOString(),
          cwd: '/isolated-fixture',
        },
        randomUUID(),
        randomUUID(),
        now,
      ],
    );
    await client.query(
      `UPDATE agent.agent_conversations SET pi_session_id=$2,row_version=1 WHERE id=$1`,
      [ids.conversation, ids.pi],
    );
    await client.query(
      `INSERT INTO agent.agent_commands VALUES($1,$2,$3,NULL,$4,'start_task',1,$5,$6,NULL,NULL,NULL,NULL,NULL,'accepted',NULL,NULL,'pending',NULL,NULL,NULL,$7,NULL)`,
      [
        ids.command,
        ids.conversation,
        user,
        randomUUID(),
        { text: 'storage fixture' },
        randomUUID(),
        now,
      ],
    );
    await client.query(
      `INSERT INTO agent.agent_tasks VALUES($1,$2,$3,'business_query','storage fixture','{}',NULL,$4,'queued',0,$5,$5,NULL)`,
      [ids.task, ids.conversation, ids.pi, ids.snapshot, now],
    );
    await client.query(`UPDATE agent.agent_commands SET task_id=$2,pi_session_id=$3 WHERE id=$1`, [
      ids.command,
      ids.task,
      ids.pi,
    ]);
    await client.query(
      `INSERT INTO agent.agent_attempts(id,task_id,pi_session_id,attempt_no,trigger_command_id,start_reason,model_requests_used,tool_calls_used,created_at) VALUES($1,$2,$3,1,$4,'initial',0,0,$5)`,
      [ids.attempt, ids.task, ids.pi, ids.command, now],
    );
    await client.query(
      `UPDATE agent.agent_commands SET result_attempt_id=$2,status='applied',outcome_code='ATTEMPT_CREATED',result_summary=$3,processed_at=$4 WHERE id=$1`,
      [ids.command, ids.attempt, { task_id: ids.task, attempt_id: ids.attempt }, now],
    );
    await client.query(`UPDATE agent.pi_sessions SET active_attempt_id=$2 WHERE id=$1`, [
      ids.pi,
      ids.attempt,
    ]);
    await client.query(
      `INSERT INTO agent.agent_messages VALUES($1,$2,$3,NULL,1,'user_input','complete',1,$4,0,$5,$6,NULL,NULL,NULL,NULL,$7,$7)`,
      [
        ids.message,
        ids.conversation,
        ids.task,
        { blocks: [{ type: 'text', text: 'storage fixture' }], context: null },
        `input/${ids.command}`,
        ids.command,
        now,
      ],
    );
    await client.query(`UPDATE agent.agent_conversations SET last_message_seq=1 WHERE id=$1`, [
      ids.conversation,
    ]);
    await insertFixtureFrame(
      client,
      ids,
      'message.created',
      1,
      { message: { id: ids.message, row_version: '0' } },
      { messageId: ids.message },
    );
    await insertFixtureFrame(client, ids, 'task.updated', 2, {
      task: { id: ids.task, row_version: '0' },
    });
    await client.query(
      `UPDATE agent.pi_sessions SET writer_owner_id=$2,execution_generation=1 WHERE id=$1`,
      [ids.pi, owner],
    );
    await client.query(
      `UPDATE agent.agent_attempts SET execution_owner_id=$2,execution_generation=1,base_revision_id=$3,started_at=$4,execution_deadline_at=$4::timestamptz+interval '600000 milliseconds' WHERE id=$1`,
      [ids.attempt, owner, ids.revision, now],
    );
    await client.query(`UPDATE agent.agent_tasks SET status='running',row_version=1 WHERE id=$1`, [
      ids.task,
    ]);
    await insertFixtureFrame(client, ids, 'task.updated', 3, {
      task: {
        id: ids.task,
        row_version: '1',
        latest_attempt: { id: ids.attempt, budget: { model_requests_used: 0, tool_calls_used: 0 } },
      },
    });
    await client.query(`UPDATE agent.agent_conversations SET last_event_seq=3 WHERE id=$1`, [
      ids.conversation,
    ]);
    await client.query('COMMIT');
    return { ...ids, owner, user, startedAt: now };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertFixtureFrame(
  client: PoolClient,
  ids: { conversation: string; stream: string; task: string; attempt: string },
  eventType: string,
  eventSeq: number,
  payload: unknown,
  options: { messageId?: string } = {},
) {
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO agent.agent_outbox_events(id,conversation_id,stream_id,event_seq,event_type,schema_version,payload,producer_key,payload_hash,task_id,attempt_id,message_id,created_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,clock_timestamp())`,
    [
      eventId,
      ids.conversation,
      ids.stream,
      String(eventSeq),
      eventType,
      {
        schema_version: 1,
        frame_kind: 'product',
        event_id: eventId,
        conversation_id: ids.conversation,
        stream_id: ids.stream,
        event_seq: String(eventSeq),
        event_type: eventType,
        payload,
      },
      `fixture/${eventId}`,
      randomUUID(),
      ids.task,
      ids.attempt,
      options.messageId ?? null,
    ],
  );
}
