import { AttendanceApplicationService } from '../attendance/attendance-application.service.js';
import { isAttendanceBusiness } from '../attendance/attendance-application.domain.js';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type ApprovalFlow, type User } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import {
  appendAction,
  approvalConflict,
  finishPending,
  lockFlow,
} from '../approval/approval.service.js';
import { lockOrganization, participatingStatuses } from './organization.service.js';
import { businessDate } from './member.service.js';
import { recordDeparture, shanghaiDay } from './departure.service.js';
export interface ExitInput {
  orgId: string;
  memberId?: string | null;
  reason: string;
  plannedLeaveDate: string;
}
export interface ApprovalQuery {
  orgId: string;
  businessType?: string | null;
  current?: number;
  size?: number;
  status?: string | null;
  startAt?: string | null;
  endAt?: string | null;
}
export interface ProcessInput {
  orgId: string;
  flowNo: string;
  nodeId: string;
  flowVersionNo: number;
  nodeVersionNo: number;
  action: 'APPROVE' | 'REJECT';
  actionComment?: string | null;
}
const invalid = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const forbidden = (message: string) => new AuthError(403, 'FORBIDDEN', message);
const malformed = (message: string) => new AuthError(500, 'INVALID_FORM', message);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const displayName = (user: Pick<User, 'displayName' | 'realName' | 'uid'>) =>
  user.displayName?.trim() && user.realName?.trim()
    ? `${user.displayName.trim()}(${user.realName.trim()})`
    : user.displayName?.trim() || user.realName?.trim() || user.uid;
const form = (flow: ApprovalFlow) =>
  (flow.formData && typeof flow.formData === 'object' && !Array.isArray(flow.formData)
    ? flow.formData
    : {}) as Record<string, Prisma.JsonValue>;
export function exitFlowNo(orgId: string, userId: string, key: string) {
  return (
    'OMX' +
    createHash('sha256')
      .update(`${orgId}:${userId}:${key.trim()}`)
      .digest('hex')
      .slice(0, 40)
      .toUpperCase()
  );
}

export class OrganizationApprovalService {
  constructor(readonly db: PrismaClient) {}
  async exit(key: string, input: ExitInput, principal: AuthPrincipal) {
    if (!key.trim() || key.length > 128) throw invalid('Idempotency-Key不能为空且不能超过128字符');
    if (!input.reason.trim()) throw invalid('reason不能为空');
    businessDate(input.plannedLeaveDate, true);
    if (input.plannedLeaveDate < shanghaiDay(new Date()))
      throw invalid('plannedLeaveDate不得早于当前日期');
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const flowNo = exitFlowNo(input.orgId, principal.userId, key);
      const existing = await tx.approvalFlow.findUnique({ where: { flowNo } });
      // 与旧Service相同：按组织+申请人+key复用，不比较新payload；本人离组后仍可取自己的幂等结果。
      if (existing) return this.exitResponse(existing);
      const actor = await this.actor(tx, input.orgId, principal.userId);
      const org = await this.organization(tx, input.orgId);
      const target = await tx.userOrgRel.findFirst({
        where: { id: input.memberId ?? actor.id, orgId: input.orgId },
        include: { user: true },
      });
      if (!target) throw new AuthError(404, 'NOT_FOUND', '组织成员不存在');
      if (target.joinStatus !== 'ACTIVE')
        throw new AuthError(409, 'DUPLICATE', '成员已处于退出或离职流程中');
      if (target.position === 'OWNER') throw invalid('主管退出前必须先转让主管角色');
      const self = target.id === actor.id;
      if (actor.position === 'MEMBER' && !self) throw forbidden('普通成员只能为自己发起退出申请');
      if (actor.position === 'ADMIN' && !self && target.position !== 'MEMBER')
        throw forbidden('管理员只能操作自己或普通成员');
      const applicant = await tx.user.findUniqueOrThrow({ where: { id: principal.userId } });
      const now = new Date();
      const immediate = !self && input.plannedLeaveDate === shanghaiDay(now);
      const joinStatus = self ? 'EXIT_APPROVING' : immediate ? 'LEFT' : 'PENDING_LEAVE';
      const flow = await tx.approvalFlow.create({
        data: {
          flowNo,
          processId: null,
          processCode: 'ORG_MEMBER_EXIT',
          processVersion: 1,
          businessType: 'ORG_MEMBER_EXIT',
          businessId: target.id,
          title: `${displayName(target.user)}退出组织`,
          applicantId: principal.userId,
          applicantName: displayName(applicant),
          applicantOrgId: org.id,
          applicantOrgName: org.name,
          formData: {
            targetMemberId: target.id,
            targetMemberName: displayName(target.user),
            plannedLeaveDate: input.plannedLeaveDate,
            joinStatus,
          },
          applyReason: input.reason.trim(),
          status: self ? 'PENDING' : 'APPROVED',
          currentNode: self ? 1 : null,
          currentNodeCode: self ? 'OWNER_APPROVAL' : null,
          totalNodes: self ? 1 : 0,
          appliedAt: now,
          finishedAt: self ? null : now,
          createdBy: principal.uid,
          updatedBy: principal.uid,
        },
      });
      if (self) {
        const owner = await tx.userOrgRel.findFirst({
          where: { orgId: input.orgId, position: 'OWNER', joinStatus: 'ACTIVE' },
          include: { user: true },
          orderBy: { id: 'asc' },
        });
        if (!owner) throw malformed('组织未配置有效主管，无法发起退出审批');
        await tx.approvalNode.create({
          data: {
            flowId: flow.id,
            flowNo,
            configId: null,
            nodeSeq: 1,
            nodeCode: 'OWNER_APPROVAL',
            nodeName: '组织主管审批',
            approverId: owner.userId,
            approverUid: owner.uid,
            approverName: displayName(owner.user),
            approverType: 'ORG_LEADER',
            nodeStatus: 'PENDING',
            createdBy: principal.uid,
            updatedBy: principal.uid,
          },
        });
      }
      await appendAction(tx, {
        flowId: flow.id,
        actionType: self ? 'SUBMIT' : 'APPROVE',
        operatorId: principal.userId,
        operatorName: displayName(applicant),
        fromStatus: 'ACTIVE',
        toStatus: self ? 'PENDING' : 'APPROVED',
        actionComment: input.reason.trim(),
        createdAt: now,
      });
      const updated = await tx.userOrgRel.update({
        where: { id: target.id },
        data: {
          joinStatus,
          plannedLeaveDate: self ? null : new Date(`${input.plannedLeaveDate}T00:00:00Z`),
          ...(immediate ? { leftAt: now } : {}),
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
          updatedAt: now,
        },
      });
      if (immediate) await recordDeparture(tx, updated, now);
      return this.exitResponse(flow);
    });
  }
  async process(input: ProcessInput, principal: AuthPrincipal) {
    return this.db.$transaction(async (tx) => {
      // 本模块统一顺序：组织→流程→节点→成员；与成员角色写操作共享组织锁。
      await lockOrganization(tx, input.orgId);
      await this.actor(tx, input.orgId, principal.userId, 'OWNER');
      await this.organization(tx, input.orgId);
      const comment = input.actionComment?.trim() || null;
      if (input.action === 'REJECT' && !comment) throw invalid('驳回时actionComment不能为空');
      const flow = await lockFlow(tx, input.flowNo.trim());
      if (flow.applicantOrgId !== input.orgId) throw forbidden('审批流程不属于当前组织');
      if (flow.businessType !== 'ORG_MEMBER_EXIT' && !isAttendanceBusiness(flow.businessType))
        throw invalid('当前接口仅支持组织成员退出、请假及考勤修正审批');
      if (flow.status !== 'PENDING' || flow.versionNo !== input.flowVersionNo)
        throw approvalConflict();
      if (flow.totalNodes !== 1 || flow.currentNode !== 1)
        throw invalid('审批流程单节点配置不正确');
      await tx.$queryRaw`SELECT "id" FROM "ApprovalNode" WHERE "id" = ${input.nodeId}::uuid FOR UPDATE`;
      const node = await tx.approvalNode.findUnique({ where: { id: input.nodeId } });
      if (!node) throw new AuthError(404, 'NOT_FOUND', '审批节点不存在');
      if (node.flowId !== flow.id || node.flowNo !== flow.flowNo)
        throw invalid('审批节点与流程不匹配');
      if (node.approverId !== principal.userId) throw forbidden('当前用户不是该节点审批人');
      if (node.nodeStatus !== 'PENDING' || node.versionNo !== input.nodeVersionNo)
        throw approvalConflict();
      if (node.nodeSeq !== flow.currentNode) throw invalid('审批节点不是流程当前节点');
      if (isAttendanceBusiness(flow.businessType))
        return new AttendanceApplicationService(this.db).process(tx, flow, node, input, principal);
      const snapshot = form(flow);
      if (typeof snapshot.targetMemberId !== 'string' || !uuid.test(snapshot.targetMemberId))
        throw malformed('审批表单targetMemberId不合法');
      if (typeof snapshot.plannedLeaveDate !== 'string')
        throw malformed('审批表单plannedLeaveDate不合法');
      try {
        businessDate(snapshot.plannedLeaveDate, true);
      } catch {
        throw malformed('审批表单plannedLeaveDate不合法');
      }
      const now = new Date();
      const approved = input.action === 'APPROVE';
      const immediate = approved && snapshot.plannedLeaveDate <= shanghaiDay(now);
      const status = approved ? 'APPROVED' : 'REJECTED';
      const nodeUpdated = await tx.approvalNode.updateMany({
        where: { id: node.id, nodeStatus: 'PENDING', versionNo: input.nodeVersionNo },
        data: {
          nodeStatus: status,
          approveComment: comment,
          approvedAt: now,
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
          updatedAt: now,
        },
      });
      if (nodeUpdated.count !== 1) throw approvalConflict();
      await finishPending(tx, flow.id, input.flowVersionNo, status, principal.uid, now);
      const joinStatus = approved ? (immediate ? 'LEFT' : 'PENDING_LEAVE') : 'ACTIVE';
      const plannedLeaveDate = approved ? snapshot.plannedLeaveDate : null;
      const changed = await tx.userOrgRel.updateMany({
        where: { id: snapshot.targetMemberId, orgId: input.orgId, joinStatus: 'EXIT_APPROVING' },
        data: {
          joinStatus,
          plannedLeaveDate: plannedLeaveDate ? new Date(`${plannedLeaveDate}T00:00:00Z`) : null,
          ...(immediate ? { leftAt: now } : {}),
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
          updatedAt: now,
        },
      });
      if (changed.count !== 1)
        throw new AuthError(409, 'DUPLICATE', '成员退出状态已变化，请刷新后重试');
      await appendAction(tx, {
        flowId: flow.id,
        nodeId: node.id,
        actionType: input.action,
        operatorId: principal.userId,
        operatorName: node.approverName || principal.uid,
        fromStatus: 'PENDING',
        toStatus: status,
        actionComment: comment,
        createdAt: now,
      });
      if (immediate)
        await recordDeparture(
          tx,
          await tx.userOrgRel.findUniqueOrThrow({ where: { id: snapshot.targetMemberId } }),
          now,
        );
      return {
        flowNo: flow.flowNo,
        nodeId: node.id,
        action: input.action,
        nodeStatus: status,
        flowStatus: status,
        currentNode: null,
        joinStatus,
        plannedLeaveDate,
        processedAt: now.toISOString(),
        finishedAt: now.toISOString(),
      };
    });
  }
  async pending(query: ApprovalQuery, principal: AuthPrincipal) {
    return this.list(query, principal, true);
  }
  async records(query: ApprovalQuery, principal: AuthPrincipal) {
    return this.list(query, principal, false);
  }
  private async list(query: ApprovalQuery, principal: AuthPrincipal, pending: boolean) {
    return this.db.$transaction(
      async (tx) => {
        await this.actor(tx, query.orgId, principal.userId, 'MANAGER');
        await this.organization(tx, query.orgId);
        const start = !pending && query.startAt ? businessDate(query.startAt) : undefined;
        const end = !pending && query.endAt ? businessDate(query.endAt) : undefined;
        if (start && end && start > end) throw invalid('startAt不能晚于endAt');
        const where: Prisma.ApprovalNodeWhereInput = {
          flow: {
            applicantOrgId: query.orgId,
            AND: [{ businessType: { in: ['ORG_MEMBER_EXIT', 'ATTENDANCE_LEAVE', 'ATTENDANCE_CORRECTION'] } }],
            ...(query.businessType?.trim() ? { businessType: query.businessType.trim() } : {}),
            ...(pending ? { status: 'PENDING' } : {}),
          },
          ...(pending
            ? { approverId: principal.userId, nodeStatus: 'PENDING' }
            : {
                approvedAt: {
                  not: null,
                  ...(start ? { gte: start } : {}),
                  ...(end ? { lte: end } : {}),
                },
                ...(query.status ? { nodeStatus: query.status } : {}),
              }),
        };
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const total = await tx.approvalNode.count({ where });
        const rows =
          (current - 1) * size >= total
            ? []
            : await tx.approvalNode.findMany({
                where,
                include: { flow: true, actions: { orderBy: { id: 'desc' }, take: 1 } },
                orderBy: pending
                  ? [{ flow: { appliedAt: 'asc' } }, { id: 'asc' }]
                  : [{ approvedAt: 'desc' }, { id: 'desc' }],
                skip: (current - 1) * size,
                take: size,
              });
        const ids = rows
          .map((r) => form(r.flow).targetMemberId)
          .filter((id): id is string => typeof id === 'string' && uuid.test(id));
        const targets = await tx.userOrgRel.findMany({
          where: { id: { in: ids }, orgId: query.orgId },
          include: { user: true },
        });
        const people = await tx.user.findMany({
          where: {
            id: {
              in: rows.flatMap((r) => [
                r.flow.applicantId,
                r.actions[0]?.operatorId ?? r.approverId,
              ]),
            },
          },
        });
        const users = new Map(people.map((u) => [u.id, u]));
        const records = rows.map((node) => {
          const flow = node.flow,
            snapshot = form(flow),
            action = node.actions[0];
          const applicant = users.get(flow.applicantId);
          const target = targets.find((rel) => rel.id === snapshot.targetMemberId);
          const common = {
            flowNo: flow.flowNo,
            businessType: flow.businessType,
            businessId: flow.businessId,
            businessNo: flow.businessNo,
            title: flow.title,
            applicantName: applicant ? displayName(applicant) : flow.applicantName,
            applyReason: flow.applyReason,
            targetMemberId:
              typeof snapshot.targetMemberId === 'string' ? snapshot.targetMemberId : null,
            targetMemberName: target
              ? displayName(target.user)
              : typeof snapshot.targetMemberName === 'string'
                ? snapshot.targetMemberName
                : null,
            plannedLeaveDate:
              typeof snapshot.plannedLeaveDate === 'string' ? snapshot.plannedLeaveDate : null,
            appliedAt: flow.appliedAt.toISOString(),
          };
          if (pending)
            return {
              ...common,
              nodeId: node.id,
              nodeVersionNo: node.versionNo,
              nodeName: node.nodeName,
              flowVersionNo: flow.versionNo,
              applicantId: flow.applicantId,
              applicantOrgId: flow.applicantOrgId,
              formData: flow.formData,
              dueAt: node.dueAt?.toISOString() ?? null,
            };
          const operator = users.get(action ? (action.operatorId ?? '') : node.approverId);
          return {
            ...common,
            nodeId: node.id,
            nodeSeq: node.nodeSeq,
            nodeCode: node.nodeCode,
            nodeName: node.nodeName,
            nodeStatus: node.nodeStatus,
            actionType: action?.actionType ?? null,
            operatorName: operator
              ? displayName(operator)
              : (action?.operatorName ?? node.approverName),
            actionComment: action?.actionComment ?? node.approveComment,
            actionAt: (action?.createdAt ?? node.approvedAt)?.toISOString() ?? null,
            applicantOrgName: flow.applicantOrgName,
            flowStatus: flow.status,
            finishedAt: flow.finishedAt?.toISOString() ?? null,
          };
        });
        return { total, pages: Math.ceil(total / size), current, size, records };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  private exitResponse(flow: ApprovalFlow) {
    const snapshot = form(flow);
    return {
      flowNo: flow.flowNo,
      businessType: flow.businessType,
      businessId: flow.businessId,
      flowStatus: flow.status,
      memberId: flow.businessId,
      joinStatus: snapshot.joinStatus ?? null,
      plannedLeaveDate: snapshot.plannedLeaveDate ?? null,
      appliedAt: flow.appliedAt.toISOString(),
    };
  }
  private async actor(
    tx: Prisma.TransactionClient,
    orgId: string,
    userId: string,
    mode?: 'OWNER' | 'MANAGER',
  ) {
    const rel = await tx.userOrgRel.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (!rel || !participatingStatuses.includes(rel.joinStatus))
      throw forbidden('当前用户不属于该组织');
    if (mode === 'OWNER' && rel.position !== 'OWNER') throw forbidden('仅组织主管可处理审批');
    if (mode === 'MANAGER' && !['OWNER', 'ADMIN'].includes(rel.position))
      throw forbidden('仅组织主管或管理员可访问组织审批');
    return rel;
  }
  private async organization(tx: Prisma.TransactionClient, orgId: string) {
    const org = await tx.organization.findFirst({ where: { id: orgId, deleted: false } });
    if (!org) throw new AuthError(404, 'NOT_FOUND', '组织不存在');
    return org;
  }
}
