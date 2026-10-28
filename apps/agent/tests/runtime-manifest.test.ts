import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  getRuntimeManifest,
  readVerifiedRuntimeManifest,
} from '../src/storage/runtime-manifest.js';
const agentRoot = fileURLToPath(new URL('../', import.meta.url));
const workspaceRoot = join(agentRoot, '../..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tyde-w5-manifest-'));
  const target = join(root, 'apps/agent');
  const manifest = JSON.parse(await readFile(join(agentRoot, 'runtime/manifest.json'), 'utf8'));
  await mkdir(join(target, 'runtime'), { recursive: true });
  await cp(join(agentRoot, 'package.json'), join(target, 'package.json'));
  await symlink(join(agentRoot, 'node_modules'), join(target, 'node_modules'), 'dir');
  for (const entry of [...manifest.verification.source, ...manifest.verification.migrations]) {
    await mkdir(dirname(join(target, entry.path)), { recursive: true });
    await cp(join(agentRoot, entry.path), join(target, entry.path));
  }
  for (const entry of manifest.verification.shared_source) {
    const to = join(root, 'packages/shared', entry.path);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(workspaceRoot, 'packages/shared', entry.path), to);
  }
  await cp(join(workspaceRoot, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'));
  await writeFile(join(target, 'runtime/manifest.json'), JSON.stringify(manifest));
  return {
    root,
    target,
    manifest,
    save: () => writeFile(join(target, 'runtime/manifest.json'), JSON.stringify(manifest)),
  };
}

test('运行清单固定发布/代码/锁/SDK/契约与精确运行环境；不含本机路径或凭据', () => {
  const identity = getRuntimeManifest();
  assert.equal(identity.sdk_version, '1.3.0');
  assert.equal(identity.node_version, '24.19.0');
  assert.equal(identity.native_format_version, 3);
  assert.match(String(identity.release_digest), /^sha256:[a-f0-9]{64}$/);
  assert.match(String(identity.code_sha256), /^[a-f0-9]{64}$/);
  assert.match(String(identity.dependency_lock_sha256), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(identity).includes(agentRoot), false);
  assert.equal(JSON.stringify(identity).includes('apiKey'), false);
});

test('源码变化、清单丢失和不兼容运行版本明确阻断', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(readVerifiedRuntimeManifest(f.target, 'source'), f.manifest.identity);
    const source = join(f.target, f.manifest.verification.source[0].path);
    await writeFile(source, (await readFile(source, 'utf8')) + '\n// controlled drift\n');
    assert.throws(() => readVerifiedRuntimeManifest(f.target, 'source'), /AGENT_RUNTIME_ARTIFACT/);
    await cp(join(agentRoot, f.manifest.verification.source[0].path), source);
    f.manifest.identity.node_version = '24.18.0';
    await f.save();
    assert.throws(() => readVerifiedRuntimeManifest(f.target, 'source'), /AGENT_RUNTIME_ARTIFACT/);
    await rm(join(f.target, 'runtime/manifest.json'));
    assert.throws(() => readVerifiedRuntimeManifest(f.target, 'source'), /AGENT_RUNTIME_ARTIFACT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('源码与compiled验证返回同一identity；compiled包不依赖源码且产物漂移拒绝', async () => {
  const f = await fixture();
  try {
    const sourceIdentity = readVerifiedRuntimeManifest(f.target, 'source');
    const bytes = 'export const controlledReleaseFixture = true;\n';
    await mkdir(join(f.target, 'dist'), { recursive: true });
    await writeFile(join(f.target, 'dist/entry.js'), bytes);
    f.manifest.verification.compiled = [{ path: 'dist/entry.js', sha256: hash(bytes) }];
    const sharedRoot = join(workspaceRoot, 'packages/shared');
    async function compiledFiles(folder: string): Promise<{ path: string; sha256: string }[]> {
      const entries = [];
      for (const item of await readdir(join(sharedRoot, folder), { withFileTypes: true })) {
        const path = `${folder}/${item.name}`;
        if (item.isDirectory()) entries.push(...(await compiledFiles(path)));
        else if (/\.(?:js|json)$/.test(item.name))
          entries.push({ path, sha256: hash(await readFile(join(sharedRoot, path))) });
      }
      return entries;
    }
    f.manifest.verification.shared_compiled = await compiledFiles('dist/agent');
    await f.save();
    await rm(join(f.target, 'src'), { recursive: true });
    assert.deepEqual(readVerifiedRuntimeManifest(f.target, 'compiled'), sourceIdentity);
    await writeFile(
      join(f.target, 'dist/entry.js'),
      'export const controlledReleaseFixture = false;\n',
    );
    assert.throws(
      () => readVerifiedRuntimeManifest(f.target, 'compiled'),
      /AGENT_RUNTIME_ARTIFACT/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
