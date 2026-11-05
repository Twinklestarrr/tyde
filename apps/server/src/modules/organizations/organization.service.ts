import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import { participatingStatuses } from './organization.domain.js';
import { lockOrganization } from './organization.repository.js';
import { type OrganizationUpdateInput } from './organization.types.js';

export class OrganizationService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}

  async overview(orgId: string, principal: AuthPrincipal, now = new Date()) {
    return this.db.$transaction(
      async (tx) => {
        await this.requireManager(tx, orgId, principal.userId);
        await this.requireOrganization(tx, orgId);
        // date列使用UTC午夜承载上海业务日期，不依赖数据库会话时区。
        const today = new Date(new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10));
        const memberTotal = await tx.userOrgRel.count({
          where: { orgId, joinStatus: { in: ['PENDING_ACTIVATION', ...participatingStatuses] } },
        });
        const activeProjectMemberTotal = await tx.projectMember.count({
          where: { status: 'ACTIVE', organizationMembership: { orgId } },
        });
        const todayScheduledTotal = await tx.orgMemberSchedule.count({
          where: { orgId, scheduleDate: today, status: 'ACTIVE', dayType: 'WORK' },
        });
        const todayPresentTotal = await tx.orgAttendanceDaily.count({
          where: { orgId, attendanceDate: today, finalStatus: 'PRESENT' },
        });
        const pendingApprovalTotal = await tx.approvalNode.count({
          where: {
            approverId: principal.userId,
            nodeStatus: 'PENDING',
            flow: { applicantOrgId: orgId, status: 'PENDING' },
          },
        });
        return {
          orgId,
          memberTotal,
          activeProjectMemberTotal,
          todayScheduledTotal,
          todayPresentTotal,
          pendingApprovalTotal,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async detail(orgId: string, principal: AuthPrincipal) {
    return this.db.$transaction(async (tx) => {
      const membership = await this.requireManager(tx, orgId, principal.userId);
      const organization = await this.requireOrganization(tx, orgId);
      return {
        id: organization.id,
        name: organization.name,
        unifiedCreditCode: organization.unifiedCreditCode,
        description: organization.description,
        businessLicenseUrl: organization.businessLicenseKey,
        logoUrl: organization.logoUrl,
        expertiseTags: organization.expertiseTags.map((tag) => tag.trim()).filter(Boolean),
        verifyStatus: organization.verifyStatus,
        status: organization.status,
        position: membership.position,
        createdAt: organization.createdAt.toISOString(),
      };
    });
  }

  async update(input: OrganizationUpdateInput, principal: AuthPrincipal) {
    if (input.logoUploadToken != null && input.logoUrl == null)
      throw new AppError(400, 'BAD_REQUEST', 'logoUploadToken必须与logoUrl一起提交');
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const membership = await this.requireManager(tx, input.orgId, principal.userId, true);
      if (membership.position !== 'OWNER')
        throw new AppError(403, 'FORBIDDEN', '仅组织主管可编辑组织基本资料');
      await this.requireOrganization(tx, input.orgId);
      const logoUrl =
        input.logoUrl != null
          ? await this.files.syncOrganizationLogo(
              tx,
              input.orgId,
              principal.uid,
              input.logoUrl.trim(),
              input.logoUploadToken,
            )
          : undefined;
      const organization = await tx.organization.update({
        where: { id: input.orgId },
        data: {
          ...(input.description != null ? { description: input.description.trim() } : {}),
          ...(logoUrl !== undefined ? { logoUrl } : {}),
          updatedBy: principal.uid,
          updatedAt: new Date(),
        },
      });
      return {
        id: organization.id,
        description: organization.description,
        logoUrl: organization.logoUrl,
        updatedAt: organization.updatedAt.toISOString(),
      };
    });
  }

  private async requireManager(
    tx: Prisma.TransactionClient,
    orgId: string,
    userId: string,
    activeOnly = false,
  ) {
    const membership = await tx.userOrgRel.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (
      !membership ||
      !(activeOnly ? ['ACTIVE'] : participatingStatuses).includes(membership.joinStatus)
    )
      throw new AppError(403, 'FORBIDDEN', '当前用户不属于该组织');
    if (!['OWNER', 'ADMIN'].includes(membership.position))
      throw new AppError(403, 'FORBIDDEN', '仅组织主管或管理员可查看组织工作台');
    return membership;
  }

  private async requireOrganization(tx: Prisma.TransactionClient, orgId: string) {
    const organization = await tx.organization.findFirst({ where: { id: orgId, deleted: false } });
    if (!organization) throw new AppError(404, 'NOT_FOUND', '组织不存在');
    return organization;
  }
}
