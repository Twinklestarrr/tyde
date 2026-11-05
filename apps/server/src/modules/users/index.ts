import type { ModuleContext } from '../../common/module-context.js';
import { personalApplicationRoutes } from './personal-application.routes.js';
import { PersonalApplicationService } from './personal-application.service.js';

export async function registerUsersModule({ app, db, config, auth }: ModuleContext) {
  await personalApplicationRoutes(app, new PersonalApplicationService(db), auth, config);
}
