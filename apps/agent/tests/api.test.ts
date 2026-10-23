import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateAgentContract, type AgentContractName } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config.js';
import { AgentMemoryRuntime } from '../src/runtime/memory-runtime.js';
import type { PiPromptResult } from '../src/pi/session.js';
import { parseStrictJson } from '../src/api/strict-json.js';
import { createSseWriter } from '../src/api/sse-writer.js';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

const token = 'local-agent-api-tests-credential-00000001';
const auth = { authorization: `Bearer ${token}` };
const base = '/api/agent/v1/conversations';

async function setup() {
  let starts = 0;
  let stops = 0;
  let finish: ((result: PiPromptResult) => void) | undefined;
  const runtime = new AgentMemoryRuntime({
    createSession: async (_id, barriers) => ({
      prompt: async (_text, onText) => {
        starts += 1;
        await barriers.beforeModel?.({ header: null, entries: [], leafId: null });
        onText?.('实时文字');
        return new Promise<PiPromptResult>((resolve) => {
          finish = resolve;
        });
      },
      stop: async () => {
        stops += 1;
        finish?.({ status: 'stopped', text: '', error: null, observations: [] });
      },
      dispose() {},
    }),
  });
  const app = await createApp(
    readConfig({
      NODE_ENV: 'test',
      AGENT_AUTH_MODE: 'development',
      AGENT_TEST_USER_ID: 'api-test-user',
      AGENT_TEST_BEARER_TOKEN: token,
    }),
    { runtime },
  );
  const created = await app.inject({
    method: 'POST',
    url: base,
    headers: auth,
    payload: { schema_version: 1 },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.ok(validateAgentContract('CreateConversationResponse', created.json()));
  const id = created.json().data.conversation.id as string;
  return {
    app,
    id,
    starts: () => starts,
    stops: () => stops,
    finish: (result: PiPromptResult) => finish?.(result),
  };
}

test('HTTP 完整问答、原 key 重放与核实保留冻结裁决，停止确认为独立状态', async (t) => {
  const fixture = await setup();
  const { app, id } = fixture;
  t.after(() => app.close());
  const start = {
    schema_version: 1,
    request_key: randomUUID(),
    kind: 'start_task',
    task_kind: 'business_query',
    input: { text: '第一轮' },
  };
  const submitted = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: start,
  });
  assert.equal(submitted.statusCode, 202, submitted.body);
  assert.ok(validateAgentContract('ResponseEnvelope', submitted.json()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts(), 1);
  const snapshot = await app.inject({
    method: 'GET',
    url: `${base}/${id}/snapshot`,
    headers: auth,
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.ok(validateAgentContract('SnapshotResponse', snapshot.json()));
  assert.equal(snapshot.json().data.focus_task.latest_attempt.budget.model_requests_used, 1);
  fixture.finish({ status: 'completed', text: '第一轮完整回答', error: null, observations: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const repeated = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: start,
  });
  assert.equal(repeated.statusCode, 202, repeated.body);
  assert.equal(repeated.json().replayed, true);
  assert.deepEqual(repeated.json().decision, submitted.json().decision);
  assert.equal(fixture.starts(), 1);
  const lookup = await app.inject({
    method: 'GET',
    url: `${base}/${id}/commands/by-key/${start.request_key}`,
    headers: auth,
  });
  assert.ok(validateAgentContract('CommandLookupResponse', lookup.json()));
  assert.equal(lookup.json().data.receipt.http_status, 202);
  const conflict = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: { ...start, input: { text: '换正文' } },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_KEY_CONFLICT');
  const next = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: { ...start, request_key: randomUUID(), input: { text: '连续追问' } },
  });
  assert.equal(next.statusCode, 202, next.body);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopped = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: {
      schema_version: 1,
      kind: 'stop_attempt',
      request_key: randomUUID(),
      task_id: next.json().decision.task_id,
      target_attempt_id: next.json().decision.result_attempt_id,
    },
  });
  assert.equal(stopped.statusCode, 202, stopped.body);
  assert.equal(stopped.json().command.outcome_code, 'STOP_REQUESTED');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const final = await app.inject({ method: 'GET', url: `${base}/${id}/snapshot`, headers: auth });
  assert.equal(final.json().data.focus_task.status, 'stopped');
  assert.equal(fixture.stops(), 1);
});

test('JSON/Unicode/请求大小/媒体/版本边界保持契约错误，读取不执行', async (t) => {
  const { app, id, starts } = await setup();
  t.after(() => app.close());
  for (const payload of [
    '{"schema_version":1,"schema_version":1}',
    '{"schema_version":1,"title":"\\ud800"}',
    '{',
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: base,
      headers: { ...auth, 'content-type': 'application/json' },
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(validateAgentContract('ReadErrorResponse', response.json()));
    assert.equal(response.json().error.code, 'INVALID_JSON');
  }
  const oversized = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: { ...auth, 'content-type': 'application/json' },
    payload: ' '.repeat(131073),
  });
  assert.equal(oversized.statusCode, 413);
  assert.ok(validateAgentContract('UnconfirmedResponse', oversized.json()));
  const media = await app.inject({
    method: 'POST',
    url: base,
    headers: { ...auth, 'content-type': 'application/xml' },
    payload: '<x/>',
  });
  assert.equal(media.statusCode, 415);
  const query = await app.inject({ method: 'GET', url: `${base}?limit=1&limit=2`, headers: auth });
  assert.equal(query.statusCode, 422);
  const unauthorized = await app.inject({ method: 'GET', url: `${base}/${id}/snapshot` });
  assert.equal(unauthorized.statusCode, 401);
  for (const url of [base, `${base}/${id}`, `${base}/${id}/snapshot`])
    assert.equal((await app.inject({ method: 'GET', url, headers: auth })).statusCode, 200);
  assert.equal(starts(), 0);
});

test('Swagger 复用源契约，所有嵌套字段有具体中文含义且示例匹配当前实现', async (t) => {
  const { app, id } = await setup();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/docs/json' });
  assert.equal(response.statusCode, 200);
  const docs = response.json();
  assert.ok(docs.components.securitySchemes.AgentBearer);
  const command = docs.paths[`${base}/{conversation_id}/commands`].post;
  assert.match(command.description, /开发内存模式/);
  const media = command.requestBody.content['application/json'];
  const examples = media.examples
    ? Object.values(media.examples).map((item: unknown) => (item as { value: unknown }).value)
    : [media.example];
  assert.ok(examples.length > 0);
  for (const value of examples)
    assert.ok(validateAgentContract('CommandRequest', value), JSON.stringify(value));
  const visit = (schema: Record<string, unknown>) => {
    if (schema.$ref) return;
    assert.match(String(schema.description), /[\u4e00-\u9fff]/);
    assert.doesNotMatch(
      String(schema.description),
      /的公开视图字段|按本接口声明的必填性和格式返回|契约规定的固定值/,
    );
    for (const value of Object.values(schema.properties ?? {}))
      visit(value as Record<string, unknown>);
    if (schema.items) visit(schema.items as Record<string, unknown>);
    for (const key of ['oneOf', 'anyOf', 'allOf'])
      for (const value of (schema[key] as Record<string, unknown>[]) ?? []) visit(value);
  };
  for (const schema of Object.values(docs.components.schemas))
    visit(schema as Record<string, unknown>);
  assert.match(
    docs.components.schemas.SnapshotData.properties.pinned_messages.description,
    /尾页之外.*未结束/,
  );
  assert.match(
    docs.components.schemas.Decision.properties.task_status_at_decision.description,
    /原命令.*裁决/,
  );
  assert.match(docs.components.schemas.ToolExecutionSummary.description, /W4.*独立/);
  assert.match(docs.components.schemas.SnapshotData.properties.tool_executions.description, /工具/);
  assert.match(
    docs.components.schemas.ToolExecutionError.properties.code.description,
    /timeout=工具/,
  );
  const toolExample = docs.components.schemas.ToolUpdatedFrame.examples[0];
  assert.ok(validateAgentContract('ProductFrame', toolExample));
  assert.equal(toolExample.event_type, 'tool.updated');
  const supported = new Set(['start_task', 'stop_attempt']);
  const checkCurrentExample = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'command' && entry && typeof entry === 'object' && 'kind' in entry)
        assert.ok(supported.has(String(entry.kind)), String(entry.kind));
      if (key === 'task_kind') assert.equal(entry, 'business_query');
      if (key === 'result_type') assert.equal(entry, 'answer');
      if (key === 'operations') assert.deepEqual(entry, []);
      checkCurrentExample(entry);
    }
  };
  for (const [routePath, path] of Object.entries(docs.paths)) {
    if (!routePath.startsWith(base)) continue;
    for (const operation of Object.values(path as Record<string, unknown>)) {
      const responses = (operation as { responses: Record<string, unknown> }).responses;
      for (const [status, response] of Object.entries(responses)) {
        const json = (
          response as {
            content?: Record<
              string,
              { schema: { $ref?: string }; examples?: Record<string, { value: unknown }> }
            >;
          }
        ).content?.['application/json'];
        if (!json?.examples) continue;
        const name = (json.schema.$ref?.split('/').at(-1) ??
          (routePath.endsWith('/commands')
            ? 'ResponseEnvelope'
            : Number(status) >= 400
              ? 'ReadErrorResponse'
              : undefined)) as AgentContractName | undefined;
        assert.ok(name, '响应例子必须引用可核验的共享契约');
        for (const example of Object.values(json.examples)) {
          assert.ok(validateAgentContract(name, example.value), `${status} ${name}`);
          if (status.startsWith('2')) checkCurrentExample(example.value);
        }
      }
    }
  }
  const startExample = examples.find((value) => (value as { kind?: string }).kind === 'start_task');
  assert.ok(startExample);
  const submitted = await app.inject({
    method: 'POST',
    url: `${base}/${id}/commands`,
    headers: auth,
    payload: startExample,
  });
  assert.equal(submitted.statusCode, 202, submitted.body);
  assert.equal(submitted.json().command.outcome_code, 'TASK_CREATED');
});

test('严格 JSON 对象键按解码值判重，合法同名跨对象与代理对不误拒', () => {
  assert.throws(() => parseStrictJson(Buffer.from('{"a":1,"\\u0061":2}')));
  assert.throws(() => parseStrictJson(Buffer.from([0x22, 0xff, 0x22])));
  assert.deepEqual(parseStrictJson(Buffer.from('{"a":{"a":"😀"}}')), { a: { a: '😀' } });
});

test('SSE 写入遵循背压，有界队列耗尽关闭连接与订阅且不触发执行停止', () => {
  class Response extends EventEmitter {
    destroyed = false;
    ended = false;
    writes: string[] = [];
    write(text: string) {
      this.writes.push(text);
      return false;
    }
    end() {
      this.ended = true;
    }
  }
  const response = new Response();
  let closes = 0;
  const writer = createSseWriter(
    response as unknown as ServerResponse,
    () => {
      closes += 1;
    },
    { maxBytes: 1000, maxFrames: 1 },
  );
  const ready = {
    schema_version: 1,
    frame_kind: 'control',
    code: 'ready',
    stream_id: randomUUID(),
    accepted_after_seq: '0',
    observed_head_seq: '0',
    pruned_through_seq: '0',
  } as const;
  writer.send(ready);
  writer.send(ready);
  writer.send(ready);
  assert.equal(closes, 1);
  assert.equal(response.writes.length, 1);
  assert.equal(response.ended, true);
  writer.close();
  assert.equal(closes, 1);
});
