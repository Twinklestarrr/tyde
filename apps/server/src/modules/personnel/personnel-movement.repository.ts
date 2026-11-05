import { Prisma } from '@prisma/client';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { type TaskSnapshot } from '../projects/project-task.types.js';
import { movementConflict } from './personnel-movement.domain.js';

export async function projectOwners(
  tx: Prisma.TransactionClient,
  projectId: number,
  organizationId: string,
) {
  const assignment = await tx.projectExpertAssignment.findFirst({
    where: { projectId, organizationId, subjectType: 'ORGANIZATION', status: 'ACCEPTED' },
    include: { owners: true },
    orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
  });
  const ids = assignment?.owners.length
    ? assignment.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.userId)
    : assignment?.projectOwnerUserId
      ? [assignment.projectOwnerUserId]
      : [];
  const users = await tx.user.findMany({
    where: {
      id: { in: ids },
      status: 'ACTIVE',
      memberships: {
        some: {
          orgId: organizationId,
          joinStatus: { in: participatingStatuses },
          organization: { deleted: false },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  if (!users.length) throw movementConflict('项目组织未配置有效项目负责人');
  return users;
}

// 只采集转项人工审批，不把接单/考试等待节点当成人工审批待办。
export async function movementTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
): Promise<TaskSnapshot> {
  const snapshot: TaskSnapshot = { scopes: [], sources: [] };
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      OR: [{ sourceProjectId: projectId }, { targetProjectId: projectId }],
      status: 'PROCESSING',
      flow: { status: 'PENDING' },
    },
    include: { flow: { include: { nodes: { where: { nodeStatus: 'PENDING' } } } } },
    orderBy: { id: 'asc' },
  });
  for (const row of rows)
    for (const node of row.flow?.nodes ?? []) {
      if (!['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER', 'TARGET_MANAGER'].includes(node.nodeCode))
        continue;
      if (
        (node.nodeCode === 'SOURCE_ORG_OWNER' ? row.sourceProjectId : row.targetProjectId) !==
        projectId
      )
        continue;
      const role = node.nodeCode === 'TARGET_MANAGER' ? ('PM' as const) : ('EXPERT' as const);
      let source = snapshot.sources.find((s) => s.userId === node.approverId && s.role === role);
      if (!source) {
        snapshot.scopes.push({
          userId: node.approverId,
          role,
          perspective: role === 'PM' ? 'PROJECT_MANAGER' : 'EXPERT_PROJECT_OWNER',
          currentNodeCode: 'PRODUCTION_TASK',
          mainEligible: false,
          boardVisible: true,
        });
        source = {
          userId: node.approverId,
          role,
          taskType: 'MEMBER_MOVEMENT_APPROVAL',
          sources: [],
        };
        snapshot.sources.push(source);
      }
      source.sources.push(`PROJECT_MEMBER_MOVEMENT:${row.id}`);
    }
  return snapshot;
}
