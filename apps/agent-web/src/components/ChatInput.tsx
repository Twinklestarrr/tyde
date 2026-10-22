// Adapted from agegr/pi-web; see ../../upstream/pi-web/SOURCE.md and LICENSE.
import { useEffect, useRef } from 'react';
import { getMarkdownListContinuation } from '../lib/markdown-list-continuation';

/** W1 accepts a local draft; transport is intentionally unavailable until its contract exists. */
export function ChatInput({
  value,
  onChange,
  unavailableReason,
}: {
  value: string;
  onChange: (value: string) => void;
  unavailableReason: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const continueList = (event: InputEvent) => {
      if (event.inputType !== 'insertLineBreak' || event.isComposing || composing.current) return;
      const edit = getMarkdownListContinuation(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
      );
      if (!edit) return;
      event.preventDefault();
      textarea.setSelectionRange(edit.start, edit.end);
      // Prefer a native edit to preserve undo; setRangeText is the browser fallback.
      if (!document.execCommand(edit.text ? 'insertText' : 'delete', false, edit.text)) {
        textarea.setRangeText(edit.text, edit.start, edit.end, 'end');
      }
      onChange(textarea.value);
    };
    textarea.addEventListener('beforeinput', continueList);
    return () => textarea.removeEventListener('beforeinput', continueList);
  }, [onChange]);

  return (
    <div className="chat-input">
      <label className="sr-only" htmlFor="agent-draft">
        Agent 消息草稿
      </label>
      <textarea
        ref={textareaRef}
        id="agent-draft"
        rows={2}
        value={value}
        placeholder="写下你的需求，后续将接入真实对话…"
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          compositionEndedAt.current = Date.now();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const inComposition =
            composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          const recentlyComposed = Date.now() - compositionEndedAt.current < 80;
          if (!inComposition && recentlyComposed) event.preventDefault();
        }}
        aria-describedby="agent-send-state"
      />
      <div className="chat-input-toolbar">
        <span id="agent-send-state">{unavailableReason}</span>
        <button
          className="send-button"
          type="button"
          disabled
          aria-label="发送消息（对话接口尚未接入）"
        >
          发送 ↑
        </button>
      </div>
    </div>
  );
}
