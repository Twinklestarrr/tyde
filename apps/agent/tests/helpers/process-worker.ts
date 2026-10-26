import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAgentDatabase } from '../../src/storage/database.js';
import { NativeStore, freezeCommit } from '../../src/storage/native-store.js';
import { appendEvent, projectInput, projectMessage } from '../../src/storage/projections.js';
import { localExecutionOwner } from '../../src/execution/process-identity.js';
import { PersistentBudget } from '../../src/execution/persistent-budget.js';
import { createAgentDatabaseFixture } from './agent-database-fixture.js';

// This process is spawned only by process-recovery.integration.ts. It has no browser or tools.
if (!process.send) throw new Error('Isolated worker requires its parent IPC channel');
const connectionString = process.env.AGENT_TEST_DATABASE_URL;
if (!connectionString) throw new Error('AGENT_TEST_DATABASE_URL is required');
const database = createAgentDatabase({
  connectionString,
  applicationName: 'tyde-agent-isolated-crash-worker',
});
const fixture = await createAgentDatabaseFixture(database.pool, { owner: localExecutionOwner() });
const authority = {
  conversationId: fixture.conversation,
  taskId: fixture.task,
  piSessionId: fixture.pi,
  attemptId: fixture.attempt,
  ownerId: fixture.owner,
  generation: '1',
  expectedHeadRevisionId: fixture.revision,
};
const client = await database.pool.connect();
const outputId = randomUUID();
try {
  await client.query('BEGIN');
  const {
    rows: [conversation],
  } = await client.query(
    'UPDATE agent_conversations SET last_message_seq=last_message_seq+1 WHERE id=$1 RETURNING *',
    [fixture.conversation],
  );
  const {
    rows: [message],
  } = await client.query(
    `INSERT INTO agent_messages(id,conversation_id,task_id,attempt_id,message_seq,message_type,status,content_schema_version,content,row_version,producer_key,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'assistant_output','in_progress',1,$6,0,$7,clock_timestamp(),clock_timestamp()) RETURNING *`,
    [
      outputId,
      fixture.conversation,
      fixture.task,
      fixture.attempt,
      conversation.last_message_seq,
      { blocks: [], context: null },
      `isolated-output:${fixture.attempt}`,
    ],
  );
  await appendEvent(client, {
    conversationId: fixture.conversation,
    eventType: 'message.created',
    payload: { message: projectMessage(message), input_receipt: null },
    producerKey: `isolated-output-created:${fixture.attempt}`,
    taskId: fixture.task,
    attemptId: fixture.attempt,
    messageId: outputId,
  });
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
if (process.argv[2] === 'after_input') {
  const native = new NativeStore(database.pool, () => {});
  const { state } = await native.load(fixture.pi);
  const manager = SessionManager.inMemory('/isolated/crash-worker');
  const inputId = manager.appendMessage({
    role: 'user',
    content: 'storage fixture',
    timestamp: Date.now(),
  });
  const revision = await native.commit(
    freezeCommit(
      authority,
      { ...state, entries: manager.getEntries(), leafId: inputId },
      'isolated-input',
    ),
    async (transaction, revisionId) => {
      const {
        rows: [command],
      } = await transaction.query(
        "UPDATE agent_commands SET input_state='consumed',input_attempt_id=$2,input_revision_id=$3 WHERE id=$1 RETURNING *",
        [fixture.command, fixture.attempt, revisionId],
      );
      await transaction.query(
        'INSERT INTO agent_command_input_entries(command_id,pi_session_id,input_revision_id,native_entry_id,link_order) VALUES($1,$2,$3,$4,1)',
        [fixture.command, fixture.pi, revisionId, inputId],
      );
      await appendEvent(transaction, {
        conversationId: fixture.conversation,
        eventType: 'input.updated',
        payload: { input_receipt: projectInput(command, fixture.message) },
        producerKey: `isolated-input-consumed:${fixture.command}`,
        taskId: fixture.task,
        attemptId: fixture.attempt,
        commandId: fixture.command,
      });
    },
  );
  authority.expectedHeadRevisionId = revision;
  // A process exit after a confirmed reservation cannot grant a replacement sender permission.
  await new PersistentBudget(database.pool).reserve(authority, {
    kind: 'model',
    modelRequestId: randomUUID(),
  });
}
process.send({ stage: 'ready', fixture, authority, outputId, inputStage: process.argv[2] });
// Remain alive until the test SIGKILLs this exact child. No periodic execution or heartbeat inference.
setInterval(() => {}, 1000);
