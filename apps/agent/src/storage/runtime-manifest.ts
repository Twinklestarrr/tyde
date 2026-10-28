import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ArtifactFile {
  path: string;
  sha256: string;
}
interface RuntimeManifest {
  manifest_schema_version: number;
  identity: Record<string, unknown>;
  verification: {
    source: ArtifactFile[];
    migrations: ArtifactFile[];
    shared_source: ArtifactFile[];
    dependency_lock: ArtifactFile;
    sdk: Record<string, ArtifactFile[]>;
    compiled?: ArtifactFile[];
    shared_compiled?: ArtifactFile[];
  };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([left], [right]) => left.localeCompare(right, 'en')),
        )
      : child,
  );
const fail = (): never => {
  throw new Error('AGENT_RUNTIME_ARTIFACT_UNAVAILABLE_OR_CHANGED');
};
function verifyFiles(root: string, files: ArtifactFile[] | undefined, prefix: string): void {
  if (!Array.isArray(files) || !files.length) fail();
  const realRoot = realpathSync(root);
  const seen = new Set<string>();
  for (const entry of files ?? fail()) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith(prefix) ||
      entry.path.includes('\\') ||
      entry.path.split('/').some((segment) => !segment || segment === '..' || segment === '.') ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    )
      fail();
    seen.add(entry.path);
    const absolute = realpathSync(join(realRoot, entry.path));
    const scoped = relative(realRoot, absolute);
    if (scoped.startsWith('..') || scoped.startsWith('/')) fail();
    if (hash(readFileSync(absolute)) !== entry.sha256) fail();
  }
}

/** Internal release verifier. The only runtime entry point is getRuntimeManifest(). */
export function readVerifiedRuntimeManifest(
  agentRoot: string,
  mode: 'source' | 'compiled',
): Record<string, unknown> {
  try {
    const manifest = JSON.parse(
      readFileSync(join(agentRoot, 'runtime/manifest.json'), 'utf8'),
    ) as RuntimeManifest;
    const identity = manifest.identity;
    if (
      manifest.manifest_schema_version !== 1 ||
      !identity ||
      identity.manifest_schema_version !== 1 ||
      identity.sdk_version !== '1.3.0' ||
      identity.runtime_version !== 'tyde-pi-native-v1' ||
      identity.native_format_version !== 3 ||
      identity.node_version !== process.versions.node ||
      identity.node_version !== '24.19.0' ||
      identity.platform !== process.platform ||
      identity.architecture !== process.arch
    )
      fail();
    const { release_digest: release, ...body } = identity;
    if (release !== `sha256:${hash(stable(body))}`) fail();
    const appPackage = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf8'));
    if (
      identity.code_sha256 !==
      hash(
        stable({
          source: manifest.verification.source,
          migrations: manifest.verification.migrations,
          shared_source: manifest.verification.shared_source,
          dependencies: appPackage.dependencies,
        }),
      )
    )
      fail();
    verifyFiles(agentRoot, manifest.verification.migrations, 'migrations/sql/');
    const agentPackageUrl = pathToFileURL(join(agentRoot, 'package.json'));
    const sdkPackages = identity.sdk_packages as Record<
      string,
      { version: string; code_sha256: string }
    >;
    for (const name of [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
    ]) {
      const packageRoot = dirname(findPackageJSON(name, agentPackageUrl) ?? fail());
      const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      const files = manifest.verification.sdk[name];
      if (
        pkg.version !== '1.3.0' ||
        sdkPackages[name]?.version !== pkg.version ||
        sdkPackages[name]?.code_sha256 !== hash(stable(files))
      )
        fail();
      verifyFiles(packageRoot, files, 'dist/');
    }
    if (mode === 'source') {
      const workspaceRoot = join(agentRoot, '../..');
      verifyFiles(agentRoot, manifest.verification.source, 'src/');
      const sharedRoot = join(workspaceRoot, 'packages/shared');
      verifyFiles(sharedRoot, manifest.verification.shared_source, 'src/agent/');
      const lock = manifest.verification.dependency_lock;
      if (
        lock.path !== 'pnpm-lock.yaml' ||
        lock.sha256 !== identity.dependency_lock_sha256 ||
        hash(readFileSync(join(workspaceRoot, lock.path))) !== lock.sha256
      )
        fail();
    } else {
      verifyFiles(agentRoot, manifest.verification.compiled, 'dist/');
      const sharedRoot = dirname(findPackageJSON('@tyde/shared/agent', agentPackageUrl) ?? fail());
      verifyFiles(sharedRoot, manifest.verification.shared_compiled, 'dist/agent/');
    }
    return structuredClone(identity);
  } catch {
    return fail();
  }
}

/** Same immutable identity in source and compiled packages; missing/stale artifacts block startup. */
export function getRuntimeManifest(): Record<string, unknown> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return readVerifiedRuntimeManifest(root, import.meta.url.endsWith('.ts') ? 'source' : 'compiled');
}
