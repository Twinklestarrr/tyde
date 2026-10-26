import type { AttemptView } from '@tyde/shared/agent';

/** 每次渲染都从服务端起止时间计算，不累加页面计时器，重连不会重置耗时。 */
export function attemptElapsedMs(
  attempt: Pick<AttemptView, 'started_at' | 'ended_at'>,
  nowMs: number,
): number | null {
  if (attempt.started_at === null) return null;
  const start = Date.parse(attempt.started_at);
  const end = attempt.ended_at === null ? nowMs : Date.parse(attempt.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function formatElapsed(ms: number | null): string {
  if (ms === null) return '耗时未知';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `耗时 ${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `耗时 ${minutes}分${seconds % 60}秒`;
  return `耗时 ${Math.floor(minutes / 60)}小时${minutes % 60}分${seconds % 60}秒`;
}

/** 默认使用浏览器时区；测试可显式传入时区覆盖 UTC 跨日边界。 */
export function messageTimestamp(timestamp: string, nowMs = Date.now(), timeZone?: string) {
  const date = new Date(timestamp);
  const today = new Date(nowMs);
  const calendar = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const sameDay = calendar.format(date) === calendar.format(today);
  const year = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone });
  const sameYear = year.format(date) === year.format(today);
  const label = new Intl.DateTimeFormat('zh-CN', {
    ...(sameDay ? {} : { month: '2-digit' as const, day: '2-digit' as const }),
    ...(!sameDay && !sameYear ? { year: 'numeric' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
  const full = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
  return { label, full };
}
