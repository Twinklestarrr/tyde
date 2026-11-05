import type { ModuleContext } from '../../common/module-context.js';
import { PersonnelRecordsService } from './personnel-records.service.js';
import { personnelRoutes } from './personnel.routes.js';
import { PersonnelService } from './personnel.service.js';

export async function registerPersonnelModule({ app, db, config, auth, files }: ModuleContext) {
  await personnelRoutes(
    app,
    new PersonnelService(db),
    auth,
    config,
    new PersonnelRecordsService(db, files),
  );
}
