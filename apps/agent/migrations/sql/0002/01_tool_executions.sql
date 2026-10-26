-- Additive W4/W5 integration. Never edit the previously installed 0001 baseline.
CREATE TABLE agent.agent_tool_executions (
 id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL,
 task_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 pi_session_id uuid NOT NULL,
 model_request_id text NOT NULL,
 tool_call_id text NOT NULL,
 tool_name text NOT NULL,
 source_native_entry_id text NOT NULL,
 source_revision_id uuid NOT NULL,
 result_native_entry_id text,
 result_revision_id uuid,
 status text NOT NULL,
 row_version bigint NOT NULL,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 is_demo boolean NOT NULL,
 display_label text NOT NULL,
 input_summary text NOT NULL,
 result_summary text,
 result_ref uuid UNIQUE,
 error jsonb,
 CONSTRAINT uq_agent_tool_call UNIQUE(attempt_id,tool_call_id),
 CONSTRAINT fk_agent_tool_task_conversation FOREIGN KEY(task_id,conversation_id) REFERENCES agent.agent_tasks(id,conversation_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_task_session FOREIGN KEY(task_id,pi_session_id) REFERENCES agent.agent_tasks(id,pi_session_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_attempt FOREIGN KEY(attempt_id,task_id) REFERENCES agent.agent_attempts(id,task_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_source_revision FOREIGN KEY(source_revision_id,pi_session_id,attempt_id) REFERENCES agent.pi_session_revisions(id,pi_session_id,writer_attempt_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_source_entry FOREIGN KEY(pi_session_id,source_native_entry_id) REFERENCES agent.pi_session_entries(pi_session_id,native_entry_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_result_revision FOREIGN KEY(result_revision_id,pi_session_id,attempt_id) REFERENCES agent.pi_session_revisions(id,pi_session_id,writer_attempt_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT fk_agent_tool_result_entry FOREIGN KEY(pi_session_id,result_native_entry_id) REFERENCES agent.pi_session_entries(pi_session_id,native_entry_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT ck_agent_tool_identity CHECK(row_version>0 AND length(model_request_id) BETWEEN 1 AND 200 AND length(tool_call_id) BETWEEN 1 AND 200 AND length(tool_name) BETWEEN 1 AND 80 AND length(display_label) BETWEEN 1 AND 160 AND length(input_summary)<=500),
 CONSTRAINT ck_agent_tool_result_link CHECK((result_native_entry_id IS NULL)=(result_revision_id IS NULL)),
 CONSTRAINT ck_agent_tool_state CHECK(
  status='running' AND ended_at IS NULL AND result_ref IS NULL AND result_summary IS NULL AND error IS NULL AND result_native_entry_id IS NULL OR
  status='succeeded' AND ended_at IS NOT NULL AND ended_at>=started_at AND result_ref IS NOT NULL AND result_summary IS NOT NULL AND length(result_summary) BETWEEN 1 AND 1000 AND error IS NULL AND result_native_entry_id IS NOT NULL OR
  status IN ('failed','cancelled') AND ended_at IS NOT NULL AND ended_at>=started_at AND result_ref IS NULL AND result_summary IS NULL AND error IS NOT NULL),
 CONSTRAINT ck_agent_tool_error CHECK(error IS NULL OR jsonb_typeof(error)='object' AND error ?& ARRAY['code','message'] AND error-ARRAY['code','message']='{}'::jsonb AND jsonb_typeof(error->'message')='string' AND length(error->>'message') BETWEEN 1 AND 500 AND jsonb_typeof(error->'code')='string' AND error->>'code' IN ('invalid_arguments','tool_failed','cancelled','budget_exceeded','timeout'))
);
CREATE INDEX ix_agent_tool_history ON agent.agent_tool_executions(conversation_id,task_id,started_at,id);

ALTER TABLE agent.agent_outbox_events DROP CONSTRAINT ck_agent_v_shape;
ALTER TABLE agent.agent_outbox_events ADD CONSTRAINT ck_agent_v_shape CHECK
 (event_seq>0 AND schema_version>0 AND event_type IN ('conversation.updated','input.updated','message.created','message.updated','operation.updated','task.updated','task.completed','tool.updated') AND jsonb_typeof(payload)='object' AND ((attempt_id IS NULL AND message_id IS NULL AND result_id IS NULL AND operation_id IS NULL) OR task_id IS NOT NULL));

CREATE FUNCTION agent.tool_public_projection(t agent.agent_tool_executions) RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,agent AS $$
 SELECT jsonb_build_object('id',t.id,'conversation_id',t.conversation_id,'task_id',t.task_id,'attempt_id',t.attempt_id,
  'model_request_id',t.model_request_id,'tool_call_id',t.tool_call_id,'tool_name',t.tool_name,'status',t.status,
  'row_version',t.row_version::text,'started_at',to_char(t.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'ended_at',to_char(t.ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'is_demo',t.is_demo,'display_label',t.display_label,'input_summary',t.input_summary,
  'result_summary',t.result_summary,'result_ref',t.result_ref,'error',t.error)
$$;

CREATE FUNCTION agent.guard_tool_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF OLD.status<>'running' OR NEW.row_version<>OLD.row_version+1 OR NEW.status='running' THEN
  RAISE EXCEPTION 'tool terminal state/version cannot be reopened or overwritten' USING ERRCODE='23514',CONSTRAINT='guard_agent_tool_terminal';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_agent_tool_identity BEFORE UPDATE ON agent.agent_tool_executions FOR EACH ROW EXECUTE FUNCTION agent.protect_columns('result_native_entry_id','result_revision_id','status','row_version','ended_at','result_summary','result_ref','error');
CREATE TRIGGER guard_agent_tool_terminal BEFORE UPDATE ON agent.agent_tool_executions FOR EACH ROW EXECUTE FUNCTION agent.guard_tool_transition();

CREATE FUNCTION agent.guard_tool_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF NEW.row_version<>1 OR NOT EXISTS(SELECT 1 FROM agent.agent_attempts a JOIN agent.pi_sessions p ON p.id=a.pi_session_id WHERE a.id=NEW.attempt_id AND a.ended_at IS NULL AND p.active_attempt_id=a.id AND p.writer_owner_id=a.execution_owner_id AND p.execution_generation=a.execution_generation) THEN
  RAISE EXCEPTION 'tool projection requires current unended execution' USING ERRCODE='23514',CONSTRAINT='guard_agent_tool_authority';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_agent_tool_authority BEFORE INSERT ON agent.agent_tool_executions FOR EACH ROW EXECUTE FUNCTION agent.guard_tool_insert();

CREATE FUNCTION agent.require_tool_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agent.agent_outbox_events v WHERE v.conversation_id=NEW.conversation_id AND v.task_id=NEW.task_id AND v.attempt_id=NEW.attempt_id AND v.event_type='tool.updated' AND v.payload#>'{payload,tool_execution}'=agent.tool_public_projection(NEW) AND v.xmin::text::bigint=pg_current_xact_id()::text::bigint) THEN
  RAISE EXCEPTION 'tool change requires matching safe frozen event in same transaction' USING ERRCODE='23514',CONSTRAINT='ct_agent_tool_event';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ct_agent_tool_event AFTER INSERT OR UPDATE ON agent.agent_tool_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.require_tool_event();

CREATE FUNCTION agent.assert_tool_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM agent.agent_tool_executions t
  JOIN agent.agent_attempts a ON a.id=t.attempt_id
  JOIN agent.pi_session_entries source ON source.pi_session_id=t.pi_session_id AND source.native_entry_id=t.source_native_entry_id
  JOIN agent.pi_session_revisions sr ON sr.id=t.source_revision_id
  LEFT JOIN agent.pi_session_entries result ON result.pi_session_id=t.pi_session_id AND result.native_entry_id=t.result_native_entry_id
  LEFT JOIN agent.pi_session_revisions rr ON rr.id=t.result_revision_id
  WHERE a.ended_at IS NOT NULL AND t.status='running' OR source.entry_seq>sr.last_entry_seq OR source.entry_type<>'message' OR source.raw_entry#>>'{message,role}' IS DISTINCT FROM 'assistant'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source.raw_entry#>'{message,content}') part WHERE part->>'type'='toolCall' AND part->>'id'=t.tool_call_id AND part->>'name'=t.tool_name)
   OR NOT EXISTS(SELECT 1 FROM agent.pi_session_revisions written JOIN agent.pi_session_revisions previous ON previous.id=written.previous_revision_id WHERE written.pi_session_id=t.pi_session_id AND written.writer_attempt_id=t.attempt_id AND source.entry_seq>previous.last_entry_seq AND source.entry_seq<=written.last_entry_seq)
   OR NOT EXISTS(SELECT 1 FROM agent.pi_session_entries observation WHERE observation.pi_session_id=t.pi_session_id AND observation.entry_seq<=sr.last_entry_seq AND observation.raw_entry->>'customType' IN ('tyde.model.usage-observation','tyde.maas.usage-observation') AND observation.raw_entry#>>'{data,modelRequestId}'=t.model_request_id AND observation.raw_entry#>>'{data,sourceNativeEntryId}'=t.source_native_entry_id)
   OR result.entry_seq>rr.last_entry_seq OR result.entry_type<>'message' OR result.raw_entry#>>'{message,role}' IS DISTINCT FROM 'toolResult' AND result.native_entry_id IS NOT NULL
   OR result.native_entry_id IS NOT NULL AND (result.raw_entry#>>'{message,toolCallId}' IS DISTINCT FROM t.tool_call_id OR result.raw_entry#>>'{message,toolName}' IS DISTINCT FROM t.tool_name)
   OR t.status='succeeded' AND result.raw_entry#>'{message,isError}' IS DISTINCT FROM 'false'::jsonb) THEN
  RAISE EXCEPTION 'tool/native identity, result or terminal attempt differs' USING ERRCODE='23514',CONSTRAINT='ct_agent_tool_native';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ct_agent_tool_native AFTER INSERT OR UPDATE OR DELETE ON agent.agent_tool_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_tool_integrity();
CREATE CONSTRAINT TRIGGER ct_agent_attempt_tool_terminal AFTER UPDATE ON agent.agent_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_tool_integrity();

CREATE FUNCTION agent.assert_tool_event_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,agent AS $$
BEGIN
 IF NEW.event_type='tool.updated' AND (NEW.task_id IS NULL OR NEW.attempt_id IS NULL OR NEW.operation_id IS NOT NULL OR
  NOT EXISTS(SELECT 1 FROM agent.agent_tool_executions t WHERE t.conversation_id=NEW.conversation_id AND t.task_id=NEW.task_id AND t.attempt_id=NEW.attempt_id AND agent.tool_public_projection(t)=NEW.payload#>'{payload,tool_execution}')) THEN
  RAISE EXCEPTION 'tool event has no matching safe tool projection' USING ERRCODE='23514',CONSTRAINT='ct_agent_tool_event_reference';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ct_agent_tool_event_reference AFTER INSERT ON agent.agent_outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent.assert_tool_event_reference();

