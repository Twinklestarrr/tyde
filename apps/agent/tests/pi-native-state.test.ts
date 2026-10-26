import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  capturePiNativeState,
  createInitialNativeState,
  freezePiNativeState,
  restorePiNativeState,
  validatePiNativeState,
} from '../src/pi/index.js';

import { nativeSample } from './fixtures/pi-native.js';

test('checked-in SDK-generated native sample loads without dropping raw fields', async () => {
  const raw: unknown = JSON.parse(
    await readFile(new URL('./fixtures/pi-native-v3.json', import.meta.url), 'utf8'),
  );
  validatePiNativeState(raw);
  assert.deepEqual(capturePiNativeState(restorePiNativeState(raw)), raw);
});

test('R0 is a frozen native header with empty prefix and null leaf', () => {
  const initial = createInitialNativeState('/isolated/r0');
  assert.equal(initial.header?.version, 3);
  assert.equal(initial.sdkVersion, '1.3.0');
  assert.deepEqual(initial.entries, []);
  assert.equal(initial.leafId, null);
  assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.header));
  assert.deepEqual(capturePiNativeState(restorePiNativeState(initial)), initial);
});

test('SDK native all fields, append order, compaction, edits, branches and multiple roots round-trip', () => {
  const { manager, input } = nativeSample();
  const state = capturePiNativeState(manager);
  assert.equal(state.leafId, input);
  assert.notEqual(state.leafId, state.entries.at(-1)?.id);
  assert.equal(state.entries.filter((entry) => entry.parentId === null).length, 2);
  assert.equal(new Set(state.entries.map((entry) => entry.type)).size, 11);
  const restored = restorePiNativeState(state);
  assert.deepEqual(capturePiNativeState(restored), state);
  assert.deepEqual(restored.buildSessionContext(), manager.buildSessionContext());
  manager.resetLeaf();
  const nullLeaf = capturePiNativeState(manager);
  assert.equal(restorePiNativeState(nullLeaf).getLeafId(), null);
  assert.deepEqual(restorePiNativeState(nullLeaf).buildSessionContext().messages, []);
  assert.deepEqual(capturePiNativeState(restored).entries, nullLeaf.entries);
  // JSONB may reorder object keys. Semantic payload identity must not depend on that order.
  const reordered = JSON.parse(JSON.stringify(state), (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.deepEqual(capturePiNativeState(restorePiNativeState(reordered)), state);
});

test('root branch summary native sentinel and immutable save copies are supported', () => {
  const manager = SessionManager.inMemory('/isolated/root-summary');
  manager.branchWithSummary(null, 'root summary');
  const frozen = freezePiNativeState(manager);
  assert.deepEqual(capturePiNativeState(restorePiNativeState(frozen)), frozen);
  assert.ok(Object.isFrozen(frozen.entries[0]));
  assert.throws(() => frozen.entries.push(frozen.entries[0]!));
  manager.appendCustomEntry('later', { notInFrozenRequest: true });
  assert.equal(frozen.entries.length, 1);
});

test('incompatible format/runtime, corruption and rewritten parent chains block native loading', () => {
  const state = capturePiNativeState(nativeSample().manager);
  for (const patch of [
    { sdkVersion: '1.4.0' },
    { nativeFormatVersion: 2 },
    { runtimeVersion: 'unknown-runtime' },
    { header: { ...state.header, version: 2 } },
    { leafId: 'missing' },
    { entries: [...state.entries].reverse() },
    { entries: [...state.entries, state.entries[0]] },
    { entries: [{ ...state.entries[0], parentId: state.entries[0]!.id }] },
    { entries: [{ ...state.entries[0], type: 'unsupported-future-type' }] },
  ]) {
    assert.throws(() => validatePiNativeState({ ...state, ...patch }), /PI_NATIVE_/);
  }
  assert.deepEqual(capturePiNativeState(restorePiNativeState(state)), state);
});
