import { Prisma, type ApprovalFlow, type ApprovalNode, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors.js';
import {
  appendAction,
  approvalConflict,
  finishPending,
  lockFlow,
} from '../approval/approval.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { shanghaiDay } from '../organizations/departure.service.js';
import type { ProcessInput } from '../organizations/organization-approval.types.js';
import { participatingStatuses } from '../organizations/organization.domain.js';
import { lockOrganization } from '../organizations/organization.repository.js';
import { displayName } from '../projects/project-detail.js';
import {
  applicationConflict,
  assertDailySnapshot,
  attendanceApplicationResult,
  attendanceBusinessId,
  attendanceBusinessTypes,
  isAttendanceBusiness,
  newDailyAutoStatus,
  readAttendanceForm,
  validateApplication,
  validateLeaveSchedule,
  type AttendanceApplyInput,
} from './attendance-application.domain.js';
import { invalid, parseDate } from './attendance.domain.js';
export class AttendanceApplicationService {
  constructor(readonly db: PrismaClient) {}
  private async scope(tx: Prisma.TransactionClient, orgId: string, userId: string) {
    const org = await tx.organization.findFirst({ where: { id: orgId, deleted: false } });
    if (!org) throw new AppError(404, 'NOT_FOUND', '组织不存在');
    const rel = await tx.userOrgRel.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { user: true },
    });
    if (!rel || !participatingStatuses.includes(rel.joinStatus) || rel.user.status !== 'ACTIVE')
      throw new AppError(403, 'FORBIDDEN', '申请人不是该组织有效成员');
    return { org, rel };
  }
  private async day(tx: Prisma.TransactionClient, orgId: string, userId: string, date: string) {
    const attendanceDate = parseDate(date);
    // 组织锁为无日考勤时的插入提供串行化；日考勤与排班额外锁行，防止后续计算器覆盖。
    await tx.$queryRaw`SELECT "id" FROM "OrgMemberSchedule" WHERE "scopeKey"=${orgId} AND "userId"=${userId}::uuid AND "scheduleDate"=${date}::date FOR UPDATE`;
    const schedule = await tx.orgMemberSchedule.findUnique({
      where: {
        scopeKey_userId_scheduleDate: { scopeKey: orgId, userId, scheduleDate: attendanceDate },
      },
    });
    await tx.$queryRaw`SELECT "id" FROM "OrgAttendanceDaily" WHERE "scopeKey"=${orgId} AND "userId"=${userId}::uuid AND "attendanceDate"=${date}::date FOR UPDATE`;
    const daily = await tx.orgAttendanceDaily.findUnique({
      where: { scopeKey_userId_attendanceDate: { scopeKey: orgId, userId, attendanceDate } },
    });
    return { schedule, daily, attendanceDate };
  }
  async apply(input: AttendanceApplyInput, principal: AuthPrincipal) {
    const today = shanghaiDay(new Date());
    validateApplication(input, today);
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const { org, rel } = await this.scope(tx, input.orgId, principal.userId);
      if (!['MEMBER', 'ADMIN'].includes(rel.position))
        throw new AppError(403, 'FORBIDDEN', '组织主管本人请使用获授权的直接变更接口');
      const businessId = attendanceBusinessId(principal.userId, input.attendanceDate);
      if (
        await tx.approvalFlow.findFirst({
          where: {
            applicantOrgId: input.orgId,
            applicantId: principal.userId,
            businessId,
            businessType: { in: attendanceBusinessTypes },
            status: 'PENDING',
          },
        })
      )
        throw applicationConflict('当日已有待审批考勤申请，请先处理或撤回');
      const { daily, schedule } = await this.day(
        tx,
        input.orgId,
        principal.userId,
        input.attendanceDate,
      );
      assertDailySnapshot(daily, input);
      if (!daily && (!schedule || schedule.status !== 'ACTIVE' || schedule.dayType !== 'WORK'))
        throw invalid('没有可申请修正的日考勤或工作排班');
      validateLeaveSchedule(input, schedule);
      if (input.applicationType === 'LEAVE' && daily?.finalStatus === 'LEAVE')
        throw applicationConflict('当日已为请假状态，不能重复申请');
      const owner = await tx.userOrgRel.findFirst({
        where: {
          orgId: input.orgId,
          position: 'OWNER',
          joinStatus: 'ACTIVE',
          user: { status: 'ACTIVE' },
        },
        include: { user: true },
        orderBy: { id: 'asc' },
      });
      if (!owner || owner.userId === principal.userId)
        throw applicationConflict('组织未配置可用的其他主管审批人');
      const name = displayName(rel.user.displayName, rel.user.realName, principal.uid);
      const now = new Date(),
        flowNo = `ATA${randomUUID().replaceAll('-', '').toUpperCase()}`;
      const businessType = `ATTENDANCE_${input.applicationType}`;
      const snapshot = {
        schemaVersion: 1,
        orgId: input.orgId,
        attendanceDate: input.attendanceDate,
        applicationType: input.applicationType,
        finalStatus: input.finalStatus,
        reason: input.reason.trim(),
        versionNo: input.versionNo,
        dailyId: daily?.id ?? null,
        scheduleId: schedule?.id ?? null,
        scheduleVersionNo: schedule?.versionNo ?? null,
        targetMemberId: rel.id,
        targetMemberName: name,
        timezone: schedule?.timezone ?? 'Asia/Shanghai',
        leaveStartAt: input.leaveStartAt ?? null,
        leaveEndAt: input.leaveEndAt ?? null,
      };
      const flow = await tx.approvalFlow.create({
        data: {
          flowNo,
          processCode: businessType,
          businessType,
          businessId,
          title: `${name}${input.applicationType === 'LEAVE' ? '请假' : '考勤修正'}申请`,
          applicantId: principal.userId,
          applicantName: name,
          applicantOrgId: org.id,
          applicantOrgName: org.name,
          formData: snapshot,
          applyReason: input.reason.trim(),
          status: 'PENDING',
          currentNode: 1,
          currentNodeCode: 'OWNER_APPROVAL',
          totalNodes: 1,
          appliedAt: now,
          createdBy: principal.uid,
          updatedBy: principal.uid,
          beforeData: {
            dailyId: daily?.id ?? null,
            dailyVersionNo: daily?.versionNo ?? null,
            finalStatus: daily?.finalStatus ?? null,
            manualRemark: daily?.manualRemark ?? null,
            scheduleId: schedule?.id ?? null,
            scheduleVersionNo: schedule?.versionNo ?? null,
          },
        },
      });
      await tx.approvalNode.create({
        data: {
          flowId: flow.id,
          flowNo,
          nodeSeq: 1,
          nodeCode: 'OWNER_APPROVAL',
          nodeName: '组织主管审批',
          approverId: owner.userId,
          approverUid: owner.uid,
          approverName: displayName(owner.user.displayName, owner.user.realName, owner.uid),
          approverType: 'ORG_LEADER',
          nodeStatus: 'PENDING',
          createdBy: principal.uid,
          updatedBy: principal.uid,
        },
      });
      await appendAction(tx, {
        flowId: flow.id,
        actionType: 'SUBMIT',
        operatorId: principal.userId,
        operatorName: name,
        fromStatus: null,
        toStatus: 'PENDING',
        actionComment: input.reason.trim(),
        createdAt: now,
      });
      return attendanceApplicationResult(flow);
    });
  }
  async withdraw(
    input: { applicationId: string; flowVersionNo: number },
    principal: AuthPrincipal,
  ) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.approvalFlow.findUnique({ where: { id: input.applicationId } });
      if (!initial) throw new AppError(404, 'NOT_FOUND', '申请不存在');
      if (initial.applicantId !== principal.userId)
        throw new AppError(403, 'FORBIDDEN', '只能撤回本人申请');
      if (!isAttendanceBusiness(initial.businessType)) throw invalid('本接口仅支持撤回考勤申请');
      if (!initial.applicantOrgId) throw invalid('考勤申请缺少所属组织');
      await lockOrganization(tx, initial.applicantOrgId);
      const flow = await lockFlow(tx, initial.flowNo);
      if (flow.status !== 'PENDING' || flow.versionNo !== input.flowVersionNo)
        throw approvalConflict();
      if (flow.applicantId !== principal.userId || flow.id !== input.applicationId)
        throw new AppError(403, 'FORBIDDEN', '只能撤回本人申请');
      readAttendanceForm(flow);
      await tx.$queryRaw`SELECT "id" FROM "ApprovalNode" WHERE "flowId"=${flow.id}::uuid ORDER BY "id" FOR UPDATE`;
      const nodes = await tx.approvalNode.findMany({ where: { flowId: flow.id } });
      if (
        nodes.length !== 1 ||
        nodes[0]!.nodeStatus !== 'PENDING' ||
        flow.currentNode !== 1 ||
        flow.totalNodes !== 1
      )
        throw approvalConflict();
      const now = new Date();
      const changed = await tx.approvalFlow.updateMany({
        where: { id: flow.id, status: 'PENDING', versionNo: input.flowVersionNo },
        data: {
          status: 'WITHDRAWN',
          currentNode: null,
          currentNodeCode: null,
          finishedAt: now,
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
        },
      });
      if (changed.count !== 1) throw approvalConflict();
      const canceled = await tx.approvalNode.updateMany({
        where: { id: nodes[0]!.id, versionNo: nodes[0]!.versionNo, nodeStatus: 'PENDING' },
        data: { nodeStatus: 'CANCELED', versionNo: { increment: 1 }, updatedBy: principal.uid },
      });
      if (canceled.count !== 1) throw approvalConflict();
      await appendAction(tx, {
        flowId: flow.id,
        nodeId: nodes[0]!.id,
        actionType: 'WITHDRAW',
        operatorId: principal.userId,
        operatorName: flow.applicantName,
        fromStatus: 'PENDING',
        toStatus: 'WITHDRAWN',
        createdAt: now,
      });
      // 离组后仍可撤回本人待审申请；撤回不写考勤，不恢复任何组织身份。
      return attendanceApplicationResult({
        ...flow,
        status: 'WITHDRAWN',
        versionNo: flow.versionNo + 1,
        finishedAt: now,
      });
    });
  }
  /** 由既有组织审批入口在组织→流程→节点锁与双版本/实际主管校验后调用，不嵌套事务。 */
  async process(
    tx: Prisma.TransactionClient,
    flow: ApprovalFlow,
    node: ApprovalNode,
    input: ProcessInput,
    principal: AuthPrincipal,
  ) {
    if (flow.applicantId === principal.userId)
      throw new AppError(403, 'FORBIDDEN', '不能审批本人的考勤申请');
    const form = readAttendanceForm(flow),
      now = new Date();
    const status = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    let dailyId: number | null = null,
      dailyVersionNo: number | null = null,
      finalStatus: string | null = null,
      adjustmentId: number | null = null;
    if (status === 'APPROVED') {
      const { rel } = await this.scope(tx, input.orgId, flow.applicantId);
      if (rel.id !== form.targetMemberId) throw applicationConflict('申请人的组织关系已变化');
      const { daily, schedule, attendanceDate } = await this.day(
        tx,
        input.orgId,
        flow.applicantId,
        form.attendanceDate,
      );
      assertDailySnapshot(daily, form);
      if (
        (schedule?.id ?? null) !== form.scheduleId ||
        (schedule?.versionNo ?? null) !== form.scheduleVersionNo
      )
        throw applicationConflict('申请后排班已变化，请撤回后重新申请');
      validateApplication(form, shanghaiDay(now));
      validateLeaveSchedule(form, schedule);
      if (!daily && (!schedule || schedule.status !== 'ACTIVE' || schedule.dayType !== 'WORK'))
        throw applicationConflict('申请所依据的工作排班已失效');
      if (daily) {
        const changed = await tx.orgAttendanceDaily.updateMany({
          where: { id: daily.id, versionNo: form.versionNo! },
          data: {
            finalStatus: form.finalStatus,
            manualOverride: true,
            manualRemark: flow.applyReason,
            correctedBy: principal.uid,
            correctedAt: now,
            updatedBy: principal.uid,
            versionNo: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw applicationConflict();
        dailyId = daily.id;
        dailyVersionNo = daily.versionNo + 1;
      } else {
        const created = await tx.orgAttendanceDaily.create({
          data: {
            scopeKey: input.orgId,
            orgId: input.orgId,
            userOrgRelId: rel.id,
            userId: flow.applicantId,
            attendanceDate,
            scheduleId: schedule!.id,
            expectedStartAt: schedule!.shiftStartAt,
            expectedEndAt: schedule!.shiftEndAt,
            autoStatus: newDailyAutoStatus(form.attendanceDate, shanghaiDay(now), schedule),
            finalStatus: form.finalStatus,
            manualOverride: true,
            manualRemark: flow.applyReason,
            correctedBy: principal.uid,
            correctedAt: now,
            createdBy: principal.uid,
            updatedBy: principal.uid,
          },
        });
        dailyId = created.id;
        dailyVersionNo = created.versionNo;
      }
      const operator = await tx.user.findUniqueOrThrow({ where: { id: principal.userId } });
      const audit = await tx.orgAttendanceAdjustment.create({
        data: {
          attendanceDailyId: dailyId!,
          beforeStatus: daily?.finalStatus ?? null,
          afterStatus: form.finalStatus,
          beforeRemark: daily?.manualRemark ?? null,
          afterRemark: flow.applyReason,
          reason: flow.applyReason ?? '',
          operatorUserId: principal.userId,
          operatorName: displayName(operator.displayName, operator.realName, principal.uid),
          createdBy: principal.uid,
          createdAt: now,
        },
      });
      adjustmentId = audit.id;
      finalStatus = form.finalStatus;
      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: { afterData: { dailyId, dailyVersionNo, finalStatus, adjustmentId } },
      });
    }
    const changedNode = await tx.approvalNode.updateMany({
      where: { id: node.id, nodeStatus: 'PENDING', versionNo: input.nodeVersionNo },
      data: {
        nodeStatus: status,
        approvedAt: now,
        approveComment: input.actionComment?.trim() || null,
        versionNo: { increment: 1 },
        updatedBy: principal.uid,
      },
    });
    if (changedNode.count !== 1) throw approvalConflict();
    await finishPending(tx, flow.id, input.flowVersionNo, status, principal.uid, now);
    await appendAction(tx, {
      flowId: flow.id,
      nodeId: node.id,
      actionType: input.action,
      operatorId: principal.userId,
      operatorName: node.approverName || principal.uid,
      fromStatus: 'PENDING',
      toStatus: status,
      actionComment: input.actionComment?.trim() || null,
      createdAt: now,
    });
    return {
      flowNo: flow.flowNo,
      nodeId: node.id,
      action: input.action,
      nodeStatus: status,
      flowStatus: status,
      currentNode: null,
      joinStatus: null,
      plannedLeaveDate: null,
      applicationId: flow.id,
      flowVersionNo: flow.versionNo + 1,
      businessType: flow.businessType,
      attendanceDate: form.attendanceDate,
      dailyId,
      dailyVersionNo,
      finalStatus,
      adjustmentId,
      processedAt: now.toISOString(),
      finishedAt: now.toISOString(),
    };
  }
}
