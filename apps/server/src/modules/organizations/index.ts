import type { ModuleContext } from '../../common/module-context.js';
import { organizationRoutes } from './organization.routes.js';
import { OrganizationService } from './organization.service.js';

export async function registerOrganizationsModule({ app, db, config, auth, files }: ModuleContext) {
  await organizationRoutes(app, new OrganizationService(db, files), auth, config);
}
