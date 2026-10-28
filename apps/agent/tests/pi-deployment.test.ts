import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { Type } from '@earendil-works/pi-ai';
import { freezePiResources, resourceSha256 } from '../src/pi/resources.js';
import {
  createTrustedPiDeployment,
  prepareTrustedPiDeployment,
} from '../src/storage/pi-deployment.js';
import type { ResourceArtifactPublication } from '../src/storage/resource-publication.js';

function fixture() {
  const version = '1.0.0';
  const text = (id: string, body: string) => ({ id, body, version, sha256: resourceSha256(body) });
  const prompt = text('fixture-prompt', 'Use only explicit deployment resources.');
  const skill = text('fixture-skill', 'For a fixture lookup, call the fixed readonly tool.');
  const code = text('fixture-code', "export const readFixture = () => 'synthetic';");
  const resources = freezePiResources({
    id: 'deployment-fixture',
    version,
    systemPrompt: prompt,
    skills: [skill],
    assets: [code],
    tools: [
      {
        name: 'read_fixture',
        version,
        description: 'Read an isolated synthetic value.',
        parameters: Type.Object({}, { additionalProperties: false }),
        validate: (args) => Object.keys(args).length === 0,
        execute: async () => 'synthetic',
      },
    ],
  });
  const files = [prompt, skill, code].map((resource, index) => ({
    path: ['prompt.md', 'SKILL.md', 'tool.mjs'][index]!,
    size_bytes: Buffer.byteLength(resource.body),
    sha256: resource.sha256,
    mode: '0644',
    kind: 'file',
    ...(index === 2 ? { exports: ['readFixture'] } : {}),
  }));
  const artifact: ResourceArtifactPublication = {
    artifact_key: 'deployment-fixture',
    version_label: version,
    manifest_schema_version: 1,
    source_descriptor: { kind: 'isolated-unit-fixture' },
    file_manifest: { files },
    archive_digest: resourceSha256(JSON.stringify(files)),
    tree_digest: resourceSha256(JSON.stringify(files)),
    archive_size_bytes: '0',
    storage_descriptor: { kind: 'isolated-unit-fixture' },
    runtime_compatibility: { pi_sdk: '1.3.0' },
    publication: { kind: 'isolated-unit-fixture' },
  };
  const members = [prompt, skill, code].map((resource, index) => ({
    member_key: resource.id,
    artifact_key: artifact.artifact_key,
    version_label: version,
    resource_kind: ['prompt', 'skill', 'business_adapter'][index]!,
    entry_path: files[index]!.path,
    load_order: index,
    options: {},
  }));
  const input = {
    resources,
    artifacts: [artifact],
    members,
    toolBindings: [
      {
        toolName: 'read_fixture',
        memberKey: code.id,
        exportName: 'readFixture',
        readOnly: true as const,
      },
    ],
    verifyArtifact: async (_artifact: Readonly<ResourceArtifactPublication>) => {},
  };
  return { input, resources };
}

test('可信部署固定工具导出、资源顺序和完整宿主身份，隔离后不受调用方修改影响', () => {
  const { input, resources } = fixture();
  const deployment = createTrustedPiDeployment(input);
  input.members[0]!.entry_path = 'changed.md';
  assert.equal(deployment.members[0]!.entry_path, 'prompt.md');
  assert.ok(Object.isFrozen(deployment.members));
  assert.ok(Object.isFrozen(deployment.toolManifest));
  assert.deepEqual(deployment.toolManifest.host_resources, resources.manifest);
  const tools = deployment.toolManifest.tools as Record<string, unknown>[];
  assert.deepEqual(tools[0]!.implementation, {
    member_key: 'fixture-code',
    export_name: 'readFixture',
  });
});

test('资源缺失、摘要不符、顺序变化及没有真实导出的工具绑定均拒绝', () => {
  const mutate = [
    (input: ReturnType<typeof fixture>['input']) => {
      input.members.pop();
    },
    (input: ReturnType<typeof fixture>['input']) => {
      input.members[0]!.load_order = 2;
    },
    (input: ReturnType<typeof fixture>['input']) => {
      input.artifacts[0]!.version_label = '2.0.0';
    },
    (input: ReturnType<typeof fixture>['input']) => {
      input.toolBindings[0]!.exportName = 'missing';
    },
  ];
  for (const change of mutate) {
    const { input } = fixture();
    change(input);
    assert.throws(() => createTrustedPiDeployment(input));
  }
  const { input } = fixture();
  const files = (input.artifacts[0]!.file_manifest as { files: { sha256: string }[] }).files;
  files[0]!.sha256 = '0'.repeat(64);
  assert.throws(() => createTrustedPiDeployment(input), /PI_RESOURCE_DEPLOYMENT_INVALID/);
});

test('准备部署先核验固定资源字节，再使用数据库规范化摘要，不执行发布写入', async () => {
  const { input } = fixture();
  const order: string[] = [];
  input.verifyArtifact = async () => {
    order.push('verify');
  };
  const deployment = createTrustedPiDeployment(input);
  const resourceHash = 'a'.repeat(64);
  const pool = {
    query: async (sql: string) => {
      order.push('normalize');
      assert.match(sql, /^SELECT agent.resource_manifest_normalize/);
      return { rows: [{ manifest: [], hash: resourceHash }] };
    },
  } as unknown as Pick<Pool, 'query'>;
  const prepared = await prepareTrustedPiDeployment(pool, deployment);
  assert.deepEqual(order, ['verify', 'normalize']);
  assert.equal(prepared.resourceManifestHash, resourceHash);
  assert.deepEqual(prepared.toolManifest.host_resources, deployment.resources.manifest);
});

test('无法核验资源时阻断，禁止退回空资源配置', async () => {
  const { input } = fixture();
  input.verifyArtifact = async () => {
    throw new Error('FIXTURE_RESOURCE_UNAVAILABLE');
  };
  const deployment = createTrustedPiDeployment(input);
  const pool = {
    query: async () => {
      assert.fail('resource failure must block database normalization');
    },
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(
    prepareTrustedPiDeployment(pool, deployment),
    /FIXTURE_RESOURCE_UNAVAILABLE/,
  );
});
