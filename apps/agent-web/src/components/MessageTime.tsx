import { memo } from 'react';
import { messageTimestamp } from '../lib/chat-time';

export const MessageTime = memo(function MessageTime({
  timestamp,
  calendarDay,
}: {
  timestamp: string;
  calendarDay: number;
}) {
  const { label, full } = messageTimestamp(timestamp, calendarDay);
  return (
    <footer className="message-footer">
      <time className="message-time" dateTime={timestamp} title={full} aria-label={full}>
        {label}
      </time>
    </footer>
  );
});
