import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDirectModelConfig } from '../maas/index.js';
import { createPiDirectModelSession, type PiMemorySession } from '../pi/index.js';
import { runSmokePreparation, SmokePreparationError } from './smoke.js';
import { runSessionSmoke } from './smoke-scenarios.js';

/** 显式的 URL＋Key 本地验收入口，不借用平台身份或切换现有 MaaS 命令。 */
export async function runDirectModelSmoke(
  options: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
    createSession?: typeof createPiDirectModelSession;
    write?: (text: string) => void;
  } = {},
): Promise<void> {
  const { values } = parseArgs({
    options: {
      'check-config': { type: 'boolean', default: false },
      'stop-after-ms': { type: 'string' },
    },
    args: (options.args ?? process.argv.slice(2)).filter(
      (arg, index) => index !== 0 || arg !== '--',
    ),
  });
  const config = readDirectModelConfig(options.env ?? process.env);
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const stopAfter = values['stop-after-ms'];
  if (
    stopAfter !== undefined &&
    (!/^[1-9][0-9]*$/.test(stopAfter) || Number(stopAfter) > 300_000)
  ) {
    throw new Error('--stop-after-ms 必须是 1 至 300000 的整数');
  }
  // 明确标注来源，不能把直连结果当作平台转发或身份委托已验通。
  write(`模型直连验收：${config.modelId}；复用 Pi openai-completions。\n`);
  if (values['check-config']) {
    write('URL、Key 和模型配置格式校验通过；尚未发送模型请求或验证 Key。\n');
    return;
  }
  const command = new AbortController();
  let session: PiMemorySession | undefined;
  const interrupt = (exitCode: number) => {
    command.abort(new SmokePreparationError('SMOKE_INTERRUPTED', exitCode));
    void session?.stop();
  };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    session = await runSmokePreparation(
      async (signal) => {
        const created = await (options.createSession ?? createPiDirectModelSession)({ config });
        if (signal.aborted) {
          created.dispose();
          signal.throwIfAborted();
        }
        session = created;
        return created;
      },
      { timeoutMs: config.timeouts.totalMs, signal: command.signal },
    );
    command.signal.throwIfAborted();
    await runSessionSmoke(session, {
      write,
      signal: command.signal,
      stopAfterMs: stopAfter === undefined ? undefined : Number(stopAfter),
      label: '模型直连',
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    session?.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDirectModelSmoke()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : '模型直连验收失败'}\n`);
      process.exitCode = error instanceof SmokePreparationError ? error.exitCode : 1;
    })
    .finally(() => {
      const exitCode = Number(process.exitCode ?? 0);
      setTimeout(() => process.exit(exitCode), 1000).unref();
    });
}
