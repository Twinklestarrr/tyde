import type { ModuleContext } from '../../common/module-context.js';
import { attendanceRoutes } from './attendance.routes.js';
import { AttendanceService } from './attendance.service.js';

export async function registerAttendanceModule({ app, db, config, auth }: ModuleContext) {
  await attendanceRoutes(app, new AttendanceService(db), auth, config);
}
