import { participatingStatuses } from '../organizations/organization.domain.js';
import { type PersonnelMember } from './personnel.types.js';

export function qualifiedForEntry(member: PersonnelMember, needWrittenExam: boolean) {
  const a = member.expertAssignment;
  const attempt = member.admissionAttempt;
  const movement = attempt?.transferMovement;
  if (attempt?.sourceBizType === 'PROJECT_MEMBER_TRANSFER') {
    if (
      !movement ||
      movement.id !== attempt.sourceBizId ||
      movement.status !== 'EFFECTIVE' ||
      movement.flow?.status !== 'APPROVED' ||
      movement.userId !== member.userId ||
      movement.targetProjectId !== member.projectId ||
      movement.targetExamAttemptId !== attempt.id ||
      attempt.candidateUserId !== member.userId ||
      attempt.organizationId !== member.organizationId ||
      attempt.userOrgRelId !== member.userOrgRelId ||
      attempt.exam.projectId !== member.projectId ||
      attempt.finalResult !== 'ADMITTED' ||
      attempt.cancelledAt ||
      member.user.status !== 'ACTIVE' ||
      !member.admittedAt
    )
      return false;
    if (!member.organizationId) return !member.userOrgRelId && !member.expertAssignmentId;
    const rel = member.organizationMembership;
    return !!(
      a &&
      a.status === 'ACCEPTED' &&
      a.subjectType === 'ORGANIZATION' &&
      a.projectId === member.projectId &&
      a.organizationId === member.organizationId &&
      !member.organization?.deleted &&
      rel &&
      rel.userId === member.userId &&
      rel.orgId === member.organizationId &&
      participatingStatuses.includes(rel.joinStatus)
    );
  }
  if (
    !a ||
    a.status !== 'ACCEPTED' ||
    a.projectId !== member.projectId ||
    member.user.status !== 'ACTIVE' ||
    !member.admittedAt
  )
    return false;
  if (member.organizationId) {
    const rel = member.organizationMembership;
    if (
      a.subjectType !== 'ORGANIZATION' ||
      a.organizationId !== member.organizationId ||
      member.organization?.deleted ||
      !rel ||
      rel.orgId !== member.organizationId ||
      rel.userId !== member.userId ||
      !participatingStatuses.includes(rel.joinStatus)
    )
      return false;
    const response = a.memberResponses.find(
      (r) => r.userId === member.userId && r.userOrgRelId === rel.id,
    );
    const owner = a.owners.length
      ? a.owners.some((o) => o.userId === member.userId && o.status === 'ACTIVE')
      : a.projectOwnerUserId === member.userId;
    if (!owner && (!response || !['ACCEPTED', 'SELECTED'].includes(response.status))) return false;
  } else if (
    a.subjectType !== 'INDIVIDUAL' ||
    a.expertUserId !== member.userId ||
    member.userOrgRelId
  )
    return false;
  return (
    !needWrittenExam ||
    !!(
      attempt &&
      attempt.candidateUserId === member.userId &&
      attempt.organizationId === member.organizationId &&
      attempt.finalResult === 'ADMITTED' &&
      attempt.exam.projectId === member.projectId &&
      attempt.userOrgRelId === member.userOrgRelId &&
      attempt.sourceBizId === a.id &&
      !attempt.cancelledAt
    )
  );
}
