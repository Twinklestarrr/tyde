import type { ModuleContext } from '../../common/module-context.js';
import { authRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';

export async function registerAuthModule({ app, db, config, files }: Omit<ModuleContext, 'auth'>) {
  const auth = new AuthService(db, config, undefined, files);
  await authRoutes(app, auth, config);
  return auth;
}
