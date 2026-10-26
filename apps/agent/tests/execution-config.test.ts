import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { readDirectModelConfig } from '../src/maas/direct-model.js';
import { digest } from '../src/storage/projections.js';
import {
  executionSnapshot,
  modelExecutionConfig,
  publishExecutionSnapshot,
  requireExecutionSnapshot,
} from '../src/storage/execution-config.js';

const config = modelExecutionConfig(
  readDirectModelConfig({
    AGENT_MODEL_BASE_URL: 'https://controlled.example.invalid/v1',
    AGENT_MODEL_ID: 'controlled-unit-model',
    AGENT_MODEL_API_KEY: 'controlled-unit-key-not-a-secret',
  }),
);
const saved = () => {
  const body = executionSnapshot(config);
  return { id: randomUUID(), ...body, snapshot_hash: digest(body), created_at: new Date() };
};
function reader(row: Record<string, unknown> | undefined) {
  return {
    query: async (sql: string, values: unknown[]) => {
      assert(sql.startsWith('SELECT * FROM agent_execution_snapshots'));
      assert.equal(values[0], digest(executionSnapshot(config)));
      return { rows: row ? [structuredClone(row)] : [] };
    },
  } as Pick<Pool, 'query'>;
}

test('固定快照：完整相同语义返回既有ID，UUID和创建时间不进入摘要', async () => {
  const row = saved();
  const pool = reader(row);
  assert.equal(await requireExecutionSnapshot(pool, config), row.id);
  row.created_at = new Date('2000-01-01T00:00:00Z');
  assert.equal(await requireExecutionSnapshot(pool, config), row.id);
  assert.equal(row.snapshot_hash, digest(executionSnapshot(config)));
});

test('固定快照：声明hash不代替完整内容，逐项损坏均明确拒绝', async () => {
  const baseline = saved();
  const corruptions: Record<string, unknown> = {
    schema_version: 2,
    scene_key: 'scheduling_draft',
    runtime_manifest: { runtime_version: 'changed-runtime' },
    model_config: { baseUrl: 'https://changed.example.invalid/v1' },
    tool_manifest: { tools: [{ name: 'unexpected_tool' }] },
    execution_policy: { attempt_limits: { max_duration_ms: 1 } },
    resource_manifest_hash: digest(['unexpected-resource']),
  };
  for (const [field, value] of Object.entries(corruptions)) {
    await assert.rejects(
      requireExecutionSnapshot(reader({ ...baseline, [field]: value }), config),
      /AGENT_EXECUTION_SNAPSHOT_CONTENT_CONFLICT/,
      field,
    );
  }
  await assert.rejects(
    requireExecutionSnapshot(reader(undefined), config),
    /AGENT_EXECUTION_SNAPSHOT_NOT_PUBLISHED/,
  );
});

test('固定快照：重复发布相同内容返回原ID，冲突内容不能被DO NOTHING掩盖', async () => {
  let row: Record<string, unknown> | undefined;
  let inserts = 0;
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('INSERT INTO')) {
        inserts++;
        row ??= {
          id: values[0],
          schema_version: 1,
          scene_key: 'business_query',
          snapshot_hash: values[1],
          runtime_manifest: JSON.parse(values[2] as string),
          model_config: JSON.parse(values[3] as string),
          tool_manifest: JSON.parse(values[4] as string),
          execution_policy: JSON.parse(values[5] as string),
          resource_manifest_hash: values[6],
        };
        return { rows: [] };
      }
      return { rows: row ? [structuredClone(row)] : [] };
    },
  } as unknown as Pool;
  const id = await publishExecutionSnapshot(pool, config);
  assert.equal(await publishExecutionSnapshot(pool, config), id);
  assert.equal(inserts, 2);
  row!.model_config = { modelId: 'corrupt-existing-row' };
  await assert.rejects(
    publishExecutionSnapshot(pool, config),
    /AGENT_EXECUTION_SNAPSHOT_CONTENT_CONFLICT/,
  );
});

test('固定快照：模型协议、逻辑凭据及禁止隐式能力明确固定且不保存Key', () => {
  const snapshot = executionSnapshot(config);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.scene_key, 'business_query');
  assert.equal(config.api, 'openai-completions');
  assert.equal(config.credential_ref, 'server:direct-model');
  assert.equal(config.preset_version, 'tyde-direct-model-v1');
  assert.match(config.endpoint_config_version as string, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes('controlled-unit-key-not-a-secret'), false);
  assert.equal(snapshot.execution_policy.implicit_retries, 0);
  assert.equal(snapshot.execution_policy.automatic_compaction, false);
  assert.equal(snapshot.execution_policy.resource_discovery, 'disabled');
  assert.equal(snapshot.execution_policy.resource_loading, 'explicit-pinned-only');
});

test('资源快照：完整资源摘要参与身份，普通发布入口不能写入缺失成员的快照', async () => {
  const resourceHash = 'a'.repeat(64);
  const plain = executionSnapshot(config);
  const resources = executionSnapshot(config, { tools: [] }, resourceHash);
  assert.equal(resources.resource_manifest_hash, resourceHash);
  assert.notEqual(digest(resources), digest(plain));
  assert.throws(
    () => executionSnapshot(config, { tools: [] }, 'invalid'),
    /AGENT_RESOURCE_MANIFEST_HASH_INVALID/,
  );
  const pool = {
    query: async () => {
      assert.fail('resource snapshot requires the atomic resource publisher');
    },
  } as unknown as Pool;
  await assert.rejects(
    publishExecutionSnapshot(pool, config, { tools: [] }, resourceHash),
    /AGENT_RESOURCE_SNAPSHOT_PUBLISHER_REQUIRED/,
  );
});
