-- Agent baseline 0001. Fields: current designs 13–17; physical constraints: design 20.

-- This file is applied only by the dedicated Agent migration command.

CREATE TABLE agent.agent_resource_artifacts (
  id uuid NOT NULL,
  artifact_key text NOT NULL,
  version_label text NOT NULL,
  manifest_schema_version integer NOT NULL,
  source_descriptor jsonb NOT NULL,
  file_manifest jsonb NOT NULL,
  archive_digest text NOT NULL,
  tree_digest text NOT NULL,
  archive_size_bytes bigint NOT NULL,
  storage_descriptor jsonb NOT NULL,
  runtime_compatibility jsonb NOT NULL,
  publication jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_f PRIMARY KEY (id)
);

CREATE TABLE agent.agent_execution_snapshots (
  id uuid NOT NULL,
  schema_version integer NOT NULL,
  scene_key text NOT NULL,
  snapshot_hash text NOT NULL,
  runtime_manifest jsonb NOT NULL,
  model_config jsonb NOT NULL,
  tool_manifest jsonb NOT NULL,
  execution_policy jsonb NOT NULL,
  resource_manifest_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_s PRIMARY KEY (id)
);

CREATE TABLE agent.agent_snapshot_resources (
  snapshot_id uuid NOT NULL,
  member_key text NOT NULL,
  artifact_id uuid NOT NULL,
  resource_kind text NOT NULL,
  entry_path text NOT NULL,
  load_order integer NOT NULL,
  options jsonb NOT NULL,
  CONSTRAINT pk_agent_g PRIMARY KEY (snapshot_id, member_key)
);

CREATE TABLE agent.agent_conversations (
  id uuid NOT NULL,
  owner_user_id text NOT NULL,
  title text NOT NULL,
  pi_session_id uuid,
  row_version bigint NOT NULL DEFAULT 0,
  last_message_seq bigint NOT NULL DEFAULT 0,
  event_stream_id uuid NOT NULL,
  last_event_seq bigint NOT NULL DEFAULT 0,
  event_pruned_through_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT pk_agent_c PRIMARY KEY (id)
);

CREATE TABLE agent.pi_sessions (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  native_session_id text NOT NULL,
  head_revision_id uuid NOT NULL,
  active_attempt_id uuid,
  writer_owner_id text,
  execution_generation bigint NOT NULL DEFAULT 0,
  restore_issue_revision_id uuid,
  restore_issue_code text,
  restore_issue_summary text,
  restore_issue_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_p PRIMARY KEY (id)
);

CREATE TABLE agent.agent_tasks (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  pi_session_id uuid NOT NULL,
  task_kind text NOT NULL,
  goal_text text NOT NULL,
  business_scope jsonb NOT NULL,
  scope_locked_at timestamptz,
  execution_snapshot_id uuid NOT NULL,
  status text NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT pk_agent_t PRIMARY KEY (id)
);

CREATE TABLE agent.agent_commands (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  actor_user_id text NOT NULL,
  client_instance_id text,
  request_key text NOT NULL,
  kind text NOT NULL,
  payload_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  task_id uuid,
  pi_session_id uuid,
  target_attempt_id uuid,
  result_attempt_id uuid,
  expected_task_version bigint,
  status text NOT NULL,
  outcome_code text,
  result_summary jsonb,
  input_state text NOT NULL,
  input_attempt_id uuid,
  input_revision_id uuid,
  input_handling_result jsonb,
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  CONSTRAINT pk_agent_q PRIMARY KEY (id)
);

CREATE TABLE agent.agent_attempts (
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  pi_session_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  trigger_command_id uuid NOT NULL,
  previous_attempt_id uuid,
  start_reason text NOT NULL,
  outcome text,
  execution_owner_id text,
  execution_generation bigint,
  base_revision_id uuid,
  last_committed_revision_id uuid,
  stop_requested_at timestamptz,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  execution_deadline_at timestamptz,
  model_requests_used integer,
  tool_calls_used integer,
  limit_exceeded_kind text,
  limit_exceeded_at timestamptz,
  ended_at timestamptz,
  error_code text,
  error_summary text,
  CONSTRAINT pk_agent_a PRIMARY KEY (id)
);

CREATE TABLE agent.pi_session_entries (
  pi_session_id uuid NOT NULL,
  native_entry_id text NOT NULL,
  parent_entry_id text,
  entry_seq bigint NOT NULL,
  entry_type text NOT NULL,
  raw_entry jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_e PRIMARY KEY (pi_session_id, native_entry_id)
);

CREATE TABLE agent.pi_session_revisions (
  id uuid NOT NULL,
  pi_session_id uuid NOT NULL,
  revision_no bigint NOT NULL,
  previous_revision_id uuid,
  last_entry_seq bigint NOT NULL,
  active_leaf_entry_id text,
  raw_header jsonb NOT NULL,
  sdk_version text NOT NULL,
  native_format_version integer NOT NULL,
  execution_snapshot_id uuid,
  writer_attempt_id uuid,
  writer_owner_id text,
  execution_generation bigint NOT NULL,
  commit_key uuid NOT NULL,
  commit_schema_version integer NOT NULL,
  commit_hash text NOT NULL,
  commit_reason text NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_r PRIMARY KEY (id)
);

CREATE TABLE agent.agent_command_input_entries (
  command_id uuid NOT NULL,
  pi_session_id uuid NOT NULL,
  input_revision_id uuid NOT NULL,
  native_entry_id text NOT NULL,
  link_order integer NOT NULL,
  CONSTRAINT pk_agent_i PRIMARY KEY (command_id, pi_session_id, native_entry_id)
);

CREATE TABLE agent.agent_operations (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  created_attempt_id uuid NOT NULL,
  action_key text NOT NULL,
  action_version integer NOT NULL,
  previous_operation_id uuid,
  intent_change_basis jsonb,
  operation_kind text NOT NULL,
  business_service text NOT NULL,
  contract_version text NOT NULL,
  request_schema_version integer NOT NULL,
  request_payload jsonb NOT NULL,
  request_hash text NOT NULL,
  scope_hash text NOT NULL,
  idempotency_contract jsonb NOT NULL,
  confirmation_state text NOT NULL,
  confirmed_receipt_id uuid,
  conflicting_receipt_id uuid,
  row_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_o PRIMARY KEY (id)
);

CREATE TABLE agent.agent_operation_requests (
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  request_no integer NOT NULL,
  request_kind text NOT NULL,
  execution_owner_id text NOT NULL,
  execution_generation bigint NOT NULL,
  request_schema_version integer NOT NULL,
  request_payload jsonb NOT NULL,
  request_hash text NOT NULL,
  authorization_basis jsonb NOT NULL,
  dispatch_authorized_at timestamptz,
  closed_at timestamptz,
  transport_outcome text,
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_h PRIMARY KEY (id)
);

CREATE TABLE agent.agent_operation_receipts (
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  request_id uuid NOT NULL,
  schema_version integer NOT NULL,
  source_kind text NOT NULL,
  http_status integer NOT NULL,
  reported_state text NOT NULL,
  verification_state text NOT NULL,
  verification_code text NOT NULL,
  verification_basis jsonb NOT NULL,
  covered_execute_request_no integer,
  backend_operation_id text,
  backend_state_version text,
  backend_reported_at timestamptz,
  business_result jsonb,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_b PRIMARY KEY (id)
);

CREATE TABLE agent.agent_operation_links (
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  linked_attempt_id uuid NOT NULL,
  link_type text NOT NULL,
  source_link_id uuid,
  command_id uuid,
  pi_session_id uuid,
  pi_revision_id uuid,
  native_entry_id text,
  native_writer_attempt_id uuid,
  tool_call_id text,
  receipt_id uuid,
  projection_schema_version integer,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_l PRIMARY KEY (id)
);

CREATE TABLE agent.agent_results (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  delivery_attempt_id uuid NOT NULL,
  result_type text NOT NULL,
  payload_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  verification jsonb NOT NULL,
  source_operation_id uuid,
  source_operation_receipt_id uuid,
  pi_session_id uuid,
  source_pi_revision_id uuid,
  content_hash text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_d PRIMARY KEY (id)
);

CREATE TABLE agent.agent_messages (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  attempt_id uuid,
  message_seq bigint NOT NULL,
  message_type text NOT NULL,
  status text NOT NULL,
  content_schema_version integer NOT NULL,
  content jsonb NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  producer_key text NOT NULL,
  source_command_id uuid,
  pi_session_id uuid,
  source_revision_id uuid,
  source_native_entry_id text,
  result_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_m PRIMARY KEY (id)
);

CREATE TABLE agent.agent_outbox_events (
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  event_seq bigint NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  producer_key text NOT NULL,
  payload_hash text NOT NULL,
  task_id uuid,
  attempt_id uuid,
  command_id uuid,
  message_id uuid,
  result_id uuid,
  operation_id uuid,
  created_at timestamptz NOT NULL,
  CONSTRAINT pk_agent_v PRIMARY KEY (id)
);
