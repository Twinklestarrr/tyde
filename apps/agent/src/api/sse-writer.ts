import type { ServerResponse } from 'node:http';
import type { ControlFrame, EphemeralFrame, ProductFrame } from '@tyde/shared/agent';

export type AgentFrame = ControlFrame | EphemeralFrame | ProductFrame;

export function encodeFrame(frame: AgentFrame): string {
  const id = frame.frame_kind === 'product' ? `id: ${frame.stream_id}:${frame.event_seq}\n` : '';
  return `${id}event: ${frame.frame_kind}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** 单连接串行写入。达到队列上限即关闭订阅；执行不依赖订阅存活。 */
export function createSseWriter(
  response: ServerResponse,
  onClose: () => void,
  { maxBytes = 1024 * 1024, maxFrames = 512 } = {},
) {
  let closed = false;
  let blocked = false;
  let queuedBytes = 0;
  const queue: string[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    response.off('drain', drain);
    queue.length = 0;
    queuedBytes = 0;
    onClose();
    if (!response.destroyed) response.end();
  };
  const drain = () => {
    blocked = false;
    while (!closed && !blocked && queue.length) {
      const text = queue.shift()!;
      queuedBytes -= Buffer.byteLength(text);
      blocked = !response.write(text);
    }
  };
  const sendText = (text: string) => {
    if (closed) return;
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes || queue.length >= maxFrames || queuedBytes + bytes > maxBytes) {
      // 已背压时不再追加控制帧，避免进一步增长；EOF 会使客户端重新读取快照。
      close();
      return;
    }
    if (!blocked && queue.length === 0) blocked = !response.write(text);
    else {
      queue.push(text);
      queuedBytes += bytes;
    }
  };
  const heartbeat = setInterval(() => sendText(': heartbeat\n\n'), 15_000);
  heartbeat.unref();
  response.on('drain', drain);
  response.once('close', close);
  response.once('error', close);
  return { send: (frame: AgentFrame) => sendText(encodeFrame(frame)), close };
}
