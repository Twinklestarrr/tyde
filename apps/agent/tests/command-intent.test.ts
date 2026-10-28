import assert from 'node:assert/strict';
import test from 'node:test';
import canonicalize from 'canonicalize';
import { prepareCommand } from '../src/commands/prepare-command.js';

const conversation = 'a0000000-0000-4000-8000-000000000001';
const requestKey = 'b0000000-0000-4000-8000-000000000001';
const start = {
  schema_version: 1,
  request_key: requestKey,
  kind: 'start_task',
  task_kind: 'business_query',
  input: { text: ' 查询 👋 ' },
};

test('v1 原意图摘要有固定字节；规范化 UUID、空 context，排除传输与实例元数据', () => {
  const prepared = prepareCommand(conversation, start);
  assert.equal(
    prepared.canonicalPayload,
    '{"api_major_version":1,"conversation_id":"a0000000-0000-4000-8000-000000000001","input":{"context":{},"text":" 查询 👋 "},"kind":"start_task","schema_version":1,"task_kind":"business_query"}',
  );
  assert.match(prepared.payloadHash, /^[0-9a-f]{64}$/);
  const reordered = {
    input: { context: {}, text: start.input.text },
    task_kind: start.task_kind,
    kind: start.kind,
    schema_version: 1,
    request_key: 'c0000000-0000-4000-8000-000000000002',
    client_instance_id: 'D0000000-0000-4000-8000-000000000003',
  };
  assert.equal(
    prepareCommand(conversation.toUpperCase(), reordered).payloadHash,
    prepared.payloadHash,
  );
  assert.equal(
    prepareCommand(conversation, reordered).clientInstanceId,
    'd0000000-0000-4000-8000-000000000003',
  );
  assert.equal(start.input.text, ' 查询 👋 ');
  assert.equal('context' in start.input, false);
});

test('正文、业务范围、数组次序和路径变化保持为不同原意图', () => {
  const hash = (input: unknown, path = conversation) =>
    prepareCommand(path, { ...start, input }).payloadHash;
  assert.notEqual(hash({ text: '查询 👋' }), hash(start.input));
  assert.notEqual(hash({ text: '\u00e9' }), hash({ text: 'e\u0301' }));
  assert.notEqual(
    hash({ text: '查询', context: { selected_employee_ids: ['a', 'b'] } }),
    hash({ text: '查询', context: { selected_employee_ids: ['b', 'a'] } }),
  );
  assert.notEqual(hash(start.input), hash(start.input, requestKey));
});

test('准备后的原语义与请求对象隔离，后续修改不能造成 payload 与摘要分离', () => {
  const input = { text: '查询人员', context: { selected_employee_ids: ['a', 'b'] } };
  const prepared = prepareCommand(conversation, { ...start, input });
  input.context.selected_employee_ids.reverse();
  input.text = '另一目标';
  assert.equal(canonicalize(prepared.semanticPayload), prepared.canonicalPayload);
  assert.ok(Object.isFrozen(prepared.semanticPayload));
  assert.ok(Object.isFrozen(prepared.semanticPayload.input));
  assert.ok(Object.isFrozen(prepared));
});

test('控制请求冻结原目标与原版本，stop 不携带版本', () => {
  const control = {
    schema_version: 1,
    request_key: requestKey,
    kind: 'continue_task',
    task_id: 'D0000000-0000-4000-8000-000000000004',
    target_attempt_id: 'E0000000-0000-4000-8000-000000000005',
    expected_task_version: '12',
  };
  const original = prepareCommand(conversation, control);
  assert.notEqual(
    original.payloadHash,
    prepareCommand(conversation, { ...control, expected_task_version: '13' }).payloadHash,
  );
  assert.notEqual(
    original.payloadHash,
    prepareCommand(conversation, { ...control, kind: 'retry_task' }).payloadHash,
  );
  const stop = {
    schema_version: 1,
    request_key: control.request_key,
    kind: 'stop_attempt',
    task_id: control.task_id,
    target_attempt_id: control.target_attempt_id,
  };
  const stopped = prepareCommand(conversation, stop);
  assert.equal('expected_task_version' in stopped.semanticPayload, false);
  assert.throws(
    () => prepareCommand(conversation, { ...stop, expected_task_version: '12' }),
    /INVALID_REQUEST/,
  );
});

test('禁止的 owner、非法 Unicode 和错误版本不能进入意图摘要', () => {
  assert.throws(
    () => prepareCommand(conversation, { ...start, owner_user_id: 'someone' }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => prepareCommand(conversation, { ...start, input: { text: '\ud800' } }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => prepareCommand(conversation, { ...start, schema_version: 2 }),
    /INVALID_REQUEST/,
  );
});

test('固定 canonicalize 版本符合 RFC 8785 的键排序、转义与数值向量', () => {
  // RFC 8785 §3.2.2 / §3.2.3 的数值和 UTF-16 键排序边界。
  assert.equal(
    canonicalize({ z: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27], a: '\n' }),
    '{"a":"\\n","z":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
  );
  assert.equal(
    canonicalize({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '😀': 5, '\u0080': 6, ö: 7 }),
    '{"\\r":2,"1":4,"\u0080":6,"ö":7,"€":1,"😀":5,"דּ":3}',
  );
  assert.throws(() => canonicalize({ x: '\ud800' }), /surrogate/i);
});
