import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createAgentDatabase } from '../src/storage/database.js';
import {
  checkAgentDatabase,
  loadAgentMigration,
  loadAgentMigrations,
  migrateAgentDatabase,
} from '../src/storage/migrations.js';
import { createAgentDatabaseFixture } from './helpers/agent-database-fixture.js';

const connectionString = process.env.AGENT_TEST_DATABASE_URL;

async function rejectsTransaction(
  pool: Pool,
  action: (client: PoolClient) => Promise<void>,
  pattern?: RegExp,
) {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await assert.rejects(async () => {
      await action(client);
      await client.query('COMMIT');
    }, pattern);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test(
  'Agent isolated PostgreSQL 18 complete migration and constraints',
  { skip: !connectionString },
  async (t) => {
    assert.ok(connectionString);
    const database = createAgentDatabase({ connectionString });
    try {
      await t.test('independent migration is idempotent and complete 19/291/74/97', async () => {
        await migrateAgentDatabase(connectionString);
        const result = await migrateAgentDatabase(connectionString);
        assert.equal(result.applied, false);
        assert.equal(result.version, '0002_tool_executions');
        await checkAgentDatabase(database.pool);
        const constraints = await database.pool.query<{ name: string }>(
          "SELECT conname AS name FROM pg_constraint WHERE connamespace='agent'::regnamespace AND contype='f' AND condeferrable ORDER BY conname",
        );
        assert.deepEqual(
          constraints.rows.map((r) => r.name),
          [
            'fk_agent_01_c_p',
            'fk_agent_05_a_q',
            'fk_agent_17_p_r',
            'fk_agent_19_p_r',
            'fk_agent_25_r_a',
            'fk_agent_54_h_o',
          ],
        );
        const before = await database.pool.query('SELECT checksum FROM agent.schema_migrations');
        await database.pool.query('SELECT 1');
        assert.deepEqual(
          (await database.pool.query('SELECT checksum FROM agent.schema_migrations')).rows,
          before.rows,
        );
      });
      const fixture = await createAgentDatabaseFixture(database.pool);
      await t.test(
        'initialization and final-state intermediate records close in one transaction',
        async () => {
          const result = await database.pool.query(
            'SELECT active_attempt_id,writer_owner_id,execution_generation FROM agent.pi_sessions WHERE id=$1',
            [fixture.pi],
          );
          assert.equal(result.rows[0].active_attempt_id, fixture.attempt);
          assert.equal(result.rows[0].writer_owner_id, fixture.owner);
          assert.equal(result.rows[0].execution_generation, '1');
        },
      );
      await t.test(
        'accepted command fails at transaction end, not at intermediate insert',
        async () => {
          let inserted = false;
          await rejectsTransaction(
            database.pool,
            async (client) => {
              await client.query(
                `INSERT INTO agent.agent_commands(id,conversation_id,actor_user_id,request_key,kind,payload_schema_version,payload,payload_hash,status,input_state,created_at) VALUES($1,$2,$3,$4,'stop_attempt',1,'{}',$5,'accepted','none',clock_timestamp())`,
                [randomUUID(), fixture.conversation, fixture.user, randomUUID(), randomUUID()],
              );
              inserted = true;
            },
            /incomplete command\/native input consumption/,
          );
          assert.equal(inserted, true);
        },
      );
      await t.test('native required JSON keys reject missing parentId immediately', async () => {
        await rejectsTransaction(
          database.pool,
          async (client) => {
            await client.query(
              `INSERT INTO agent.pi_session_entries VALUES($1,'missing-parent',NULL,1,'custom',$2,clock_timestamp())`,
              [fixture.pi, { id: 'missing-parent', type: 'custom' }],
            );
          },
          /ck_agent_e_shape/,
        );
      });
      await t.test(
        'full native JSON, original append order, multiple roots, older leaf and null leaf roundtrip',
        async () => {
          const first = 'short-a';
          const second = 'short-b';
          const r1 = randomUUID();
          const r2 = randomUUID();
          const entries = [
            {
              id: first,
              type: 'custom',
              parentId: null,
              timestamp: '2026-10-22T00:00:00.000Z',
              customType: 'isolated-fixture',
              data: { nested: [null, 0, '完整字段'], unknown: { enabled: true } },
            },
            {
              id: second,
              type: 'message',
              parentId: null,
              timestamp: '2026-10-22T00:00:00.001Z',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'tool-call-1',
                    name: 'isolated_fixture',
                    arguments: { nested: [1, 2] },
                  },
                ],
                api: 'openai-completions',
                provider: 'fixture',
                model: 'fixture',
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'toolUse',
                timestamp: 0,
              },
            },
          ];
          const client = await database.pool.connect();
          try {
            await client.query('BEGIN');
            for (let i = 0; i < entries.length; i++)
              await client.query(
                'INSERT INTO agent.pi_session_entries VALUES($1,$2,NULL,$3,$4,$5,clock_timestamp())',
                [fixture.pi, entries[i]!.id, i + 1, entries[i]!.type, entries[i]],
              );
            await client.query(
              `INSERT INTO agent.pi_session_revisions SELECT $1,pi_session_id,1,id,2,$2,raw_header,sdk_version,native_format_version,$3,$4,$5,1,$6,1,$7,'isolated_native_fixture',clock_timestamp() FROM agent.pi_session_revisions WHERE id=$8`,
              [
                r1,
                first,
                fixture.snapshot,
                fixture.attempt,
                fixture.owner,
                randomUUID(),
                randomUUID(),
                fixture.revision,
              ],
            );
            await client.query('UPDATE agent.pi_sessions SET head_revision_id=$2 WHERE id=$1', [
              fixture.pi,
              r1,
            ]);
            await client.query(
              'UPDATE agent.agent_attempts SET last_committed_revision_id=$2 WHERE id=$1',
              [fixture.attempt, r1],
            );
            await client.query('COMMIT');
            const stored = await client.query(
              'SELECT raw_entry FROM agent.pi_session_entries WHERE pi_session_id=$1 ORDER BY entry_seq',
              [fixture.pi],
            );
            assert.deepEqual(
              stored.rows.map((r) => r.raw_entry),
              entries,
            );
            assert.equal(
              (
                await client.query(
                  'SELECT active_leaf_entry_id FROM agent.pi_session_revisions WHERE id=$1',
                  [r1],
                )
              ).rows[0].active_leaf_entry_id,
              first,
            );
            await client.query('BEGIN');
            await client.query(
              `INSERT INTO agent.pi_session_revisions SELECT $1,pi_session_id,2,id,2,NULL,raw_header,sdk_version,native_format_version,execution_snapshot_id,writer_attempt_id,writer_owner_id,execution_generation,$2,1,$3,'leaf_only_fixture',clock_timestamp() FROM agent.pi_session_revisions WHERE id=$4`,
              [r2, randomUUID(), randomUUID(), r1],
            );
            await client.query('UPDATE agent.pi_sessions SET head_revision_id=$2 WHERE id=$1', [
              fixture.pi,
              r2,
            ]);
            await client.query(
              'UPDATE agent.agent_attempts SET last_committed_revision_id=$2 WHERE id=$1',
              [fixture.attempt, r2],
            );
            await client.query('COMMIT');
            assert.equal(
              (
                await client.query(
                  'SELECT active_leaf_entry_id FROM agent.pi_session_revisions WHERE id=$1',
                  [r2],
                )
              ).rows[0].active_leaf_entry_id,
              null,
            );
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        },
      );
      await t.test(
        'old owner/generation/head cannot commit and immutable originals cannot change',
        async () => {
          await rejectsTransaction(
            database.pool,
            async (client) => {
              await client.query(
                `UPDATE agent.pi_session_entries SET raw_entry=raw_entry||'{"modified":true}' WHERE pi_session_id=$1`,
                [fixture.pi],
              );
            },
            /immutable Agent record/,
          );
          await rejectsTransaction(
            database.pool,
            async (client) => {
              await client.query(
                `INSERT INTO agent.pi_session_revisions SELECT $1,pi_session_id,3,id,last_entry_seq,NULL,raw_header,sdk_version,native_format_version,execution_snapshot_id,writer_attempt_id,'stale-owner',execution_generation,$2,1,$3,'stale_fixture',clock_timestamp() FROM agent.pi_session_revisions WHERE id=(SELECT head_revision_id FROM agent.pi_sessions WHERE id=$4)`,
                [randomUUID(), randomUUID(), randomUUID(), fixture.pi],
              );
            },
            /stale native writer/,
          );
        },
      );
      await t.test(
        'orphan native append and fake completed task roll back completely',
        async () => {
          const before = (
            await database.pool.query(
              'SELECT count(*) FROM agent.pi_session_entries WHERE pi_session_id=$1',
              [fixture.pi],
            )
          ).rows[0].count;
          await rejectsTransaction(
            database.pool,
            async (client) => {
              await client.query(
                `INSERT INTO agent.pi_session_entries VALUES($1,'orphan',NULL,3,'custom',$2,clock_timestamp())`,
                [fixture.pi, { id: 'orphan', type: 'custom', parentId: null }],
              );
            },
            /native\/revision prefix is incomplete/,
          );
          assert.equal(
            (
              await database.pool.query(
                'SELECT count(*) FROM agent.pi_session_entries WHERE pi_session_id=$1',
                [fixture.pi],
              )
            ).rows[0].count,
            before,
          );
          await rejectsTransaction(database.pool, async (client) => {
            await client.query(
              `UPDATE agent.agent_tasks SET status='completed',completed_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1`,
              [fixture.task],
            );
          });
        },
      );
      await t.test(
        'baseline DDL failure rolls back all objects in a scoped disposable probe',
        async () => {
          const schema = `agent_probe_${randomUUID().replaceAll('-', '')}`;
          const resources = (await loadAgentMigration()).resources;
          const client = await database.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`CREATE SCHEMA ${schema}`);
            for (const resource of resources.slice(0, 3))
              await client.query(resource.sql.replaceAll('agent.', `${schema}.`));
            await assert.rejects(() =>
              client.query('SELECT missing_agent_migration_failure_probe()'),
            );
            await client.query('ROLLBACK');
            assert.equal(
              (
                await client.query(
                  'SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS found',
                  [schema],
                )
              ).rows[0].found,
              false,
            );
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      );
      await t.test(
        'runtime role is not owner and cannot DDL, truncate, delete immutable history or publish config',
        async () => {
          const roles = await readFile(new URL('../migrations/roles.sql', import.meta.url), 'utf8');
          const privileges = (await loadAgentMigration()).resources.find(
            (r) => r.name === '05_privileges.sql',
          )!.sql;
          await database.pool.query(roles);
          await database.pool.query(privileges);
          await database.pool.query(
            (await loadAgentMigrations())[1]!.resources.find((r) => r.name === '02_privileges.sql')!
              .sql,
          );
          const client = await database.pool.connect();
          try {
            await client.query('SET ROLE tyde_agent_runtime');
            assert.equal(
              (await client.query('SELECT current_user')).rows[0].current_user,
              'tyde_agent_runtime',
            );
            const toolPrivileges = (
              await client.query(
                `SELECT (has_table_privilege(current_user,'agent.agent_tool_executions','SELECT')
                AND has_table_privilege(current_user,'agent.agent_tool_executions','INSERT')
                AND has_table_privilege(current_user,'agent.agent_tool_executions','UPDATE')) AS allowed,
                has_table_privilege(current_user,'agent.agent_tool_executions','DELETE') AS may_delete`,
              )
            ).rows[0];
            assert.equal(toolPrivileges.allowed, true);
            assert.equal(toolPrivileges.may_delete, false);
            assert.equal(
              (
                await client.query(
                  "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='agent.agent_tasks'::regclass",
                )
              ).rows[0].owner === 'tyde_agent_runtime',
              false,
            );
            for (const sql of [
              'CREATE TABLE agent.forbidden_probe(id integer)',
              'TRUNCATE agent.agent_messages',
              `DELETE FROM agent.pi_session_entries WHERE pi_session_id='${fixture.pi}'`,
              `INSERT INTO agent.agent_execution_snapshots SELECT * FROM agent.agent_execution_snapshots LIMIT 1`,
            ])
              await assert.rejects(() => client.query(sql), /permission denied/);
            await checkAgentDatabase(client);
          } finally {
            await client.query('RESET ROLE');
            client.release();
          }
        },
      );
    } finally {
      await database.close();
    }
  },
);
