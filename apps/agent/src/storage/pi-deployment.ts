import type { Pool } from 'pg';
import { assertTrustedPiResources, type TrustedPiResources } from '../pi/resources.js';
import type { JsonValue } from './database.js';
import { executionSnapshot, requireExecutionSnapshot } from './execution-config.js';
import { digest } from './projections.js';
import {
  normalizeResourceManifest,
  publishResourceSnapshot,
  validateResourcePublication,
  type ResourceArtifactPublication,
  type ResourceMemberPublication,
  type ResourceSnapshotPublication,
} from './resource-publication.js';

export interface TrustedPiDeployment {
  readonly resources: TrustedPiResources;
  readonly toolManifest: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ResourceArtifactPublication[];
  readonly members: readonly ResourceMemberPublication[];
  /** Deployment-owned verifier: exact bytes, provenance and retrieval, with no discovery. */
  readonly verifyArtifact: (artifact: Readonly<ResourceArtifactPublication>) => Promise<void>;
}

const deployments = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const fail = (): never => {
  throw new Error('PI_RESOURCE_DEPLOYMENT_INVALID');
};

function publication(
  deployment: TrustedPiDeployment,
  snapshot: ResourceSnapshotPublication['snapshot'],
): ResourceSnapshotPublication {
  return { snapshot, artifacts: deployment.artifacts, members: deployment.members };
}

/**
 * Host-only bridge between W4's already frozen resources and W5's resource publisher.
 * This never reads a path or imports code. Every resource and tool export is explicit.
 */
export function createTrustedPiDeployment(input: {
  resources: TrustedPiResources;
  artifacts: readonly ResourceArtifactPublication[];
  members: readonly ResourceMemberPublication[];
  toolBindings: readonly {
    toolName: string;
    memberKey: string;
    exportName: string;
    readOnly: true;
  }[];
  verifyArtifact: TrustedPiDeployment['verifyArtifact'];
}): TrustedPiDeployment {
  assertTrustedPiResources(input.resources);
  if (typeof input.verifyArtifact !== 'function') fail();
  const artifacts = freeze(structuredClone(input.artifacts));
  const members = freeze(structuredClone(input.members));
  const bindings = new Map(input.toolBindings.map((binding) => [binding.toolName, binding]));
  if (
    bindings.size !== input.toolBindings.length ||
    bindings.size !== input.resources.tools.length ||
    members.length !== input.resources.manifest.resources.length
  )
    fail();
  for (const [index, resource] of input.resources.manifest.resources.entries()) {
    const member = members.find((value) => value.member_key === resource.id);
    const artifact =
      member &&
      artifacts.find(
        (value) =>
          value.artifact_key === member.artifact_key &&
          value.version_label === member.version_label,
      );
    const files = artifact?.file_manifest as
      { files?: { path: string; sha256: string }[] } | undefined;
    const file = files?.files?.find((value) => value.path === member?.entry_path);
    if (
      !member ||
      !artifact ||
      !file ||
      member.load_order !== index ||
      artifact.version_label !== resource.version ||
      file.sha256 !== resource.sha256 ||
      (resource.kind === 'asset'
        ? !['context', 'extension', 'business_adapter'].includes(member.resource_kind)
        : member.resource_kind !== resource.kind)
    )
      fail();
  }
  const toolManifest = freeze({
    host_resources: json(input.resources.manifest),
    tools: input.resources.tools.map((tool) => {
      const binding = bindings.get(tool.name);
      const identity = input.resources.manifest.tools.find((value) => value.name === tool.name);
      if (
        !binding ||
        !identity ||
        binding.readOnly !== true ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.exportName)
      )
        fail();
      return {
        name: tool.name,
        description: tool.description,
        parameters: json(tool.parameters),
        output: {
          type: 'string',
          description: 'Native tool result text; safe summaries are separate.',
        },
        read_only: true,
        version: identity.version,
        declaration_sha256: identity.declarationSha256,
        public_metadata: json(tool.publicMetadata ?? null),
        timeout_ms: tool.timeoutMs ?? 30_000,
        implementation: { member_key: binding.memberKey, export_name: binding.exportName },
      };
    }),
  });
  const deployment = Object.freeze({
    resources: input.resources,
    artifacts,
    members,
    toolManifest,
    verifyArtifact: input.verifyArtifact,
  });
  validateResourcePublication(
    publication(deployment, {
      schema_version: 1,
      scene_key: 'business_query',
      runtime_manifest: {},
      model_config: {},
      execution_policy: {},
      tool_manifest: json(toolManifest),
    }),
  );
  deployments.add(deployment);
  return deployment;
}

/** Verify pinned host bytes and use the database's canonical resource digest; no writes. */
export async function prepareTrustedPiDeployment(
  pool: Pick<Pool, 'query'>,
  deployment: TrustedPiDeployment,
): Promise<{ toolManifest: Record<string, unknown>; resourceManifestHash: string }> {
  if (!deployments.has(deployment)) fail();
  assertTrustedPiResources(deployment.resources);
  for (const artifact of deployment.artifacts)
    await deployment.verifyArtifact(Object.freeze(structuredClone(artifact)));
  const shape = publication(deployment, {
    schema_version: 1,
    scene_key: 'business_query',
    runtime_manifest: {},
    model_config: {},
    execution_policy: {},
    tool_manifest: json(deployment.toolManifest),
  });
  const members = validateResourcePublication(shape);
  const normalized = await normalizeResourceManifest(pool, members);
  if (!/^[0-9a-f]{64}$/.test(normalized.hash)) fail();
  return {
    toolManifest: structuredClone(deployment.toolManifest),
    resourceManifestHash: normalized.hash,
  };
}

/** Separate publisher role only; runtime startup never creates or repairs snapshots. */
export async function publishTrustedPiDeploymentSnapshot(
  pool: Pool,
  config: Record<string, unknown>,
  deployment: TrustedPiDeployment,
): Promise<string> {
  const prepared = await prepareTrustedPiDeployment(pool, deployment);
  const { resource_manifest_hash: resourceHash, ...snapshot } = executionSnapshot(
    config,
    prepared.toolManifest,
    prepared.resourceManifestHash,
  );
  const id = await publishResourceSnapshot(
    pool,
    publication(deployment, json(snapshot) as unknown as ResourceSnapshotPublication['snapshot']),
    deployment.verifyArtifact,
  );
  const required = await requireExecutionSnapshot(
    pool,
    config,
    prepared.toolManifest,
    resourceHash,
  );
  if (required !== id || digest(deployment.toolManifest) !== digest(prepared.toolManifest)) fail();
  return id;
}
