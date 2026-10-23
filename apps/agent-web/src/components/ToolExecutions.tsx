import type { ToolExecutionSummary } from '@tyde/shared/agent';
import { messageTimestamp } from '../lib/chat-time';

const STATUS_LABELS: Record<ToolExecutionSummary['status'], string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

/** Renders only the reviewed product projection; native parameters and receipts never enter it. */
export function ToolExecutions({
  tools,
  calendarDay,
}: {
  tools: ToolExecutionSummary[];
  calendarDay: number;
}) {
  if (tools.length === 0) return null;
  return (
    <div className="tool-execution-list" aria-label="工具过程">
      {tools.map((tool) => {
        const started = messageTimestamp(tool.started_at, calendarDay);
        const ended = tool.ended_at ? messageTimestamp(tool.ended_at, calendarDay) : null;
        return (
          <section
            className={`tool-execution tool-${tool.status}`}
            key={tool.id}
            aria-label={`${tool.tool_name}：${STATUS_LABELS[tool.status]}`}
          >
            <div className="tool-execution-heading">
              <strong>{tool.tool_name}</strong>
              <span className="tool-execution-status">{STATUS_LABELS[tool.status]}</span>
              {tool.is_demo && <span className="tool-demo-label">演示数据／演示建议</span>}
            </div>
            <p className="tool-source-label">{tool.display_label}</p>
            <p className="tool-summary">{tool.input_summary}</p>
            {tool.result_summary !== null && <p className="tool-summary">{tool.result_summary}</p>}
            {tool.error && (
              <p className="tool-error" role={tool.status === 'failed' ? 'alert' : undefined}>
                {tool.error.message} <small>（{tool.error.code}）</small>
              </p>
            )}
            <div className="tool-execution-time">
              <time dateTime={tool.started_at} title={started.full}>
                开始 {started.label}
              </time>
              {ended && (
                <time dateTime={tool.ended_at!} title={ended.full}>
                  结束 {ended.label}
                </time>
              )}
            </div>
            <details className="tool-trace">
              <summary>调用追溯</summary>
              <dl>
                <dt>工具调用</dt>
                <dd>{tool.tool_call_id}</dd>
                <dt>模型请求</dt>
                <dd>{tool.model_request_id}</dd>
                <dt>任务</dt>
                <dd>{tool.task_id}</dd>
                <dt>执行尝试</dt>
                <dd>{tool.attempt_id}</dd>
                <dt>过程记录</dt>
                <dd>{tool.id}</dd>
                {tool.result_ref && (
                  <>
                    <dt>结果引用</dt>
                    <dd>{tool.result_ref}</dd>
                  </>
                )}
              </dl>
            </details>
          </section>
        );
      })}
    </div>
  );
}
