import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { hasManagementRole } from '../management/management.service.js';
export async function requireExamManager(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
) {
  if (!(await hasManagementRole(tx, principal, 'PM')))
    throw new AppError(403, 'FORBIDDEN', '请切换到对应业务角色');
  const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
  if (!project) throw new AppError(404, 'NOT_FOUND', '项目不存在');
  if (project.status !== 'PUBLISHED')
    throw new AppError(400, 'VALIDATION_ERROR', '只有已发布项目可以组织准入考试');
  const manager = await tx.projectManagerRecruitment.findFirst({
    where: { projectId, status: 'ASSIGNED' },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  if (!manager || manager.candidateUserId !== principal.userId)
    throw new AppError(403, 'FORBIDDEN', '当前用户不是该项目的生效策略官');
  return project;
}

// 不读取客户端角色头：管理关系优先；无PM项目关系时再按当前NAVIGATOR角色和历史人工轮次判定。
export async function requireExamViewer(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
) {
  const [pm, navigator] = await Promise.all([
    hasManagementRole(tx, principal, 'PM'),
    hasManagementRole(tx, principal, 'NAVIGATOR'),
  ]);
  if (!pm && !navigator) throw new AppError(403, 'FORBIDDEN', '请切换到对应业务角色');
  const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
  if (!project) throw new AppError(404, 'NOT_FOUND', '项目不存在');
  if (project.status !== 'PUBLISHED')
    throw new AppError(400, 'VALIDATION_ERROR', '只有已发布项目可以组织准入考试');
  if (pm) {
    const manager = await tx.projectManagerRecruitment.findFirst({
      where: { projectId, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    if (
      manager &&
      (manager.candidateUserId === principal.userId ||
        manager.expertRecruitmentHandlerUserId === principal.userId)
    )
      return { project, canManage: manager.candidateUserId === principal.userId };
  }
  if (
    navigator &&
    (await tx.entranceExamGradingRound.findFirst({
      where: {
        gradingMode: 'MANUAL',
        version: { exam: { projectId, deleted: false } },
        reviewersJson: { array_contains: [{ userId: principal.userId }] },
      },
      select: { id: true },
    }))
  )
    return { project, canManage: false };
  throw new AppError(
    403,
    'FORBIDDEN',
    '当前用户不是项目策略官、招募协作负责人或配置的领航员阅卷人',
  );
}

export interface ExamLocator {
  projectId: number;
  examId: number;
}
export async function requireProjectExam(tx: Prisma.TransactionClient, input: ExamLocator) {
  const exam = await tx.projectEntranceExam.findFirst({
    where: { id: input.examId, projectId: input.projectId, deleted: false },
  });
  if (!exam) throw new AppError(404, 'NOT_FOUND', '考试不存在或不属于当前项目');
  return exam;
}
