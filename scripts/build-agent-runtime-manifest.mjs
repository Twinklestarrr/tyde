import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const agentRoot = join(root, 'apps/agent');
const sharedRoot = join(root, 'packages/shared');
const agentPackageUrl = pathToFileURL(join(agentRoot, 'package.json'));
const compiled = process.argv.includes('--compiled');
if (process.argv.slice(2).some((argument) => argument !== '--compiled'))
  throw new Error('Usage: build-agent-runtime-manifest.mjs [--compiled]');
if (process.versions.node !== '24.19.0')
  throw new Error('Agent runtime manifest requires Node.js 24.19.0');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([left], [right]) => left.localeCompare(right, 'en')),
        )
      : child,
  );
const fileHash = async (path) => hash(await readFile(path));
async function files(directory, base, pattern) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Agent release inputs cannot contain symbolic links');
    if (entry.isDirectory()) result.push(...(await files(absolute, base, pattern)));
    else if (entry.isFile() && pattern.test(entry.name))
      result.push({
        path: relative(base, absolute).split('\\').join('/'),
        sha256: await fileHash(absolute),
      });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}
const source = await files(join(agentRoot, 'src'), agentRoot, /\.(?:ts|json)$/);
const migrations = await files(join(agentRoot, 'migrations/sql'), agentRoot, /\.sql$/);
const sharedSource = await files(join(sharedRoot, 'src/agent'), sharedRoot, /\.(?:ts|json)$/);
const lock = { path: 'pnpm-lock.yaml', sha256: await fileHash(join(root, 'pnpm-lock.yaml')) };
const contracts = Object.fromEntries(
  await Promise.all(
    ['21-commands.openapi.json', '22-reads-events.openapi.json'].map(async (name) => [
      name,
      await fileHash(join(sharedRoot, 'src/agent/contracts/sources', name)),
    ]),
  ),
);
const pkg = JSON.parse(await readFile(join(agentRoot, 'package.json'), 'utf8'));
const sdk = {};
const sdkVerification = {};
for (const name of [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
]) {
  const packageRoot = dirname(findPackageJSON(name, agentPackageUrl));
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.dependencies[name] !== '1.3.0' || installed.version !== '1.3.0')
    throw new Error('Pi SDK must remain exactly 1.3.0');
  const entries = await files(
    join(packageRoot, 'dist'),
    packageRoot,
    /\.(?:js|mjs|cjs|json|node|wasm)$/,
  );
  sdk[name] = { version: installed.version, code_sha256: hash(stable(entries)) };
  sdkVerification[name] = entries;
}
const identity = {
  manifest_schema_version: 1,
  application_version: pkg.version,
  sdk_version: '1.3.0',
  sdk_packages: sdk,
  runtime_version: 'tyde-pi-native-v1',
  native_format_version: 3,
  node_version: '24.19.0',
  package_manager: 'pnpm@11.23.0',
  platform: process.platform,
  architecture: process.arch,
  code_sha256: hash(
    stable({ source, migrations, shared_source: sharedSource, dependencies: pkg.dependencies }),
  ),
  dependency_lock_sha256: lock.sha256,
  contract_sources: contracts,
};
identity.release_digest = `sha256:${hash(stable(identity))}`;
const manifest = {
  manifest_schema_version: 1,
  identity,
  verification: {
    source,
    migrations,
    shared_source: sharedSource,
    dependency_lock: lock,
    sdk: sdkVerification,
  },
};
if (compiled) {
  manifest.verification.compiled = await files(
    join(agentRoot, 'dist'),
    agentRoot,
    /\.(?:js|json)$/,
  );
  manifest.verification.shared_compiled = await files(
    join(sharedRoot, 'dist/agent'),
    sharedRoot,
    /\.(?:js|json)$/,
  );
  if (!manifest.verification.compiled.length || !manifest.verification.shared_compiled.length)
    throw new Error('Compiled Agent and shared artifacts must exist');
}
await mkdir(join(agentRoot, 'runtime'), { recursive: true });
const manifestPath = join(agentRoot, 'runtime/manifest.json');
const pendingManifest = `${manifestPath}.pending-${process.pid}`;
await writeFile(pendingManifest, JSON.stringify(manifest, null, 2) + '\n');
await rename(pendingManifest, manifestPath);
process.stdout.write(
  `Agent runtime manifest ${identity.release_digest} (${compiled ? 'source + compiled' : 'source'})\n`,
);
