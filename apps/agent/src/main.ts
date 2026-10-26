import { createApp } from './application.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await createApp(config);
let closing = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      app.log.error('Agent 服务关闭失败');
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('Agent 服务启动失败，请检查监听地址和端口');
  await app.close();
  process.exitCode = 1;
}
