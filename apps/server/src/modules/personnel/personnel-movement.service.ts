import { processDueMovements } from './personnel-movement-effective.js';
import {
  listMovements,
  movementDetail,
  type MovementQuery,
  type MovementDetailQuery,
} from './personnel-movement-query.js';
import { createMovement } from './personnel-movement-create.js';
import {
  processMovement,
  withdrawMovement,
  type MovementProcessInput,
  type MovementWithdrawInput,
} from './personnel-transfer.js';
import type { MovementInput } from './personnel-movement.domain.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { displayName } from '../projects/project-detail.js';
import { personnelScope } from './personnel-access.js';

export interface TransferTargetQuery {
  projectId: number;
  memberIds: number[];
  keyword?: string | null;
  current?: number;
  size?: number;
}

// 同一用户在目标项目的任一组织或个人身份存在开放成员关系时，均不能再次转入。
const openMemberStatuses = [
  'PENDING_CONFIRM',
  'PENDING_ENTRY',
  'ACTIVE',
  'PENDING_EXIT',
  'PENDING_TRANSFER',
];

export class PersonnelMovementService {
  constructor(readonly db: PrismaClient) {}
  processDue(now = new Date()) {
    return processDueMovements(this.db, now);
  }
  list(query: MovementQuery, principal: AuthPrincipal) {
    return listMovements(this.db, query, principal);
  }
  detail(query: MovementDetailQuery, principal: AuthPrincipal) {
    return movementDetail(this.db, query, principal);
  }
  process(input: MovementProcessInput, principal: AuthPrincipal) {
    return processMovement(this.db, input, principal);
  }
  withdraw(input: MovementWithdrawInput, principal: AuthPrincipal) {
    return withdrawMovement(this.db, input, principal);
  }

  create(input: MovementInput, principal: AuthPrincipal, now = new Date()) {
    return createMovement(this.db, input, principal, now);
  }

  async targets(query: TransferTargetQuery, principal: AuthPrincipal) {
    const validId = (value: number) => Number.isInteger(value) && value > 0 && value <= 2147483647;
    if (
      !validId(query.projectId) ||
      !Array.isArray(query.memberIds) ||
      !query.memberIds.length ||
      query.memberIds.length > 100 ||
      !query.memberIds.every(validId) ||
      !validId(query.current ?? 1) ||
      !validId(query.size ?? 20) ||
      (query.size ?? 20) > 100 ||
      (query.keyword != null && (typeof query.keyword !== 'string' || query.keyword.length > 128))
    )
      throw new AuthError(400, 'VALIDATION_ERROR', '项目、成员、分页或关键字格式不正确');
    return this.db.$transaction(
      async (tx) => {
        // 旧候选入口使用管理权限，招募协作负责人的只读权限不适用于此入口。
        const scope = await personnelScope(tx, query.projectId, principal, true);
        const ids = [...new Set(query.memberIds)];
        const members = await tx.projectMember.findMany({
          where: { projectId: query.projectId, id: { in: ids }, status: 'ACTIVE' },
          select: { id: true, organizationId: true, userId: true },
        });
        if (members.length !== ids.length)
          throw new AuthError(400, 'VALIDATION_ERROR', '所选人员包含非本项目已入项成员');
        if (
          scope.organizationIds &&
          members.some(
            (m) => !m.organizationId || !scope.organizationIds.includes(m.organizationId),
          )
        )
          throw new AuthError(403, 'FORBIDDEN', '所选人员不在当前组织管理范围');

        const current = query.current ?? 1;
        const size = query.size ?? 20;
        const empty = { total: 0, current, size, pages: 0, records: [] };
        // 保留旧查询契约：批次含无组织成员时没有候选，不自动选用该用户的其他组织。
        if (members.some((m) => !m.organizationId)) return empty;

        const organizationIds = [...new Set(members.map((m) => m.organizationId!))];
        const keyword = query.keyword?.trim();
        const where: Prisma.ProjectWhereInput = {
          deleted: false,
          status: 'PUBLISHED',
          id: { not: query.projectId },
          ...(keyword
            ? { OR: [{ projectName: { contains: keyword } }, { projectNo: { contains: keyword } }] }
            : {}),
          AND: organizationIds.map((organizationId) => ({
            expertAssignments: {
              some: { organizationId, subjectType: 'ORGANIZATION', status: 'ACCEPTED' },
            },
          })),
          members: {
            none: {
              userId: { in: [...new Set(members.map((m) => m.userId))] },
              status: { in: openMemberStatuses },
            },
          },
        };
        const total = await tx.project.count({ where });
        const rows = await tx.project.findMany({
          where,
          orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * size,
          take: size,
          select: {
            id: true,
            projectNo: true,
            projectName: true,
            requesterType: true,
            requesterName: true,
            requester: { select: { displayName: true, realName: true, uid: true } },
            productionPlan: { select: { needWrittenExam: true } },
          },
        });
        return {
          total,
          current,
          size,
          pages: Math.ceil(total / size),
          records: rows.map((row) => ({
            projectId: row.id,
            projectNo: row.projectNo,
            projectName: row.projectName,
            requesterName:
              row.requesterType === 'INDIVIDUAL'
                ? displayName(row.requester.displayName, row.requester.realName, row.requester.uid)
                : row.requesterName,
            examRequired: row.productionPlan?.needWrittenExam ?? true,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
