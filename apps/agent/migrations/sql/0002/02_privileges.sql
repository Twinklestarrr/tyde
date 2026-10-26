REVOKE ALL ON agent.agent_tool_executions FROM PUBLIC;
REVOKE ALL ON FUNCTION agent.tool_public_projection(agent.agent_tool_executions),agent.guard_tool_transition(),agent.guard_tool_insert(),agent.require_tool_event(),agent.assert_tool_integrity(),agent.assert_tool_event_reference() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON agent.agent_tool_executions TO tyde_agent_runtime;
  GRANT EXECUTE ON FUNCTION agent.tool_public_projection(agent.agent_tool_executions),agent.guard_tool_transition(),agent.guard_tool_insert(),agent.require_tool_event(),agent.assert_tool_integrity(),agent.assert_tool_event_reference() TO tyde_agent_runtime;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_publisher') THEN
  GRANT SELECT ON agent.agent_tool_executions TO tyde_agent_publisher;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_cleanup') THEN
  GRANT SELECT,DELETE ON agent.agent_tool_executions TO tyde_agent_cleanup;
  GRANT EXECUTE ON FUNCTION agent.tool_public_projection(agent.agent_tool_executions),agent.guard_tool_transition(),agent.guard_tool_insert(),agent.require_tool_event(),agent.assert_tool_integrity(),agent.assert_tool_event_reference() TO tyde_agent_cleanup;
 END IF;
END $$;
