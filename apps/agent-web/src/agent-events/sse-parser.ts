/** A frame-local SSE envelope. `id` is never inherited from an earlier frame. */
export interface RawSseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseParseError';
  }
}

/**
 * Incremental UTF-8 SSE parsing for fetch bodies. Comments, retry hints and
 * unknown fields are ignored. Only a blank line dispatches an event; an
 * incomplete event at EOF is discarded, as required by the SSE protocol.
 *
 * The local buffer bound is a client capacity limit, not a server payload
 * contract. Hitting it must end the subscription, never skip a reliable frame.
 */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private line = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  private skipLf = false;
  private bufferedCharacters = 0;
  private closed = false;

  constructor(private readonly maxBufferedCharacters = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBufferedCharacters) || maxBufferedCharacters < 1) {
      throw new RangeError('SSE 缓冲上限必须为正整数。');
    }
  }

  feed(chunk: Uint8Array): RawSseEvent[] {
    if (this.closed) throw new SseParseError('SSE 解析器已经关闭。');
    return this.read(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): RawSseEvent[] {
    if (this.closed) return [];
    const events = this.read(this.decoder.decode());
    this.closed = true;
    this.resetFrame();
    this.line = '';
    return events;
  }

  private read(text: string): RawSseEvent[] {
    const events: RawSseEvent[] = [];
    for (const character of text) {
      if (this.skipLf) {
        this.skipLf = false;
        if (character === '\n') continue;
      }
      this.bufferedCharacters += character.length;
      if (this.bufferedCharacters > this.maxBufferedCharacters) {
        this.closed = true;
        throw new SseParseError('SSE 帧超过客户端缓冲上限，请重建订阅基线。');
      }
      if (character === '\r' || character === '\n') {
        this.readLine(events);
        this.skipLf = character === '\r';
      } else {
        this.line += character;
      }
    }
    return events;
  }

  private readLine(events: RawSseEvent[]): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      if (this.data.length > 0) {
        const event: RawSseEvent = {
          event: this.event || 'message',
          data: this.data.join('\n'),
        };
        if (this.id !== undefined) event.id = this.id;
        events.push(event);
      }
      this.resetFrame();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.event = value;
    // The SSE protocol ignores an id containing NUL. Keep the previous local
    // field, but never carry it to the next dispatched event.
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }

  private resetFrame(): void {
    this.data = [];
    this.event = '';
    this.id = undefined;
    this.bufferedCharacters = 0;
  }
}
