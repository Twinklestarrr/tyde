import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { DEFAULT_ATTEMPT_LIMITS } from '../execution/attempt-budget.js';
import { readDirectModelConfig, type DirectModelConfig } from '../maas/direct-model.js';
import { createAgentDatabase } from './database.js';
import { checkAgentDatabase } from './migrations.js';
import { digest } from './projections.js';
import { getRuntimeManifest } from './runtime-manifest.js';

export function modelExecutionConfig(config: DirectModelConfig): Record<string, unknown> {
  return {
    api: 'openai-completions',
    model_role: 'chat',
    credential_ref: 'server:direct-model',
    preset_version: 'tyde-direct-model-v1',
    endpoint_config_version: digest({ baseUrl: config.baseUrl, compat: config.compat }),
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    actualModelIds: config.actualModelIds,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: config.compat,
    timeouts: config.timeouts,
    provider: config.provider,
  };
}
export function executionSnapshot(
  executionConfig: Record<string, unknown>,
  toolManifest: Record<string, unknown> = { tools: [] },
) {
  const runtimeManifest = getRuntimeManifest();
  // Only trusted internal native fixtures supply this declaration; HTTP/model input cannot.
  if (toolManifest.isolated_fixture === true)
    runtimeManifest.fixture_tool_exports = structuredClone(toolManifest.fixture_tool_exports);
  return {
    schema_version: 1,
    scene_key: 'business_query',
    runtime_manifest: runtimeManifest,
    model_config: executionConfig,
    tool_manifest: toolManifest,
    execution_policy: {
      attempt_limits: DEFAULT_ATTEMPT_LIMITS,
      implicit_retries: 0,
      automatic_compaction: false,
      automatic_context_edit: false,
      tool_execution: 'sequential',
      resource_discovery: 'disabled',
      resource_loading: 'explicit-pinned-only',
      finish_grace_ms: 5000,
    },
    resource_manifest_hash: digest([]),
  };
}
export async function requireExecutionSnapshot(
  pool: Pick<Pool, 'query'>,
  config: Record<string, unknown>,
  toolManifest?: Record<string, unknown>,
): Promise<string> {
  const {
    rows: [snapshot],
  } = await pool.query(
    'SELECT * FROM agent_execution_snapshots WHERE schema_version=1 AND snapshot_hash=$1',
    [digest(executionSnapshot(config, toolManifest))],
  );
  if (!snapshot)
    throw new Error(
      'AGENT_EXECUTION_SNAPSHOT_NOT_PUBLISHED: 请用独立配置发布账号运行 publish:agent-config',
    );
  const {
    schema_version,
    scene_key,
    runtime_manifest,
    model_config,
    tool_manifest,
    execution_policy,
    resource_manifest_hash,
  } = snapshot;
  if (
    digest({
      schema_version,
      scene_key,
      runtime_manifest,
      model_config,
      tool_manifest,
      execution_policy,
      resource_manifest_hash,
    }) !== snapshot.snapshot_hash
  )
    throw new Error('AGENT_EXECUTION_SNAPSHOT_CONTENT_CONFLICT');
  return snapshot.id;
}
/** Trusted configuration publication, separate from the HTTP runtime role. No key is persisted. */
export async function publishExecutionSnapshot(
  pool: Pool,
  config: Record<string, unknown>,
  toolManifest?: Record<string, unknown>,
): Promise<string> {
  const value = executionSnapshot(config, toolManifest),
    hash = digest(value);
  await pool.query(
    `INSERT INTO agent_execution_snapshots(id,schema_version,scene_key,snapshot_hash,runtime_manifest,model_config,tool_manifest,execution_policy,resource_manifest_hash,created_at)
    VALUES($1,1,'business_query',$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT(schema_version,snapshot_hash) DO NOTHING`,
    [
      randomUUID(),
      hash,
      JSON.stringify(value.runtime_manifest),
      JSON.stringify(value.model_config),
      JSON.stringify(value.tool_manifest),
      JSON.stringify(value.execution_policy),
      value.resource_manifest_hash,
    ],
  );
  return requireExecutionSnapshot(pool, config, toolManifest);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.AGENT_PUBLISH_DATABASE_URL;
  if (!connectionString)
    throw new Error('配置发布需要独立 AGENT_PUBLISH_DATABASE_URL；不使用业务或运行账号配置');
  const database = createAgentDatabase({ connectionString });
  try {
    await checkAgentDatabase(database.pool);
    await publishExecutionSnapshot(database.pool, modelExecutionConfig(readDirectModelConfig()));
    process.stdout.write('Agent execution snapshot published (credentials excluded)\n');
  } finally {
    await database.close();
  }
}
