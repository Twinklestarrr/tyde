import type { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { todayText } from '../personnel/personnel-domain.js';
import { isReportOwner, outputScope } from '../production/output-report-access.js';

/** 上海当日本人是否已有报量；零量、项目报量与子任务报量均计入。 */
export async function hasReportedExpertOutputToday(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
  now: Date,
) {
  return !!(await tx.projectOutputReport.findFirst({
    where: { projectId, userId, reportDate: new Date(todayText(now)) },
    select: { id: true },
  }));
}

/** 按当前卡片组织校验本人/负责人代报范围；按钮不代替保存接口逐笔鉴权。 */
export async function canReportExpertOutput(
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
    if (error instanceof AuthError && [403, 404].includes(error.status)) return false;
    throw error;
  }
  if (scope.readOnly || scope.project.currentNodeCode === 'COMPLETED') return false;
  const eligible = scope.active.some(
    (m) =>
      m.organizationId === organizationId &&
      (m.userId === principal.userId ||
        (scope.organizationIds?.includes(m.organizationId ?? '') &&
          isReportOwner(m, principal.userId))),
  );
  if (!eligible) return false;
  // 按项目/本人/上海自然日判断，包含项目和子任务所有报量状态。
  return !(await hasReportedExpertOutputToday(tx, projectId, principal.userId, now));
}
