import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  agentContractSchemas,
  agentContractSources,
  validateAgentContract,
  type AgentContractName,
} from '../../../packages/shared/src/agent/contracts/index.js';

const id = (digit: string) => `${digit}0000000-0000-4000-8000-000000000001`;
const now = '2026-10-22T08:00:00Z';
const request = { schema_version: 1, request_key: id('1') };
const start = {
  ...request,
  kind: 'start_task',
  task_kind: 'business_query',
  input: { text: '查询人员' },
};
const target = { ...request, task_id: id('2'), target_attempt_id: id('3') };
const activity = { last_activity_at: now, last_message_seq: '1' };
const attempt = {
  id: id('3'),
  attempt_no: 1,
  previous_attempt_id: null,
  start_reason: 'initial',
  outcome: null,
  created_at: now,
  started_at: now,
  stop_requested_at: null,
  ended_at: null,
  error: null,
};
const task = {
  id: id('2'),
  conversation_id: id('4'),
  task_kind: 'business_query',
  goal_text: '查询人员',
  business_scope: {},
  scope_locked_at: now,
  status: 'running',
  row_version: '1',
  created_at: now,
  updated_at: now,
  completed_at: null,
  latest_attempt: attempt,
  active_attempt_id: id('3'),
  result_id: null,
};
const message = {
  id: id('5'),
  conversation_id: id('4'),
  task_id: id('2'),
  attempt_id: id('3'),
  message_seq: '1',
  message_type: 'assistant_output',
  status: 'in_progress',
  content_schema_version: 1,
  content: { blocks: [], context: null },
  row_version: '0',
  source_command_id: null,
  result_id: null,
  created_at: now,
  updated_at: now,
};
const inputReceipt = {
  command_id: id('6'),
  user_message_id: id('7'),
  task_id: id('2'),
  input_state: 'consumed',
  input_attempt_id: id('3'),
  handling_summary: null,
};
const result = {
  id: id('8'),
  conversation_id: id('4'),
  task_id: id('2'),
  delivery_attempt_id: id('3'),
  payload_schema_version: 1,
  verification_summary: {
    business_scope: {},
    data_as_of: now,
    sources: [{ label: '测试数据', business_service: 'test-business' }],
  },
  verified_at: now,
  created_at: now,
  result_type: 'answer',
  payload: { blocks: [{ type: 'text', text: '共 3 人。' }] },
};
const product = (event_type: string, payload: unknown) => ({
  schema_version: 1,
  frame_kind: 'product',
  event_id: id('9'),
  conversation_id: id('4'),
  stream_id: id('a'),
  event_seq: '1',
  event_type,
  occurred_at: now,
  activity,
  payload,
});

test('公开契约包含全部去重定义，并记录两份原始设计快照的真实摘要', async () => {
  assert.equal(Object.keys(agentContractSchemas).length, 98);
  for (const source of agentContractSources) {
    const bytes = await readFile(
      new URL(
        `../../../packages/shared/src/agent/contracts/sources/${source.file}`,
        import.meta.url,
      ),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    const document = JSON.parse(bytes.toString('utf8'));
    assert.equal(source.designVersion, document.info.version);
    for (const name of Object.keys(document.components.schemas)) {
      assert.ok(
        (name === 'ErrorDetails' ? 'CommandErrorDetails' : name) in agentContractSchemas,
        name,
      );
    }
  }
});

test('五类命令互斥，拒绝越权字段、null、非法版本和不属于该命令的字段', () => {
  const commands = [
    start,
    { ...target, kind: 'provide_input', expected_task_version: '1', input: { text: '补充信息' } },
    { ...target, kind: 'continue_task', expected_task_version: '1' },
    { ...target, kind: 'retry_task', expected_task_version: '1' },
    { ...target, kind: 'stop_attempt' },
  ];
  for (const command of commands) {
    assert.equal(validateAgentContract('CommandRequest', command), true, command.kind);
    for (const extension of [
      { owner_user_id: 'another-user' },
      { pi_session_id: id('b') },
      { client_instance_id: null },
    ]) {
      assert.equal(validateAgentContract('CommandRequest', { ...command, ...extension }), false);
    }
  }
  for (const invalid of [
    { ...start, task_id: id('2') },
    { ...target, kind: 'stop_attempt', expected_task_version: '1' },
    { ...target, kind: 'continue_task', expected_task_version: 1 },
    { ...target, kind: 'continue_task', expected_task_version: '01' },
    { ...target, kind: 'continue_task', expected_task_version: '9223372036854775808' },
    { ...target, kind: 'provide_input', expected_task_version: '1' },
    { ...start, input: { text: '   \t\n' } },
    { ...start, input: { text: '输入', context: null } },
  ])
    assert.equal(validateAgentContract('CommandRequest', invalid), false);
});

test('文字长度按 Unicode 码点计算，拒绝孤立代理项、非 JSON 对象和非有限数字', () => {
  assert.equal(validateAgentContract('UserInput', { text: '😀'.repeat(16000) }), true);
  assert.equal(validateAgentContract('UserInput', { text: '😀'.repeat(16001) }), false);
  assert.equal(validateAgentContract('UserInput', { text: '\ud800' }), false);
  assert.equal(validateAgentContract('UserInput', { text: '\udc00' }), false);
  assert.equal(validateAgentContract('UserInput', { text: '😀' }), true);
  assert.equal(validateAgentContract('BusinessContext', { ['\ud800']: 'value' }), false);
  assert.equal(validateAgentContract('BusinessContext', new Date()), false);
  assert.equal(
    validateAgentContract('RetryControlFrame', {
      schema_version: 1,
      frame_kind: 'control',
      code: 'server_retry',
      retry_after_ms: Infinity,
    }),
    false,
  );
  assert.equal(
    validateAgentContract('CreateConversationRequest', {
      schema_version: 1,
      title: '😀'.repeat(80),
    }),
    true,
  );
  assert.equal(
    validateAgentContract('CreateConversationRequest', {
      schema_version: 1,
      title: '😀'.repeat(81),
    }),
    false,
  );
  assert.equal(
    validateAgentContract('CreateConversationRequest', { schema_version: 1, title: '\t' }),
    false,
  );
});

test('业务上下文同时检查日期依赖、真实日历、起止顺序、时区和人员去重', () => {
  assert.equal(validateAgentContract('BusinessContext', {}), true);
  const date_range = { start: '2028-02-29', end: '2028-03-01' };
  assert.equal(
    validateAgentContract('BusinessContext', { date_range, timezone: 'Asia/Shanghai' }),
    true,
  );
  for (const invalid of [
    { date_range },
    { date_range, timezone: 'Invalid/Timezone' },
    { date_range, timezone: '+08:00' },
    { date_range: { start: '2027-02-29', end: '2027-03-01' }, timezone: 'UTC' },
    { date_range: { start: '2028-03-02', end: '2028-03-01' }, timezone: 'UTC' },
    { selected_employee_ids: ['one', 'one'] },
    { selected_employee_ids: [] },
    { selected_employee_ids: ['one'], arbitrary_filter: true },
  ])
    assert.equal(validateAgentContract('BusinessContext', invalid), false);
  for (const invalid of ['0', '01', '-1', '1e3', '9223372036854775808', '9'.repeat(1000)]) {
    assert.equal(validateAgentContract('PositiveBigInt', invalid), false);
  }
  assert.equal(validateAgentContract('PositiveBigInt', '9223372036854775807'), true);
});

test('七种可靠产品事件有独立载荷，完成整组与消息更新收紧字段约束', () => {
  const completed = {
    task: {
      ...task,
      status: 'completed',
      row_version: '2',
      completed_at: now,
      result_id: id('8'),
      active_attempt_id: null,
      latest_attempt: { ...attempt, outcome: 'completed', ended_at: now },
    },
    result,
    message: { ...message, status: 'complete', result_id: id('8') },
  };
  const frames = [
    product('conversation.updated', {
      conversation: { id: id('4'), title: '测试会话', row_version: '1', created_at: now, activity },
    }),
    product('task.updated', { task }),
    product('task.completed', completed),
    product('message.created', { message, input_receipt: null }),
    product('message.updated', {
      message: { ...message, status: 'interrupted' },
      input_receipt: null,
    }),
    product('input.updated', { input_receipt: inputReceipt }),
    product('operation.updated', {
      operation: {
        id: id('b'),
        task_id: id('2'),
        action_key: 'save-draft',
        action_version: 1,
        previous_operation_id: null,
        operation_kind: 'save_schedule_draft',
        confirmation_state: 'succeeded',
        row_version: '1',
        updated_at: now,
        summary: '草案已保存',
      },
    }),
  ];
  for (const frame of frames) {
    assert.equal(validateAgentContract('ProductFrame', frame), true, frame.event_type);
    assert.equal(validateAgentContract('ProductFrame', { ...frame, event_seq: '0' }), false);
    assert.equal(
      validateAgentContract('ProductFrame', { ...frame, event_type: 'pi.raw-event' }),
      false,
    );
  }
  assert.equal(
    validateAgentContract(
      'ProductFrame',
      product('task.completed', {
        ...completed,
        message: {
          ...completed.message,
          content: { blocks: [{ type: 'text', text: '不允许重复正文' }], context: null },
        },
      }),
    ),
    false,
  );
  assert.equal(
    validateAgentContract(
      'ProductFrame',
      product('task.completed', {
        ...completed,
        task: { ...completed.task, active_attempt_id: id('3') },
      }),
    ),
    false,
  );
  assert.equal(
    validateAgentContract(
      'ProductFrame',
      product('message.updated', {
        message: { ...message, status: 'complete' },
        input_receipt: inputReceipt,
      }),
    ),
    false,
  );
  assert.equal(
    validateAgentContract(
      'ProductFrame',
      product('input.updated', {
        input_receipt: { ...inputReceipt, input_state: 'pending', input_attempt_id: null },
      }),
    ),
    false,
  );
  assert.equal(
    validateAgentContract('ProductFrame', { ...frames[0], occurred_at: '2026-02-30T08:00:00Z' }),
    false,
  );
});

test('所有原设计公开示例均可校验；控制和临时帧不能携带可靠事件序号', async () => {
  const document = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    const examples = (schema as { examples?: unknown[] }).examples ?? [];
    for (const example of examples) {
      assert.equal(validateAgentContract(name as AgentContractName, example), true, name);
      if (name === 'ControlFrame' || name === 'EphemeralFrame') {
        assert.equal(
          validateAgentContract(name, { ...(example as object), event_seq: '1' }),
          false,
        );
      }
    }
  }
});
