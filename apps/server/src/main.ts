import { createApp } from './application.js';
import { readConfig } from './config/index.js';
import { registerWeb } from './plugins/static-web.js';
const config = readConfig();
const app = await createApp(config);
await registerWeb(app);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('服务启动失败，请检查监听地址和端口');
  await app.close();
  process.exitCode = 1;
}
