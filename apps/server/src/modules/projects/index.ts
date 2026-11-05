import type { ModuleContext } from '../../common/module-context.js';
import { ProjectBoardService } from './project-board.service.js';
import { ProjectCreationService } from './project-creation.service.js';
import { projectFoundationRoutes } from './project-foundation.routes.js';
import { ProjectFoundationService } from './project-foundation.service.js';
import { ProjectListService } from './project-list.service.js';
import { ProjectManagerService } from './project-manager.service.js';
import { ProjectMaterialsService } from './project-materials.service.js';
import { ProjectProductionPlanService } from './project-production-plan.service.js';
import { ProjectQueryService } from './project-query.service.js';
import { ProjectRecruitmentHandlerService } from './project-recruitment-handler.service.js';
import { ProjectRecruitmentService } from './project-recruitment.service.js';

export async function registerProjectsModule({ app, db, config, auth, files }: ModuleContext) {
  await projectFoundationRoutes(
    app,
    new ProjectFoundationService(db),
    auth,
    config,
    new ProjectCreationService(db, files),
    new ProjectManagerService(db),
    new ProjectProductionPlanService(db),
    new ProjectQueryService(db),
    new ProjectListService(db),
    new ProjectMaterialsService(db, files),
    new ProjectRecruitmentHandlerService(db),
    new ProjectRecruitmentService(db),
    new ProjectBoardService(db),
  );
}
