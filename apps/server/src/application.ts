import Fastify from 'fastify';
import { readConfig, type Config } from './config/index.js';
import { createDatabase } from './infrastructure/database/client.js';
import {
  createObjectStorage,
  type ObjectStorage,
} from './infrastructure/storage/object-storage.js';
import { registerAttendanceModule } from './modules/attendance/index.js';
import { registerAuthModule } from './modules/auth/index.js';
import { registerEntranceExamsModule } from './modules/entrance-exams/index.js';
import { registerExpertModule } from './modules/expert/index.js';
import { FileRegistryService } from './modules/files/file-registry.service.js';
import { registerFilesModule } from './modules/files/index.js';
import { registerOrganizationsModule } from './modules/organizations/index.js';
import { registerPersonnelModule } from './modules/personnel/index.js';
import { registerProductionModule } from './modules/production/index.js';
import { registerProjectsModule } from './modules/projects/index.js';
import { registerUsersModule } from './modules/users/index.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealth } from './plugins/health.js';
import { fastifyOptions } from './plugins/http-options.js';
import { registerHttpPlugins } from './plugins/index.js';

export { fastifyOptions } from './plugins/http-options.js';

/** 装配入口：依赖创建、模块注册及生命周期；业务规则留在各模块。 */
export async function createApp(
  config: Config = readConfig(),
  db = createDatabase(config),
  app = Fastify(fastifyOptions(config)),
  storage: ObjectStorage = createObjectStorage(config.files),
) {
  await registerHttpPlugins(app, config);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });
  registerErrorHandler(app);
  const files = new FileRegistryService(db, storage, config.files);
  const auth = await registerAuthModule({ app, db, config, files });
  const context = { app, db, config, files, auth };
  await registerUsersModule(context);
  await registerAttendanceModule(context);
  await registerPersonnelModule(context);
  await registerProductionModule(context);
  await registerExpertModule(context);
  await registerEntranceExamsModule(context);
  await registerFilesModule(context);
  await registerOrganizationsModule(context);
  await registerProjectsModule(context);
  registerHealth(app, db);
  return app;
}
