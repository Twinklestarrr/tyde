import type { ModuleContext } from '../../common/module-context.js';
import { fileRoutes } from './file.routes.js';
import { FileService } from './file.service.js';

export async function registerFilesModule({ app, config, auth, files }: ModuleContext) {
  await fileRoutes(app, new FileService(files), auth, config);
}
