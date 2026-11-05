import type { ModuleContext } from '../../common/module-context.js';
import { FileService } from '../files/file.service.js';
import { examAutoCallbackRoutes } from './exam-auto.routes.js';
import { ExamAutoService } from './exam-auto.service.js';
import { ExamCandidateCommandService } from './exam-candidate-command.service.js';
import { ExamCandidateService } from './exam-candidate.service.js';
import { ExamCommandService } from './exam-command.service.js';
import { ExamGradingCommandService } from './exam-grading-command.service.js';
import { ExamImportService } from './exam-import.service.js';
import { examManagementRoutes } from './exam-management.routes.js';
import { ExamManagementService } from './exam-management.service.js';
import { ExamQueryService } from './exam-query.service.js';

export async function registerEntranceExamsModule({ app, db, config, auth, files }: ModuleContext) {
  const gradings = new ExamGradingCommandService(db);
  await examAutoCallbackRoutes(app, gradings, config);
  await examManagementRoutes(
    app,
    new ExamManagementService(db),
    auth,
    config,
    new ExamImportService(db, new FileService(files)),
    new ExamCommandService(db, files),
    new ExamQueryService(db),
    gradings,
    new ExamAutoService(db),
    new ExamCandidateService(db),
    new ExamCandidateCommandService(db, files),
  );
}
