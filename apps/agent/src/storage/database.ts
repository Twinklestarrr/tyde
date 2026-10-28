import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool } from 'pg';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentConversationsTable {
  id: string;
  owner_user_id: string;
  title: string;
  pi_session_id: string | null;
  row_version: string;
  last_message_seq: string;
  event_stream_id: string;
  last_event_seq: string;
  event_pruned_through_seq: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  deleted_at: Date | null;
}

export interface AgentTasksTable {
  id: string;
  conversation_id: string;
  pi_session_id: string;
  task_kind: string;
  goal_text: string;
  business_scope: JsonValue;
  scope_locked_at: Date | null;
  execution_snapshot_id: string;
  status: string;
  row_version: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface AgentAttemptsTable {
  id: string;
  task_id: string;
  pi_session_id: string;
  attempt_no: number;
  trigger_command_id: string;
  previous_attempt_id: string | null;
  start_reason: string;
  outcome: string | null;
  execution_owner_id: string | null;
  execution_generation: string | null;
  base_revision_id: string | null;
  last_committed_revision_id: string | null;
  stop_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  execution_deadline_at: Date | null;
  model_requests_used: number | null;
  tool_calls_used: number | null;
  limit_exceeded_kind: string | null;
  limit_exceeded_at: Date | null;
  ended_at: Date | null;
  error_code: string | null;
  error_summary: string | null;
}

export interface AgentCommandsTable {
  id: string;
  conversation_id: string;
  actor_user_id: string;
  client_instance_id: string | null;
  request_key: string;
  kind: string;
  payload_schema_version: number;
  payload: JsonValue;
  payload_hash: string;
  task_id: string | null;
  pi_session_id: string | null;
  target_attempt_id: string | null;
  result_attempt_id: string | null;
  expected_task_version: string | null;
  status: string;
  outcome_code: string | null;
  result_summary: JsonValue | null;
  input_state: string;
  input_attempt_id: string | null;
  input_revision_id: string | null;
  input_handling_result: JsonValue | null;
  created_at: Date;
  processed_at: Date | null;
}

export interface PiSessionsTable {
  id: string;
  conversation_id: string;
  native_session_id: string;
  head_revision_id: string;
  active_attempt_id: string | null;
  writer_owner_id: string | null;
  execution_generation: string;
  restore_issue_revision_id: string | null;
  restore_issue_code: string | null;
  restore_issue_summary: string | null;
  restore_issue_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PiSessionEntriesTable {
  pi_session_id: string;
  native_entry_id: string;
  parent_entry_id: string | null;
  entry_seq: string;
  entry_type: string;
  raw_entry: JsonValue;
  created_at: Date;
}

export interface PiSessionRevisionsTable {
  id: string;
  pi_session_id: string;
  revision_no: string;
  previous_revision_id: string | null;
  last_entry_seq: string;
  active_leaf_entry_id: string | null;
  raw_header: JsonValue;
  sdk_version: string;
  native_format_version: number;
  execution_snapshot_id: string | null;
  writer_attempt_id: string | null;
  writer_owner_id: string | null;
  execution_generation: string;
  commit_key: string;
  commit_schema_version: number;
  commit_hash: string;
  commit_reason: string;
  committed_at: Date;
}

export interface AgentCommandInputEntriesTable {
  command_id: string;
  pi_session_id: string;
  input_revision_id: string;
  native_entry_id: string;
  link_order: number;
}

export interface AgentMessagesTable {
  id: string;
  conversation_id: string;
  task_id: string;
  attempt_id: string | null;
  message_seq: string;
  message_type: string;
  status: string;
  content_schema_version: number;
  content: JsonValue;
  row_version: string;
  producer_key: string;
  source_command_id: string | null;
  pi_session_id: string | null;
  source_revision_id: string | null;
  source_native_entry_id: string | null;
  result_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentResultsTable {
  id: string;
  conversation_id: string;
  task_id: string;
  delivery_attempt_id: string;
  result_type: string;
  payload_schema_version: number;
  payload: JsonValue;
  verification: JsonValue;
  source_operation_id: string | null;
  source_operation_receipt_id: string | null;
  pi_session_id: string | null;
  source_pi_revision_id: string | null;
  content_hash: string;
  verified_at: Date;
  created_at: Date;
}

export interface AgentOutboxEventsTable {
  id: string;
  conversation_id: string;
  stream_id: string;
  event_seq: string;
  event_type: string;
  schema_version: number;
  payload: JsonValue;
  producer_key: string;
  payload_hash: string;
  task_id: string | null;
  attempt_id: string | null;
  command_id: string | null;
  message_id: string | null;
  result_id: string | null;
  operation_id: string | null;
  created_at: Date;
}

export interface AgentOperationsTable {
  id: string;
  conversation_id: string;
  task_id: string;
  created_attempt_id: string;
  action_key: string;
  action_version: number;
  previous_operation_id: string | null;
  intent_change_basis: JsonValue | null;
  operation_kind: string;
  business_service: string;
  contract_version: string;
  request_schema_version: number;
  request_payload: JsonValue;
  request_hash: string;
  scope_hash: string;
  idempotency_contract: JsonValue;
  confirmation_state: string;
  confirmed_receipt_id: string | null;
  conflicting_receipt_id: string | null;
  row_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface AgentOperationRequestsTable {
  id: string;
  operation_id: string;
  task_id: string;
  attempt_id: string;
  request_no: number;
  request_kind: string;
  execution_owner_id: string;
  execution_generation: string;
  request_schema_version: number;
  request_payload: JsonValue;
  request_hash: string;
  authorization_basis: JsonValue;
  dispatch_authorized_at: Date | null;
  closed_at: Date | null;
  transport_outcome: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: Date;
}

export interface AgentOperationReceiptsTable {
  id: string;
  operation_id: string;
  task_id: string;
  request_id: string;
  schema_version: number;
  source_kind: string;
  http_status: number;
  reported_state: string;
  verification_state: string;
  verification_code: string;
  verification_basis: JsonValue;
  covered_execute_request_no: number | null;
  backend_operation_id: string | null;
  backend_state_version: string | null;
  backend_reported_at: Date | null;
  business_result: JsonValue | null;
  evidence: JsonValue;
  evidence_hash: string;
  received_at: Date;
  created_at: Date;
}

export interface AgentOperationLinksTable {
  id: string;
  operation_id: string;
  task_id: string;
  linked_attempt_id: string;
  link_type: string;
  source_link_id: string | null;
  command_id: string | null;
  pi_session_id: string | null;
  pi_revision_id: string | null;
  native_entry_id: string | null;
  native_writer_attempt_id: string | null;
  tool_call_id: string | null;
  receipt_id: string | null;
  projection_schema_version: number | null;
  created_at: Date;
}

export interface AgentExecutionSnapshotsTable {
  id: string;
  schema_version: number;
  scene_key: string;
  snapshot_hash: string;
  runtime_manifest: JsonValue;
  model_config: JsonValue;
  tool_manifest: JsonValue;
  execution_policy: JsonValue;
  resource_manifest_hash: string;
  created_at: Date;
}

export interface AgentResourceArtifactsTable {
  id: string;
  artifact_key: string;
  version_label: string;
  manifest_schema_version: number;
  source_descriptor: JsonValue;
  file_manifest: JsonValue;
  archive_digest: string;
  tree_digest: string;
  archive_size_bytes: string;
  storage_descriptor: JsonValue;
  runtime_compatibility: JsonValue;
  publication: JsonValue;
  created_at: Date;
}

export interface AgentSnapshotResourcesTable {
  snapshot_id: string;
  member_key: string;
  artifact_id: string;
  resource_kind: string;
  entry_path: string;
  load_order: number;
  options: JsonValue;
}

export interface AgentToolExecutionsTable {
  id: string;
  conversation_id: string;
  task_id: string;
  attempt_id: string;
  pi_session_id: string;
  model_request_id: string;
  tool_call_id: string;
  tool_name: string;
  source_native_entry_id: string;
  source_revision_id: string;
  result_native_entry_id: string | null;
  result_revision_id: string | null;
  status: string;
  row_version: string;
  started_at: Date;
  ended_at: Date | null;
  is_demo: boolean;
  display_label: string;
  input_summary: string;
  result_summary: string | null;
  result_ref: string | null;
  error: JsonValue | null;
}

export interface AgentDatabaseSchema {
  agent_conversations: AgentConversationsTable;
  agent_tasks: AgentTasksTable;
  agent_attempts: AgentAttemptsTable;
  agent_commands: AgentCommandsTable;
  pi_sessions: PiSessionsTable;
  pi_session_entries: PiSessionEntriesTable;
  pi_session_revisions: PiSessionRevisionsTable;
  agent_command_input_entries: AgentCommandInputEntriesTable;
  agent_messages: AgentMessagesTable;
  agent_results: AgentResultsTable;
  agent_outbox_events: AgentOutboxEventsTable;
  agent_tool_executions: AgentToolExecutionsTable;
  agent_operations: AgentOperationsTable;
  agent_operation_requests: AgentOperationRequestsTable;
  agent_operation_receipts: AgentOperationReceiptsTable;
  agent_operation_links: AgentOperationLinksTable;
  agent_execution_snapshots: AgentExecutionSnapshotsTable;
  agent_resource_artifacts: AgentResourceArtifactsTable;
  agent_snapshot_resources: AgentSnapshotResourcesTable;
}

export type AgentDatabase = Kysely<AgentDatabaseSchema>;
export type AgentTransaction = Transaction<AgentDatabaseSchema>;

export interface AgentDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  applicationName?: string;
}

export function createAgentDatabase(options: AgentDatabaseOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    application_name: options.applicationName ?? 'tyde-agent',
    options: '-c search_path=pg_catalog,agent',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const db = new Kysely<AgentDatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  return {
    pool,
    db,
    close: async () => {
      await db.destroy();
      if (!pool.ended) await pool.end();
    },
  };
}
