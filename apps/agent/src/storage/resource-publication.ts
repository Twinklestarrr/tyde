import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AgentResourceArtifactsTable,
  AgentSnapshotResourcesTable,
  JsonValue,
} from './database.js';
import { digest } from './projections.js';

/** Metadata schema 1: regular immutable files only. Symlinks require a separately validated extension. */
export type ResourceArtifactPublication = Omit<AgentResourceArtifactsTable, 'id' | 'created_at'>;
export interface ResourceMemberPublication extends Omit<
  AgentSnapshotResourcesTable,
  'snapshot_id' | 'artifact_id'
> {
  artifact_key: string;
  version_label: string;
}
export interface ResourceSnapshotPublication {
  snapshot: {
    schema_version: number;
    scene_key: string;
    runtime_manifest: JsonValue;
    model_config: JsonValue;
    tool_manifest: JsonValue;
    execution_policy: JsonValue;
  };
  artifacts: readonly ResourceArtifactPublication[];
  members: readonly ResourceMemberPublication[];
}
export interface ResourceManifestItem {
  member_key: string;
  resource_kind: string;
  entry_path: string;
  load_order: number;
  options: JsonValue;
  artifact: ResourceArtifactPublication;
}
function fail(code: string): never {
  throw new Error(code);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (artifact: Pick<ResourceArtifactPublication, 'artifact_key' | 'version_label'>) =>
  JSON.stringify([artifact.artifact_key, artifact.version_label]);
const pathValid = (value: string) =>
  value.length > 0 &&
  !value.includes('\\') &&
  ![...value].some((character) => character.charCodeAt(0) < 32) &&
  !/(^\/|^[A-Za-z]:|\/\/|\/$|(^|\/)\.{1,2}(\/|$))/.test(value);

export function validateResourcePublication(
  publication: ResourceSnapshotPublication,
): readonly ResourceManifestItem[] {
  const { snapshot, artifacts, members } = publication;
  if (
    snapshot.schema_version !== 1 ||
    !snapshot.scene_key ||
    !object(snapshot.runtime_manifest) ||
    !object(snapshot.model_config) ||
    !object(snapshot.execution_policy) ||
    !object(snapshot.tool_manifest) ||
    !Array.isArray(snapshot.tool_manifest.tools)
  )
    fail('RESOURCE_SNAPSHOT_SHAPE_INVALID');
  const artifactMap = new Map<string, ResourceArtifactPublication>();
  for (const artifact of artifacts) {
    if (
      Object.keys(artifact).some(
        (field) =>
          ![
            'artifact_key',
            'version_label',
            'manifest_schema_version',
            'source_descriptor',
            'file_manifest',
            'archive_digest',
            'tree_digest',
            'archive_size_bytes',
            'storage_descriptor',
            'runtime_compatibility',
            'publication',
          ].includes(field),
      ) ||
      artifactMap.has(key(artifact)) ||
      !artifact.artifact_key ||
      !artifact.version_label ||
      artifact.manifest_schema_version !== 1 ||
      !/^(sha256:)?[0-9a-f]{64}$/.test(artifact.archive_digest) ||
      !/^(sha256:)?[0-9a-f]{64}$/.test(artifact.tree_digest) ||
      !/^(0|[1-9][0-9]*)$/.test(artifact.archive_size_bytes) ||
      !object(artifact.source_descriptor) ||
      !object(artifact.storage_descriptor) ||
      !object(artifact.runtime_compatibility) ||
      !object(artifact.publication) ||
      !object(artifact.file_manifest) ||
      !Array.isArray(artifact.file_manifest.files)
    )
      fail('RESOURCE_ARTIFACT_SHAPE_INVALID');
    const paths = new Set<string>();
    for (const file of artifact.file_manifest.files) {
      if (
        !object(file) ||
        typeof file.path !== 'string' ||
        !pathValid(file.path) ||
        paths.has(file.path) ||
        file.kind !== 'file' ||
        typeof file.size_bytes !== 'number' ||
        !Number.isSafeInteger(file.size_bytes) ||
        file.size_bytes < 0 ||
        typeof file.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        typeof file.mode !== 'string' ||
        !/^[0-7]{3,4}$/.test(file.mode) ||
        (file.exports !== undefined &&
          (!Array.isArray(file.exports) ||
            file.exports.some((value) => typeof value !== 'string' || !value)))
      )
        fail('RESOURCE_FILE_MANIFEST_INVALID');
      paths.add(file.path);
    }
    artifactMap.set(key(artifact), structuredClone(artifact));
  }
  const memberMap = new Map<string, ResourceMemberPublication>();
  const orders = new Set<number>();
  for (const member of members) {
    const artifact = artifactMap.get(key(member));
    if (
      !member.member_key ||
      memberMap.has(member.member_key) ||
      !Number.isSafeInteger(member.load_order) ||
      member.load_order < 0 ||
      orders.has(member.load_order) ||
      !artifact ||
      !pathValid(member.entry_path) ||
      !object(member.options) ||
      !['skill', 'prompt', 'extension', 'context', 'business_adapter'].includes(
        member.resource_kind,
      )
    )
      fail('RESOURCE_MEMBER_INVALID');
    const files = (artifact.file_manifest as { files: Record<string, unknown>[] }).files;
    if (
      !files.some((file) => file.path === member.entry_path) ||
      (member.resource_kind === 'skill' && !/(^|\/)SKILL\.md$/.test(member.entry_path))
    )
      fail('RESOURCE_MEMBER_ENTRY_MISSING');
    memberMap.set(member.member_key, member);
    orders.add(member.load_order);
  }
  const toolNames = new Set<string>();
  for (const tool of snapshot.tool_manifest.tools) {
    if (
      !object(tool) ||
      typeof tool.name !== 'string' ||
      !tool.name ||
      toolNames.has(tool.name) ||
      typeof tool.description !== 'string' ||
      !object(tool.parameters) ||
      !object(tool.output) ||
      !object(tool.implementation)
    )
      fail('RESOURCE_TOOL_DECLARATION_INVALID');
    toolNames.add(tool.name);
    const implementation = tool.implementation;
    if (
      typeof implementation.member_key === 'string' &&
      implementation.runtime_export === undefined
    ) {
      const member = memberMap.get(implementation.member_key);
      const artifact = member && artifactMap.get(key(member));
      const files =
        artifact && (artifact.file_manifest as { files: Record<string, unknown>[] }).files;
      const file = files?.find((value) => value.path === member!.entry_path);
      if (
        !member ||
        !['extension', 'business_adapter'].includes(member.resource_kind) ||
        typeof implementation.export_name !== 'string' ||
        !Array.isArray(file?.exports) ||
        !file.exports.includes(implementation.export_name)
      )
        fail('RESOURCE_TOOL_BINDING_MISSING');
    } else if (
      typeof implementation.runtime_export === 'string' &&
      implementation.member_key === undefined
    ) {
      if (
        !implementation.runtime_export ||
        !Array.isArray(snapshot.runtime_manifest.tool_exports) ||
        !snapshot.runtime_manifest.tool_exports.includes(implementation.runtime_export)
      )
        fail('RESOURCE_RUNTIME_EXPORT_MISSING');
    } else if (
      implementation.kind === 'isolated-test-fixture' &&
      implementation.member_key === undefined &&
      implementation.runtime_export === undefined
    ) {
      if (
        snapshot.tool_manifest.isolated_fixture !== true ||
        typeof implementation.entry !== 'string' ||
        !pathValid(implementation.entry) ||
        !implementation.entry.startsWith('tests/') ||
        typeof implementation.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(implementation.sha256) ||
        !Array.isArray(snapshot.tool_manifest.fixture_tool_exports) ||
        !snapshot.tool_manifest.fixture_tool_exports.some(
          (value) => digest(value) === digest(implementation),
        ) ||
        !Array.isArray(snapshot.runtime_manifest.fixture_tool_exports) ||
        !snapshot.runtime_manifest.fixture_tool_exports.some(
          (value) => digest(value) === digest(implementation),
        )
      )
        fail('RESOURCE_FIXTURE_EXPORT_MISSING');
    } else fail('RESOURCE_TOOL_BINDING_MISSING');
  }
  for (const member of members) {
    const files = (
      artifactMap.get(key(member))!.file_manifest as { files: Record<string, unknown>[] }
    ).files;
    for (const dependencyKind of ['requires_members', 'requires_tools', 'requires_files']) {
      const dependencies = (member.options as Record<string, JsonValue>)[dependencyKind];
      if (dependencies === undefined) continue;
      if (
        !Array.isArray(dependencies) ||
        dependencies.some(
          (value) =>
            typeof value !== 'string' ||
            (dependencyKind === 'requires_members'
              ? !memberMap.has(value)
              : dependencyKind === 'requires_tools'
                ? !toolNames.has(value)
                : !files.some((file) => file.path === value)),
        )
      )
        fail('RESOURCE_DEPENDENCY_MISSING');
    }
  }
  if (new Set(members.map(key)).size !== artifacts.length) fail('RESOURCE_UNUSED_ARTIFACT');
  return members.map((member) => ({
    member_key: member.member_key,
    resource_kind: member.resource_kind,
    entry_path: member.entry_path,
    load_order: member.load_order,
    options: structuredClone(member.options),
    artifact: artifactMap.get(key(member))!,
  }));
}

/** One source of manifest ordering/normalization for publisher and DB deferred checks. */
export async function normalizeResourceManifest(
  client: Pick<PoolClient, 'query'>,
  manifest: readonly ResourceManifestItem[],
) {
  const {
    rows: [value],
  } = await client.query<{ manifest: JsonValue; hash: string }>(
    'SELECT agent.resource_manifest_normalize($1::jsonb) AS manifest,agent.resource_manifest_digest($1::jsonb) AS hash',
    [JSON.stringify(manifest)],
  );
  if (!value) fail('RESOURCE_MANIFEST_NORMALIZATION_FAILED');
  return value;
}

/** Trusted internal publisher; the supplied verifier must prove bytes, provenance and retrieval before SQL. */
export async function publishResourceSnapshot(
  pool: Pool,
  original: ResourceSnapshotPublication,
  verifyArtifact: (artifact: Readonly<ResourceArtifactPublication>) => Promise<void>,
): Promise<string> {
  const publication = structuredClone(original);
  const members = validateResourcePublication(publication);
  for (const artifact of publication.artifacts)
    await verifyArtifact(Object.freeze(structuredClone(artifact)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalized = await normalizeResourceManifest(client, members);
    const snapshotBody = { ...publication.snapshot, resource_manifest_hash: normalized.hash };
    const snapshotHash = digest(snapshotBody);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `agent-resource-snapshot:${snapshotHash}`,
    ]);
    const artifacts = new Map<string, string>();
    for (const artifact of [...publication.artifacts].sort((a, b) =>
      key(a).localeCompare(key(b), 'en'),
    )) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `agent-resource-artifact:${key(artifact)}`,
      ]);
      const {
        rows: [old],
      } = await client.query(
        'SELECT * FROM agent.agent_resource_artifacts WHERE artifact_key=$1 AND version_label=$2',
        [artifact.artifact_key, artifact.version_label],
      );
      if (old) {
        const { id, created_at: createdAt, ...content } = old;
        void createdAt;
        if (digest(content) !== digest(artifact))
          fail('RESOURCE_ARTIFACT_VERSION_CONTENT_CONFLICT');
        artifacts.set(key(artifact), id as string);
      } else {
        const id = randomUUID();
        await client.query(
          'INSERT INTO agent.agent_resource_artifacts SELECT (jsonb_populate_record(NULL::agent.agent_resource_artifacts,$1::jsonb)).*',
          [JSON.stringify({ ...artifact, id, created_at: new Date().toISOString() })],
        );
        artifacts.set(key(artifact), id);
      }
    }
    const {
      rows: [old],
    } = await client.query(
      'SELECT * FROM agent.agent_execution_snapshots WHERE schema_version=$1 AND snapshot_hash=$2',
      [snapshotBody.schema_version, snapshotHash],
    );
    if (old) {
      const { id, created_at: createdAt, snapshot_hash: storedHash, ...content } = old;
      void createdAt;
      void storedHash;
      const {
        rows: [existing],
      } = await client.query('SELECT agent.resource_manifest_for_snapshot($1) AS manifest', [id]);
      if (
        digest(content) !== digest(snapshotBody) ||
        digest(existing.manifest) !== digest(normalized.manifest)
      )
        fail('RESOURCE_SNAPSHOT_CONTENT_CONFLICT');
      await client.query('SELECT agent.assert_resource_snapshot($1)', [id]);
      await client.query('COMMIT');
      return id as string;
    }
    const id = randomUUID();
    await client.query(
      'INSERT INTO agent.agent_execution_snapshots SELECT (jsonb_populate_record(NULL::agent.agent_execution_snapshots,$1::jsonb)).*',
      [
        JSON.stringify({
          ...snapshotBody,
          id,
          snapshot_hash: snapshotHash,
          created_at: new Date().toISOString(),
        }),
      ],
    );
    for (const member of publication.members) {
      const { artifact_key: artifactKey, version_label: versionLabel, ...content } = member;
      await client.query(
        'INSERT INTO agent.agent_snapshot_resources SELECT (jsonb_populate_record(NULL::agent.agent_snapshot_resources,$1::jsonb)).*',
        [
          JSON.stringify({
            ...content,
            snapshot_id: id,
            artifact_id: artifacts.get(
              key({ artifact_key: artifactKey, version_label: versionLabel }),
            ),
          }),
        ],
      );
    }
    await client.query('SELECT agent.assert_resource_snapshot($1)', [id]);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
