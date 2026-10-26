import type { Prisma, PrismaClient } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import type { FileRegistryService } from '../files/file-registry.service.js';

export const participatingStatuses = ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'];
export interface OrganizationUpdateInput {
  orgId: string;
  description?: string | null;
  logoUrl?: string | null;
  logoUploadToken?: string | null;
}

// 后续成员写操作亦须先锁组织，再检查关系，统一组织内角色/人数/权限变更的锁顺序。
export async function lockOrganization(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`;
}

export class OrganizationService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}

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
      throw new AuthError(400, 'BAD_REQUEST', 'logoUploadToken必须与logoUrl一起提交');
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const membership = await this.requireManager(tx, input.orgId, principal.userId, true);
      if (membership.position !== 'OWNER')
        throw new AuthError(403, 'FORBIDDEN', '仅组织主管可编辑组织基本资料');
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
      throw new AuthError(403, 'FORBIDDEN', '当前用户不属于该组织');
    if (!['OWNER', 'ADMIN'].includes(membership.position))
      throw new AuthError(403, 'FORBIDDEN', '仅组织主管或管理员可查看组织工作台');
    return membership;
  }

  private async requireOrganization(tx: Prisma.TransactionClient, orgId: string) {
    const organization = await tx.organization.findFirst({ where: { id: orgId, deleted: false } });
    if (!organization) throw new AuthError(404, 'NOT_FOUND', '组织不存在');
    return organization;
  }
}
