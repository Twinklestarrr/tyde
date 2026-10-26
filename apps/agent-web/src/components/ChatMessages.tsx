import type { MessageView, ToolExecutionSummary } from '@tyde/shared/agent';
import { messageText, type ChatProjection } from '../agent-events/projection';
import { MarkdownBody } from './MarkdownBody';
import { MessageTime } from './MessageTime';
import { ToolExecutions } from './ToolExecutions';

/** Each tool group appears once, next to its attempt's answer, including interrupted output. */
export function ChatMessages({ view, calendarDay }: { view: ChatProjection; calendarDay: number }) {
  const messages = [...view.messages.values()].sort((a, b) =>
    BigInt(a.message_seq) < BigInt(b.message_seq) ? -1 : 1,
  );
  const groups = new Map<string, ToolExecutionSummary[]>();
  const unanchored: ToolExecutionSummary[] = [];
  const tools = [...view.toolExecutions.values()].sort(
    (a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id),
  );
  for (const tool of tools) {
    const anchor = messages.find(
      (message) =>
        message.message_type === 'assistant_output' &&
        message.task_id === tool.task_id &&
        message.attempt_id === tool.attempt_id,
    );
    if (!anchor) unanchored.push(tool);
    else groups.set(anchor.id, [...(groups.get(anchor.id) ?? []), tool]);
  }
  return (
    <>
      {messages.map((message: MessageView) => {
        const text = messageText(view, message);
        return (
          <article className={`chat-message message-${message.message_type}`} key={message.id}>
            <div className="message-author">
              {message.message_type === 'user_input'
                ? '你'
                : message.message_type === 'notice'
                  ? '提示'
                  : 'tyde Agent'}
              <span>
                {message.status === 'in_progress'
                  ? '生成中'
                  : message.status === 'interrupted'
                    ? '输出已中断'
                    : ''}
              </span>
            </div>
            <ToolExecutions tools={groups.get(message.id) ?? []} calendarDay={calendarDay} />
            {text ? (
              <MarkdownBody>{text}</MarkdownBody>
            ) : (
              <p className="generating-text">
                {message.status === 'in_progress' ? '仍在生成…' : '此条输出没有正文。'}
              </p>
            )}
            <MessageTime timestamp={message.created_at} calendarDay={calendarDay} />
          </article>
        );
      })}
      <ToolExecutions tools={unanchored} calendarDay={calendarDay} />
    </>
  );
}
