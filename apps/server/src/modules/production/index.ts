import type { ModuleContext } from '../../common/module-context.js';
import { productionRoutes } from './production.routes.js';
import { ProductionService } from './production.service.js';

export async function registerProductionModule({ app, db, config, auth }: ModuleContext) {
  await productionRoutes(app, new ProductionService(db), auth, config);
}
