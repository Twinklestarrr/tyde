import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { queryTransferTasks } from './expert-transfer-query.js';
import { respondToAssignment, type RespondInput } from './expert-respond-command.js';
import { queryExpertTasks, validateTaskQuery, type ExpertTaskQuery } from './expert-task-query.js';
import { replaceProjectOwners, type OwnerChangeInput } from './expert-owner-command.js';
import {
  Prisma,
  type PrismaClient,
  type EntranceExamAttempt,
  type ProjectMember,
} from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import {
  projectDetailData,
  projectDetailInclude,
  displayName,
} from '../projects/project-detail.js';
import { productionStageData } from '../projects/project-production-plan.service.js';

export function admissionStatus(
  attempts: Pick<
    EntranceExamAttempt,
    'finalResult' | 'gradingStatus' | 'enteredAt' | 'submittedAt' | 'finalDecidedAt'
  >[],
) {
  if (attempts.some((a) => a.finalResult === 'ADMITTED')) return 'PASSED';
  if (
    attempts.some(
      (a) =>
        !['ADMITTED', 'ELIMINATED'].includes(a.finalResult) &&
        (['PENDING', 'IN_PROGRESS'].includes(a.gradingStatus) ||
          (a.submittedAt && !a.finalDecidedAt)),
    )
  )
    return 'PENDING';
  return attempts.some((a) => a.enteredAt) ? 'NOT_PASSED' : 'NOT_EXAMINED';
}
export function expertProgress(
  needExam: boolean,
  passed: boolean,
  member?: Pick<
    ProjectMember,
    'status' | 'entryDecision' | 'joinedAt' | 'standardTrainingConfirmedAt'
  >,
) {
  if (needExam && !passed) return 'ENTRANCE_EXAM';
  if (
    member &&
    ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(member.status) &&
    member.entryDecision !== 'NO' &&
    member.joinedAt &&
    member.standardTrainingConfirmedAt
  )
    return 'PRODUCTION_TASK';
  // 沿旧my-projects展示回退；不表示已完成准入或实际入项，也不授予后续动作。
  return 'STANDARD_TRAINING';
}
export const expertNodeNames: Record<string, string> = {
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
  OUTPUT_DATA_REVIEW: '检查数据',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
};
export class ExpertAssignmentService {
  constructor(readonly db: PrismaClient) {}
  setProjectOwners(input: OwnerChangeInput, principal: AuthPrincipal, legacy = false) {
    return replaceProjectOwners(
      this.db,
      input,
      principal,
      legacy ? 'expert.change-project-owner' : 'expert.set-project-owners',
    );
  }
  respond(input: RespondInput, principal: AuthPrincipal) {
    return respondToAssignment(this.db, input, principal);
  }
  private requireExpert(principal: AuthPrincipal) {
    if (principal.role !== 'EXPERT') throw new AuthError(403, 'FORBIDDEN', '仅执行专家可访问');
  }
  private async memberships(tx: Prisma.TransactionClient, userId: string) {
    return tx.userOrgRel.findMany({
      where: {
        userId,
        joinStatus: { in: participatingStatuses },
        organization: { deleted: false },
      },
    });
  }
  async myTasks(query: ExpertTaskQuery, principal: AuthPrincipal) {
    this.requireExpert(principal);
    validateTaskQuery(query);
    return this.db.$transaction((tx) => queryExpertTasks(tx, query, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async projectOwnerCandidates(assignmentId: number, principal: AuthPrincipal) {
    this.requireExpert(principal);
    if (!Number.isInteger(assignmentId) || assignmentId < 1 || assignmentId > 2147483647)
      throw new AuthError(400, 'VALIDATION_ERROR', 'assignmentId必须为32位正整数');
    return this.db.$transaction(
      async (tx) => {
        const assignment = await tx.projectExpertAssignment.findFirst({
          where: { id: assignmentId, subjectType: 'ORGANIZATION', project: { deleted: false } },
          include: { owners: true },
        });
        if (!assignment || !assignment.organizationId)
          throw new AuthError(404, 'NOT_FOUND', '组织执行专家任务不存在');
        const owner = await tx.userOrgRel.findFirst({
          where: {
            orgId: assignment.organizationId,
            userId: principal.userId,
            position: 'OWNER',
            joinStatus: { in: participatingStatuses },
            organization: { deleted: false },
          },
        });
        if (!owner) throw new AuthError(403, 'FORBIDDEN', '只有该组织主管可以执行此操作');
        const members = await tx.userOrgRel.findMany({
          where: {
            orgId: assignment.organizationId,
            joinStatus: { in: participatingStatuses },
            user: { status: 'ACTIVE' },
          },
          include: { user: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        });
        // 关系表存在任何历史即禁用旧单值回退；仅已接单任务具有现任负责人。
        const ownerIds = new Set(
          assignment.status !== 'ACCEPTED'
            ? []
            : assignment.owners.length
              ? assignment.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.userId)
              : assignment.projectOwnerUserId
                ? [assignment.projectOwnerUserId]
                : [],
        );
        return members.map(({ user, position }) => ({
          userId: user.id,
          uid: user.uid,
          name: displayName(user.displayName, user.realName, user.uid),
          avatarUrl: user.avatarUrl,
          position,
          projectOwner: ownerIds.has(user.id),
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async myProjects(keyword: string | undefined, principal: AuthPrincipal) {
    this.requireExpert(principal);
    if (keyword && keyword.length > 100)
      throw new AuthError(400, 'VALIDATION_ERROR', 'keyword长度不能超过100');
    return this.db.$transaction(
      async (tx) => {
        const rels = await this.memberships(tx, principal.userId);
        const assignments = await tx.projectExpertAssignment.findMany({
          where: {
            project: { deleted: false },
            status: 'ACCEPTED',
            OR: [
              { subjectType: 'INDIVIDUAL', expertUserId: principal.userId },
              { subjectType: 'ORGANIZATION', organizationId: { in: rels.map((r) => r.orgId) } },
            ],
          },
          include: {
            owners: true,
            memberResponses: { where: { userId: principal.userId } },
            project: { include: { requester: true, productionPlan: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const ownerOf = (a: (typeof assignments)[number]) =>
          a.owners.length
            ? a.owners.some((o) => o.userId === principal.userId && o.status === 'ACTIVE')
            : a.projectOwnerUserId === principal.userId;
        const relOf = (a: (typeof assignments)[number]) =>
          rels.find((r) => r.orgId === a.organizationId);
        // 有效组织身份优先；尚未响应的成员也压过个人身份，拒绝/取消才恢复个人身份。
        const organizationProjects = new Set(
          assignments
            .filter(
              (a) =>
                a.subjectType === 'ORGANIZATION' &&
                (relOf(a)?.position === 'OWNER' ||
                  ownerOf(a) ||
                  !['REJECTED', 'CANCELLED'].includes(a.memberResponses[0]?.status ?? 'PENDING')),
            )
            .map((a) => a.projectId),
        );
        const rows = assignments.filter((a) =>
          a.subjectType === 'INDIVIDUAL'
            ? !organizationProjects.has(a.projectId)
            : relOf(a)?.position !== 'OWNER' &&
              !ownerOf(a) &&
              ['ACCEPTED', 'SELECTED'].includes(a.memberResponses[0]?.status ?? ''),
        );
        const unique = [
          ...new Map(rows.map((a) => [a.projectId, a] as const).reverse()).values(),
        ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
        const transferred = (await queryTransferTasks(tx, {}, principal))
          .filter((c) => ['STANDARD_TRAINING', 'PRODUCTION_TASK'].includes(c.branchNodeCode ?? ''))
          .map((c) => ({
            assignmentId: null,
            movementId: c.movementId,
            projectId: c.basicInfo.projectId,
            projectName: c.basicInfo.projectName,
            requesterName: c.basicInfo.requesterName,
            needWrittenExam: true,
            admissionStatus: 'PASSED',
            currentNodeCode: c.branchNodeCode!,
          }));
        if (!unique.length)
          return transferred.filter(
            (r) =>
              !keyword?.trim() ||
              [
                r.projectName,
                r.requesterName,
                r.currentNodeCode,
                expertNodeNames[r.currentNodeCode],
                'PASSED',
                '通过',
              ].some((v) => v?.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase())),
          );
        const ids = unique.map((a) => a.projectId);
        const attempts = await tx.entranceExamAttempt.findMany({
          where: {
            candidateUserId: principal.userId,
            exam: { projectId: { in: ids }, deleted: false },
          },
          include: { exam: { select: { projectId: true } } },
        });
        const members = await tx.projectMember.findMany({
          where: { projectId: { in: ids }, userId: principal.userId },
          orderBy: { id: 'desc' },
        });
        const snapshots = await tx.projectRoleNodeSnapshot.findMany({
          where: {
            projectId: { in: ids },
            userId: principal.userId,
            perspective: { in: ['EXPERT_INDIVIDUAL', 'EXPERT_MEMBER'] },
          },
        });
        const normalized = keyword?.trim().toLocaleLowerCase();
        const ordinary = unique
          .map((a) => {
            const project = a.project;
            const status = admissionStatus(
              attempts.filter((r) => r.exam.projectId === a.projectId),
            );
            const needWrittenExam = project.productionPlan?.needWrittenExam ?? false;
            const perspective =
              a.subjectType === 'INDIVIDUAL' ? 'EXPERT_INDIVIDUAL' : 'EXPERT_MEMBER';
            const snapshot = snapshots.find(
              (s) => s.projectId === a.projectId && s.perspective === perspective,
            );
            let currentNodeCode = expertProgress(
              needWrittenExam,
              status === 'PASSED',
              members.find((m) => m.projectId === a.projectId),
            );
            // 普通个人履约进度读取当前最新成员事实。其他支线沿真实快照；报量核验真值待11接入，不沿用可能过期的核验快照。
            if (
              (!needWrittenExam || status === 'PASSED') &&
              snapshot &&
              ![
                'ENTRANCE_EXAM',
                'STANDARD_TRAINING',
                'PRODUCTION_TASK',
                'OUTPUT_DATA_REVIEW',
              ].includes(snapshot.branchNodeCode)
            )
              currentNodeCode = snapshot.branchNodeCode;
            return {
              assignmentId: a.id,
              movementId: null,
              projectId: project.id,
              projectName: project.projectName,
              requesterName:
                project.requesterType === 'INDIVIDUAL'
                  ? displayName(
                      project.requester.displayName,
                      project.requester.realName,
                      project.requesterName,
                    )
                  : project.requesterName,
              needWrittenExam,
              admissionStatus: status,
              currentNodeCode,
            };
          })
          .filter(
            (row) =>
              !normalized ||
              [
                row.projectName,
                row.requesterName,
                row.currentNodeCode,
                expertNodeNames[row.currentNodeCode],
                row.admissionStatus,
                { PASSED: '通过', PENDING: '待阅卷', NOT_PASSED: '未通过', NOT_EXAMINED: '未考试' }[
                  row.admissionStatus
                ],
              ].some((value) => value?.toLocaleLowerCase().includes(normalized)),
          );
        const combined = [
          ...transferred,
          ...ordinary.filter((r) => !transferred.some((t) => t.projectId === r.projectId)),
        ];
        return combined.filter(
          (r) =>
            !normalized ||
            [
              r.projectName,
              r.requesterName,
              r.currentNodeCode,
              expertNodeNames[r.currentNodeCode],
              r.admissionStatus,
              '通过',
            ].some((v) => v?.toLocaleLowerCase().includes(normalized)),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async detail(assignmentId: number | undefined, principal: AuthPrincipal, movementId?: number) {
    this.requireExpert(principal);
    return this.db.$transaction(
      async (tx) => {
        if ((assignmentId == null) === (movementId == null))
          throw new AuthError(400, 'VALIDATION_ERROR', 'assignmentId与movementId须二选一');
        const transferCard =
          movementId == null
            ? null
            : (await queryTransferTasks(tx, {}, principal)).find(
                (c) => c.movementId === movementId,
              );
        const assignment =
          movementId != null
            ? transferCard
              ? {
                  id: null,
                  projectId: transferCard.basicInfo.projectId,
                  subjectType: 'INDIVIDUAL',
                  expertUserId: principal.userId,
                  organizationId: null,
                  status: 'ACCEPTED',
                  operatorHeadcount: null,
                  inspectorHeadcount: null,
                  productionRequirement: null,
                }
              : null
            : await tx.projectExpertAssignment.findFirst({
                where: { id: assignmentId, project: { deleted: false } },
              });
        if (!assignment) throw new AuthError(404, 'NOT_FOUND', '执行专家任务不存在');
        if (assignment.subjectType === 'INDIVIDUAL') {
          if (assignment.expertUserId !== principal.userId)
            throw new AuthError(403, 'FORBIDDEN', '无权查看该个人执行专家任务');
        } else if (assignment.subjectType === 'ORGANIZATION') {
          const rel = (await this.memberships(tx, principal.userId)).find(
            (r) => r.orgId === assignment.organizationId,
          );
          if (!rel || (assignment.status !== 'ACCEPTED' && rel.position !== 'OWNER'))
            throw new AuthError(403, 'FORBIDDEN', '无权查看该组织执行专家任务');
        } else throw new AuthError(403, 'FORBIDDEN', '接单主体不支持');
        const project = await tx.project.findFirst({
          where: { id: assignment.projectId, deleted: false, status: 'PUBLISHED' },
          include: projectDetailInclude,
        });
        if (!project) throw new AuthError(404, 'NOT_FOUND', '已发布项目不存在');
        const data = await projectDetailData(tx, project);
        const creator = await tx.user.findUnique({ where: { uid: project.createdBy } });
        const plan = await tx.projectProductionPlan.findUnique({
          where: { projectId: project.id },
          include: {
            crowds: { orderBy: { sequenceNo: 'asc' } },
            stages: { orderBy: { sequenceNo: 'asc' } },
          },
        });
        return {
          projectDetail: {
            ...data,
            creatorName: creator
              ? displayName(
                  creator.displayName,
                  creator.realName,
                  project.requesterName || project.createdBy,
                )
              : project.requesterName || project.createdBy,
          },
          productionPlan: {
            hasPlan: !!plan,
            planId: plan?.id ?? null,
            operatorHeadcount: assignment.operatorHeadcount,
            operatorCpd: plan?.operatorCpd.toNumber() ?? null,
            inspectorHeadcount: assignment.inspectorHeadcount,
            inspectorCpd: plan?.inspectorCpd?.toNumber() ?? null,
            totalExpectedOutput: assignment.productionRequirement?.toNumber() ?? null,
            crowds:
              plan?.crowds.map(({ id, sequenceNo, crowdName, profileRequirement }) => ({
                id,
                sequenceNo,
                crowdName,
                profileRequirement,
              })) ?? [],
            stages: plan?.stages.map(productionStageData) ?? [],
          },
          assignmentId: assignment.id,
          movementId: movementId ?? null,
          currentNodeCode: project.currentNodeCode,
          availableOperations: ['VIEW_DETAIL'],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** 与旧标准材料授权SQL一致；ACTIVE项目成员本身不授予附件权限。 */
export async function canReadExpertProjectFile(
  db: PrismaClient,
  projectId: number,
  userId: string,
) {
  const transferred = await db.projectMember.findMany({
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
  const rows = await db.$queryRaw<{ allowed: boolean }[]>`SELECT EXISTS(
    SELECT 1 FROM "ProjectExpertAssignment" a
    LEFT JOIN "ProjectProductionPlan" plan ON plan."projectId"=a."projectId"
    LEFT JOIN "UserOrgRel" rel ON rel."orgId"=a."organizationId" AND rel."userId"=${userId}::uuid
      AND rel."joinStatus" IN (${Prisma.join(participatingStatuses)})
    LEFT JOIN "Organization" org ON org."id"=rel."orgId" AND org."deleted"=false
    WHERE a."projectId"=${projectId} AND a."status"='ACCEPTED'
    AND ((a."subjectType"='INDIVIDUAL' AND a."expertUserId"=${userId}::uuid)
      OR (a."subjectType"='ORGANIZATION' AND rel."id" IS NOT NULL AND org."id" IS NOT NULL))
    AND (COALESCE(plan."needWrittenExam", false)=false
      OR (a."subjectType"='ORGANIZATION' AND (rel."position"='OWNER'
        OR EXISTS(SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId"=a."id" AND o."userId"=${userId}::uuid AND o."status"='ACTIVE')
        OR (a."projectOwnerUserId"=${userId}::uuid AND NOT EXISTS(SELECT 1 FROM "ProjectExpertAssignmentOwner" o WHERE o."assignmentId"=a."id"))))
      OR EXISTS(SELECT 1 FROM "EntranceExamAttempt" attempt JOIN "ProjectEntranceExam" exam ON exam."id"=attempt."examId" AND exam."deleted"=false
        WHERE attempt."candidateUserId"=${userId}::uuid AND exam."projectId"=a."projectId" AND attempt."finalResult"='ADMITTED'))
  ) AS allowed`;
  return rows[0]?.allowed === true;
}
