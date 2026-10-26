import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessages } from '../src/components/ChatMessages';
import { ToolExecutions } from '../src/components/ToolExecutions';
import { applyProduct, fromSnapshot } from '../src/agent-events/projection';
import { sample, snapshot, toolExecution, toolUpdated } from './chat-fixtures';

const calendarDay = Date.parse('2026-10-22T00:00:00Z');

test('tool cards show genuine names, safe summaries, demo labels, times and opaque trace references', () => {
  const tool = toolExecution('succeeded');
  const html = renderToStaticMarkup(<ToolExecutions tools={[tool]} calendarDay={calendarDay} />);
  assert.match(html, /synthetic_readonly_query/);
  assert.match(html, /成功/);
  assert.match(html, /演示数据／演示建议/);
  assert.match(html, /合成测试资源 v1/);
  assert.match(html, /返回 2 条合成测试记录/);
  assert.match(html, /调用追溯/);
  for (const id of [
    tool.id,
    tool.tool_call_id,
    tool.model_request_id,
    tool.task_id,
    tool.attempt_id,
    tool.result_ref!,
  ])
    assert.ok(html.includes(id));
  assert.ok(html.includes(`dateTime="${tool.started_at}"`));
  assert.ok(html.includes(`dateTime="${tool.ended_at}"`));
  assert.doesNotMatch(html, /<button|<a /);
});

test('running, failure and cancellation retain their actual state without inventing a result', () => {
  for (const [status, label] of [
    ['running', '运行中'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ] as const) {
    const html = renderToStaticMarkup(
      <ToolExecutions tools={[toolExecution(status)]} calendarDay={calendarDay} />,
    );
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /返回 2 条|结果引用/);
    if (status === 'running') assert.doesNotMatch(html, /结束/);
    else assert.match(html, /结束/);
    if (status === 'failed') assert.match(html, /role="alert"/);
  }
});

test('generic tools are not labelled as demo and projection summaries remain escaped text', () => {
  const tool = {
    ...toolExecution('succeeded'),
    is_demo: false,
    result_summary: '<script>private()</script>',
  };
  const html = renderToStaticMarkup(<ToolExecutions tools={[tool]} calendarDay={calendarDay} />);
  assert.doesNotMatch(html, /演示数据／演示建议|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(renderToStaticMarkup(<ToolExecutions tools={[]} calendarDay={calendarDay} />), '');
});

test('tool process appears once next to the matching answer and preserves message time and text', () => {
  const tool = toolExecution('succeeded');
  const frame = sample('message.created');
  frame.payload.message.task_id = tool.task_id;
  frame.payload.message.attempt_id = tool.attempt_id;
  frame.payload.message.content.blocks = [{ type: 'text', text: '这是真实产品投影正文。' }];
  let view = applyProduct(fromSnapshot(snapshot()), frame);
  const second = structuredClone(frame);
  second.payload.message.id = '60000000-0000-4000-8000-000000000099';
  second.payload.message.message_seq = '99';
  view = applyProduct(view, second);
  view = applyProduct(view, toolUpdated('succeeded'));
  const html = renderToStaticMarkup(<ChatMessages view={view} calendarDay={calendarDay} />);
  assert.equal(html.match(/class="tool-execution tool-succeeded"/g)?.length, 1);
  assert.ok(html.indexOf('synthetic_readonly_query') < html.indexOf('这是真实产品投影正文。'));
  assert.match(html, /message-time/);
  assert.match(html, /tyde Agent/);
  const plain = renderToStaticMarkup(
    <ChatMessages view={fromSnapshot(snapshot())} calendarDay={calendarDay} />,
  );
  assert.doesNotMatch(plain, /工具过程|演示数据/);
});

test('a tool without a loaded answer remains visible through start and terminal projection', () => {
  let view = applyProduct(fromSnapshot(snapshot()), toolUpdated());
  assert.match(
    renderToStaticMarkup(<ChatMessages view={view} calendarDay={calendarDay} />),
    /运行中/,
  );
  view = applyProduct(view, toolUpdated('cancelled', '12'));
  const html = renderToStaticMarkup(<ChatMessages view={view} calendarDay={calendarDay} />);
  assert.match(html, /已取消/);
  assert.doesNotMatch(html, /运行中/);
});
