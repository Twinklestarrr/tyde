import { PrismaClient } from '@prisma/client';
import type { fetch as NodeFetch } from 'undici-types';
import { readConfig } from '../config/index.js';
import {
  autoCallbackPath,
  signAutoCallback,
} from '../modules/entrance-exams/exam-auto-signature.js';
import { ExamAutoService } from '../modules/entrance-exams/exam-auto.service.js';
const config = readConfig();
const [recordArg, outcome = 'correct'] = process.argv.slice(2);
if (
  !recordArg ||
  (!(recordArg === 'expire' && outcome === 'expire') &&
    !['correct', 'incorrect', 'failed', 'timeout'].includes(outcome))
)
  throw new Error(
    '用法：exam-auto:mock <记录ID> [correct|incorrect|failed|timeout]；或 exam-auto:mock expire expire',
  );
if (!config.autoGradingSecret)
  throw new Error('须配置专用AUTO_GRADING_HMAC_SECRET，与本地后端一致');
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const service = new ExamAutoService(db);
  if (recordArg === 'expire' && outcome === 'expire')
    console.log(JSON.stringify({ provider: 'mock', expired: await service.expireTimedOut() }));
  else {
    const recordId = Number(recordArg);
    if (!Number.isInteger(recordId) || recordId < 1) throw new Error('记录ID须为正整数');
    const result = await service.executeMock(
      recordId,
      outcome as 'correct' | 'incorrect' | 'failed' | 'timeout',
      async (callback) => {
        const body = JSON.stringify(callback),
          timestamp = String(Math.floor(Date.now() / 1000));
        const response = await (globalThis.fetch as unknown as typeof NodeFetch)(
          `http://127.0.0.1:${config.port}${autoCallbackPath}`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: {
              'content-type': 'application/json',
              'x-agent-timestamp': timestamp,
              'x-agent-signature': signAutoCallback(config.autoGradingSecret, timestamp, body),
            },
            body,
          },
        );
        if (!response.ok)
          throw new Error(
            `本地mock回调HTTP ${response.status}，请核对执行状态；失败回写受当前trace保护，勿重置库`,
          );
      },
    );
    console.log(JSON.stringify(result));
  }
} finally {
  await db.$disconnect();
}
