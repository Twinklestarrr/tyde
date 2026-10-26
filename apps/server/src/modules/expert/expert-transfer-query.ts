import type { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import {
  transferInclude,
  requireTransferEligibility,
  currentApprovers,
} from '../personnel/personnel-transfer.js';
import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import type { ExpertTaskQuery } from './expert-task-query.js';

export async function queryTransferTasks(
  tx: Prisma.TransactionClient,
  query: ExpertTaskQuery,
  p: AuthPrincipal,
  projectId?: number,
) {
  const keyword = query.keyword?.trim();
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      movementType: 'TRANSFER',
      status: { in: ['PROCESSING', 'WAITING_EFFECTIVE', 'EFFECTIVE'] },
      targetProject: {
        deleted: false,
        status: 'PUBLISHED',
        ...(projectId === undefined ? {} : { id: projectId }),
        ...(keyword
          ? {
              OR: [
                { projectName: { contains: keyword } },
                { requesterName: { contains: keyword } },
              ],
            }
          : {}),
      },
      OR: [
        { userId: p.userId },
        { flow: { nodes: { some: { approverId: p.userId, nodeStatus: 'PENDING' } } } },
      ],
    },
    include: {
      ...transferInclude,
      targetProject: {
        include: {
          requester: true,
          categories: { orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }] },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const cards = [];
  for (const m of rows) {
    const project = m.targetProject;
    if (!project || project.currentNodeCode === 'COMPLETED') continue;
    let branch: string | null;
    let pending = false;
    if (m.status === 'EFFECTIVE') {
      if (m.userId !== p.userId) continue;
      const member = await tx.projectMember.findFirst({
        where: {
          projectId: project.id,
          userId: p.userId,
          admissionAttemptId: m.targetExamAttemptId,
        },
        include: memberInclude,
      });
      if (
        !member ||
        !['ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER'].includes(member.status) ||
        !member.joinedAt ||
        member.leftAt ||
        !qualifiedForEntry(member, true)
      )
        continue;
      branch = member.standardTrainingConfirmedAt ? 'PRODUCTION_TASK' : 'STANDARD_TRAINING';
    } else {
      try {
        await requireTransferEligibility(tx, m);
      } catch (error) {
        if (error instanceof AuthError) continue;
        throw error;
      }
      if (m.status !== 'PROCESSING' || m.flow?.status !== 'PENDING') continue;
      const code = m.flow.currentNodeCode!;
      if (!(await currentApprovers(tx, m, code)).some((u) => u.id === p.userId)) continue;
      if (
        !m.flow.nodes.some(
          (n) =>
            n.nodeSeq === m.flow!.currentNode &&
            n.nodeStatus === 'PENDING' &&
            n.approverId === p.userId,
        )
      )
        continue;
      if (code === 'TARGET_MANAGER') continue; // PM角色使用人员变动审批入口。
      pending = code === 'MEMBER_CONFIRM';
      branch = pending
        ? null
        : code === 'TARGET_ENTRANCE_EXAM'
          ? 'ENTRANCE_EXAM'
          : 'MEMBER_MOVEMENT_APPROVAL';
      if (
        code === 'TARGET_ENTRANCE_EXAM' &&
        (m.targetExamAttempt?.submittedAt || m.targetExamAttempt?.cancelledAt)
      )
        continue;
    }
    const acceptanceStatus = pending ? 'PENDING_ACCEPTANCE' : 'ACCEPTED';
    if (
      (query.acceptanceStatus ?? query.status) &&
      (query.acceptanceStatus ?? query.status) !== acceptanceStatus
    )
      continue;
    const manager = await tx.projectManagerRecruitment.findFirst({
      where: { projectId: project.id, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      include: { candidate: true },
    });
    const creator = await tx.user.findUnique({ where: { uid: project.createdBy } });
    cards.push({
      assignmentId: null,
      movementId: m.id,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      sourceBizId: m.id,
      basicInfo: {
        projectId: project.id,
        projectName: project.projectName,
        projectDescription: project.projectDescription,
        requesterName:
          project.requesterType === 'INDIVIDUAL'
            ? displayName(
                project.requester.displayName,
                project.requester.realName,
                project.requesterName,
              )
            : project.requesterName,
        creatorId: creator?.id ?? null,
        creatorName: creator
          ? displayName(creator.displayName, creator.realName, project.requesterName)
          : project.requesterName,
        projectManagerId: manager?.candidate.id ?? null,
        projectManagerName: manager
          ? displayName(
              manager.candidate.displayName,
              manager.candidate.realName,
              manager.candidate.uid,
            )
          : null,
        categoryLevel1Name:
          project.categories.find((c) => c.categoryLevel === 1)?.categoryNameSnapshot ?? null,
        categoryLevel2Name:
          project.categories.find((c) => c.categoryLevel === 2)?.categoryNameSnapshot ?? null,
        categoryLevel3Names: project.categories
          .filter((c) => c.categoryLevel === 3)
          .map((c) => c.categoryNameSnapshot),
        deadline: project.deadline ? projectTime(project.deadline) : null,
        subjectType: m.member.organizationId ? 'ORGANIZATION' : 'INDIVIDUAL',
        organizationId: m.member.organizationId,
        organizationName: m.member.organization?.name ?? null,
        productionRequirement: null,
        operatorHeadcount: null,
        inspectorHeadcount: null,
        projectOwners: [],
        projectOwnerUserId: null,
        projectOwnerName: null,
        projectOwnerAvatarUrl: null,
        assignedAt: projectTime(m.createdAt),
      },
      acceptanceStatus,
      needWrittenExam: true,
      currentNodeCode: project.currentNodeCode ?? 'PERSONNEL_MANAGEMENT',
      branchNodeCode: branch,
      accessContext: {
        projectOwner: false,
        acceptedOrganizationOwner: false,
        canViewOrganizationData: false,
      },
      operations: { canAccept: pending, canReject: pending, canReportOutput: false },
    });
  }
  return cards;
}
