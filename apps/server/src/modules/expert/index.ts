import type { ModuleContext } from '../../common/module-context.js';
import { expertAssignmentRoutes } from './expert-assignment.routes.js';
import { ExpertAssignmentService } from './expert-assignment.service.js';

export async function registerExpertModule({ app, db, config, auth }: ModuleContext) {
  await expertAssignmentRoutes(app, new ExpertAssignmentService(db), auth, config);
}
