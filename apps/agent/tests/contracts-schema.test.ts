import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  agentContractSchemas,
  agentContractSources,
  agentContractOperations,
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
  assert.equal(Object.keys(agentContractSchemas).length, 103);
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
    assert.equal(
      source.designVersion,
      source.file === '21-commands.openapi.json' ? '1.1.0-design' : '1.2.0-w4-design',
    );
    for (const path of Object.keys(document.paths)) assert.ok(path in agentContractOperations);
    for (const name of Object.keys(document.components.schemas)) {
      assert.ok(
        (name === 'ErrorDetails' ? 'CommandErrorDetails' : name) in agentContractSchemas,
        name,
      );
    }
  }
});

test('预算兼容历史投影，新预算检查计数上限及首因时间成对出现', () => {
  const budget = {
    policy_version: 1,
    max_duration_ms: 600000,
    max_model_requests: 12,
    max_tool_calls: 10,
    execution_deadline_at: '2026-10-22T08:10:00Z',
    model_requests_used: 12,
    tool_calls_used: 10,
    limit_exceeded_kind: null,
    limit_exceeded_at: null,
  };
  assert.equal(validateAgentContract('AttemptView', attempt), true);
  assert.equal(validateAgentContract('AttemptView', { ...attempt, budget: null }), true);
  assert.equal(validateAgentContract('AttemptView', { ...attempt, budget }), true);
  assert.equal(validateAgentContract('AttemptBudgetView', budget), true);
  for (const extension of [
    { model_requests_used: 13 },
    { tool_calls_used: 11 },
    { limit_exceeded_kind: 'duration' },
    { limit_exceeded_at: now },
    { limit_exceeded_at: '2026-02-30T08:00:00Z', limit_exceeded_kind: 'duration' },
  ])
    assert.equal(validateAgentContract('AttemptBudgetView', { ...budget, ...extension }), false);
  assert.equal(
    validateAgentContract('AttemptBudgetView', {
      ...budget,
      limit_exceeded_kind: 'duration',
      limit_exceeded_at: now,
    }),
    true,
  );
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

test('W3 七种可靠事件保留原载荷，完成整组与消息更新收紧字段约束', () => {
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

test('W4 工具过程安全契约独立于业务 Operation，严格校验生命周期及私有字段', () => {
  const tool = {
    id: id('b'),
    conversation_id: id('4'),
    task_id: id('2'),
    attempt_id: id('3'),
    model_request_id: id('c'),
    tool_call_id: 'call_test_1',
    tool_name: 'readonly_test',
    status: 'running',
    row_version: '1',
    started_at: now,
    ended_at: null,
    is_demo: true,
    display_label: '合成测试数据',
    input_summary: '受限查询摘要',
    result_summary: null,
    result_ref: null,
    error: null,
  };
  assert.ok(validateAgentContract('ToolExecutionSummary', tool));
  assert.ok(
    validateAgentContract('ProductFrame', product('tool.updated', { tool_execution: tool })),
  );
  assert.equal(validateAgentContract('OperationSummary', tool), false);
  assert.equal(
    validateAgentContract('ProductFrame', product('tool.updated', { operation: tool })),
    false,
  );
  const success = {
    ...tool,
    status: 'succeeded',
    ended_at: now,
    row_version: '2',
    result_summary: '演示数据：空查询结果。',
    result_ref: id('d'),
  };
  assert.ok(validateAgentContract('ToolExecutionSummary', success));
  for (const code of [
    'invalid_arguments',
    'tool_failed',
    'timeout',
    'cancelled',
    'budget_exceeded',
  ]) {
    assert.ok(
      validateAgentContract('ToolExecutionSummary', {
        ...tool,
        status: code === 'cancelled' || code === 'budget_exceeded' ? 'cancelled' : 'failed',
        ended_at: now,
        error: { code, message: '安全失败摘要' },
      }),
      code,
    );
  }
  for (const extension of [
    { status: 'succeeded' },
    { ended_at: now },
    { result_ref: id('d') },
    { error: { code: 'tool_failed', message: '错误' } },
    { raw_arguments: { secret: 'private' } },
    { native_entry: { content: 'private' } },
    { tool_call_id: '' },
    { model_request_id: 'x'.repeat(201) },
    { result_summary: 'x'.repeat(1001) },
  ])
    assert.equal(validateAgentContract('ToolExecutionSummary', { ...tool, ...extension }), false);
  for (const extension of [
    { result_ref: 'https://example.invalid/result' },
    { ended_at: '2026-10-21T08:00:00Z' },
    { error: { code: 'tool_failed', message: '错误' } },
    { result_summary: null },
    {
      status: 'cancelled',
      result_summary: null,
      result_ref: null,
      error: { code: 'tool_failed', message: '错误' },
    },
    {
      status: 'failed',
      result_summary: null,
      result_ref: null,
      error: { code: 'cancelled', message: '错误' },
    },
  ])
    assert.equal(
      validateAgentContract('ToolExecutionSummary', { ...success, ...extension }),
      false,
    );
  assert.equal(
    validateAgentContract('ProductFrame', product('tool.unknown', { tool_execution: tool })),
    false,
  );
});

test('W4 可选工具数组兼容旧冻结读取投影，新增字段与示例来自唯一源', async () => {
  const source = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const [suffix, name] of [
    ['/snapshot', 'SnapshotResponse'],
    ['/messages', 'MessageHistoryResponse'],
    ['/tasks/{task_id}', 'TaskDetailResponse'],
    ['/results/{result_id}', 'ResultDetailResponse'],
  ] as const) {
    const path = Object.keys(source.paths).find((key) => key.endsWith(suffix))!;
    const example =
      source.paths[path].get.responses['200'].content['application/json'].examples.success.value;
    assert.ok(validateAgentContract(name, example), name);
    assert.equal(example.data.tool_executions.length, 1);
    const legacy = structuredClone(example);
    delete legacy.data.tool_executions;
    assert.ok(validateAgentContract(name, legacy), name);
    assert.equal(
      validateAgentContract(name, {
        ...example,
        data: { ...example.data, tool_executions: null },
      }),
      false,
    );
  }
});
