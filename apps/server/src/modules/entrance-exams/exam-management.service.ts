import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ManagementService } from '../management/management.service.js';
import { displayName } from '../projects/project-detail.js';
import { requireExamManager } from './exam-access.js';
import { examImportTemplate, type ExamTemplateType } from './exam-import-template.js';

export class ExamManagementService {
  readonly management: ManagementService;
  constructor(readonly db: PrismaClient) {
    this.management = new ManagementService(db);
  }
  async template(type: ExamTemplateType, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'PM');
    return examImportTemplate(type);
  }
  async reviewers(projectId: number, keyword: string | undefined, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const project = await requireExamManager(tx, projectId, principal);
        const ids = [...new Set([project.requesterId, principal.userId])];
        const users = await tx.user.findMany({
          where: { id: { in: ids }, status: 'ACTIVE' },
          select: { id: true, uid: true, displayName: true, realName: true, avatarUrl: true },
        });
        const normalized = keyword?.trim().toLowerCase();
        return ids.flatMap((id) => {
          const user = users.find((u) => u.id === id);
          if (
            !user ||
            (normalized &&
              ![user.displayName, user.realName, user.uid].some((value) =>
                value?.toLowerCase().includes(normalized),
              ))
          )
            return [];
          return [
            {
              userId: user.id,
              uid: user.uid,
              name: displayName(user.displayName, user.realName, user.uid),
              avatarUrl: user.avatarUrl,
            },
          ];
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
