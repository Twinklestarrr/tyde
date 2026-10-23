import {
  SessionManager,
  type SessionEntry,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent';
import { isDeepStrictEqual } from 'node:util';

export const PI_SDK_VERSION = '1.3.0';
export const PI_SOURCE_COMMIT = '71023aec1546d6d677a65669c5665c0927ce0dd0';
export const PI_NATIVE_FORMAT_VERSION = 3;
export const PI_RUNTIME_VERSION = 'tyde-pi-native-v1';

/** The full Pi JSON payload and selected leaf; product messages are never a restore source. */
export interface PiNativeState {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
  sdkVersion: typeof PI_SDK_VERSION;
  nativeFormatVersion: typeof PI_NATIVE_FORMAT_VERSION;
  runtimeVersion: typeof PI_RUNTIME_VERSION;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('PI_NATIVE_STATE_INVALID');
}
function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function content(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.every(
        (part) =>
          record(part) &&
          ((part.type === 'text' && typeof part.text === 'string') ||
            (part.type === 'image' && string(part.data) && string(part.mimeType))),
      ))
  );
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return (
    record(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(value).every(jsonValue)
  );
}
function checkMessage(message: unknown) {
  ensure(record(message) && string(message.role) && Number.isFinite(message.timestamp));
  switch (message.role) {
    case 'system':
      ensure(content(message.content));
      break;
    case 'user':
      ensure(content(message.content));
      break;
    case 'assistant':
      ensure(
        Array.isArray(message.content) &&
          string(message.api) &&
          string(message.provider) &&
          string(message.model) &&
          record(message.usage) &&
          ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(message.stopReason)),
      );
      for (const part of message.content) {
        ensure(record(part) && ['text', 'thinking', 'toolCall'].includes(String(part.type)));
        if (part.type === 'text') ensure(typeof part.text === 'string');
        if (part.type === 'thinking') ensure(typeof part.thinking === 'string');
        if (part.type === 'toolCall')
          ensure(string(part.id) && string(part.name) && record(part.arguments));
      }
      break;
    case 'toolResult':
      ensure(
        string(message.toolCallId) &&
          string(message.toolName) &&
          content(message.content) &&
          Array.isArray(message.content) &&
          typeof message.isError === 'boolean',
      );
      break;
    case 'custom':
      ensure(string(message.customType) && content(message.content));
      break;
    case 'bashExecution':
      // Supported native history, without exposing a shell tool in this runtime.
      ensure(typeof message.command === 'string' && typeof message.output === 'string');
      break;
    default:
      throw new Error('PI_NATIVE_MESSAGE_UNSUPPORTED');
  }
}

/** Check the fixed native wire format without rewriting unknown fields or migrating payloads. */
export function validatePiNativeState(value: unknown): asserts value is PiNativeState {
  ensure(record(value) && jsonValue(value));
  if (
    value.sdkVersion !== PI_SDK_VERSION ||
    value.nativeFormatVersion !== PI_NATIVE_FORMAT_VERSION ||
    value.runtimeVersion !== PI_RUNTIME_VERSION
  )
    throw new Error('PI_NATIVE_VERSION_UNSUPPORTED');
  ensure(record(value.header));
  const header = value.header;
  ensure(
    header.type === 'session' &&
      header.version === PI_NATIVE_FORMAT_VERSION &&
      string(header.id) &&
      timestamp(header.timestamp) &&
      typeof header.cwd === 'string',
  );
  ensure(Array.isArray(value.entries));
  const prior = new Map<string, Record<string, unknown>>();
  for (const entry of value.entries) {
    ensure(
      record(entry) &&
        string(entry.id) &&
        !prior.has(entry.id) &&
        timestamp(entry.timestamp) &&
        (entry.parentId === null || (string(entry.parentId) && prior.has(entry.parentId))),
    );
    prior.set(entry.id, entry);
    switch (entry.type) {
      case 'message':
        checkMessage(entry.message);
        break;
      case 'model_change':
        ensure(string(entry.provider) && string(entry.modelId));
        break;
      case 'thinking_level_change':
        ensure(string(entry.thinkingLevel));
        break;
      case 'usage':
        ensure(
          string(entry.kind) &&
            string(entry.provider) &&
            string(entry.model) &&
            record(entry.usage),
        );
        break;
      case 'custom':
        ensure(string(entry.customType));
        break;
      case 'custom_message':
        ensure(
          string(entry.customType) && content(entry.content) && typeof entry.display === 'boolean',
        );
        break;
      case 'compaction':
        ensure(
          typeof entry.summary === 'string' &&
            string(entry.firstKeptEntryId) &&
            Number.isFinite(entry.tokensBefore),
        );
        break;
      case 'branch_summary':
        ensure(string(entry.fromId) && typeof entry.summary === 'string');
        break;
      case 'context_edit':
        ensure(
          string(entry.targetId) &&
            prior.has(entry.targetId) &&
            (entry.replacement === null ||
              (record(entry.replacement) && content(entry.replacement.content))),
        );
        break;
      case 'label':
        ensure(string(entry.targetId));
        break;
      case 'session_info':
        ensure(entry.name === undefined || typeof entry.name === 'string');
        break;
      default:
        throw new Error('PI_NATIVE_ENTRY_UNSUPPORTED');
    }
  }
  // Other native references may point to a later append or the compaction entry itself.
  for (const entry of value.entries) {
    ensure(record(entry));
    for (const key of ['firstKeptEntryId', 'fromId', 'targetId']) {
      const referenced = entry[key];
      if (referenced !== undefined)
        ensure(
          string(referenced) &&
            (prior.has(referenced) ||
              (entry.type === 'branch_summary' && key === 'fromId' && referenced === 'root')),
        );
    }
  }
  ensure(value.leafId === null || (string(value.leafId) && prior.has(value.leafId)));
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Match Pi's native JSON serialization (optional undefined fields have no wire value). */
export function capturePiNativeState(manager: SessionManager): PiNativeState {
  const value: unknown = JSON.parse(
    JSON.stringify({
      header: manager.getHeader(),
      entries: manager.getEntries(),
      leafId: manager.getLeafId(),
      sdkVersion: PI_SDK_VERSION,
      nativeFormatVersion: PI_NATIVE_FORMAT_VERSION,
      runtimeVersion: PI_RUNTIME_VERSION,
    }),
  );
  validatePiNativeState(value);
  return value;
}

/** Every awaited save receives an independent immutable request, never live SDK references. */
export function freezePiNativeState(manager: SessionManager): PiNativeState {
  return freeze(capturePiNativeState(manager));
}

/** R0 has a native header, no entries and an explicitly null active leaf. */
export function createInitialNativeState(cwd?: string): PiNativeState {
  return freezePiNativeState(SessionManager.inMemory(cwd));
}

export function restorePiNativeState(state: PiNativeState): SessionManager {
  validatePiNativeState(state);
  const copy = structuredClone(state);
  ensure(copy.header);
  const manager = SessionManager.inMemory(copy.header.cwd, undefined, [
    copy.header,
    ...copy.entries,
  ]);
  // inMemory's loader otherwise selects the last append, which may be another branch.
  if (copy.leafId === null) manager.resetLeaf();
  else manager.branch(copy.leafId);
  ensure(isDeepStrictEqual(capturePiNativeState(manager), copy));
  return manager;
}
