import type { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { outputScope, reportActions } from '../production/output-report-access.js';

// 读取实时核查/修正权限，不信任历史卡片；同账号管理多个组织时按当前卡片组织收窄。
export async function expertOutputTask(
  tx: Prisma.TransactionClient,
  projectId: number,
  organizationId: string | null,
  principal: AuthPrincipal,
  now: Date,
) {
  let scope;
  try {
    scope = await outputScope(tx, projectId, principal, now);
  } catch (error) {
    if (error instanceof AuthError && [403, 404].includes(error.status)) return null;
    throw error;
  }
  if (scope.project.currentNodeCode === 'COMPLETED') return null;
  const reports = await tx.projectOutputReport.findMany({
    where: {
      projectId,
      member: { organizationId },
      reviewStatus: { in: ['PENDING', 'RETURNED'] },
      ...(scope.memberIds === null ? {} : { memberId: { in: scope.memberIds } }),
      OR: [
        { subtaskId: null, project: { currentNodeCode: 'PRODUCTION_TASK' } },
        { subtask: { status: 'IN_PROGRESS' } },
      ],
    },
    include: { member: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let correction = false;
  for (const report of reports) {
    const actions = reportActions(scope, report.memberId, report.reviewStatus, true);
    if (actions.includes('VERIFY')) return 'OUTPUT_DATA_REVIEW';
    if (actions.includes('SAVE_REPORT')) correction = true;
  }
  return correction ? 'PRODUCTION_TASK' : null;
}
