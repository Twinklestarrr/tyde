import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client, type Pool, type PoolClient } from 'pg';

export const AGENT_BASELINE_VERSION = '0001_agent_baseline';
export const AGENT_SCHEMA_VERSION = '0002_tool_executions';
const migrationDirectory = new URL('../../migrations/', import.meta.url);
const files = [
  '01_tables.sql',
  '02_indexes.sql',
  '03_foreign_keys.sql',
  '04_guards.sql',
  '05_privileges.sql',
] as const;

/** The immutable 0001 resources remain available for baseline/permission fixtures. */
export async function loadAgentMigration() {
  const resources = await Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(new URL(`sql/0001/${name}`, migrationDirectory), 'utf8'),
    })),
  );
  const checksum = createHash('sha256');
  for (const resource of resources)
    checksum.update(resource.name).update('\0').update(resource.sql);
  return { version: AGENT_BASELINE_VERSION, checksum: checksum.digest('hex'), resources };
}

export async function loadAgentMigrations() {
  const baseline = await loadAgentMigration();
  const resources = await Promise.all(
    ['01_tool_executions.sql', '02_privileges.sql'].map(async (name) => ({
      name,
      sql: await readFile(new URL(`sql/0002/${name}`, migrationDirectory), 'utf8'),
    })),
  );
  const checksum = createHash('sha256');
  for (const resource of resources)
    checksum.update(resource.name).update('\0').update(resource.sql);
  return [baseline, { version: AGENT_SCHEMA_VERSION, checksum: checksum.digest('hex'), resources }];
}

type Queryable = Pick<Pool | PoolClient | Client, 'query'>;

export async function assertPostgres18(database: Queryable): Promise<void> {
  const result = await database.query<{ server_version_num: string }>('SHOW server_version_num');
  if (Math.floor(Number(result.rows[0]?.server_version_num) / 10_000) !== 18) {
    throw new Error('Agent PostgreSQL 持久模式要求 PostgreSQL 18；不会自动迁移或回退内存');
  }
}

/** Dedicated stable connection, one full transaction, and one schema-scoped migration lock. */
export async function migrateAgentDatabase(connectionString: string): Promise<{
  version: string;
  checksum: string;
  applied: boolean;
}> {
  const migrations = await loadAgentMigrations();
  const latest = migrations.at(-1)!;
  const client = new Client({ connectionString, application_name: 'tyde-agent-migration' });
  await client.connect();
  try {
    await assertPostgres18(client);
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('tyde:agent:schema-migration',0))",
    );
    const existing = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('agent.schema_migrations') IS NOT NULL AS exists",
    );
    let installed = 0;
    if (existing.rows[0]?.exists) {
      const history = await client.query<{
        version: string;
        checksum: string;
        definition_hash: string;
      }>('SELECT version,checksum,definition_hash FROM agent.schema_migrations ORDER BY version');
      installed = history.rows.length;
      if (
        !installed ||
        installed > migrations.length ||
        history.rows.some(
          (row, index) =>
            row.version !== migrations[index]?.version ||
            row.checksum !== migrations[index]?.checksum,
        )
      )
        throw new Error('Agent 已应用迁移历史或摘要不兼容；必须追加迁移，不能覆盖历史');
      if (history.rows.at(-1)!.definition_hash !== (await agentDefinitionHash(client)))
        throw new Error('Agent 已安装对象定义漂移；拒绝在未确认基线上升级');
    } else {
      const objects = await client.query<{ count: string }>(
        "SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='agent'",
      );
      if (objects.rows[0]?.count !== '0')
        throw new Error('Agent schema 已有未登记对象；拒绝猜测基线或操作既有数据');
      await client.query('CREATE SCHEMA IF NOT EXISTS agent');
      await client.query(
        'CREATE TABLE agent.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, definition_hash text NOT NULL, applied_at timestamptz NOT NULL)',
      );
    }
    for (const migration of migrations.slice(installed)) {
      for (const resource of migration.resources) await client.query(resource.sql);
      await client.query(
        'INSERT INTO agent.schema_migrations(version,checksum,definition_hash,applied_at) VALUES ($1,$2,$3,clock_timestamp())',
        [migration.version, migration.checksum, await agentDefinitionHash(client)],
      );
    }
    await client.query('COMMIT');
    await checkAgentDatabase(client);
    return {
      version: latest.version,
      checksum: latest.checksum,
      applied: installed < migrations.length,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** HTTP startup checks compatibility and installed object shape. This function never executes DDL. */
export async function checkAgentDatabase(database: Queryable): Promise<void> {
  await assertPostgres18(database);
  const expected = await loadAgentMigrations();
  const history = await database.query<{
    version: string;
    checksum: string;
    definition_hash: string;
  }>('SELECT version,checksum,definition_hash FROM agent.schema_migrations ORDER BY version');
  if (
    history.rows.length !== expected.length ||
    history.rows.some(
      (row, index) =>
        row.version !== expected[index]?.version || row.checksum !== expected[index]?.checksum,
    )
  ) {
    throw new Error('Agent 数据库版本或迁移摘要不兼容；请运行独立 Agent 迁移命令');
  }
  const shape = await database.query<{
    tables: string;
    columns: string;
    foreign_keys: string;
    deferrable_foreign_keys: string;
    indexes: string;
  }>(`SELECT
    (SELECT count(*) FROM information_schema.tables WHERE table_schema='agent' AND table_name<>'schema_migrations')::text AS tables,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='agent' AND table_name<>'schema_migrations')::text AS columns,
    (SELECT count(*) FROM pg_constraint WHERE connamespace='agent'::regnamespace AND contype='f')::text AS foreign_keys,
    (SELECT count(*) FROM pg_constraint WHERE connamespace='agent'::regnamespace AND contype='f' AND condeferrable AND NOT condeferred)::text AS deferrable_foreign_keys,
    (SELECT count(*) FROM pg_indexes WHERE schemaname='agent' AND tablename<>'schema_migrations')::text AS indexes`);
  const actual = shape.rows[0];
  if (
    actual?.tables !== '19' ||
    actual.columns !== '291' ||
    actual.foreign_keys !== '74' ||
    actual.deferrable_foreign_keys !== '6' ||
    actual.indexes !== '97'
  ) {
    throw new Error('Agent 数据库基线对象不完整或已漂移，拒绝对外服务');
  }
  if (history.rows.at(-1)?.definition_hash !== (await agentDefinitionHash(database))) {
    throw new Error('Agent 数据库对象定义发生漂移，拒绝对外服务');
  }
}

/** Definition fingerprint excludes owners/ACLs, which are provisioned separately. */
export async function agentDefinitionHash(database: Queryable): Promise<string> {
  const result = await database.query<{ definition: string }>(`
    SELECT definition FROM (
      SELECT 'column/'||table_name||'/'||ordinal_position||'/'||column_name||'/'||udt_name||'/'||is_nullable||'/'||coalesce(column_default,'') AS definition FROM information_schema.columns WHERE table_schema='agent' AND table_name<>'schema_migrations'
      UNION ALL SELECT 'constraint/'||conname||'/'||pg_get_constraintdef(oid,true) FROM pg_constraint WHERE connamespace='agent'::regnamespace
      UNION ALL SELECT 'index/'||indexname||'/'||indexdef FROM pg_indexes WHERE schemaname='agent' AND tablename<>'schema_migrations'
      UNION ALL SELECT 'function/'||proname||'/'||pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='agent'::regnamespace
      UNION ALL SELECT 'trigger/'||tgname||'/'||pg_get_triggerdef(t.oid,true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='agent' AND NOT t.tgisinternal
    ) definitions ORDER BY definition`);
  return createHash('sha256')
    .update(result.rows.map((row) => row.definition.replaceAll('agent.', '')).join('\n'))
    .digest('hex');
}

async function main(): Promise<void> {
  const connectionString = process.env.AGENT_MIGRATION_DATABASE_URL;
  if (!connectionString)
    throw new Error('独立迁移需要 AGENT_MIGRATION_DATABASE_URL；不读取业务 DATABASE_URL');
  if (process.argv[2] === 'check') {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await checkAgentDatabase(client);
    } finally {
      await client.end();
    }
    process.stdout.write('Agent PostgreSQL 18 baseline compatible\n');
  } else {
    const result = await migrateAgentDatabase(connectionString);
    process.stdout.write(
      `Agent ${result.version}: ${result.applied ? 'applied' : 'already applied'}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Agent migration failed'}\n`);
    process.exitCode = 1;
  });
}
