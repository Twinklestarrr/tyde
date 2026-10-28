import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import { refreshManagementCardSnapshots } from './project-management-card-snapshot.js';
import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { Prisma, type PrismaClient, type Project, type ProjectMember } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import type { ProjectAttachmentInput } from './project-creation.types.js';
import { syncProjectAttachments } from './project-attachments.js';
import { displayName, projectDetailInclude } from './project-detail.js';
import { projectTime } from './project-time.js';
import {
  collectManagementTasks,
  managementTaskTypes,
  reconcileTaskRounds,
} from './project-task-rounds.js';

export interface MaterialsInput {
  projectId: number;
  standardContent?: string | null;
  standardLink?: string | null;
  attachments?: ProjectAttachmentInput[] | null;
}
const forbidden = () => new AuthError(403, 'FORBIDDEN', '当前角色及项目关系无权操作标准材料');
const nodes = [
  'RECRUIT_PROJECT_MANAGER',
  'PRODUCTION_PLAN',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
  'RECRUIT_EXECUTION_EXPERT',
  'PERSONNEL_MANAGEMENT',
  'PRODUCTION_TASK',
  'COMPLETED',
];
export function nodeAfterMaterials(current: string | null) {
  return current && nodes.indexOf(current) >= 4 ? current : 'RECRUIT_EXECUTION_EXPERT';
}
// 复刻旧接单/组织/考试授权；不从统一账号身份推导项目权限。
export async function canExpertViewMaterials(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
) {
  const transferred = await tx.projectMember.findMany({
    where: {
      projectId,
      userId,
      status: { in: ['ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER'] },
      joinedAt: { not: null },
      leftAt: null,
      admissionAttempt: { sourceBizType: 'PROJECT_MEMBER_TRANSFER' },
    },
    include: memberInclude,
  });
  if (transferred.some((m) => qualifiedForEntry(m, true))) return true;
  const [row] = await tx.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "ProjectExpertAssignment" a
      LEFT JOIN "ProjectProductionPlan" p ON p."projectId" = a."projectId"
      LEFT JOIN "UserOrgRel" r ON r."orgId" = a."organizationId"
        AND r."userId" = ${userId}::uuid AND r."joinStatus" IN ('ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE')
      WHERE a."projectId" = ${projectId} AND a."status" = 'ACCEPTED'
        AND ((a."subjectType" = 'INDIVIDUAL' AND a."expertUserId" = ${userId}::uuid)
          OR (a."subjectType" = 'ORGANIZATION' AND r."id" IS NOT NULL))
        AND (COALESCE(p."needWrittenExam", false) = false
          OR (a."subjectType" = 'ORGANIZATION' AND (
            r."position" = 'OWNER' OR EXISTS (
              SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId" = a."id"
                AND o."userId" = ${userId}::uuid AND o."status" = 'ACTIVE'
            ) OR (a."projectOwnerUserId" = ${userId}::uuid AND NOT EXISTS (
              SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId" = a."id"
            ))))
          OR EXISTS (SELECT 1 FROM "EntranceExamAttempt" t JOIN "ProjectEntranceExam" e ON e."id" = t."examId"
            WHERE t."candidateUserId" = ${userId}::uuid AND e."projectId" = a."projectId"
              AND e."deleted" = false AND t."finalResult" = 'ADMITTED'))
    ) AS "allowed"`);
  return row?.allowed === true;
}
export class ProjectMaterialsService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}
  private async accessible(
    tx: Prisma.TransactionClient,
    id: number,
    principal: AuthPrincipal,
    write: boolean,
  ) {
    const project = await tx.project.findFirst({
      where: { id, deleted: false, status: 'PUBLISHED' },
    });
    if (!project) throw new AuthError(404, 'NOT_FOUND', '已发布项目不存在');
    if (principal.role === 'NAVIGATOR' && project.createdBy === principal.uid)
      return { project, primary: false };
    if (principal.role === 'PM') {
      const manager = await tx.projectManagerRecruitment.findFirst({
        where: { projectId: id, status: 'ASSIGNED' },
      });
      const primary = manager?.candidateUserId === principal.userId;
      if (primary || (!write && manager?.expertRecruitmentHandlerUserId === principal.userId))
        return { project, primary };
    }
    if (
      !write &&
      principal.role === 'EXPERT' &&
      (await canExpertViewMaterials(tx, id, principal.userId))
    )
      return { project, primary: false };
    throw forbidden();
  }
  private async response(
    tx: Prisma.TransactionClient,
    project: Project,
    principal: AuthPrincipal,
    stateTransitioned: boolean,
  ) {
    let canConfirmRead = false;
    let confirmedReadAt: string | null = null;
    if (principal.role === 'EXPERT') {
      const member = await tx.projectMember.findFirst({
        where: {
          projectId: project.id,
          userId: principal.userId,
          status: 'ACTIVE',
          joinedAt: { not: null },
        },
        orderBy: { id: 'desc' },
      });
      if (member) {
        const assignment =
          member.expertAssignmentId == null
            ? null
            : await tx.projectExpertAssignment.findUnique({
                where: { id: member.expertAssignmentId },
                include: { owners: true },
              });
        const isOwner =
          assignment?.owners.some((o) => o.userId === principal.userId && o.status === 'ACTIVE') ||
          (assignment?.owners.length === 0 && assignment.projectOwnerUserId === principal.userId);
        if (!isOwner) {
          canConfirmRead = member.standardTrainingConfirmedAt == null;
          confirmedReadAt = member.standardTrainingConfirmedAt
            ? projectTime(member.standardTrainingConfirmedAt)
            : null;
        }
      }
    }
    return {
      projectId: project.id,
      standardContent: project.standardContent,
      standardLink: project.standardLink,
      attachments: await tx.projectAttachment.findMany({
        where: { projectId: project.id, status: 'ACTIVE' },
        orderBy: [{ sortNo: 'asc' }, { id: 'asc' }],
        select: projectDetailInclude.attachments.select,
      }),
      currentNodeCode: project.currentNodeCode,
      stateTransitioned,
      canConfirmRead,
      confirmedReadAt,
      readConfirmationTransitioned: false,
      versionNo: project.versionNo,
    };
  }
  async confirmRead(id: number, principal: AuthPrincipal) {
    if (principal.role !== 'EXPERT') throw forbidden();
    return this.db.$transaction(async (tx) => {
      // 与项目管理写操作保持相同锁顺序；并发确认只产生一次时间和培训完成轮次。
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR UPDATE`;
      const { project } = await this.accessible(tx, id, principal, false);
      const [member] = await tx.$queryRaw<ProjectMember[]>`
        SELECT * FROM "ProjectMember" WHERE "projectId" = ${id}
          AND "userId" = ${principal.userId}::uuid AND "status" = 'ACTIVE'
          AND "joinedAt" IS NOT NULL ORDER BY "id" DESC LIMIT 1 FOR UPDATE`;
      if (!member)
        throw new AuthError(
          400,
          'VALIDATION_ERROR',
          '当前执行专家尚未实际入项，不能确认标准与培训',
        );
      const assignment =
        member.expertAssignmentId == null
          ? null
          : await tx.projectExpertAssignment.findUnique({
              where: { id: member.expertAssignmentId },
              include: { owners: true },
            });
      if (
        assignment?.owners.some((o) => o.userId === principal.userId && o.status === 'ACTIVE') ||
        (assignment?.owners.length === 0 && assignment.projectOwnerUserId === principal.userId)
      )
        throw new AuthError(403, 'FORBIDDEN', '项目负责人不使用普通成员确认入口');
      const now = new Date();
      const transitioned = member.standardTrainingConfirmedAt == null;
      if (transitioned) {
        const updated = await tx.projectMember.updateMany({
          where: {
            id: member.id,
            status: 'ACTIVE',
            joinedAt: { not: null },
            standardTrainingConfirmedAt: null,
          },
          data: { standardTrainingConfirmedAt: now, updatedBy: principal.uid },
        });
        if (updated.count !== 1)
          throw new AuthError(409, 'DUPLICATE', '标准与培训确认状态已变化，请刷新后重试');
      }
      if (project.currentNodeCode !== 'COMPLETED') {
        const open = await tx.projectTaskRound.findMany({
          where: {
            projectId: id,
            userId: principal.userId,
            role: 'EXPERT',
            taskType: 'STANDARD_TRAINING',
            status: 'OPEN',
          },
        });
        if (transitioned && open.length === 0)
          await tx.projectTaskRound.create({
            data: {
              projectId: id,
              userId: principal.userId,
              role: 'EXPERT',
              taskType: 'STANDARD_TRAINING',
              status: 'COMPLETED',
              participated: true,
              openedAt: member.joinedAt!,
              finishedAt: now,
            },
          });
        for (const round of open)
          await tx.projectTaskRound.update({
            where: { id: round.id },
            data: {
              status: 'COMPLETED',
              participated: true,
              finishedAt: now,
            },
          });
      }
      // 完整采集后统一仲裁，避免覆盖其他真实来源，也清理已失效的高优先级卡片。
      // 确认/材料更新沿原动作保持静默，不新增通知事件。
      await refreshOwnerProgress(tx, id, [principal.userId], now);
      await refreshManagementCardSnapshots(tx, id, now);
      return {
        ...(await this.response(tx, project, principal, false)),
        readConfirmationTransitioned: transitioned,
      };
    });
  }
  async get(id: number, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const { project } = await this.accessible(tx, id, principal, false);
        return this.response(tx, project, principal, false);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async update(input: MaterialsInput, principal: AuthPrincipal) {
    if (principal.role !== 'NAVIGATOR' && principal.role !== 'PM') throw forbidden();
    return this.db.$transaction(async (tx) => {
      // 与项目创建相同：先锁上传人，再锁项目，附件认领复用业务事务。
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const { project, primary } = await this.accessible(tx, input.projectId, principal, true);
      const standardContent = input.standardContent?.trim() || null;
      const standardLink = input.standardLink?.trim() || null;
      if (
        (!standardContent && !standardLink) ||
        (input.standardLink?.length ?? 0) > 2000 ||
        (input.attachments?.length ?? 0) > 20
      )
        throw new AuthError(
          400,
          'VALIDATION_ERROR',
          '正文与链接至少填写一项，链接最多2000字符，附件最多20个',
        );
      const before = await collectManagementTasks(tx, project);
      const currentNodeCode = primary
        ? nodeAfterMaterials(project.currentNodeCode)
        : project.currentNodeCode;
      const changed = await tx.project.updateMany({
        where: {
          id: project.id,
          versionNo: project.versionNo,
          status: 'PUBLISHED',
          deleted: false,
        },
        data: {
          standardContent,
          standardLink,
          currentNodeCode,
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
        },
      });
      if (changed.count !== 1) throw new AuthError(409, 'DUPLICATE', '项目已更新，请刷新后重试');
      const user =
        input.attachments == null
          ? null
          : await tx.user.findUnique({ where: { id: principal.userId } });
      await syncProjectAttachments(
        tx,
        this.files,
        project.id,
        input.attachments,
        principal.uid,
        user ? displayName(user.displayName, user.realName, principal.uid) : principal.uid,
      );
      const updated = {
        ...project,
        standardContent,
        standardLink,
        currentNodeCode,
        versionNo: project.versionNo + 1,
      };
      const after = await collectManagementTasks(tx, updated);
      await reconcileTaskRounds(
        tx,
        project.id,
        before,
        after,
        { userId: principal.userId, role: primary ? 'PM' : 'NAVIGATOR' },
        ['MAIN_STANDARD_TRAINING'],
        ['MAIN_STANDARD_TRAINING'],
        managementTaskTypes,
      );
      const now = new Date();
      await refreshOwnerProgress(tx, project.id, null, now);
      await refreshManagementCardSnapshots(tx, project.id, now);
      // 旧动作publishRealtimeEvent=false；卡片与主线轮次同事务刷新，保持静默。
      return this.response(tx, updated, principal, currentNodeCode !== project.currentNodeCode);
    });
  }
}
