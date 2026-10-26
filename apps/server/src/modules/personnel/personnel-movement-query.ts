import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { displayName } from '../projects/project-detail.js';
import { parseProjectTime, projectTime } from '../projects/project-time.js';
import { personnelScope } from './personnel-access.js';
import { todayText } from './personnel-domain.js';
import {
  currentApprovers,
  isManualTransferStep,
  requireTransferStage,
  requireTransferPassed,
  transferInclude,
} from './personnel-transfer.js';

export const movementStatusNames: Record<string, string> = {
  PROCESSING: '审批处理中',
  WAITING_EFFECTIVE: '待生效',
  EFFECTIVE: '已生效',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};
export interface MovementQuery {
  projectId: number;
  movementId?: number | null;
  memberId?: number | null;
  movementTypes?: string[] | null;
  statuses?: string[] | null;
  keyword?: string | null;
  createdStartAt?: string | null;
  createdEndAt?: string | null;
  current?: number;
  size?: number;
}
export interface MovementDetailQuery {
  projectId: number;
  memberId: number;
}
const queryInclude = {
  ...transferInclude,
  member: { include: { ...transferInclude.member.include, project: true } },
  initiator: true,
  flow: {
    include: {
      nodes: {
        orderBy: [{ nodeSeq: 'asc' }, { id: 'asc' }],
        include: { actions: { orderBy: { id: 'desc' }, take: 1 } },
      },
    },
  },
} satisfies Prisma.ProjectMemberMovementInclude;
const time = (value: Date | null | undefined) => (value ? projectTime(value) : null);

export async function listMovements(
  db: PrismaClient,
  q: MovementQuery,
  p: AuthPrincipal,
  now = new Date(),
) {
  const id = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647;
  const choices = (v: unknown, options: string[], max: number) =>
    v == null || (Array.isArray(v) && v.length <= max && v.every((x) => options.includes(x)));
  if (
    !id(q.projectId) ||
    (q.memberId != null && !id(q.memberId)) ||
    (q.movementId != null && !id(q.movementId)) ||
    !id(q.current ?? 1) ||
    !id(q.size ?? 20) ||
    (q.size ?? 20) > 100 ||
    !choices(q.movementTypes, ['REMOVAL', 'TRANSFER'], 2) ||
    !choices(q.statuses, Object.keys(movementStatusNames), 5) ||
    (q.keyword != null && (typeof q.keyword !== 'string' || q.keyword.length > 100))
  )
    throw new AuthError(400, 'VALIDATION_ERROR', '人员变动筛选或分页格式不正确');
  const start = q.createdStartAt == null ? undefined : parseProjectTime(q.createdStartAt);
  const end = q.createdEndAt == null ? undefined : parseProjectTime(q.createdEndAt);
  if (start && end && start > end) throw new AuthError(400, 'VALIDATION_ERROR', '发起时间区间倒置');
  if (!['PM', 'EXPERT'].includes(p.role))
    throw new AuthError(403, 'FORBIDDEN', '请切换至PM或EXPERT角色');
  return db.$transaction(
    async (tx) => {
      const scope = await personnelScope(tx, q.projectId, p).catch((error) => {
        if (error instanceof AuthError && error.status === 403)
          return { organizationIds: [] as string[], readOnly: false };
        throw error;
      });
      const visibility: Prisma.ProjectMemberMovementWhereInput[] = [
        { userId: p.userId },
        // 历史参与保留读取；组织参与人离组后不能凭旧节点读取他人记录。
        {
          flow: {
            nodes: {
              some: {
                approverId: p.userId,
                nodeCode: p.role === 'PM' ? 'TARGET_MANAGER' : { not: 'TARGET_MANAGER' },
              },
            },
          },
          ...(p.role === 'EXPERT'
            ? {
                member: {
                  organization: {
                    deleted: false,
                    memberships: {
                      some: { userId: p.userId, joinStatus: { in: participatingStatuses } },
                    },
                  },
                },
              }
            : {}),
        },
        ...(scope.organizationIds?.length
          ? [{ member: { organizationId: { in: scope.organizationIds } } }]
          : []),
      ];
      const keyword = q.keyword?.trim();
      const where: Prisma.ProjectMemberMovementWhereInput = {
        AND: [
          { OR: [{ sourceProjectId: q.projectId }, { targetProjectId: q.projectId }] },
          ...(scope.organizationIds === null ? [] : [{ OR: visibility }]),
        ],
        ...(q.memberId != null ? { memberId: q.memberId, sourceProjectId: q.projectId } : {}),
        ...(q.movementId != null ? { id: q.movementId } : {}),
        ...(q.movementTypes?.length ? { movementType: { in: q.movementTypes } } : {}),
        ...(q.statuses?.length ? { status: { in: q.statuses } } : {}),
        ...(start || end ? { createdAt: { gte: start, lte: end } } : {}),
        ...(keyword
          ? {
              member: {
                user: {
                  OR: ['displayName', 'realName', 'uid'].map((field) => ({
                    [field]: { contains: keyword },
                  })),
                },
              },
            }
          : {}),
      };
      const current = q.current ?? 1,
        size = q.size ?? 20;
      const total = await tx.projectMemberMovement.count({ where });
      const rows = await tx.projectMemberMovement.findMany({
        where,
        include: queryInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (current - 1) * size,
        take: size,
      });
      const records = [];
      for (const m of rows) {
        const allowedActions: string[] = [];
        if (!scope.readOnly) {
          if (
            m.initiatedBy === p.userId &&
            m.sourceProjectId === q.projectId &&
            (scope.organizationIds === null ||
              scope.organizationIds.includes(m.member.organizationId!)) &&
            (m.movementType === 'TRANSFER'
              ? m.status === 'PROCESSING' && m.flow?.status === 'PENDING'
              : m.status === 'WAITING_EFFECTIVE' &&
                m.plannedEffectiveDate.toISOString().slice(0, 10) > todayText(now))
          )
            allowedActions.push('WITHDRAW');
          const flow = m.flow,
            code = flow?.currentNodeCode;
          if (code && m.status === 'PROCESSING' && flow?.status === 'PENDING') {
            const node = flow.nodes.find(
              (n) =>
                n.nodeSeq === flow.currentNode &&
                n.nodeStatus === 'PENDING' &&
                n.approverId === p.userId,
            );
            if (node && p.role === (code === 'TARGET_MANAGER' ? 'PM' : 'EXPERT')) {
              try {
                await requireTransferStage(tx, m, code);
                if (code !== 'SOURCE_ORG_OWNER' && isManualTransferStep(code))
                  requireTransferPassed(m);
                const approvers = await currentApprovers(tx, m, code);
                if (approvers.some((u) => u.id === p.userId)) {
                  if (isManualTransferStep(code)) allowedActions.push('APPROVE', 'REJECT');
                  else if (code === 'MEMBER_CONFIRM')
                    allowedActions.push('ACCEPT_TRANSFER', 'REJECT_TRANSFER');
                  else if (!m.targetExamAttempt?.submittedAt && !m.targetExamAttempt?.cancelledAt)
                    allowedActions.push('TAKE_TARGET_EXAM');
                }
              } catch (error) {
                if (!(error instanceof AuthError && [403, 409].includes(error.status))) throw error;
              }
            }
          }
        }
        const u = m.member.user,
          exam = m.targetExamAttempt;
        records.push({
          movementId: m.id,
          movementNo: m.movementNo,
          movementType: m.movementType,
          status: m.status,
          statusName: movementStatusNames[m.status] ?? m.status,
          memberId: m.memberId,
          userId: m.userId,
          uid: u.uid,
          displayName: displayName(u.displayName, u.realName, u.uid),
          accountType: m.member.organizationId ? 'ORGANIZATION' : 'INDIVIDUAL',
          organizationId: m.member.organizationId,
          organizationName: m.member.organization?.deleted
            ? null
            : (m.member.organization?.name ?? null),
          sourceProjectId: m.sourceProjectId,
          sourceProjectName: m.member.project.projectName,
          targetProjectId: m.targetProjectId,
          targetProjectName: m.targetProject?.projectName ?? null,
          reason: m.reason,
          plannedEffectiveDate: m.plannedEffectiveDate.toISOString().slice(0, 10),
          initiatedBy: m.initiatedBy,
          initiatorName: displayName(
            m.initiator.displayName,
            m.initiator.realName,
            m.initiator.uid,
          ),
          initiatedAt: time(m.createdAt),
          effectiveAt: time(m.effectiveAt),
          rejectedAt: time(m.rejectedAt),
          withdrawnAt: time(m.withdrawnAt),
          examAttemptId: m.targetExamAttemptId,
          examStatus: exam?.submittedAt ? exam.finalResult : null,
          examSubmittedAt: time(exam?.submittedAt),
          examCancelledAt: time(exam?.cancelledAt),
          flowNo: m.flow?.flowNo ?? null,
          flowStatus: m.flow?.status ?? null,
          flowVersionNo: m.flow?.versionNo ?? null,
          currentNode: m.flow?.currentNode ?? null,
          approvalSteps: (m.flow?.nodes ?? []).map((n) => {
            const a = n.actions[0];
            return {
              nodeId: n.id,
              nodeSeq: n.nodeSeq,
              nodeCode: n.nodeCode,
              nodeName: n.nodeName,
              nodeStatus: n.nodeStatus,
              operatorId: a?.operatorId ?? null,
              operatorName: a?.operatorName ?? null,
              action: a?.actionType ?? null,
              actionComment: a?.actionComment ?? null,
              actionAt: time(a?.createdAt),
              nodeVersionNo: n.versionNo,
            };
          }),
          allowedActions,
        });
      }
      return { total, current, size, pages: Math.ceil(total / size), records };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
export async function movementDetail(db: PrismaClient, q: MovementDetailQuery, p: AuthPrincipal) {
  if (q.memberId == null) throw new AuthError(400, 'VALIDATION_ERROR', 'memberId必填');
  const result = await listMovements(
    db,
    { projectId: q.projectId, memberId: q.memberId, size: 1 },
    p,
  );
  if (!result.records.length) throw new AuthError(404, 'NOT_FOUND', '人员变动记录不存在或无权查看');
  return result.records[0]!;
}
