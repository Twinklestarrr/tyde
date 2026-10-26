import { randomUUID } from 'node:crypto';
import type { PiMemorySession } from '../pi/index.js';

/** 两类接入使用同一组原生多轮／停止验收，不在这里实现模型循环。 */
export async function runSessionSmoke(
  session: PiMemorySession,
  options: {
    write: (text: string) => void;
    signal: AbortSignal;
    stopAfterMs?: number;
    label: string;
  },
): Promise<void> {
  const { write, signal, stopAfterMs, label } = options;
  const marker = `W2-${randomUUID()}`;
  const prompts =
    stopAfterMs === undefined
      ? [`请记住这个口令：${marker}。只回复“已记住”。`, '上一轮的口令是什么？请只输出完整口令。']
      : ['请从 1 开始逐项数到 10000，每个数字单独一行。'];
  const timer =
    stopAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          void session.stop();
        }, stopAfterMs);
  try {
    for (const [index, prompt] of prompts.entries()) {
      signal.throwIfAborted();
      write(`\n--- turn ${index + 1}（临时流式文字）---\n`);
      let streamedText = false;
      const result = await session.prompt(prompt, (text) => {
        streamedText ||= text.length > 0;
        write(text);
      });
      write(`\n${JSON.stringify(result)}\n`);
      if (result.status === 'failed') {
        process.exitCode = 1;
        return;
      }
      signal.throwIfAborted();
      if (result.status !== 'completed') {
        if (result.status === 'stopped' && stopAfterMs !== undefined) {
          if (
            !streamedText ||
            !result.observations.some(
              (call) => call.httpStatus === 200 && call.state === 'cancelled',
            )
          ) {
            throw new Error(
              '尚未观察到模型增量及读取中取消，本次未验证到流式停止；请调整停止时机后重跑',
            );
          }
          process.exitCode = 0;
        } else process.exitCode = 1;
        return;
      }
      if (index === 1 && !result.text.includes(marker)) throw new Error('真实多轮召回核对失败');
    }
    if (stopAfterMs !== undefined)
      throw new Error('模型已先完成，本次未验证到执行中停止；请调整停止时机后重跑');
    write(`${label}两轮与口令召回通过；结果仅存在进程内存。\n`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
