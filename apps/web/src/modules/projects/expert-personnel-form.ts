import type { ExpertTask, ExpertProjectOwnerCandidate } from '@tyde/shared';
import { personnelBody } from './personnel-form';

export function canManageExpertPersonnel(task: ExpertTask) {
  return (
    task.sourceBizType === 'EXPERT_ASSIGNMENT' &&
    task.acceptanceStatus === 'ACCEPTED' &&
    task.basicInfo.subjectType === 'ORGANIZATION' &&
    !!task.basicInfo.organizationId &&
    task.accessContext.canViewOrganizationData &&
    (task.accessContext.projectOwner || task.accessContext.acceptedOrganizationOwner)
  );
}
export function isExpertPersonnelApproval(task: ExpertTask) {
  return (
    task.sourceBizType === 'PROJECT_MEMBER_TRANSFER' &&
    task.movementId !== null &&
    task.acceptanceStatus === 'ACCEPTED' &&
    task.branchNodeCode === 'MEMBER_MOVEMENT_APPROVAL'
  );
}
export function expertOwnerIds(task: ExpertTask) {
  return task.basicInfo.projectOwners.length
    ? task.basicInfo.projectOwners
        .map((owner) => owner.userId)
        .filter((id): id is string => id !== null)
    : task.basicInfo.projectOwnerUserId
      ? [task.basicInfo.projectOwnerUserId]
      : [];
}
export function expertOwnersInput(
  task: ExpertTask,
  selected: string[],
  candidates: ExpertProjectOwnerCandidate[],
) {
  if (task.basicInfo.projectOwners.some((owner) => owner.userId === null))
    throw new Error('当前负责人标识不完整，请重新读取项目后再更换。');
  if (
    !canManageExpertPersonnel(task) ||
    !task.accessContext.acceptedOrganizationOwner ||
    !task.assignmentId
  )
    throw new Error('只有当前已接单组织的有效主管可以更换项目负责人。');
  const ids = [...new Set(selected)];
  if (
    !ids.length ||
    ids.length > 20 ||
    ids.some((id) => !candidates.some((row) => row.userId === id))
  )
    throw new Error('请选择1至20名当前组织有效候选作为完整负责人集合。');
  return personnelBody({ assignmentId: task.assignmentId, projectOwnerUserIds: ids });
}
