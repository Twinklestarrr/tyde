-- Run only as the administrator of the confirmed Agent database/cluster.
-- NOLOGIN group roles keep credentials outside SQL and separate operational grants.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_runtime') THEN CREATE ROLE tyde_agent_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_publisher') THEN CREATE ROLE tyde_agent_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tyde_agent_cleanup') THEN CREATE ROLE tyde_agent_cleanup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
END $$;
-- Grant exactly one group to each separately managed LOGIN role as appropriate.
-- Do not grant tyde_agent_cleanup or object ownership to the HTTP runtime login.
