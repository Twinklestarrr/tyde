import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAgentDatabase } from '../src/storage/database.js';
import { digest } from '../src/storage/projections.js';
import {
  normalizeResourceManifest,
  publishResourceSnapshot,
  validateResourcePublication,
  type ResourceSnapshotPublication,
} from '../src/storage/resource-publication.js';

const url = process.env.AGENT_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(): ResourceSnapshotPublication {
  const artifactKey = `isolated.resource.${randomUUID()}`;
  const files = [
    { path: 'SKILL.md', body: '# Isolated fixture\nUses the explicitly declared fixture tool.' },
    { path: 'fixture.ts', body: 'export function readonlyFixture() { return "fixture"; }' },
    { path: 'references/input.json', body: '{"fixture":true}' },
  ];
  return {
    snapshot: {
      schema_version: 1,
      scene_key: 'business_query',
      runtime_manifest: { sdk_version: '1.3.0', runtime_version: 'tyde-pi-native-v1' },
      model_config: { model: 'isolated-metadata-fixture' },
      tool_manifest: {
        tools: [
          {
            name: 'readonly_fixture',
            description: 'Isolated resource metadata fixture.',
            parameters: { type: 'object' },
            output: { type: 'string' },
            implementation: { member_key: 'tools', export_name: 'readonlyFixture' },
          },
        ],
      },
      execution_policy: {
        attempt_limits: {
          policy_version: 1,
          max_duration_ms: 600000,
          max_model_requests: 12,
          max_tool_calls: 10,
        },
        resource_loading: 'explicit-pinned-only',
      },
    },
    artifacts: [
      {
        artifact_key: artifactKey,
        version_label: '1',
        manifest_schema_version: 1,
        source_descriptor: { kind: 'isolated-test-fixture', revision: 'fixed-1' },
        file_manifest: {
          files: files.map((file) => ({
            path: file.path,
            size_bytes: Buffer.byteLength(file.body),
            sha256: hash(file.body),
            mode: '0644',
            kind: 'file',
            ...(file.path === 'fixture.ts' ? { exports: ['readonlyFixture'] } : {}),
          })),
        },
        archive_digest: `sha256:${hash('controlled archive fixture')}`,
        tree_digest: `sha256:${hash('controlled tree fixture')}`,
        archive_size_bytes: '26',
        storage_descriptor: { kind: 'controlled-fixture', identity: 'metadata-only-test' },
        runtime_compatibility: { node_major: 24 },
        publication: { kind: 'isolated-test-fixture', verified: true },
      },
    ],
    members: [
      {
        member_key: 'skill',
        artifact_key: artifactKey,
        version_label: '1',
        resource_kind: 'skill',
        entry_path: 'SKILL.md',
        load_order: 1,
        options: {
          requires_members: ['tools'],
          requires_tools: ['readonly_fixture'],
          requires_files: ['references/input.json'],
        },
      },
      {
        member_key: 'tools',
        artifact_key: artifactKey,
        version_label: '1',
        resource_kind: 'extension',
        entry_path: 'fixture.ts',
        load_order: 0,
        options: {},
      },
    ],
  };
}

test(
  'CT07 resource metadata publication, canonical members and independent deferred rejection',
  { skip: !url },
  async (t) => {
    assert.ok(url);
    const database = createAgentDatabase({ connectionString: url });
    const verify = async () => {
      /* Explicit isolated metadata fixture: never a production byte verifier or page tool. */
    };
    let valid: ResourceSnapshotPublication;
    let id: string;
    try {
      await t.test(
        'valid Skill/tool members freeze, sort, and same-content repeat returns original snapshot',
        async () => {
          valid = fixture();
          id = await publishResourceSnapshot(database.pool, valid, verify);
          const reversed = structuredClone(valid);
          reversed.members.reverse();
          assert.equal(await publishResourceSnapshot(database.pool, reversed, verify), id);
          const {
            rows: [saved],
          } = await database.pool.query(
            'SELECT agent.resource_manifest_for_snapshot($1) AS manifest,resource_manifest_hash FROM agent.agent_execution_snapshots WHERE id=$1',
            [id],
          );
          assert.deepEqual(
            saved.manifest.map((member: { member_key: string }) => member.member_key),
            ['tools', 'skill'],
          );
          const normalized = await normalizeResourceManifest(
            database.pool,
            validateResourcePublication(valid),
          );
          assert.equal(saved.resource_manifest_hash, normalized.hash);
          const empty = await normalizeResourceManifest(database.pool, []);
          assert.equal(empty.hash, digest([]));
        },
      );
      async function rejectsRaw(
        change: (candidate: ResourceSnapshotPublication) => void,
        kind: string,
        options: { omitMembers?: boolean; wrongHash?: boolean } = {},
      ) {
        const candidate = structuredClone(valid);
        change(candidate);
        const client = await database.pool.connect();
        try {
          await client.query('BEGIN');
          // Bypass the TypeScript publisher deliberately: the database must reject invalid metadata itself.
          const members = candidate.members.map((member) => ({
            member_key: member.member_key,
            resource_kind: member.resource_kind,
            entry_path: member.entry_path,
            load_order: member.load_order,
            options: member.options,
            artifact: candidate.artifacts[0]!,
          }));
          const normalized = await normalizeResourceManifest(client, members);
          const sid = randomUUID();
          await client.query(
            'INSERT INTO agent.agent_execution_snapshots SELECT (jsonb_populate_record(NULL::agent.agent_execution_snapshots,$1::jsonb)).*',
            [
              JSON.stringify({
                ...candidate.snapshot,
                id: sid,
                snapshot_hash: randomUUID(),
                resource_manifest_hash: options.wrongHash ? '0'.repeat(64) : normalized.hash,
                created_at: new Date().toISOString(),
              }),
            ],
          );
          if (!options.omitMembers)
            for (const member of candidate.members) {
              const { artifact_key: artifactKey, version_label: versionLabel, ...body } = member;
              const artifact = (
                await client.query(
                  'SELECT id FROM agent.agent_resource_artifacts WHERE artifact_key=$1 AND version_label=$2',
                  [artifactKey, versionLabel],
                )
              ).rows[0];
              await client.query(
                'INSERT INTO agent.agent_snapshot_resources SELECT (jsonb_populate_record(NULL::agent.agent_snapshot_resources,$1::jsonb)).*',
                [JSON.stringify({ ...body, snapshot_id: sid, artifact_id: artifact.id })],
              );
            }
          await assert.rejects(
            () => client.query('COMMIT'),
            (error: unknown) =>
              error !== null &&
              typeof error === 'object' &&
              'constraint' in error &&
              error.constraint === kind,
          );
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
      await t.test('missing G cannot satisfy a nonempty frozen resource hash', () =>
        rejectsRaw(() => {}, 'ct_agent_07_resource_digest', { omitMembers: true }),
      );
      await t.test('wrong resource digest rolls back even with all G/F present', () =>
        rejectsRaw(() => {}, 'ct_agent_07_resource_digest', { wrongHash: true }),
      );
      await t.test('member entry must exist inside F file manifest', () =>
        rejectsRaw((candidate) => {
          candidate.members[0]!.entry_path = 'missing/SKILL.md';
        }, 'ct_agent_07_member_entry'),
      );
      await t.test('tool implementation must resolve a pinned member export', () =>
        rejectsRaw((candidate) => {
          (
            candidate.snapshot.tool_manifest as {
              tools: { implementation: { member_key: string } }[];
            }
          ).tools[0]!.implementation.member_key = 'absent';
        }, 'ct_agent_07_tool_binding'),
      );
      await t.test('Skill required member/tool/file declarations must close', async () => {
        for (const dependency of ['requires_members', 'requires_tools', 'requires_files'])
          await rejectsRaw((candidate) => {
            candidate.members[0]!.options = { [dependency]: ['absent'] };
          }, 'ct_agent_07_resource_dependency');
      });
      await t.test(
        'isolated fixture marker, exact exports and traversal-free source are mandatory in database',
        async () => {
          const implementation = {
            kind: 'isolated-test-fixture',
            entry: 'tests/readonly-fixture.ts:run',
            sha256: hash('isolated fixture'),
          };
          for (const variant of ['missing_flag', 'unsafe_path', 'dual_binding']) {
            await rejectsRaw((candidate) => {
              const binding = {
                ...implementation,
                ...(variant === 'unsafe_path' ? { entry: 'tests/../src/fixture.ts:run' } : {}),
                ...(variant === 'dual_binding'
                  ? { member_key: 'tools', runtime_export: 'runtime.fixture' }
                  : {}),
              };
              candidate.snapshot.runtime_manifest = { fixture_tool_exports: [binding] };
              candidate.snapshot.tool_manifest = {
                ...(variant === 'missing_flag' ? {} : { isolated_fixture: true }),
                fixture_tool_exports: [binding],
                tools: [
                  {
                    name: 'readonly_fixture',
                    description: 'Isolated declaration only',
                    parameters: { type: 'object' },
                    output: { type: 'string' },
                    implementation: binding,
                  },
                ],
              };
            }, 'ct_agent_07_tool_binding');
          }
        },
      );
      await t.test(
        'same artifact version cannot be reinterpreted with changed immutable content',
        async () => {
          const candidate = structuredClone(valid);
          candidate.artifacts[0]!.storage_descriptor = { kind: 'changed' };
          await assert.rejects(
            publishResourceSnapshot(database.pool, candidate, verify),
            /RESOURCE_ARTIFACT_VERSION_CONTENT_CONFLICT/,
          );
        },
      );
      await t.test(
        'same declared snapshot hash still compares complete stored snapshot content',
        async () => {
          const candidate = fixture();
          candidate.artifacts = [];
          candidate.members = [];
          candidate.snapshot.tool_manifest = { tools: [] };
          candidate.snapshot.model_config = {
            model: 'isolated-hash-conflict',
            fixture_scope: randomUUID(),
          };
          const normalized = await normalizeResourceManifest(database.pool, []);
          const body = { ...candidate.snapshot, resource_manifest_hash: normalized.hash };
          const claimed = digest(body);
          await database.pool.query(
            'INSERT INTO agent.agent_execution_snapshots SELECT (jsonb_populate_record(NULL::agent.agent_execution_snapshots,$1::jsonb)).*',
            [
              JSON.stringify({
                ...body,
                id: randomUUID(),
                snapshot_hash: claimed,
                model_config: { model: 'intentionally-corrupt-content-fixture' },
                created_at: new Date().toISOString(),
              }),
            ],
          );
          await assert.rejects(
            publishResourceSnapshot(database.pool, candidate, verify),
            /RESOURCE_SNAPSHOT_CONTENT_CONFLICT/,
          );
        },
      );
      await t.test(
        'partial member deletion is rejected at commit; complete unused snapshot cleanup closes',
        async () => {
          const candidate = fixture();
          const snapshot = await publishResourceSnapshot(database.pool, candidate, verify);
          const client = await database.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('DELETE FROM agent.agent_snapshot_resources WHERE snapshot_id=$1', [
              snapshot,
            ]);
            await assert.rejects(() => client.query('COMMIT'), /resource manifest differs/);
            await client.query('ROLLBACK');
            await client.query('BEGIN');
            await client.query('DELETE FROM agent.agent_snapshot_resources WHERE snapshot_id=$1', [
              snapshot,
            ]);
            await client.query('DELETE FROM agent.agent_execution_snapshots WHERE id=$1', [
              snapshot,
            ]);
            await client.query('COMMIT');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      );
      await t.test(
        'runtime tool exports and isolated fixture exports require exact pinned identities',
        async () => {
          const candidate = fixture();
          candidate.artifacts = [];
          candidate.members = [];
          candidate.snapshot.tool_manifest = {
            tools: [
              {
                name: 'runtime_fixture',
                description: 'Pinned runtime fixture',
                parameters: { type: 'object' },
                output: { type: 'string' },
                implementation: { runtime_export: 'runtime.fixture' },
              },
            ],
          };
          candidate.snapshot.runtime_manifest = {
            sdk_version: '1.3.0',
            tool_exports: ['runtime.fixture'],
          };
          await publishResourceSnapshot(database.pool, candidate, verify);
          candidate.snapshot.runtime_manifest = { sdk_version: '1.3.0', tool_exports: [] };
          await assert.rejects(
            publishResourceSnapshot(database.pool, candidate, verify),
            /RESOURCE_RUNTIME_EXPORT_MISSING/,
          );
        },
      );
      await t.test(
        'unknown artifact fields and empty runtime exports are rejected before publication',
        async () => {
          const unknown = fixture();
          Object.assign(unknown.artifacts[0]!, { unknown_identity_field: true });
          await assert.rejects(
            publishResourceSnapshot(database.pool, unknown, verify),
            /RESOURCE_ARTIFACT_SHAPE_INVALID/,
          );
          const empty = fixture();
          empty.artifacts = [];
          empty.members = [];
          empty.snapshot.runtime_manifest = { tool_exports: [''] };
          empty.snapshot.tool_manifest = {
            tools: [
              {
                name: 'empty',
                description: 'Invalid empty export',
                parameters: {},
                output: {},
                implementation: { runtime_export: '' },
              },
            ],
          };
          await assert.rejects(
            publishResourceSnapshot(database.pool, empty, verify),
            /RESOURCE_RUNTIME_EXPORT_MISSING/,
          );
        },
      );
      await t.test(
        'invalid path, missing export and verifier failure never publish a snapshot',
        async () => {
          for (const change of [
            (candidate: ResourceSnapshotPublication) => {
              candidate.members[0]!.entry_path = '../SKILL.md';
            },
            (candidate: ResourceSnapshotPublication) => {
              (
                candidate.snapshot.tool_manifest as {
                  tools: { implementation: { export_name: string } }[];
                }
              ).tools[0]!.implementation.export_name = 'missing';
            },
          ]) {
            const candidate = fixture();
            change(candidate);
            await assert.rejects(publishResourceSnapshot(database.pool, candidate, verify));
          }
          let verified = 0;
          await assert.rejects(
            publishResourceSnapshot(database.pool, fixture(), async () => {
              verified++;
              throw new Error('CONTROLLED_BYTES_UNAVAILABLE');
            }),
            /CONTROLLED_BYTES_UNAVAILABLE/,
          );
          assert.equal(verified, 1);
        },
      );
    } finally {
      await database.close();
    }
  },
);
