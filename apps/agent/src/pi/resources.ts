import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PiMemoryTool } from './session.js';

export interface TrustedTextResource {
  id: string;
  version: string;
  /** Expected digest from the trusted deployment manifest, never from a browser. */
  sha256: string;
  body: string;
}

export interface PiResourceManifest {
  id: string;
  version: string;
  sha256: string;
  skillActivation: 'host-preloaded-system-prompt';
  resources: readonly {
    id: string;
    version: string;
    sha256: string;
    kind: 'prompt' | 'skill' | 'asset';
  }[];
  tools: readonly {
    name: string;
    schemaSha256: string;
    declarationSha256: string;
    version: string;
  }[];
}

export interface TrustedPiResources {
  readonly manifest: PiResourceManifest;
  readonly systemPrompt: string;
  readonly tools: readonly PiMemoryTool[];
}

const trustedBundles = new WeakSet<object>();

export function assertTrustedPiResources(value: TrustedPiResources): void {
  if (!trustedBundles.has(value)) throw new Error('PI_RESOURCE_BUNDLE_UNTRUSTED');
}

export function resourceSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function identity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Explicit, deployment-owned assembly. No paths, environment lookup, discovery,
 * imports or hot reload are performed here. The caller supplies already read text.
 * Skill bodies are actually preloaded into the system prompt; Pi's native Skill
 * discovery/expansion stays disabled and is not claimed as validated.
 */
export function freezePiResources(input: {
  id: string;
  version: string;
  systemPrompt: TrustedTextResource;
  skills?: readonly TrustedTextResource[];
  /** Validated deployment data/code identities; these bodies are not prompt text. */
  assets?: readonly TrustedTextResource[];
  tools?: readonly (PiMemoryTool & { version: string })[];
}): TrustedPiResources {
  if (!identity(input.id) || !identity(input.version)) throw new Error('PI_RESOURCE_ID_INVALID');
  const texts = [input.systemPrompt, ...(input.skills ?? []), ...(input.assets ?? [])];
  if (texts.some((item) => !item)) throw new Error('PI_RESOURCE_MISSING_OR_INVALID');
  if (texts.length > 33 || new Set(texts.map((item) => item.id)).size !== texts.length)
    throw new Error('PI_RESOURCE_MANIFEST_INVALID');
  for (const item of texts) {
    if (
      !item ||
      !identity(item.id) ||
      !identity(item.version) ||
      typeof item.body !== 'string' ||
      !item.body.trim() ||
      Buffer.byteLength(item.body, 'utf8') > 256 * 1024 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error('PI_RESOURCE_MISSING_OR_INVALID');
    if (resourceSha256(item.body) !== item.sha256) throw new Error('PI_RESOURCE_DIGEST_MISMATCH');
  }
  const tools = (input.tools ?? []).map((tool) => {
    if (!identity(tool.version)) throw new Error('PI_RESOURCE_TOOL_VERSION_INVALID');
    return Object.freeze({
      ...tool,
      parameters: freeze(structuredClone(tool.parameters)),
      ...(tool.publicMetadata
        ? { publicMetadata: freeze(structuredClone(tool.publicMetadata)) }
        : {}),
    });
  });
  const descriptor = {
    id: input.id,
    version: input.version,
    skillActivation: 'host-preloaded-system-prompt' as const,
    resources: texts.map((item, index) => ({
      id: item.id,
      version: item.version,
      sha256: item.sha256,
      kind:
        index === 0
          ? ('prompt' as const)
          : index <= (input.skills?.length ?? 0)
            ? ('skill' as const)
            : ('asset' as const),
    })),
    tools: tools.map((tool) => ({
      name: tool.name,
      schemaSha256: resourceSha256(canonicalize(tool.parameters)!),
      declarationSha256: resourceSha256(
        canonicalize({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          publicMetadata: tool.publicMetadata ?? null,
          timeoutMs: tool.timeoutMs ?? 30_000,
          version: tool.version,
        })!,
      ),
      version: tool.version,
    })),
  };
  const manifest = freeze({ ...descriptor, sha256: resourceSha256(canonicalize(descriptor)!) });
  const bundle = Object.freeze({
    manifest,
    systemPrompt: [
      input.systemPrompt.body,
      ...(input.skills ?? []).map(
        (skill) =>
          `\n<host-preloaded-skill id="${skill.id}" version="${skill.version}">\n${skill.body}\n</host-preloaded-skill>`,
      ),
    ].join('\n'),
    tools: Object.freeze(tools),
  });
  trustedBundles.add(bundle);
  return bundle;
}
