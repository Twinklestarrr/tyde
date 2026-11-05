import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { movementConflict } from './personnel-movement.domain.js';
import { projectOwners } from './personnel-movement.repository.js';
import { type Transfer } from './personnel-transfer.types.js';

export const isManualTransferStep = (code: string) =>
  ['SOURCE_ORG_OWNER', 'TARGET_MANAGER', 'TARGET_ORG_OWNER'].includes(code);

export function requireTransferSource(m: Transfer) {
  const r = m.member,
    a = r.expertAssignment;
  if (
    r.status !== 'PENDING_TRANSFER' ||
    r.user.status !== 'ACTIVE' ||
    !a ||
    a.status !== 'ACCEPTED' ||
    a.projectId !== m.sourceProjectId ||
    (r.organizationId
      ? a.subjectType !== 'ORGANIZATION' ||
        a.organizationId !== r.organizationId ||
        r.organization?.deleted ||
        !r.organizationMembership ||
        r.organizationMembership.userId !== r.userId ||
        r.organizationMembership.orgId !== r.organizationId ||
        !participatingStatuses.includes(r.organizationMembership.joinStatus)
      : a.subjectType !== 'INDIVIDUAL' || a.expertUserId !== r.userId || !!r.userOrgRelId)
  )
    throw movementConflict('转项来源成员或组织关系已失效');
  if (
    !m.targetProject ||
    m.targetProject.deleted ||
    m.targetProject.status !== 'PUBLISHED' ||
    m.targetProject.currentNodeCode === 'COMPLETED'
  )
    throw movementConflict('目标项目已失效');
}

export async function requireTransferStage(
  tx: Prisma.TransactionClient,
  m: Transfer,
  code: string,
) {
  if (
    m.movementType !== 'TRANSFER' ||
    m.status !== 'PROCESSING' ||
    m.flow?.status !== 'PENDING' ||
    m.flow.currentNodeCode !== code
  )
    throw movementConflict('转项当前不在此处理阶段');
  await requireTransferEligibility(tx, m);
}

export async function requireTransferEligibility(tx: Prisma.TransactionClient, m: Transfer) {
  requireTransferSource(m);
  const source = await tx.project.findFirst({ where: { id: m.sourceProjectId, deleted: false } });
  if (!source || source.currentNodeCode === 'COMPLETED') throw movementConflict('原项目已失效');
  if (
    m.member.organizationId &&
    !(await tx.projectExpertAssignment.findFirst({
      where: {
        projectId: m.targetProjectId!,
        organizationId: m.member.organizationId,
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
      },
    }))
  )
    throw movementConflict('目标项目组织接单已失效');
  if (
    await tx.projectMember.findFirst({
      where: {
        projectId: m.targetProjectId!,
        userId: m.userId,
        status: {
          in: ['PENDING_CONFIRM', 'PENDING_ENTRY', 'ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER'],
        },
      },
    })
  )
    throw movementConflict('目标项目已存在该用户的开放成员身份');
}

export async function currentApprovers(tx: Prisma.TransactionClient, m: Transfer, code: string) {
  if (code === 'MEMBER_CONFIRM' || code === 'TARGET_ENTRANCE_EXAM') return [m.member.user];
  if (code === 'TARGET_MANAGER') {
    const manager = await tx.projectManagerRecruitment.findFirst({
      where: { projectId: m.targetProjectId!, status: 'ASSIGNED' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      include: { candidate: true },
    });
    return manager?.candidate.status === 'ACTIVE' ? [manager.candidate] : [];
  }
  if (!m.member.organizationId) return [];
  try {
    return await projectOwners(
      tx,
      code === 'SOURCE_ORG_OWNER' ? m.sourceProjectId : m.targetProjectId!,
      m.member.organizationId,
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 409) return [];
    throw error;
  }
}

export function requireTransferPassed(m: Transfer) {
  const a = m.targetExamAttempt;
  if (
    !a ||
    a.sourceBizType !== 'PROJECT_MEMBER_TRANSFER' ||
    a.sourceBizId !== m.id ||
    a.exam.projectId !== m.targetProjectId ||
    a.candidateUserId !== m.userId ||
    a.organizationId !== m.member.organizationId ||
    a.userOrgRelId !== m.member.userOrgRelId ||
    !a.submittedAt ||
    !a.finalDecidedAt ||
    a.cancelledAt ||
    a.finalResult !== 'ADMITTED'
  )
    throw movementConflict('目标项目准入考试尚未通过');
}
