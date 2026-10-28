import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttemptStats } from '../src/components/AttemptStats';
import { MessageTime } from '../src/components/MessageTime';
import { attemptElapsedMs, formatElapsed, messageTimestamp } from '../src/lib/chat-time';
import { watchLocalCalendarDay } from '../src/hooks/useLocalCalendarDay';
import { runningTask } from './chat-fixtures';

test('elapsed time survives a reconnect and freezes at the server end time', () => {
  const attempt = runningTask().latest_attempt;
  attempt.started_at = '2026-10-22T08:00:00Z';
  const now = Date.parse('2026-10-22T08:00:14.999Z');
  assert.equal(attemptElapsedMs(attempt, now), 14999);
  assert.equal(attemptElapsedMs(structuredClone(attempt), now), 14999);
  for (const outcome of ['completed', 'stopped', 'failed'] as const) {
    const ended = { ...attempt, outcome, ended_at: '2026-10-22T08:00:14Z' };
    assert.equal(attemptElapsedMs(ended, now + 60000), 14000);
  }
  assert.equal(attemptElapsedMs(attempt, Date.parse('2026-10-22T07:59:59Z')), 0);
  assert.equal(attemptElapsedMs({ ...attempt, started_at: null }, now), null);
});

test('elapsed labels cross second, minute and hour boundaries without resetting', () => {
  assert.equal(formatElapsed(null), '耗时未知');
  assert.equal(formatElapsed(59999), '耗时 59秒');
  assert.equal(formatElapsed(60000), '耗时 1分0秒');
  assert.equal(formatElapsed(3599999), '耗时 59分59秒');
  assert.equal(formatElapsed(3600000), '耗时 1小时0分0秒');
});

test('message times use local calendar days and include the year only across years', () => {
  const now = Date.parse('2026-10-22T16:01:00Z');
  const localMidnight = messageTimestamp('2026-10-22T16:00:00Z', now, 'Asia/Shanghai');
  assert.equal(localMidnight.label, '00:00');
  assert.match(localMidnight.full, /2026\/10\/23/);
  const yesterday = messageTimestamp('2026-10-22T15:59:00Z', now, 'Asia/Shanghai');
  assert.match(yesterday.label, /10\/22/);
  assert.match(yesterday.label, /23:59/);
  assert.doesNotMatch(yesterday.label, /2026/);
  assert.match(messageTimestamp('2025-12-31T00:00:00Z', now, 'Asia/Shanghai').label, /2025/);
});

test('attempt statistics show used counts and elapsed time without displaying budget limits', () => {
  const attempt = runningTask().latest_attempt;
  attempt.budget = {
    policy_version: 1,
    max_duration_ms: 600000,
    max_model_requests: 12,
    max_tool_calls: 10,
    execution_deadline_at: '2026-10-22T08:10:00Z',
    model_requests_used: 2,
    tool_calls_used: 1,
    limit_exceeded_kind: null,
    limit_exceeded_at: null,
  };
  attempt.started_at = '2026-10-22T08:00:00Z';
  attempt.ended_at = '2026-10-22T08:00:14Z';
  const html = renderToStaticMarkup(<AttemptStats attempt={attempt} />);
  assert.match(html, /2 次模型请求/);
  assert.match(html, /1 次工具调用/);
  assert.match(html, /耗时 14秒/);
  assert.doesNotMatch(html, /\/12|\/10|12 次|10 次|600000/);
});

test('unknown statistics stay unknown and message time exposes the original timestamp', () => {
  const attempt = { ...runningTask().latest_attempt, budget: null, started_at: null };
  const html = renderToStaticMarkup(<AttemptStats attempt={attempt} />);
  assert.match(html, /模型请求次数未知/);
  assert.match(html, /工具调用次数未知/);
  assert.match(html, /等待执行/);
  assert.doesNotMatch(html, /0 次/);
  const stoppedBeforeStart = renderToStaticMarkup(
    <AttemptStats attempt={{ ...attempt, outcome: 'stopped', ended_at: '2026-10-22T08:00:00Z' }} />,
  );
  assert.match(stoppedBeforeStart, /未执行/);
  assert.doesNotMatch(stoppedBeforeStart, /等待执行/);
  const message = renderToStaticMarkup(
    <MessageTime timestamp="2026-10-22T08:00:00Z" calendarDay={Date.now()} />,
  );
  assert.match(message, /dateTime="2026-10-22T08:00:00Z"/);
  assert.match(message, /title=/);
});

test('one calendar clock updates message dates at midnight and after sleep, then cleans up', (context) => {
  const beforeMidnight = new Date(2026, 9, 22, 23, 59, 59, 900);
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: beforeMidnight });
  const visibility = new EventTarget();
  const days: number[] = [];
  const close = watchLocalCalendarDay((day) => days.push(day), visibility);
  const timestamp = beforeMidnight.toISOString();
  const today = renderToStaticMarkup(<MessageTime timestamp={timestamp} calendarDay={days[0]!} />);
  assert.match(today, />23:59<\/time>/);

  context.mock.timers.tick(100);
  assert.equal(days.length, 2);
  const yesterday = renderToStaticMarkup(
    <MessageTime timestamp={timestamp} calendarDay={days[1]!} />,
  );
  assert.match(yesterday, />10\/22 23:59<\/time>/);
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(days.length, 2);

  const afterSleep = new Date(2026, 9, 25, 12, 0, 0);
  context.mock.timers.setTime(afterSleep.getTime());
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(days.length, 3);
  assert.equal(days[2], new Date(2026, 9, 25).getTime());
  close();
  context.mock.timers.tick(24 * 60 * 60 * 1000);
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(days.length, 3);
});
