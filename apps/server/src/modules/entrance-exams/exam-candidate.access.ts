import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { transferCandidate } from '../personnel/personnel-transfer-exam.access.js';

/** 有效组织身份优先；待响应成员及单纯主管不能借个人接单绕过组织资格。 */
export async function requireCandidate(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
) {
  const project = await tx.project.findFirst({
    where: { id: projectId, deleted: false, status: 'PUBLISHED' },
  });
  if (!project) throw new AppError(404, 'NOT_FOUND', '已发布项目不存在');
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw new AppError(403, 'FORBIDDEN', '账号不可用');
  const rels = await tx.userOrgRel.findMany({
    where: { userId, joinStatus: { in: participatingStatuses }, organization: { deleted: false } },
    include: { organization: true },
  });
  const assignments = await tx.projectExpertAssignment.findMany({
    where: {
      projectId,
      status: 'ACCEPTED',
      OR: [
        { subjectType: 'INDIVIDUAL', expertUserId: userId },
        { subjectType: 'ORGANIZATION', organizationId: { in: rels.map((r) => r.orgId) } },
      ],
    },
    include: { owners: true, memberResponses: { where: { userId } } },
    orderBy: { id: 'asc' },
  });
  const ownerOf = (a: (typeof assignments)[number]) =>
    a.owners.length
      ? a.owners.some((o) => o.userId === userId && o.status === 'ACTIVE')
      : a.projectOwnerUserId === userId;
  const organizations = assignments.filter(
    (a) =>
      a.subjectType === 'ORGANIZATION' &&
      (rels.find((r) => r.orgId === a.organizationId)?.position === 'OWNER' ||
        ownerOf(a) ||
        !['REJECTED', 'CANCELLED'].includes(a.memberResponses[0]?.status ?? 'PENDING')),
  );
  const a = organizations.length
    ? organizations.find(
        (a) =>
          (rels.find((r) => r.orgId === a.organizationId)?.position !== 'OWNER' || ownerOf(a)) &&
          ['ACCEPTED', 'SELECTED'].includes(a.memberResponses[0]?.status ?? ''),
      )
    : assignments.find((a) => a.subjectType === 'INDIVIDUAL');
  if (!a) throw new AppError(403, 'FORBIDDEN', '当前执行专家尚未有效接单或无应试资格');
  return { assignment: a, user, project, relation: rels.find((r) => r.orgId === a.organizationId) };
}

export async function candidateContext(
  tx: Prisma.TransactionClient,
  projectId: number,
  userId: string,
  readOnly = false,
) {
  const transfer = await transferCandidate(tx, projectId, userId, readOnly);
  if (transfer) return transfer;
  const ordinary = await requireCandidate(tx, projectId, userId);
  return {
    ...ordinary,
    movement: null,
    sourceBizType: 'EXPERT_ORDER',
    sourceBizId: ordinary.assignment.id,
    organizationId: ordinary.assignment.organizationId,
  };
}
