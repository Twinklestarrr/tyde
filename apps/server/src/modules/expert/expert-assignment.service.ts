import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import {
  displayName,
  projectDetailData,
  projectDetailInclude,
} from '../projects/project-detail.js';
import { productionStageData } from '../projects/project-production-plan.service.js';
import { admissionStatus, expertNodeNames, expertProgress } from './expert-assignment.domain.js';
import { replaceProjectOwners, type OwnerChangeInput } from './expert-owner.service.js';
import { respondToAssignment, type RespondInput } from './expert-respond.service.js';
import { queryExpertTasks, validateTaskQuery } from './expert-task-query.js';
import { type ExpertTaskQuery } from './expert-task.types.js';
import { queryTransferTasks } from './expert-transfer-query.js';

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
    if (principal.role !== 'EXPERT') throw new AppError(403, 'FORBIDDEN', '仅执行专家可访问');
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
      throw new AppError(400, 'VALIDATION_ERROR', 'assignmentId必须为32位正整数');
    return this.db.$transaction(
      async (tx) => {
        const assignment = await tx.projectExpertAssignment.findFirst({
          where: { id: assignmentId, subjectType: 'ORGANIZATION', project: { deleted: false } },
          include: { owners: true },
        });
        if (!assignment || !assignment.organizationId)
          throw new AppError(404, 'NOT_FOUND', '组织执行专家任务不存在');
        const owner = await tx.userOrgRel.findFirst({
          where: {
            orgId: assignment.organizationId,
            userId: principal.userId,
            position: 'OWNER',
            joinStatus: { in: participatingStatuses },
            organization: { deleted: false },
          },
        });
        if (!owner) throw new AppError(403, 'FORBIDDEN', '只有该组织主管可以执行此操作');
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
      throw new AppError(400, 'VALIDATION_ERROR', 'keyword长度不能超过100');
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
          throw new AppError(400, 'VALIDATION_ERROR', 'assignmentId与movementId须二选一');
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
        if (!assignment) throw new AppError(404, 'NOT_FOUND', '执行专家任务不存在');
        if (assignment.subjectType === 'INDIVIDUAL') {
          if (assignment.expertUserId !== principal.userId)
            throw new AppError(403, 'FORBIDDEN', '无权查看该个人执行专家任务');
        } else if (assignment.subjectType === 'ORGANIZATION') {
          const rel = (await this.memberships(tx, principal.userId)).find(
            (r) => r.orgId === assignment.organizationId,
          );
          if (!rel || (assignment.status !== 'ACCEPTED' && rel.position !== 'OWNER'))
            throw new AppError(403, 'FORBIDDEN', '无权查看该组织执行专家任务');
        } else throw new AppError(403, 'FORBIDDEN', '接单主体不支持');
        const project = await tx.project.findFirst({
          where: { id: assignment.projectId, deleted: false, status: 'PUBLISHED' },
          include: projectDetailInclude,
        });
        if (!project) throw new AppError(404, 'NOT_FOUND', '已发布项目不存在');
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
