-- Cluster roles are provisioned separately by the database administrator (see roles.sql).
-- PUBLIC never gains an Agent object privilege through a default grant.
REVOKE ALL ON SCHEMA agent FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA agent FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agent FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_runtime') THEN
  GRANT USAGE ON SCHEMA agent TO tyde_agent_runtime;
  GRANT SELECT ON ALL TABLES IN SCHEMA agent TO tyde_agent_runtime;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agent TO tyde_agent_runtime;
  GRANT INSERT ON agent.agent_conversations,agent.pi_sessions,agent.agent_tasks,agent.agent_commands,agent.agent_attempts,agent.pi_session_entries,agent.pi_session_revisions,agent.agent_command_input_entries,agent.agent_operations,agent.agent_operation_requests,agent.agent_operation_receipts,agent.agent_operation_links,agent.agent_results,agent.agent_messages,agent.agent_outbox_events TO tyde_agent_runtime;
  GRANT UPDATE ON agent.agent_conversations,agent.pi_sessions,agent.agent_tasks,agent.agent_commands,agent.agent_attempts,agent.agent_operations,agent.agent_operation_requests,agent.agent_messages TO tyde_agent_runtime;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_publisher') THEN
  GRANT USAGE ON SCHEMA agent TO tyde_agent_publisher;
  GRANT SELECT ON ALL TABLES IN SCHEMA agent TO tyde_agent_publisher;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agent TO tyde_agent_publisher;
  GRANT INSERT ON agent.agent_resource_artifacts,agent.agent_execution_snapshots,agent.agent_snapshot_resources TO tyde_agent_publisher;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_cleanup') THEN
  GRANT USAGE ON SCHEMA agent TO tyde_agent_cleanup;
  GRANT SELECT,DELETE ON ALL TABLES IN SCHEMA agent TO tyde_agent_cleanup;
  GRANT UPDATE ON agent.agent_conversations TO tyde_agent_cleanup;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agent TO tyde_agent_cleanup;
 END IF;
END $$;
