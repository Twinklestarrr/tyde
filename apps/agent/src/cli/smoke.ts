import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readMaasConfig } from '../maas/index.js';
import { createPiMemorySession, type PiMemorySession } from '../pi/index.js';
import { runSessionSmoke } from './smoke-scenarios.js';

export class SmokePreparationError extends Error {
  constructor(
    public readonly code: 'SMOKE_PREPARATION_TIMEOUT' | 'SMOKE_INTERRUPTED',
    public readonly exitCode = 1,
  ) {
    super(
      code === 'SMOKE_PREPARATION_TIMEOUT' ? 'MaaS 准备超时，尚未发送模型请求' : 'MaaS 验证已中断',
    );
    this.name = 'SmokePreparationError';
  }
}

/** 模块导入、首次授权和 Session 装配共用一个可取消预算，迟到结果不予采用。 */
export function runSmokePreparation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', fail);
    };
    const fail = () => {
      cleanup();
      reject(controller.signal.reason);
    };
    const cancel = () =>
      controller.abort(
        options.signal?.reason instanceof SmokePreparationError
          ? options.signal.reason
          : new SmokePreparationError('SMOKE_INTERRUPTED'),
      );
    // 保留引用，使未解决的模块或 resolver Promise 不能令 Node 直接以 0 退出。
    const timer = setTimeout(
      () => controller.abort(new SmokePreparationError('SMOKE_PREPARATION_TIMEOUT')),
      options.timeoutMs,
    );
    controller.signal.addEventListener('abort', fail, { once: true });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => {
          cleanup();
          if (!controller.signal.aborted) resolve(value);
        },
        (error: unknown) => {
          cleanup();
          if (!controller.signal.aborted) reject(error);
        },
      );
  });
}

/** 显式的服务端授权装配入口；不能从开发测试用户或客户端字段构造委托。 */
export async function loadSmokeIdentity(
  modulePath: string | undefined,
  signal?: AbortSignal,
): Promise<
  (signal?: AbortSignal) => Promise<{ platformSubjectRef: string; serviceToken?: string }>
> {
  signal?.throwIfAborted();
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new Error(
      '请配置 AGENT_MAAS_IDENTITY_MODULE 的绝对文件路径，由该服务端模块验证平台授权并导出 resolveIdentity',
    );
  }
  let identityModule: Record<string, unknown>;
  try {
    identityModule = await import(pathToFileURL(modulePath).href);
  } catch {
    throw new Error('无法加载 MaaS 服务端身份模块');
  }
  if (typeof identityModule.resolveIdentity !== 'function') {
    throw new Error('MaaS 服务端身份模块必须导出 resolveIdentity 函数');
  }
  signal?.throwIfAborted();
  const resolver = identityModule.resolveIdentity as (signal?: AbortSignal) => Promise<unknown>;
  return async (signal) => {
    signal?.throwIfAborted();
    let identity: unknown;
    try {
      identity = await resolver(signal);
    } catch {
      throw new Error('平台原主体授权验证失败');
    }
    signal?.throwIfAborted();
    if (
      !identity ||
      typeof identity !== 'object' ||
      !('platformSubjectRef' in identity) ||
      typeof identity.platformSubjectRef !== 'string' ||
      !identity.platformSubjectRef ||
      identity.platformSubjectRef.length > 256 ||
      /[^\x21-\x7e]/.test(identity.platformSubjectRef) ||
      ('source' in identity && identity.source !== 'platform') ||
      ('serviceToken' in identity &&
        (typeof identity.serviceToken !== 'string' ||
          !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(identity.serviceToken)))
    ) {
      throw new Error('平台身份模块未返回有效可信主体');
    }
    return {
      platformSubjectRef: identity.platformSubjectRef,
      ...('serviceToken' in identity ? { serviceToken: identity.serviceToken as string } : {}),
    };
  };
}

export async function runSmoke(
  options: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
    createSession?: typeof createPiMemorySession;
    write?: (text: string) => void;
  } = {},
): Promise<void> {
  const source = options.env ?? process.env;
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const { values } = parseArgs({
    options: {
      'check-config': { type: 'boolean', default: false },
      'stop-after-ms': { type: 'string' },
    },
    // pnpm 允许在脚本参数前保留一个 --。
    args: (options.args ?? process.argv.slice(2)).filter(
      (arg, index) => index !== 0 || arg !== '--',
    ),
  });
  const config = readMaasConfig(source);
  const stopAfter = values['stop-after-ms'];
  if (
    stopAfter !== undefined &&
    (!/^[1-9][0-9]*$/.test(stopAfter) || Number(stopAfter) > 300_000)
  ) {
    throw new Error('--stop-after-ms 必须是 1 至 300000 的整数');
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
    const prepared = await runSmokePreparation(
      async (signal) => {
        const resolveIdentity = await loadSmokeIdentity(source.AGENT_MAAS_IDENTITY_MODULE, signal);
        signal.throwIfAborted();
        const identity = await resolveIdentity(signal);
        signal.throwIfAborted();
        if (values['check-config']) return null;
        const created = await (options.createSession ?? createPiMemorySession)({
          config,
          context: {
            platformSubjectRef: identity.platformSubjectRef,
            conversationId: randomUUID(),
            taskId: randomUUID(),
            attemptId: randomUUID(),
            executionSnapshotId: randomUUID(),
            executionGeneration: '1',
          },
          resolveIdentity,
        });
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
    if (values['check-config']) {
      write('MaaS 配置与身份模块校验通过；尚未发送模型请求或验证平台路由。\n');
      return;
    }
    if (!prepared) throw new Error('MaaS 内存 Session 未装配');
    await runSessionSmoke(prepared, {
      write,
      signal: command.signal,
      stopAfterMs: stopAfter === undefined ? undefined : Number(stopAfter),
      label: '真实 MaaS ',
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    session?.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke()
    .catch((error: unknown) => {
      // 配置错误仅由上述受控校验产生；身份模块和 Provider 异常不直接输出。
      process.stderr.write(`${error instanceof Error ? error.message : 'MaaS 验证失败'}\n`);
      process.exitCode = error instanceof SmokePreparationError ? error.exitCode : 1;
    })
    .finally(() => {
      // main 的 finally 已清理本地 Session。仅独立 CLI 为不配合取消的可信模块
      // 保留有界退出兜底，先给输出和合作式 I/O 清理留时间；服务 API 不退出进程。
      const exitCode = Number(process.exitCode ?? 0);
      const shutdown = setTimeout(() => process.exit(exitCode), 1000);
      shutdown.unref();
    });
}
