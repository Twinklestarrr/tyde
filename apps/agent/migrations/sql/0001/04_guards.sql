-- Immediate row shapes. Every expression is total: missing JSON keys cannot pass via NULL.
ALTER TABLE agent.agent_conversations ADD CONSTRAINT ck_agent_c_shape CHECK
 (length(owner_user_id)>0 AND length(title)>0 AND row_version>=0 AND last_message_seq>=0 AND last_event_seq>=0 AND event_pruned_through_seq BETWEEN 0 AND last_event_seq);
ALTER TABLE agent.agent_tasks ADD CONSTRAINT ck_agent_t_shape CHECK
 (task_kind IN ('business_query','scheduling_draft') AND status IN ('queued','running','waiting_input','stopping','stopped','interrupted','failed','completed') AND row_version>=0 AND ((status='completed')=(completed_at IS NOT NULL)) AND jsonb_typeof(business_scope)='object');
ALTER TABLE agent.agent_attempts ADD CONSTRAINT ck_agent_a_shape CHECK
 (attempt_no>0 AND start_reason IN ('initial','provide_input','continue','retry') AND (outcome IS NULL OR outcome IN ('completed','needs_input','stopped','interrupted','failed')) AND ((ended_at IS NULL)=(outcome IS NULL)) AND ((execution_owner_id IS NULL)=(execution_generation IS NULL)) AND (execution_generation IS NULL OR execution_generation>0) AND
 ((model_requests_used IS NULL AND tool_calls_used IS NULL AND execution_deadline_at IS NULL AND limit_exceeded_kind IS NULL AND limit_exceeded_at IS NULL) OR
 (model_requests_used IS NOT NULL AND tool_calls_used IS NOT NULL AND model_requests_used>=0 AND tool_calls_used>=0 AND
  ((started_at IS NULL AND model_requests_used=0 AND tool_calls_used=0 AND execution_deadline_at IS NULL) OR (started_at IS NOT NULL AND execution_deadline_at IS NOT NULL AND execution_deadline_at>started_at)) AND
  ((limit_exceeded_kind IS NULL AND limit_exceeded_at IS NULL) OR (started_at IS NOT NULL AND limit_exceeded_kind IN ('duration','model_requests','tool_calls') AND limit_exceeded_at IS NOT NULL)))));
ALTER TABLE agent.agent_commands ADD CONSTRAINT ck_agent_q_shape CHECK
 (kind IN ('start_task','provide_input','continue_task','retry_task','stop_attempt') AND status IN ('accepted','applied','rejected') AND payload_schema_version>0 AND jsonb_typeof(payload)='object' AND input_state IN ('none','pending','consumed','handled') AND ((task_id IS NULL)=(pi_session_id IS NULL)) AND (expected_task_version IS NULL OR expected_task_version>=0) AND ((target_attempt_id IS NULL AND result_attempt_id IS NULL AND input_attempt_id IS NULL) OR task_id IS NOT NULL) AND ((status='accepted')=(processed_at IS NULL)) AND (status<>'rejected' OR input_state='none') AND
 ((input_state IN ('none','pending') AND input_attempt_id IS NULL AND input_revision_id IS NULL AND input_handling_result IS NULL) OR (input_state='consumed' AND input_attempt_id IS NOT NULL AND input_revision_id IS NOT NULL AND input_handling_result IS NULL) OR (input_state='handled' AND input_attempt_id IS NOT NULL AND input_handling_result IS NOT NULL)));
ALTER TABLE agent.pi_sessions ADD CONSTRAINT ck_agent_p_shape CHECK
 (length(native_session_id)>0 AND execution_generation>=0 AND (writer_owner_id IS NULL OR active_attempt_id IS NOT NULL) AND ((restore_issue_revision_id IS NULL AND restore_issue_code IS NULL AND restore_issue_summary IS NULL AND restore_issue_at IS NULL) OR (restore_issue_revision_id IS NOT NULL AND restore_issue_code IS NOT NULL AND restore_issue_summary IS NOT NULL AND restore_issue_at IS NOT NULL)));
ALTER TABLE agent.pi_session_entries ADD CONSTRAINT ck_agent_e_shape CHECK
 (entry_seq>0 AND jsonb_typeof(raw_entry)='object' AND raw_entry ?& ARRAY['id','type','parentId'] AND jsonb_typeof(raw_entry->'id')='string' AND jsonb_typeof(raw_entry->'type')='string' AND raw_entry->>'id'=native_entry_id AND raw_entry->>'type'=entry_type AND ((parent_entry_id IS NULL AND raw_entry->'parentId'='null'::jsonb) OR (parent_entry_id IS NOT NULL AND jsonb_typeof(raw_entry->'parentId')='string' AND raw_entry->>'parentId'=parent_entry_id)));
ALTER TABLE agent.pi_session_revisions ADD CONSTRAINT ck_agent_r_shape CHECK
 (revision_no>=0 AND last_entry_seq>=0 AND native_format_version>0 AND commit_schema_version>0 AND length(commit_hash)>0 AND jsonb_typeof(raw_header)='object' AND raw_header ?& ARRAY['id','type','version'] AND jsonb_typeof(raw_header->'id')='string' AND raw_header->>'type'='session' AND raw_header->'version'=to_jsonb(native_format_version) AND
 ((revision_no=0 AND previous_revision_id IS NULL AND last_entry_seq=0 AND active_leaf_entry_id IS NULL AND execution_snapshot_id IS NULL AND writer_attempt_id IS NULL AND writer_owner_id IS NULL AND execution_generation=0) OR (revision_no>0 AND previous_revision_id IS NOT NULL AND execution_snapshot_id IS NOT NULL AND writer_attempt_id IS NOT NULL AND writer_owner_id IS NOT NULL AND execution_generation>0)));
ALTER TABLE agent.agent_command_input_entries ADD CONSTRAINT ck_agent_i_shape CHECK (link_order>0);
ALTER TABLE agent.agent_messages ADD CONSTRAINT ck_agent_m_shape CHECK
 (message_seq>0 AND row_version>=0 AND content_schema_version>0 AND jsonb_typeof(content)='object' AND content ? 'blocks' AND jsonb_typeof(content->'blocks')='array' AND ((status<>'in_progress' AND result_id IS NULL AND NOT (status='interrupted' AND pi_session_id IS NULL)) OR content->'blocks'='[]'::jsonb) AND message_type IN ('user_input','assistant_output','notice') AND status IN ('in_progress','complete','interrupted') AND
 ((pi_session_id IS NULL AND source_revision_id IS NULL AND source_native_entry_id IS NULL) OR (pi_session_id IS NOT NULL AND source_revision_id IS NOT NULL AND source_native_entry_id IS NOT NULL)) AND
 ((message_type='user_input' AND status='complete' AND source_command_id IS NOT NULL AND attempt_id IS NULL AND result_id IS NULL AND pi_session_id IS NULL) OR
  (message_type='assistant_output' AND attempt_id IS NOT NULL AND source_command_id IS NULL AND ((status='in_progress' AND result_id IS NULL AND pi_session_id IS NULL) OR (status IN ('complete','interrupted') AND pi_session_id IS NOT NULL AND result_id IS NULL) OR (status='interrupted' AND pi_session_id IS NULL AND result_id IS NULL) OR (status='complete' AND result_id IS NOT NULL AND pi_session_id IS NULL))) OR
  (message_type='notice' AND status='complete' AND attempt_id IS NOT NULL AND source_command_id IS NULL AND result_id IS NULL AND pi_session_id IS NULL)));
ALTER TABLE agent.agent_results ADD CONSTRAINT ck_agent_d_shape CHECK
 (result_type IN ('answer','scheduling_draft') AND payload_schema_version>0 AND jsonb_typeof(payload)='object' AND jsonb_typeof(verification)='object' AND ((source_operation_id IS NULL)=(source_operation_receipt_id IS NULL)) AND ((pi_session_id IS NULL)=(source_pi_revision_id IS NULL)) AND (result_type<>'scheduling_draft' OR source_operation_id IS NOT NULL));
ALTER TABLE agent.agent_outbox_events ADD CONSTRAINT ck_agent_v_shape CHECK
 (event_seq>0 AND schema_version>0 AND event_type IN ('conversation.updated','input.updated','message.created','message.updated','operation.updated','task.updated','task.completed') AND jsonb_typeof(payload)='object' AND ((attempt_id IS NULL AND message_id IS NULL AND result_id IS NULL AND operation_id IS NULL) OR task_id IS NOT NULL));
ALTER TABLE agent.agent_operations ADD CONSTRAINT ck_agent_o_shape CHECK
 (action_version>0 AND row_version>=0 AND request_schema_version>0 AND ((action_version=1 AND previous_operation_id IS NULL AND intent_change_basis IS NULL) OR (action_version>1 AND previous_operation_id IS NOT NULL AND intent_change_basis IS NOT NULL)) AND confirmation_state IN ('prepared','unknown','processing','succeeded','failed_no_effect','conflicted') AND
 ((confirmation_state IN ('prepared','unknown') AND confirmed_receipt_id IS NULL AND conflicting_receipt_id IS NULL) OR (confirmation_state IN ('processing','succeeded','failed_no_effect') AND confirmed_receipt_id IS NOT NULL AND conflicting_receipt_id IS NULL) OR (confirmation_state='conflicted' AND confirmed_receipt_id IS NOT NULL AND conflicting_receipt_id IS NOT NULL AND confirmed_receipt_id<>conflicting_receipt_id)));
ALTER TABLE agent.agent_operation_requests ADD CONSTRAINT ck_agent_h_shape CHECK
 (request_no>0 AND request_schema_version>0 AND execution_generation>0 AND request_kind IN ('execute','status_query') AND ((closed_at IS NULL)=(transport_outcome IS NULL)) AND (transport_outcome IS NULL OR transport_outcome IN ('response_received','timeout','cancelled','connection_error','not_dispatched','orphaned')) AND (transport_outcome IS DISTINCT FROM 'not_dispatched' OR dispatch_authorized_at IS NULL) AND (transport_outcome IS DISTINCT FROM 'response_received' OR dispatch_authorized_at IS NOT NULL) AND jsonb_typeof(authorization_basis)='object');
ALTER TABLE agent.agent_operation_receipts ADD CONSTRAINT ck_agent_b_shape CHECK
 (schema_version>0 AND http_status BETWEEN 100 AND 599 AND source_kind IN ('execute_response','status_response') AND reported_state IN ('processing','succeeded','failed_no_effect','not_found','unclassified') AND verification_state IN ('accepted','rejected') AND (covered_execute_request_no IS NULL OR covered_execute_request_no>=0));
ALTER TABLE agent.agent_operation_links ADD CONSTRAINT ck_agent_l_shape CHECK
 (link_type IN ('tool_call','command','tool_result','verified_fact') AND ((pi_session_id IS NULL AND pi_revision_id IS NULL AND native_entry_id IS NULL AND native_writer_attempt_id IS NULL) OR (pi_session_id IS NOT NULL AND pi_revision_id IS NOT NULL AND native_entry_id IS NOT NULL AND native_writer_attempt_id IS NOT NULL)) AND
 ((link_type='tool_call' AND pi_session_id IS NOT NULL AND tool_call_id IS NOT NULL AND source_link_id IS NULL AND command_id IS NULL AND receipt_id IS NULL AND projection_schema_version IS NULL) OR
  (link_type='command' AND command_id IS NOT NULL AND pi_session_id IS NULL AND tool_call_id IS NULL AND source_link_id IS NULL AND receipt_id IS NULL AND projection_schema_version IS NULL) OR
  (link_type IN ('tool_result','verified_fact') AND pi_session_id IS NOT NULL AND source_link_id IS NOT NULL AND receipt_id IS NOT NULL AND projection_schema_version>0 AND tool_call_id IS NULL AND command_id IS NULL)));
ALTER TABLE agent.agent_execution_snapshots ADD CONSTRAINT ck_agent_s_shape CHECK
 (schema_version>0 AND length(scene_key)>0 AND length(snapshot_hash)>0 AND length(resource_manifest_hash)>0 AND jsonb_typeof(runtime_manifest)='object' AND jsonb_typeof(model_config)='object' AND jsonb_typeof(tool_manifest)='object' AND jsonb_typeof(execution_policy)='object');
ALTER TABLE agent.agent_resource_artifacts ADD CONSTRAINT ck_agent_f_shape CHECK
 (manifest_schema_version>0 AND archive_size_bytes>=0 AND length(artifact_key)>0 AND length(version_label)>0 AND length(archive_digest)>0 AND length(tree_digest)>0);
ALTER TABLE agent.agent_snapshot_resources ADD CONSTRAINT ck_agent_g_shape CHECK
 (load_order>=0 AND length(member_key)>0 AND length(entry_path)>0 AND resource_kind IN ('skill','prompt','extension','context','business_adapter') AND jsonb_typeof(options)='object');

CREATE FUNCTION agent.cleanup_authorized() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='tyde_agent_cleanup' AND pg_catalog.pg_has_role(session_user,r.oid,'MEMBER'))
$$;
CREATE FUNCTION agent.protect_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF TG_OP='DELETE' AND agent.cleanup_authorized() THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable Agent record: %',TG_TABLE_NAME USING ERRCODE='23514',CONSTRAINT='guard_agent_immutable';
END $$;
CREATE FUNCTION agent.protect_columns() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF (to_jsonb(NEW)-TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD)-TG_ARGV) THEN
  RAISE EXCEPTION 'immutable Agent identity: %',TG_TABLE_NAME USING ERRCODE='23514',CONSTRAINT='guard_agent_identity';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION agent.protect_transitions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE limits jsonb; task_version bigint; tracked boolean;
BEGIN
 IF TG_TABLE_NAME='agent_conversations' THEN
  IF OLD.pi_session_id IS NOT NULL AND NEW.pi_session_id IS DISTINCT FROM OLD.pi_session_id THEN RAISE EXCEPTION 'Pi binding is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_binding'; END IF;
  IF NEW.row_version<OLD.row_version OR NEW.last_message_seq<OLD.last_message_seq OR NEW.last_event_seq<OLD.last_event_seq OR NEW.event_pruned_through_seq<OLD.event_pruned_through_seq THEN
   IF NEW.event_stream_id=OLD.event_stream_id OR NEW.last_event_seq<>0 OR NEW.event_pruned_through_seq<>0 OR NEW.last_message_seq<>OLD.last_message_seq THEN RAISE EXCEPTION 'watermarks cannot regress' USING ERRCODE='23514',CONSTRAINT='guard_agent_watermark'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='agent_tasks' THEN
  IF NEW.row_version<OLD.row_version OR OLD.status='completed' AND to_jsonb(NEW)<>to_jsonb(OLD) THEN RAISE EXCEPTION 'task terminal/version is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_task_terminal'; END IF;
  IF NEW.business_scope<>OLD.business_scope AND (OLD.scope_locked_at IS NOT NULL OR NOT NEW.business_scope @> OLD.business_scope) THEN RAISE EXCEPTION 'scope may only fill absent fields before locking' USING ERRCODE='23514',CONSTRAINT='guard_agent_scope'; END IF;
  IF OLD.scope_locked_at IS NOT NULL AND NEW.scope_locked_at IS DISTINCT FROM OLD.scope_locked_at THEN RAISE EXCEPTION 'scope lock is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_scope'; END IF;
 ELSIF TG_TABLE_NAME='pi_sessions' THEN
  IF NEW.execution_generation<OLD.execution_generation THEN RAISE EXCEPTION 'generation cannot regress' USING ERRCODE='23514',CONSTRAINT='guard_agent_generation'; END IF;
 ELSIF TG_TABLE_NAME='agent_attempts' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.model_requests_used IS DISTINCT FROM 0 OR NEW.tool_calls_used IS DISTINCT FROM 0 OR NEW.started_at IS NOT NULL OR NEW.execution_deadline_at IS NOT NULL THEN RAISE EXCEPTION 'new attempt requires explicit zero counters and queued start' USING ERRCODE='23514',CONSTRAINT='guard_agent_new_attempt'; END IF;
  ELSE
   IF OLD.ended_at IS NOT NULL AND to_jsonb(NEW)<>to_jsonb(OLD) THEN RAISE EXCEPTION 'ended attempt is immutable' USING ERRCODE='23514',CONSTRAINT='guard_agent_attempt_terminal'; END IF;
   IF OLD.execution_owner_id IS NOT NULL AND (NEW.execution_owner_id IS DISTINCT FROM OLD.execution_owner_id OR NEW.execution_generation IS DISTINCT FROM OLD.execution_generation) OR OLD.base_revision_id IS NOT NULL AND NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id OR OLD.started_at IS NOT NULL AND (NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.execution_deadline_at IS DISTINCT FROM OLD.execution_deadline_at) OR OLD.stop_requested_at IS NOT NULL AND NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at OR OLD.limit_exceeded_kind IS NOT NULL AND (NEW.limit_exceeded_kind IS DISTINCT FROM OLD.limit_exceeded_kind OR NEW.limit_exceeded_at IS DISTINCT FROM OLD.limit_exceeded_at) THEN RAISE EXCEPTION 'attempt assignment/start/latch is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_attempt_assignment'; END IF;
   IF OLD.model_requests_used IS NULL AND (NEW.model_requests_used IS NOT NULL OR NEW.tool_calls_used IS NOT NULL) OR NEW.model_requests_used<OLD.model_requests_used OR NEW.tool_calls_used<OLD.tool_calls_used OR NEW.model_requests_used>OLD.model_requests_used+1 OR NEW.tool_calls_used>OLD.tool_calls_used+1 THEN RAISE EXCEPTION 'budget must reserve monotonically one call at a time' USING ERRCODE='23514',CONSTRAINT='guard_agent_budget_monotonic'; END IF;
   IF NEW.model_requests_used>OLD.model_requests_used OR NEW.tool_calls_used>OLD.tool_calls_used OR NEW.limit_exceeded_kind IS DISTINCT FROM OLD.limit_exceeded_kind THEN
    IF OLD.stop_requested_at IS NOT NULL OR OLD.limit_exceeded_kind IS NOT NULL OR NOT EXISTS(SELECT 1 FROM agent.pi_sessions p JOIN agent.agent_tasks t ON t.id=OLD.task_id JOIN agent.agent_conversations c ON c.id=t.conversation_id WHERE p.id=OLD.pi_session_id AND p.active_attempt_id=OLD.id AND p.writer_owner_id=OLD.execution_owner_id AND p.execution_generation=OLD.execution_generation AND t.status='running' AND c.deleted_at IS NULL) THEN RAISE EXCEPTION 'budget requires current active execution authority' USING ERRCODE='23514',CONSTRAINT='guard_agent_budget_authority'; END IF;
   END IF;
   IF OLD.limit_exceeded_kind IS NULL AND NEW.limit_exceeded_kind IS NOT NULL THEN
    SELECT s.execution_policy->'attempt_limits' INTO limits FROM agent.agent_tasks t JOIN agent.agent_execution_snapshots s ON s.id=t.execution_snapshot_id WHERE t.id=NEW.task_id;
    IF NEW.limit_exceeded_kind='duration' AND NEW.limit_exceeded_at<NEW.execution_deadline_at OR NEW.limit_exceeded_kind='model_requests' AND NEW.model_requests_used<>(limits->>'max_model_requests')::integer OR NEW.limit_exceeded_kind='tool_calls' AND NEW.tool_calls_used<>(limits->>'max_tool_calls')::integer THEN RAISE EXCEPTION 'limit latch must reflect first exhausted boundary' USING ERRCODE='23514',CONSTRAINT='guard_agent_limit_boundary'; END IF;
   END IF;
   IF OLD.limit_exceeded_kind IS NOT NULL AND NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at OR OLD.stop_requested_at IS NOT NULL AND NEW.limit_exceeded_kind IS DISTINCT FROM OLD.limit_exceeded_kind THEN RAISE EXCEPTION 'first stop/limit verdict wins' USING ERRCODE='23514',CONSTRAINT='guard_agent_stop_limit'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='agent_commands' THEN
  IF OLD.status<>'accepted' AND (to_jsonb(NEW)-ARRAY['input_state','input_attempt_id','input_revision_id','input_handling_result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['input_state','input_attempt_id','input_revision_id','input_handling_result']) OR OLD.status<>'accepted' AND OLD.input_state IN ('none','consumed','handled') AND (NEW.input_state IS DISTINCT FROM OLD.input_state OR NEW.input_attempt_id IS DISTINCT FROM OLD.input_attempt_id OR NEW.input_revision_id IS DISTINCT FROM OLD.input_revision_id OR NEW.input_handling_result IS DISTINCT FROM OLD.input_handling_result) THEN RAISE EXCEPTION 'command verdict/input is frozen' USING ERRCODE='23514',CONSTRAINT='guard_agent_command_terminal'; END IF;
 ELSIF TG_TABLE_NAME='agent_messages' THEN
  IF OLD.pi_session_id IS NOT NULL AND (NEW.pi_session_id IS DISTINCT FROM OLD.pi_session_id OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR NEW.source_native_entry_id IS DISTINCT FROM OLD.source_native_entry_id) OR OLD.result_id IS NOT NULL AND NEW.result_id IS DISTINCT FROM OLD.result_id THEN RAISE EXCEPTION 'message source is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_message_source'; END IF;
  IF OLD.status<>'in_progress' AND to_jsonb(NEW)<>to_jsonb(OLD) OR NEW.row_version<OLD.row_version THEN RAISE EXCEPTION 'message terminal is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_message_terminal'; END IF;
 ELSIF TG_TABLE_NAME='agent_operation_requests' THEN
  IF OLD.dispatch_authorized_at IS NOT NULL AND (NEW.dispatch_authorized_at IS DISTINCT FROM OLD.dispatch_authorized_at OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis) OR OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.transport_outcome IS DISTINCT FROM OLD.transport_outcome OR NEW.dispatch_authorized_at IS DISTINCT FROM OLD.dispatch_authorized_at) THEN RAISE EXCEPTION 'request authorization/close is fixed' USING ERRCODE='23514',CONSTRAINT='guard_agent_request_once'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION agent.check_new_native_or_result() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE p agent.pi_sessions; a agent.agent_attempts; t agent.agent_tasks;
BEGIN
 IF TG_TABLE_NAME='pi_session_revisions' THEN
  SELECT * INTO p FROM agent.pi_sessions WHERE id=NEW.pi_session_id;
  IF NEW.raw_header->>'id' IS DISTINCT FROM p.native_session_id THEN RAISE EXCEPTION 'native header identity mismatch' USING ERRCODE='23514',CONSTRAINT='guard_agent_header'; END IF;
  IF NEW.revision_no=0 THEN RETURN NEW; END IF;
  SELECT * INTO a FROM agent.agent_attempts WHERE id=NEW.writer_attempt_id;
  SELECT * INTO t FROM agent.agent_tasks WHERE id=a.task_id;
  IF p.active_attempt_id IS DISTINCT FROM a.id OR p.writer_owner_id IS DISTINCT FROM NEW.writer_owner_id OR p.execution_generation IS DISTINCT FROM NEW.execution_generation OR p.head_revision_id IS DISTINCT FROM NEW.previous_revision_id OR a.ended_at IS NOT NULL OR NEW.execution_snapshot_id IS DISTINCT FROM t.execution_snapshot_id OR EXISTS(SELECT 1 FROM agent.agent_conversations WHERE id=t.conversation_id AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'stale native writer/generation/head' USING ERRCODE='23514',CONSTRAINT='guard_agent_native_writer'; END IF;
 ELSIF TG_TABLE_NAME='agent_results' THEN
  SELECT * INTO a FROM agent.agent_attempts WHERE id=NEW.delivery_attempt_id;
  SELECT * INTO t FROM agent.agent_tasks WHERE id=NEW.task_id;
  SELECT * INTO p FROM agent.pi_sessions WHERE id=t.pi_session_id;
  IF t.status<>'running' OR a.ended_at IS NOT NULL OR a.stop_requested_at IS NOT NULL OR a.limit_exceeded_kind IS NOT NULL OR p.active_attempt_id IS DISTINCT FROM a.id OR p.writer_owner_id IS DISTINCT FROM a.execution_owner_id OR p.execution_generation IS DISTINCT FROM a.execution_generation OR a.execution_owner_id IS NULL OR a.execution_deadline_at IS NULL OR NEW.verified_at>=a.execution_deadline_at THEN RAISE EXCEPTION 'delivery is not currently authorized' USING ERRCODE='23514',CONSTRAINT='guard_agent_delivery'; END IF;
  IF NEW.result_type='scheduling_draft' AND NOT EXISTS (SELECT 1 FROM agent.agent_operation_receipts b JOIN agent.agent_operations o ON o.id=b.operation_id WHERE b.id=NEW.source_operation_receipt_id AND b.verification_state='accepted' AND b.reported_state='succeeded' AND o.confirmation_state='succeeded' AND NOT EXISTS(SELECT 1 FROM agent.agent_operations newer WHERE newer.previous_operation_id=o.id)) THEN RAISE EXCEPTION 'delivery requires current trusted success' USING ERRCODE='23514',CONSTRAINT='guard_agent_delivery_evidence'; END IF;
 ELSIF TG_TABLE_NAME='agent_execution_snapshots' THEN
  IF NOT (NEW.execution_policy ? 'attempt_limits') OR jsonb_typeof(NEW.execution_policy->'attempt_limits')<>'object' OR NEW.execution_policy#>'{attempt_limits,policy_version}' IS DISTINCT FROM '1'::jsonb OR NOT (NEW.execution_policy->'attempt_limits' ?& ARRAY['max_duration_ms','max_model_requests','max_tool_calls']) OR NOT ((NEW.execution_policy#>>'{attempt_limits,max_duration_ms}') ~ '^[1-9][0-9]*$') OR NOT ((NEW.execution_policy#>>'{attempt_limits,max_model_requests}') ~ '^[1-9][0-9]*$') OR NOT ((NEW.execution_policy#>>'{attempt_limits,max_tool_calls}') ~ '^[1-9][0-9]*$') THEN RAISE EXCEPTION 'new snapshot requires valid frozen attempt_limits' USING ERRCODE='23514',CONSTRAINT='guard_agent_snapshot_limits'; END IF;
 ELSIF TG_TABLE_NAME='agent_snapshot_resources' THEN
  IF NOT EXISTS(SELECT 1 FROM agent.agent_execution_snapshots s WHERE s.id=NEW.snapshot_id AND s.xmin::text::bigint=pg_current_xact_id()::text::bigint) THEN RAISE EXCEPTION 'members must be frozen in snapshot publication transaction' USING ERRCODE='23514',CONSTRAINT='guard_agent_snapshot_members'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Deferred checks re-read final database state. They never re-grant current execution rights.
CREATE FUNCTION agent.assert_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 -- CT01: coordination, binding and direct attempt lineage.
 IF EXISTS(SELECT 1 FROM agent.pi_sessions p LEFT JOIN agent.agent_conversations c ON c.id=p.conversation_id WHERE c.pi_session_id IS DISTINCT FROM p.id) OR EXISTS(SELECT 1 FROM agent.pi_sessions p WHERE p.active_attempt_id IS DISTINCT FROM (SELECT a.id FROM agent.agent_attempts a WHERE a.pi_session_id=p.id AND a.ended_at IS NULL) OR p.active_attempt_id IS NULL AND p.writer_owner_id IS NOT NULL OR p.writer_owner_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent.agent_attempts a WHERE a.id=p.active_attempt_id AND a.execution_owner_id=p.writer_owner_id AND a.execution_generation=p.execution_generation)) THEN RAISE EXCEPTION 'incomplete conversation/Pi/executor binding' USING ERRCODE='23514',CONSTRAINT='ct_agent_01_coordination'; END IF;
 IF EXISTS(SELECT 1 FROM agent.agent_tasks t LEFT JOIN LATERAL(SELECT * FROM agent.agent_attempts a WHERE a.task_id=t.id ORDER BY attempt_no DESC LIMIT 1) a ON true WHERE a.id IS NULL OR (t.status IN ('queued','running','stopping') AND (a.ended_at IS NOT NULL OR (t.status='stopping')<>(a.stop_requested_at IS NOT NULL))) OR (t.status NOT IN ('queued','running','stopping') AND (a.ended_at IS NULL OR a.outcome<>CASE t.status WHEN 'waiting_input' THEN 'needs_input' ELSE t.status END))) THEN RAISE EXCEPTION 'task/latest attempt state mismatch' USING ERRCODE='23514',CONSTRAINT='ct_agent_01_task'; END IF;
 IF EXISTS(SELECT 1 FROM agent.agent_attempts a JOIN agent.agent_commands q ON q.id=a.trigger_command_id LEFT JOIN agent.agent_attempts prev ON prev.id=a.previous_attempt_id WHERE q.status<>'applied' OR q.result_attempt_id IS DISTINCT FROM a.id OR (a.start_reason='initial' AND (a.attempt_no<>1 OR a.previous_attempt_id IS NOT NULL OR q.kind<>'start_task')) OR (a.start_reason<>'initial' AND (prev.id IS NULL OR prev.ended_at IS NULL OR a.attempt_no<>prev.attempt_no+1 OR q.target_attempt_id IS DISTINCT FROM prev.id OR q.kind<>CASE a.start_reason WHEN 'continue' THEN 'continue_task' WHEN 'retry' THEN 'retry_task' ELSE 'provide_input' END))) THEN RAISE EXCEPTION 'invalid attempt direct lineage' USING ERRCODE='23514',CONSTRAINT='ct_agent_01_lineage'; END IF;
 -- CT02: complete immutable original prefix and linear revisions, preserving null/older leaf.
 IF EXISTS(SELECT 1 FROM agent.pi_sessions p JOIN agent.pi_session_revisions h ON h.id=p.head_revision_id WHERE h.revision_no<>(SELECT max(r.revision_no) FROM agent.pi_session_revisions r WHERE r.pi_session_id=p.id) OR (SELECT count(*) FROM agent.pi_session_revisions r WHERE r.pi_session_id=p.id)<>h.revision_no+1 OR h.last_entry_seq<>(SELECT count(*) FROM agent.pi_session_entries e WHERE e.pi_session_id=p.id) OR h.last_entry_seq<>COALESCE((SELECT max(e.entry_seq) FROM agent.pi_session_entries e WHERE e.pi_session_id=p.id),0)) OR EXISTS(SELECT 1 FROM agent.pi_session_entries e JOIN agent.pi_session_entries parent ON parent.pi_session_id=e.pi_session_id AND parent.native_entry_id=e.parent_entry_id WHERE parent.entry_seq>=e.entry_seq) THEN RAISE EXCEPTION 'native/revision prefix is incomplete' USING ERRCODE='23514',CONSTRAINT='ct_agent_02_prefix'; END IF;
 IF EXISTS(SELECT 1 FROM agent.pi_session_revisions r JOIN agent.pi_sessions p ON p.id=r.pi_session_id LEFT JOIN agent.pi_session_revisions prev ON prev.id=r.previous_revision_id LEFT JOIN agent.pi_session_entries leaf ON leaf.pi_session_id=r.pi_session_id AND leaf.native_entry_id=r.active_leaf_entry_id LEFT JOIN agent.agent_attempts a ON a.id=r.writer_attempt_id LEFT JOIN agent.agent_tasks t ON t.id=a.task_id WHERE r.raw_header->>'id' IS DISTINCT FROM p.native_session_id OR r.revision_no>0 AND (r.revision_no<>prev.revision_no+1 OR r.last_entry_seq<prev.last_entry_seq OR r.execution_snapshot_id IS DISTINCT FROM t.execution_snapshot_id) OR leaf.entry_seq>r.last_entry_seq) OR EXISTS(SELECT 1 FROM agent.agent_attempts a WHERE a.last_committed_revision_id IS DISTINCT FROM (SELECT r.id FROM agent.pi_session_revisions r WHERE r.writer_attempt_id=a.id ORDER BY revision_no DESC LIMIT 1)) THEN RAISE EXCEPTION 'revision lineage/leaf/author mismatch' USING ERRCODE='23514',CONSTRAINT='ct_agent_02_revision'; END IF;
 -- CT03: command consumption is inseparable from actual new native entries.
 IF EXISTS(SELECT 1 FROM agent.agent_commands q WHERE q.status='accepted' OR q.input_state IN ('none','pending') AND EXISTS(SELECT 1 FROM agent.agent_command_input_entries i WHERE i.command_id=q.id) OR q.input_state='consumed' AND NOT EXISTS(SELECT 1 FROM agent.agent_command_input_entries i WHERE i.command_id=q.id) OR q.input_state='handled' AND q.input_revision_id IS NULL AND EXISTS(SELECT 1 FROM agent.agent_command_input_entries i WHERE i.command_id=q.id)) OR EXISTS(SELECT 1 FROM agent.agent_command_input_entries i JOIN agent.pi_session_revisions r ON r.id=i.input_revision_id JOIN agent.pi_session_revisions prev ON prev.id=r.previous_revision_id JOIN agent.pi_session_entries e ON e.pi_session_id=i.pi_session_id AND e.native_entry_id=i.native_entry_id WHERE e.entry_seq<=prev.last_entry_seq OR e.entry_seq>r.last_entry_seq) THEN RAISE EXCEPTION 'incomplete command/native input consumption' USING ERRCODE='23514',CONSTRAINT='ct_agent_03_input'; END IF;
 IF EXISTS(WITH RECURSIVE path AS (SELECT q.id AS command_id,r.pi_session_id,r.active_leaf_entry_id AS native_entry_id FROM agent.agent_commands q JOIN agent.pi_session_revisions r ON r.id=q.input_revision_id WHERE q.input_state='consumed' UNION ALL SELECT path.command_id,path.pi_session_id,e.parent_entry_id FROM path JOIN agent.pi_session_entries e ON e.pi_session_id=path.pi_session_id AND e.native_entry_id=path.native_entry_id WHERE e.parent_entry_id IS NOT NULL) SELECT 1 FROM agent.agent_command_input_entries i JOIN agent.agent_commands q ON q.id=i.command_id WHERE q.input_state='consumed' AND NOT EXISTS(SELECT 1 FROM path WHERE path.command_id=i.command_id AND path.native_entry_id=i.native_entry_id)) THEN RAISE EXCEPTION 'consumed input is not in committed active native path' USING ERRCODE='23514',CONSTRAINT='ct_agent_03_active_input'; END IF;
 -- CT04: product source identity and exactly one final delivery.
 IF EXISTS(SELECT 1 FROM agent.agent_commands q WHERE (SELECT count(*) FROM agent.agent_messages m WHERE m.source_command_id=q.id)<>CASE WHEN q.status='applied' AND q.kind IN ('start_task','provide_input') THEN 1 ELSE 0 END) OR EXISTS(SELECT 1 FROM agent.agent_messages m JOIN agent.pi_session_entries e ON e.pi_session_id=m.pi_session_id AND e.native_entry_id=m.source_native_entry_id JOIN agent.pi_session_revisions r ON r.id=m.source_revision_id JOIN agent.pi_session_revisions prev ON prev.id=r.previous_revision_id WHERE e.entry_seq<=prev.last_entry_seq OR e.entry_seq>r.last_entry_seq OR e.entry_type<>'message' OR e.raw_entry#>>'{message,role}' IS DISTINCT FROM 'assistant') THEN RAISE EXCEPTION 'message source is not a new native assistant/user command' USING ERRCODE='23514',CONSTRAINT='ct_agent_04_source'; END IF;
 IF EXISTS(SELECT 1 FROM agent.agent_tasks t WHERE (t.status='completed')<>EXISTS(SELECT 1 FROM agent.agent_results d WHERE d.task_id=t.id)) OR EXISTS(SELECT 1 FROM agent.agent_results d JOIN agent.agent_attempts a ON a.id=d.delivery_attempt_id JOIN agent.agent_tasks t ON t.id=d.task_id WHERE a.outcome IS DISTINCT FROM 'completed' OR a.ended_at IS NULL OR (SELECT count(*) FROM agent.agent_messages m WHERE m.result_id=d.id)<>1 OR d.result_type<>CASE t.task_kind WHEN 'scheduling_draft' THEN 'scheduling_draft' ELSE 'answer' END) OR EXISTS(SELECT 1 FROM agent.agent_messages m JOIN agent.agent_attempts a ON a.id=m.attempt_id WHERE m.status='in_progress' AND a.ended_at IS NOT NULL) THEN RAISE EXCEPTION 'completion/result/final message is not atomic' USING ERRCODE='23514',CONSTRAINT='ct_agent_04_completion'; END IF;
 -- CT05: complete current stream prefix; frozen frame matches typed references.
 IF EXISTS(SELECT 1 FROM agent.agent_conversations c WHERE c.last_message_seq<>(SELECT count(*) FROM agent.agent_messages m WHERE m.conversation_id=c.id) OR c.last_message_seq<>COALESCE((SELECT max(m.message_seq) FROM agent.agent_messages m WHERE m.conversation_id=c.id),0) OR c.last_event_seq-c.event_pruned_through_seq<>(SELECT count(*) FROM agent.agent_outbox_events v WHERE v.conversation_id=c.id) OR EXISTS(SELECT 1 FROM agent.agent_outbox_events v WHERE v.conversation_id=c.id AND (v.event_seq<=c.event_pruned_through_seq OR v.event_seq>c.last_event_seq))) THEN RAISE EXCEPTION 'product message/event prefix has gaps' USING ERRCODE='23514',CONSTRAINT='ct_agent_05_watermark'; END IF;
 IF EXISTS(SELECT 1 FROM agent.agent_outbox_events v WHERE v.payload->>'event_id' IS DISTINCT FROM v.id::text OR v.payload->>'conversation_id' IS DISTINCT FROM v.conversation_id::text OR v.payload->>'stream_id' IS DISTINCT FROM v.stream_id::text OR v.payload->>'event_seq' IS DISTINCT FROM v.event_seq::text OR v.payload->>'event_type' IS DISTINCT FROM v.event_type OR v.payload->>'frame_kind' IS DISTINCT FROM 'product' OR v.payload->'schema_version' IS DISTINCT FROM to_jsonb(v.schema_version) OR v.task_id IS NOT NULL AND v.event_type IN ('task.updated','task.completed') AND v.payload#>>'{payload,task,id}' IS DISTINCT FROM v.task_id::text OR v.message_id IS NOT NULL AND v.payload#>>'{payload,message,id}' IS DISTINCT FROM v.message_id::text) THEN RAISE EXCEPTION 'frozen outbox frame/reference mismatch' USING ERRCODE='23514',CONSTRAINT='ct_agent_05_payload'; END IF;
 -- CT06: business tables exist even while W5 exposes no real business writer.
 IF EXISTS(SELECT 1 FROM agent.agent_operations o WHERE NOT EXISTS(SELECT 1 FROM agent.agent_operation_links l WHERE l.operation_id=o.id) OR o.confirmed_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent.agent_operation_receipts b WHERE b.id=o.confirmed_receipt_id AND b.verification_state='accepted') OR o.action_version>1 AND NOT EXISTS(SELECT 1 FROM agent.agent_operations prev WHERE prev.id=o.previous_operation_id AND prev.action_version=o.action_version-1)) OR EXISTS(SELECT 1 FROM agent.agent_operation_requests h WHERE h.transport_outcome='response_received' AND NOT EXISTS(SELECT 1 FROM agent.agent_operation_receipts b WHERE b.request_id=h.id)) OR EXISTS(SELECT 1 FROM agent.agent_operation_receipts b JOIN agent.agent_operation_requests h ON h.id=b.request_id WHERE h.dispatch_authorized_at IS NULL OR b.source_kind<>CASE h.request_kind WHEN 'execute' THEN 'execute_response' ELSE 'status_response' END) OR EXISTS(SELECT 1 FROM agent.agent_operation_links l LEFT JOIN agent.agent_operation_links source ON source.id=l.source_link_id LEFT JOIN agent.agent_operation_receipts b ON b.id=l.receipt_id WHERE l.link_type IN ('tool_result','verified_fact') AND (source.link_type IS DISTINCT FROM 'tool_call' OR b.verification_state IS DISTINCT FROM 'accepted' OR l.native_writer_attempt_id<>l.linked_attempt_id)) THEN RAISE EXCEPTION 'incomplete business evidence/source ledger' USING ERRCODE='23514',CONSTRAINT='ct_agent_06_evidence'; END IF;
 IF EXISTS(SELECT 1 FROM agent.agent_tasks t JOIN agent.agent_execution_snapshots s ON s.id=t.execution_snapshot_id WHERE s.scene_key<>t.task_kind) THEN RAISE EXCEPTION 'task scene differs from fixed execution snapshot' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_scene'; END IF;
 -- CT07/08: exact fixed snapshot deadline and cap, without inventing legacy counters.
 IF EXISTS(SELECT 1 FROM agent.agent_attempts a JOIN agent.agent_tasks t ON t.id=a.task_id JOIN agent.agent_execution_snapshots s ON s.id=t.execution_snapshot_id WHERE a.model_requests_used IS NOT NULL AND (NOT s.execution_policy ? 'attempt_limits' OR a.model_requests_used>(s.execution_policy#>>'{attempt_limits,max_model_requests}')::numeric OR a.tool_calls_used>(s.execution_policy#>>'{attempt_limits,max_tool_calls}')::numeric OR a.started_at IS NOT NULL AND a.execution_deadline_at IS DISTINCT FROM a.started_at+((s.execution_policy#>>'{attempt_limits,max_duration_ms}')::numeric*interval '1 millisecond'))) THEN RAISE EXCEPTION 'attempt budget differs from frozen snapshot' USING ERRCODE='23514',CONSTRAINT='ct_agent_08_budget'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION agent.require_product_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE entity text; version_path text[];
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NULL; END IF;
 entity:=CASE TG_TABLE_NAME WHEN 'agent_tasks' THEN 'task' WHEN 'agent_messages' THEN 'message' ELSE 'operation' END;
 version_path:=ARRAY['payload',entity,'row_version'];
 IF NOT EXISTS(SELECT 1 FROM agent.agent_outbox_events v WHERE (CASE entity WHEN 'task' THEN v.task_id WHEN 'message' THEN v.message_id ELSE v.operation_id END)=NEW.id AND v.payload#>>version_path=NEW.row_version::text AND v.xmin::text::bigint=pg_current_xact_id()::text::bigint) THEN RAISE EXCEPTION 'product change requires frozen event in same transaction: %',TG_TABLE_NAME USING ERRCODE='23514',CONSTRAINT='ct_agent_product_event'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION agent.require_budget_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF (NEW.model_requests_used,NEW.tool_calls_used,NEW.limit_exceeded_kind) IS DISTINCT FROM (OLD.model_requests_used,OLD.tool_calls_used,OLD.limit_exceeded_kind) AND NOT EXISTS(SELECT 1 FROM agent.agent_tasks t JOIN agent.agent_outbox_events v ON v.task_id=t.id WHERE t.id=NEW.task_id AND t.xmin::text::bigint=pg_current_xact_id()::text::bigint AND v.xmin::text::bigint=pg_current_xact_id()::text::bigint AND v.event_type='task.updated' AND v.payload#>>'{payload,task,row_version}'=t.row_version::text AND v.payload#>>'{payload,task,latest_attempt,budget,model_requests_used}'=NEW.model_requests_used::text AND v.payload#>>'{payload,task,latest_attempt,budget,tool_calls_used}'=NEW.tool_calls_used::text) THEN RAISE EXCEPTION 'budget reservation/latch requires task version and frozen event' USING ERRCODE='23514',CONSTRAINT='ct_agent_budget_event'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION agent.protect_event_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM agent.agent_attempts a WHERE a.pi_session_id=(SELECT pi_session_id FROM agent.agent_conversations c WHERE c.id=OLD.conversation_id) AND a.ended_at IS NULL AND OLD.attempt_id=a.id AND (OLD.producer_key LIKE 'budget/%' OR OLD.producer_key LIKE 'budget:%')) THEN RAISE EXCEPTION 'active authorization evidence cannot be pruned' USING ERRCODE='23514',CONSTRAINT='guard_agent_budget_retention'; END IF;
 IF NOT agent.cleanup_authorized() THEN RAISE EXCEPTION 'event retention requires cleanup role' USING ERRCODE='42501'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER guard_pi_session_entries_immutable BEFORE UPDATE OR DELETE ON agent.pi_session_entries FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_pi_session_revisions_immutable BEFORE UPDATE OR DELETE ON agent.pi_session_revisions FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_command_input_entries_immutable BEFORE UPDATE OR DELETE ON agent.agent_command_input_entries FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_results_immutable BEFORE UPDATE OR DELETE ON agent.agent_results FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_operation_receipts_immutable BEFORE UPDATE OR DELETE ON agent.agent_operation_receipts FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_operation_links_immutable BEFORE UPDATE OR DELETE ON agent.agent_operation_links FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_execution_snapshots_immutable BEFORE UPDATE OR DELETE ON agent.agent_execution_snapshots FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_resource_artifacts_immutable BEFORE UPDATE OR DELETE ON agent.agent_resource_artifacts FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_snapshot_resources_immutable BEFORE UPDATE OR DELETE ON agent.agent_snapshot_resources FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_conversations_identity BEFORE UPDATE ON agent.agent_conversations FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('title','pi_session_id','row_version','last_message_seq','event_stream_id','last_event_seq','event_pruned_through_seq','updated_at','last_activity_at','deleted_at');
CREATE TRIGGER guard_agent_conversations_transitions BEFORE UPDATE ON agent.agent_conversations FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_agent_tasks_identity BEFORE UPDATE ON agent.agent_tasks FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('business_scope','scope_locked_at','status','row_version','updated_at','completed_at');
CREATE TRIGGER guard_agent_tasks_transitions BEFORE UPDATE ON agent.agent_tasks FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_agent_attempts_identity BEFORE UPDATE ON agent.agent_attempts FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('outcome','execution_owner_id','execution_generation','base_revision_id','last_committed_revision_id','stop_requested_at','started_at','execution_deadline_at','model_requests_used','tool_calls_used','limit_exceeded_kind','limit_exceeded_at','ended_at','error_code','error_summary');
CREATE TRIGGER guard_agent_attempts_transitions BEFORE INSERT OR UPDATE ON agent.agent_attempts FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_agent_commands_identity BEFORE UPDATE ON agent.agent_commands FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('task_id','pi_session_id','target_attempt_id','result_attempt_id','status','outcome_code','result_summary','input_state','input_attempt_id','input_revision_id','input_handling_result','processed_at');
CREATE TRIGGER guard_agent_commands_transitions BEFORE UPDATE ON agent.agent_commands FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_pi_sessions_identity BEFORE UPDATE ON agent.pi_sessions FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('head_revision_id','active_attempt_id','writer_owner_id','execution_generation','restore_issue_revision_id','restore_issue_code','restore_issue_summary','restore_issue_at','updated_at');
CREATE TRIGGER guard_pi_sessions_transitions BEFORE UPDATE ON agent.pi_sessions FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_agent_messages_identity BEFORE UPDATE ON agent.agent_messages FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('status','content','row_version','pi_session_id','source_revision_id','source_native_entry_id','result_id','updated_at');
CREATE TRIGGER guard_agent_messages_transitions BEFORE UPDATE ON agent.agent_messages FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_agent_operations_identity BEFORE UPDATE ON agent.agent_operations FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('confirmation_state','confirmed_receipt_id','conflicting_receipt_id','row_version','updated_at');
CREATE TRIGGER guard_agent_operation_requests_identity BEFORE UPDATE ON agent.agent_operation_requests FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('authorization_basis','dispatch_authorized_at','closed_at','transport_outcome','error_code','error_summary');
CREATE TRIGGER guard_agent_operation_requests_transitions BEFORE UPDATE ON agent.agent_operation_requests FOR EACH ROW EXECUTE FUNCTION agent.protect_transitions();
CREATE TRIGGER guard_pi_session_revisions_new BEFORE INSERT ON agent.pi_session_revisions FOR EACH ROW EXECUTE FUNCTION agent.check_new_native_or_result();
CREATE TRIGGER guard_agent_results_new BEFORE INSERT ON agent.agent_results FOR EACH ROW EXECUTE FUNCTION agent.check_new_native_or_result();
CREATE TRIGGER guard_agent_execution_snapshots_new BEFORE INSERT ON agent.agent_execution_snapshots FOR EACH ROW EXECUTE FUNCTION agent.check_new_native_or_result();
CREATE TRIGGER guard_agent_snapshot_resources_new BEFORE INSERT ON agent.agent_snapshot_resources FOR EACH ROW EXECUTE FUNCTION agent.check_new_native_or_result();
CREATE CONSTRAINT TRIGGER ct_agent_resource_artifacts_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_resource_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_execution_snapshots_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_execution_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_snapshot_resources_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_snapshot_resources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_conversations_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_conversations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_pi_sessions_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.pi_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_tasks_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_commands_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_attempts_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_pi_session_entries_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.pi_session_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_pi_session_revisions_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.pi_session_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_command_input_entries_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_command_input_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_operations_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_operation_requests_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_operation_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_operation_receipts_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_operation_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_operation_links_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_operation_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_results_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_messages_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_outbox_events_integrity AFTER INSERT OR UPDATE OR DELETE ON agent.agent_outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_tasks_event AFTER INSERT OR UPDATE ON agent.agent_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.require_product_event();
CREATE CONSTRAINT TRIGGER ct_agent_messages_event AFTER INSERT OR UPDATE ON agent.agent_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.require_product_event();
CREATE CONSTRAINT TRIGGER ct_agent_operations_event AFTER INSERT OR UPDATE ON agent.agent_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.require_product_event();
CREATE CONSTRAINT TRIGGER ct_agent_attempts_budget_event AFTER UPDATE ON agent.agent_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.require_budget_event();
CREATE TRIGGER guard_agent_event_update BEFORE UPDATE ON agent.agent_outbox_events FOR EACH ROW EXECUTE FUNCTION agent.protect_immutable();
CREATE TRIGGER guard_agent_event_delete BEFORE DELETE ON agent.agent_outbox_events FOR EACH ROW EXECUTE FUNCTION agent.protect_event_delete();

-- Resource manifest v1 deliberately uses PG18's deterministic JSONB text, not JCS.
-- The typed artifact projection makes bigint archive sizes decimal strings and excludes row IDs/times.
CREATE FUNCTION agent.resource_artifact_semantics(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,agent AS $$
 SELECT (to_jsonb(f)-ARRAY['id','created_at','archive_size_bytes'])||jsonb_build_object('archive_size_bytes',f.archive_size_bytes::text)
 FROM jsonb_populate_record(NULL::agent.agent_resource_artifacts,value) f
$$;
CREATE FUNCTION agent.resource_manifest_normalize(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,agent AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'member_key',m->'member_key','resource_kind',m->'resource_kind','entry_path',m->'entry_path',
  'load_order',(m->>'load_order')::integer,'options',m->'options',
  'artifact',agent.resource_artifact_semantics(m->'artifact'))
  ORDER BY (m->>'load_order')::integer,(m->>'member_key') COLLATE "C"),'[]'::jsonb)
 FROM jsonb_array_elements(value) m
$$;
CREATE FUNCTION agent.resource_manifest_digest(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,agent AS $$
 SELECT encode(sha256(convert_to(agent.resource_manifest_normalize(value)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION agent.resource_manifest_for_snapshot(snapshot uuid) RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,agent AS $$
 SELECT agent.resource_manifest_normalize(COALESCE(jsonb_agg(jsonb_build_object(
  'member_key',g.member_key,'resource_kind',g.resource_kind,'entry_path',g.entry_path,
  'load_order',g.load_order,'options',g.options,'artifact',to_jsonb(f))),'[]'::jsonb))
 FROM agent.agent_snapshot_resources g JOIN agent.agent_resource_artifacts f ON f.id=g.artifact_id WHERE g.snapshot_id=snapshot
$$;
CREATE FUNCTION agent.resource_path_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NOT NULL AND length(value)>0 AND value !~ '[\\\x00-\x1f]' AND value !~ '(^/|^[A-Za-z]:|//|/$|(^|/)\.{1,2}(/|$))'
$$;
CREATE FUNCTION agent.assert_resource_artifact(artifact uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE f agent.agent_resource_artifacts; entry jsonb; paths text[]:='{}';
BEGIN
 SELECT * INTO f FROM agent.agent_resource_artifacts WHERE id=artifact;
 IF NOT FOUND THEN RETURN; END IF;
 IF f.manifest_schema_version<>1 OR jsonb_typeof(f.source_descriptor) IS DISTINCT FROM 'object' OR jsonb_typeof(f.storage_descriptor) IS DISTINCT FROM 'object' OR jsonb_typeof(f.runtime_compatibility) IS DISTINCT FROM 'object' OR jsonb_typeof(f.publication) IS DISTINCT FROM 'object' OR jsonb_typeof(f.file_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(f.file_manifest->'files') IS DISTINCT FROM 'array' OR f.archive_digest !~ '^(sha256:)?[0-9a-f]{64}$' OR f.tree_digest !~ '^(sha256:)?[0-9a-f]{64}$' THEN RAISE EXCEPTION 'resource artifact manifest shape is invalid' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_artifact'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(f.file_manifest->'files') LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR NOT entry ?& ARRAY['path','size_bytes','sha256','mode','kind'] OR jsonb_typeof(entry->'path') IS DISTINCT FROM 'string' OR NOT agent.resource_path_valid(entry->>'path') OR (entry->>'path')=ANY(paths) OR entry->>'kind' IS DISTINCT FROM 'file' OR jsonb_typeof(entry->'size_bytes') IS DISTINCT FROM 'number' OR (entry->>'size_bytes')::numeric<0 OR (entry->>'size_bytes')::numeric>9007199254740991 OR trunc((entry->>'size_bytes')::numeric)<>(entry->>'size_bytes')::numeric OR jsonb_typeof(entry->'sha256') IS DISTINCT FROM 'string' OR entry->>'sha256' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(entry->'mode') IS DISTINCT FROM 'string' OR entry->>'mode' !~ '^[0-7]{3,4}$' OR entry ? 'exports' AND jsonb_typeof(entry->'exports') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'resource file manifest/path is invalid' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_file_manifest'; END IF;
  IF entry ? 'exports' AND EXISTS(SELECT 1 FROM jsonb_array_elements(entry->'exports') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(x#>>'{}')=0) THEN RAISE EXCEPTION 'resource exports must be explicit names' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_file_manifest'; END IF;
  paths:=array_append(paths,entry->>'path');
 END LOOP;
END $$;
CREATE FUNCTION agent.assert_resource_snapshot(snapshot uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE s agent.agent_execution_snapshots; g record; actual jsonb; tool jsonb; implementation jsonb; dependency jsonb; name text; names text[]:='{}'; file jsonb;
BEGIN
 SELECT * INTO s FROM agent.agent_execution_snapshots WHERE id=snapshot;
 IF NOT FOUND THEN RETURN; END IF;
 actual:=agent.resource_manifest_for_snapshot(snapshot);
 IF s.resource_manifest_hash IS DISTINCT FROM agent.resource_manifest_digest(actual) THEN RAISE EXCEPTION 'resource manifest differs from frozen complete members' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_resource_digest'; END IF;
 IF jsonb_typeof(s.tool_manifest->'tools') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'tool manifest requires an explicit tools array' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tools'; END IF;
 FOR tool IN SELECT value FROM jsonb_array_elements(s.tool_manifest->'tools') LOOP
  name:=tool->>'name'; implementation:=tool->'implementation';
  IF jsonb_typeof(tool) IS DISTINCT FROM 'object' OR jsonb_typeof(tool->'name') IS DISTINCT FROM 'string' OR length(name)=0 OR name=ANY(names) OR jsonb_typeof(tool->'description') IS DISTINCT FROM 'string' OR jsonb_typeof(tool->'parameters') IS DISTINCT FROM 'object' OR jsonb_typeof(tool->'output') IS DISTINCT FROM 'object' OR jsonb_typeof(implementation) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'tool declaration/implementation is incomplete' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tool_binding'; END IF;
  names:=array_append(names,name);
  IF implementation ? 'member_key' AND NOT implementation ? 'runtime_export' THEN
   IF jsonb_typeof(implementation->'member_key') IS DISTINCT FROM 'string' OR jsonb_typeof(implementation->'export_name') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM agent.agent_snapshot_resources member JOIN agent.agent_resource_artifacts artifact ON artifact.id=member.artifact_id CROSS JOIN LATERAL jsonb_array_elements(artifact.file_manifest->'files') entry WHERE member.snapshot_id=snapshot AND member.member_key=implementation->>'member_key' AND member.resource_kind IN ('extension','business_adapter') AND entry->>'path'=member.entry_path AND COALESCE(entry->'exports','[]'::jsonb) ? (implementation->>'export_name')) THEN RAISE EXCEPTION 'tool member/export is not present in frozen resources' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tool_binding'; END IF;
  ELSIF implementation ? 'runtime_export' AND NOT implementation ? 'member_key' THEN
   IF jsonb_typeof(implementation->'runtime_export') IS DISTINCT FROM 'string' OR length(implementation->>'runtime_export')=0 OR jsonb_typeof(s.runtime_manifest->'tool_exports') IS DISTINCT FROM 'array' OR NOT (s.runtime_manifest->'tool_exports') ? (implementation->>'runtime_export') THEN RAISE EXCEPTION 'tool runtime export is not pinned by runtime identity' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tool_binding'; END IF;
  ELSIF implementation->>'kind'='isolated-test-fixture' AND NOT implementation ?| ARRAY['member_key','runtime_export'] THEN
   IF s.tool_manifest->'isolated_fixture' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(implementation->'entry') IS DISTINCT FROM 'string' OR NOT agent.resource_path_valid(implementation->>'entry') OR implementation->>'entry' NOT LIKE 'tests/%' OR jsonb_typeof(implementation->'sha256') IS DISTINCT FROM 'string' OR implementation->>'sha256' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(s.runtime_manifest->'fixture_tool_exports') IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.runtime_manifest->'fixture_tool_exports') declared WHERE declared=implementation) OR jsonb_typeof(s.tool_manifest->'fixture_tool_exports') IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.tool_manifest->'fixture_tool_exports') declared WHERE declared=implementation) THEN RAISE EXCEPTION 'isolated fixture implementation is not pinned by test runtime' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tool_binding'; END IF;
  ELSE RAISE EXCEPTION 'tool implementation has no closed resource/runtime binding' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_tool_binding'; END IF;
 END LOOP;
 FOR g IN SELECT member.*,artifact.file_manifest FROM agent.agent_snapshot_resources member JOIN agent.agent_resource_artifacts artifact ON artifact.id=member.artifact_id WHERE member.snapshot_id=snapshot LOOP
  PERFORM agent.assert_resource_artifact(g.artifact_id);
  IF NOT agent.resource_path_valid(g.entry_path) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.file_manifest->'files') entry WHERE entry->>'path'=g.entry_path) OR g.resource_kind='skill' AND g.entry_path !~ '(^|/)SKILL\.md$' THEN RAISE EXCEPTION 'snapshot member entry is absent from artifact manifest' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_member_entry'; END IF;
  FOREACH name IN ARRAY ARRAY['requires_members','requires_tools','requires_files'] LOOP
   IF g.options ? name THEN
    IF jsonb_typeof(g.options->name) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'resource dependency declaration must be an array' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_resource_dependency'; END IF;
    FOR dependency IN SELECT value FROM jsonb_array_elements(g.options->name) LOOP
     IF jsonb_typeof(dependency) IS DISTINCT FROM 'string' OR name='requires_members' AND NOT EXISTS(SELECT 1 FROM agent.agent_snapshot_resources member WHERE member.snapshot_id=snapshot AND member.member_key=dependency#>>'{}') OR name='requires_tools' AND NOT (dependency#>>'{}')=ANY(names) OR name='requires_files' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.file_manifest->'files') entry WHERE entry->>'path'=dependency#>>'{}') THEN RAISE EXCEPTION 'resource/Skill dependency does not resolve inside frozen manifest' USING ERRCODE='23514',CONSTRAINT='ct_agent_07_resource_dependency'; END IF;
    END LOOP;
   END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION agent.check_resource_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
DECLARE target uuid; item record;
BEGIN
 IF TG_TABLE_NAME='agent_execution_snapshots' THEN
  IF TG_OP<>'DELETE' THEN PERFORM agent.assert_resource_snapshot(NEW.id); ELSE PERFORM agent.assert_resource_snapshot(OLD.id); END IF;
 ELSIF TG_TABLE_NAME='agent_snapshot_resources' THEN
  IF TG_OP<>'INSERT' THEN PERFORM agent.assert_resource_snapshot(OLD.snapshot_id); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM agent.assert_resource_snapshot(NEW.snapshot_id); END IF;
 ELSIF TG_TABLE_NAME='agent_resource_artifacts' THEN
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  PERFORM agent.assert_resource_artifact(target);
  FOR item IN SELECT DISTINCT snapshot_id FROM agent.agent_snapshot_resources WHERE artifact_id=target LOOP PERFORM agent.assert_resource_snapshot(item.snapshot_id); END LOOP;
 ELSE
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.execution_snapshot_id ELSE NEW.execution_snapshot_id END;
  IF target IS NOT NULL THEN PERFORM agent.assert_resource_snapshot(target); END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ct_agent_snapshots_resources AFTER INSERT OR UPDATE OR DELETE ON agent.agent_execution_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.check_resource_closure();
CREATE CONSTRAINT TRIGGER ct_agent_members_resources AFTER INSERT OR UPDATE OR DELETE ON agent.agent_snapshot_resources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.check_resource_closure();
CREATE CONSTRAINT TRIGGER ct_agent_artifacts_resources AFTER INSERT OR UPDATE OR DELETE ON agent.agent_resource_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.check_resource_closure();
CREATE CONSTRAINT TRIGGER ct_agent_tasks_resources AFTER INSERT OR UPDATE OR DELETE ON agent.agent_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.check_resource_closure();
CREATE CONSTRAINT TRIGGER ct_agent_revisions_resources AFTER INSERT OR UPDATE OR DELETE ON agent.pi_session_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.check_resource_closure();
