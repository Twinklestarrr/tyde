import type { ConversationListItem } from '@tyde/shared/agent';

/** 标题用行版本，活动投影用同流观察水位；迟到列表页不能覆盖已应用的事件。 */
export function mergeConversationItem(
  previous: ConversationListItem | undefined,
  incoming: ConversationListItem,
): ConversationListItem {
  if (!previous || previous.read_cursor.stream_id !== incoming.read_cursor.stream_id)
    return incoming;
  const core =
    BigInt(incoming.conversation.row_version) >= BigInt(previous.conversation.row_version)
      ? incoming.conversation
      : previous.conversation;
  const observed =
    BigInt(incoming.read_cursor.event_seq) >= BigInt(previous.read_cursor.event_seq)
      ? incoming
      : previous;
  return {
    conversation: { ...core, activity: observed.conversation.activity },
    read_cursor: observed.read_cursor,
  };
}
