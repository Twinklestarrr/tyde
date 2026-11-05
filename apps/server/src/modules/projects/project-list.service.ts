import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { hasManagementRole } from '../management/management.service.js';
import { projectTime } from './project-time.js';
export const branchLabels = {
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  ENTRANCE_EXAM_GRADING_RETRY: '自动阅卷失败待处理',
  EXPERT_RECRUITMENT_RETRY: '重新招募执行专家',
  SUBTASK_REWORK_REVIEW: '驳回验收',
  SUBTASK_REWORK_SUBMIT: '提交验收',
  SUBTASK_ACCEPTANCE: '验收',
  ENTRANCE_EXAM_GRADING: '待阅卷',
  OUTPUT_DATA_REVIEW: '检查数据',
  SUBTASK_CREATE: '子任务创建',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
};
export type ListRole = 'NAVIGATOR' | 'PM';
export interface ProjectCardRow {
  id: number;
  projectNo: string;
  projectName: string | null;
  projectDescription: string | null;
  currentNodeCode: string | null;
  branchNodeCode: string | null;
  requesterName: string;
  creatorId: string | null;
  creatorName: string;
  projectManagerId: string | null;
  projectManagerName: string | null;
  activeExpertCount: bigint;
  requiredHeadcount: number | null;
  deadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
  primaryProjectManager: boolean;
  expertRecruitmentHandler: boolean;
  needAssistGrading: boolean;
}
export function cardMainNode(row: Pick<ProjectCardRow, 'currentNodeCode' | 'projectManagerId'>) {
  return (
    row.currentNodeCode ?? (row.projectManagerId ? 'PRODUCTION_PLAN' : 'RECRUIT_PROJECT_MANAGER')
  );
}
export function visibleCard(row: ProjectCardRow, role: ListRole) {
  const main = cardMainNode(row),
    branch = row.branchNodeCode;
  if (main === 'COMPLETED') return false;
  if (role === 'NAVIGATOR') return main === 'RECRUIT_PROJECT_MANAGER' || branch !== null;
  if (row.primaryProjectManager)
    return (
      [
        'PRODUCTION_PLAN',
        'ENTRANCE_EXAM',
        'STANDARD_TRAINING',
        'RECRUIT_EXECUTION_EXPERT',
      ].includes(main) || branch !== null
    );
  return (
    row.expertRecruitmentHandler &&
    (main === 'RECRUIT_EXECUTION_EXPERT' || branch === 'EXPERT_RECRUITMENT_RETRY')
  );
}
// 静态SQL片段只处理展示名；用户值始终通过Prisma.sql参数绑定。
function displaySql(alias: string, fallback: string) {
  return Prisma.raw(
    `CASE WHEN NULLIF(BTRIM(${alias}."displayName"),'') IS NOT NULL AND NULLIF(BTRIM(${alias}."realName"),'') IS NOT NULL THEN BTRIM(${alias}."displayName") || '(' || BTRIM(${alias}."realName") || ')' ELSE COALESCE(NULLIF(BTRIM(${alias}."displayName"),''),NULLIF(BTRIM(${alias}."realName"),''),${fallback}) END`,
  );
}
export class ProjectListService {
  constructor(readonly db: PrismaClient) {}
  async list(role: ListRole, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        if (!(await hasManagementRole(tx, principal, role)))
          throw new AppError(403, 'FORBIDDEN', '请切换到对应业务角色');
        const perspective =
          role === 'NAVIGATOR'
            ? Prisma.sql`'NAVIGATOR'`
            : Prisma.sql`CASE WHEN r."candidateUserId"=${principal.userId}::uuid THEN 'PROJECT_MANAGER' ELSE 'EXPERT_RECRUITMENT_HANDLER' END`;
        const scope =
          role === 'NAVIGATOR'
            ? Prisma.sql`p."createdBy"=${principal.uid}`
            : Prisma.sql`(r."candidateUserId"=${principal.userId}::uuid OR r."expertRecruitmentHandlerUserId"=${principal.userId}::uuid)`;
        const grading =
          role === 'NAVIGATOR'
            ? Prisma.sql`EXISTS(SELECT 1 FROM "ProjectEntranceExam" e JOIN "EntranceExamGradingRound" g ON g."examVersionId"=e."currentVersionId" AND g."gradingMode"='MANUAL' WHERE e."projectId"=p."id" AND e."status"='ACTIVE' AND e."deleted"=false AND g."reviewersJson" @> ${JSON.stringify([{ userId: principal.userId }])}::jsonb)`
            : Prisma.sql`false`;
        const rows = await tx.$queryRaw<ProjectCardRow[]>(Prisma.sql`
    SELECT p."id",p."projectNo",p."projectName",p."projectDescription",p."currentNodeCode",s."branchNodeCode",
     CASE WHEN p."requesterType"='INDIVIDUAL' THEN ${displaySql('requester', 'p."requesterName"')} ELSE p."requesterName" END AS "requesterName",
     creator."id" AS "creatorId",${displaySql('creator', 'p."requesterName"')} AS "creatorName",
     manager."id" AS "projectManagerId",${displaySql('manager', 'manager."uid"')} AS "projectManagerName",
     (SELECT COUNT(*) FROM "ProjectMember" m WHERE m."projectId"=p."id" AND m."status"='ACTIVE') AS "activeExpertCount",
     p."requiredHeadcount",p."deadline",p."createdAt",p."updatedAt",
     COALESCE(r."candidateUserId"=${principal.userId}::uuid,false) AS "primaryProjectManager",
     COALESCE(r."expertRecruitmentHandlerUserId"=${principal.userId}::uuid,false) AS "expertRecruitmentHandler",
     ${grading} AS "needAssistGrading"
    FROM "Project" p
    LEFT JOIN "User" requester ON requester."id"=p."requesterId"
    LEFT JOIN "User" creator ON creator."uid"=p."createdBy"
    LEFT JOIN "ProjectManagerRecruitment" r ON r."projectId"=p."id" AND r."status"='ASSIGNED'
    LEFT JOIN "User" manager ON manager."id"=r."candidateUserId"
    LEFT JOIN "ProjectRoleNodeSnapshot" s ON s."projectId"=p."id" AND s."userId"=${principal.userId}::uuid AND s."perspective"=${perspective}
    WHERE p."deleted"=false AND p."status"='PUBLISHED' AND ${scope}
    ORDER BY p."updatedAt" DESC,p."id" DESC`);
        const visible = rows.filter((row) => visibleCard(row, role));
        if (!visible.length) return [];
        const ids = visible.map((row) => row.id);
        const categories = await tx.projectCategoryRelation.findMany({
          where: { projectId: { in: ids } },
          orderBy: [
            { projectId: 'asc' },
            { categoryLevel: 'asc' },
            { sortNo: 'asc' },
            { id: 'asc' },
          ],
        });
        // 保留旧UNION ALL行为：只有该assignment完全没有关系行才回退单负责人，REMOVED行也阻止回退。
        const owners = await tx.$queryRaw<
          { projectId: number; userId: string; name: string; avatarUrl: string | null }[]
        >(Prisma.sql`
    SELECT a."projectId",u."id" AS "userId",${displaySql('u', 'u."uid"')} AS "name",u."avatarUrl"
    FROM "ProjectExpertAssignment" a JOIN "ProjectExpertAssignmentOwner" o ON o."assignmentId"=a."id" AND o."status"='ACTIVE' JOIN "User" u ON u."id"=o."userId"
    WHERE a."projectId" IN (${Prisma.join(ids)}) AND a."subjectType"='ORGANIZATION' AND a."status"='ACCEPTED'
    UNION ALL
    SELECT a."projectId",u."id" AS "userId",${displaySql('u', 'u."uid"')} AS "name",u."avatarUrl"
    FROM "ProjectExpertAssignment" a JOIN "User" u ON u."id"=a."projectOwnerUserId"
    WHERE a."projectId" IN (${Prisma.join(ids)}) AND a."subjectType"='ORGANIZATION' AND a."status"='ACCEPTED'
    AND NOT EXISTS(SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId"=a."id")
    ORDER BY "projectId","userId"`);
        const categoriesByProject = new Map<number, typeof categories>(),
          ownersByProject = new Map<number, typeof owners>();
        for (const c of categories)
          categoriesByProject.set(c.projectId, [
            ...(categoriesByProject.get(c.projectId) ?? []),
            c,
          ]);
        for (const o of owners)
          ownersByProject.set(o.projectId, [...(ownersByProject.get(o.projectId) ?? []), o]);
        return visible.map((row) => {
          const relations = categoriesByProject.get(row.id) ?? [],
            first = relations.find((c) => c.categoryLevel === 1)?.categoryNameSnapshot ?? null,
            second = relations.find((c) => c.categoryLevel === 2)?.categoryNameSnapshot ?? null,
            third = relations
              .filter((c) => c.categoryLevel === 3)
              .map((c) => c.categoryNameSnapshot);
          const main = cardMainNode(row),
            waiting = main === 'RECRUIT_PROJECT_MANAGER';
          return {
            id: row.id,
            projectNo: row.projectNo,
            projectName: row.projectName,
            projectDescription: row.projectDescription,
            categoryLevel1Name: first,
            categoryLevel2Name: second,
            categoryLevel3Names: third,
            categoryDisplayName:
              [third.join('、'), second, first].find((v) => v?.trim()) ?? '未分类项目',
            status: 'PUBLISHED',
            statusDescription: '已发布',
            currentNodeCode: main,
            branchNodeCode: row.branchNodeCode,
            workbenchStatus: waiting ? 'PENDING' : 'PROCESSING',
            workbenchStatusDescription: waiting ? '待处理' : '处理中',
            currentAction:
              role === 'PM' && row.expertRecruitmentHandler && !row.primaryProjectManager
                ? 'VIEW_DETAIL'
                : waiting
                  ? 'RECRUIT_PROJECT_MANAGER'
                  : 'VIEW_DETAIL',
            currentActionDescription:
              role === 'PM' && row.expertRecruitmentHandler && !row.primaryProjectManager
                ? '查看项目详情'
                : waiting
                  ? '招募策略官'
                  : '查看项目详情',
            ...(role === 'PM'
              ? {
                  primaryProjectManager: row.primaryProjectManager,
                  expertRecruitmentHandler: row.expertRecruitmentHandler,
                }
              : {}),
            needAssistGrading: row.needAssistGrading,
            requesterName: row.requesterName,
            creatorId: row.creatorId,
            creatorName: row.creatorName,
            projectManagerId: row.projectManagerId,
            projectManagerName: row.projectManagerName,
            projectManagerStatusDescription: row.projectManagerId ? '已指定' : '招募中',
            projectOwners: (ownersByProject.get(row.id) ?? []).map(
              ({ userId, name, avatarUrl }) => ({ userId, name, avatarUrl }),
            ),
            activeExpertCount: Number(row.activeExpertCount),
            requiredHeadcount: row.requiredHeadcount,
            deadline: row.deadline ? projectTime(row.deadline) : null,
            createdAt: projectTime(row.createdAt),
            updatedAt: projectTime(row.updatedAt),
          };
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
