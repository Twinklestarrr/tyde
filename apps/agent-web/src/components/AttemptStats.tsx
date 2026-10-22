import { useEffect, useState } from 'react';
import type { AttemptView } from '@tyde/shared/agent';
import { attemptElapsedMs, formatElapsed } from '../lib/chat-time';

export function AttemptStats({ attempt }: { attempt: AttemptView }) {
  const [now, setNow] = useState(Date.now);
  const active = attempt.started_at !== null && attempt.ended_at === null;
  useEffect(() => {
    if (!active) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [attempt.id, active]);
  const budget = attempt.budget;
  return (
    <div className="attempt-stats" aria-label="本次尝试统计">
      <span>{budget ? `${budget.model_requests_used} 次模型请求` : '模型请求次数未知'}</span>
      <span aria-hidden="true"> · </span>
      <span>{budget ? `${budget.tool_calls_used} 次工具调用` : '工具调用次数未知'}</span>
      <span aria-hidden="true"> · </span>
      <span>
        {attempt.started_at === null
          ? attempt.ended_at === null
            ? '等待执行'
            : '未执行'
          : formatElapsed(attemptElapsedMs(attempt, now))}
      </span>
    </div>
  );
}
