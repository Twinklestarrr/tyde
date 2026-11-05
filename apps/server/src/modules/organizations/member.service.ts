import { Prisma, type PrismaClient, type UserOrgRel } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { businessDate } from './member.domain.js';
import {
  type MemberPositionInput,
  type MemberQuery,
  type MemberUpdateInput,
} from './member.types.js';
import { participatingStatuses } from './organization.domain.js';
import { lockOrganization } from './organization.repository.js';

const invalid = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);

const conflict = (message = '成员资料已被更新，请刷新后重试') =>
  new AppError(409, 'DUPLICATE', message);

function dateFilter(start?: string | null, end?: string | null) {
  const from = start ? businessDate(start, true) : undefined;
  const to = end ? businessDate(end, true) : undefined;
  if (from && to && from > to) throw invalid('日期范围起点不能晚于终点');
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}),
  };
}

export class MemberService {
  constructor(readonly db: PrismaClient) {}
  async list(input: MemberQuery, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        await this.manager(tx, input.orgId, principal.userId);
        await this.organization(tx, input.orgId);
        const joinedAt = dateFilter(input.joinedStartDate, input.joinedEndDate);
        const leftAt = dateFilter(input.leftStartDate, input.leftEndDate);
        if (
          input.projectId != null &&
          (!Number.isInteger(input.projectId) ||
            input.projectId < -2147483648 ||
            input.projectId > 2147483647)
        )
          throw invalid('projectId必须为32位整数');
        const current = input.current ?? 1,
          size = input.size ?? 20;
        const keyword = input.keyword?.trim();
        const where: Prisma.UserOrgRelWhereInput = {
          orgId: input.orgId,
          ...(input.projectId != null
            ? { projectMembers: { some: { projectId: input.projectId, status: 'ACTIVE' } } }
            : {}),
          ...(input.employmentType ? { employmentType: input.employmentType } : {}),
          ...(input.position ? { position: input.position } : {}),
          ...(input.joinStatus ? { joinStatus: input.joinStatus } : {}),
          ...(Object.keys(joinedAt).length ? { joinedAt } : {}),
          ...(Object.keys(leftAt).length ? { leftAt } : {}),
          ...(keyword
            ? {
                user: {
                  OR: [
                    { realName: { contains: keyword } },
                    { uid: { contains: keyword } },
                    { phoneE164: `+86${keyword}` },
                  ],
                },
              }
            : {}),
        };
        const total = await tx.userOrgRel.count({ where });
        const offset = (current - 1) * size;
        const rows =
          offset >= total
            ? []
            : await tx.userOrgRel.findMany({
                where,
                include: { user: true },
                orderBy: [{ joinedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
                skip: offset,
                take: size,
              });
        // 只统计当前页关系，保持固定查询次数；不把项目筛选带入全量在项数统计。
        // 沿旧SQL COUNT(*)口径，不按projectId去重，不过滤projectRole/项目状态/删除。
        const projectCounts = rows.length
          ? await tx.projectMember.groupBy({
              by: ['userOrgRelId'],
              where: { userOrgRelId: { in: rows.map((rel) => rel.id) }, status: 'ACTIVE' },
              _count: { _all: true },
            })
          : [];
        const countByRelation = new Map(
          projectCounts.map((group) => [group.userOrgRelId, group._count._all]),
        );
        return {
          total,
          pages: Math.ceil(total / size),
          current,
          size,
          records: rows.map((rel) => ({
            memberId: rel.id,
            userId: rel.userId,
            uid: rel.uid,
            realName: rel.user.realName,
            nickname: rel.user.displayName,
            phoneMasked: /^\+86\d{11}$/.test(rel.user.phoneE164)
              ? rel.user.phoneE164.slice(3).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
              : '****',
            avatarUrl: rel.user.avatarUrl,
            userStatus: rel.user.status,
            employmentType: rel.employmentType,
            position: rel.position,
            joinStatus: rel.joinStatus,
            joinedAt: rel.joinedAt?.toISOString() ?? null,
            plannedLeaveDate: rel.plannedLeaveDate?.toISOString().slice(0, 10) ?? null,
            leftAt: rel.leftAt?.toISOString() ?? null,
            activeProjectCount: countByRelation.get(rel.id) ?? 0,
            versionNo: rel.versionNo,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async update(input: MemberUpdateInput, principal: AuthPrincipal) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const actor = await this.manager(tx, input.orgId, principal.userId);
      await this.organization(tx, input.orgId);
      if (input.joinedAt == null && input.employmentType == null)
        throw invalid('joinedAt和employmentType至少填写一项');
      const joinedAt = input.joinedAt != null ? businessDate(input.joinedAt) : undefined;
      if (joinedAt && joinedAt > new Date()) throw invalid('入组时间不得晚于当前时间');
      const target = await this.member(tx, input.orgId, input.memberId);
      if (actor.position === 'ADMIN' && target.position !== 'MEMBER' && target.id !== actor.id)
        throw new AppError(403, 'FORBIDDEN', '管理员只能编辑普通成员或自己');
      const updated = await tx.userOrgRel.updateMany({
        where: { id: target.id, orgId: input.orgId, versionNo: input.versionNo },
        data: {
          ...(joinedAt ? { joinedAt } : {}),
          ...(input.employmentType != null ? { employmentType: input.employmentType } : {}),
          versionNo: { increment: 1 },
          updatedBy: principal.uid,
          updatedAt: new Date(),
        },
      });
      if (updated.count !== 1) throw conflict();
      const rel = await this.member(tx, input.orgId, input.memberId);
      return {
        memberId: rel.id,
        userId: rel.userId,
        joinedAt: rel.joinedAt?.toISOString() ?? null,
        employmentType: rel.employmentType,
        versionNo: rel.versionNo,
        updatedAt: rel.updatedAt.toISOString(),
      };
    });
  }
  async position(input: MemberPositionInput, principal: AuthPrincipal) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, input.orgId);
      const actor = await this.manager(tx, input.orgId, principal.userId);
      await this.organization(tx, input.orgId);
      const target = await this.member(tx, input.orgId, input.memberId);
      if (target.joinStatus !== 'ACTIVE') throw invalid('仅在职成员可以变更组织角色');
      if (actor.position === 'ADMIN') {
        if (input.position === 'OWNER')
          throw new AppError(403, 'FORBIDDEN', '管理员不能变更主管角色');
        if (target.id !== actor.id && target.position !== 'MEMBER')
          throw new AppError(403, 'FORBIDDEN', '管理员只能变更普通成员或自己的角色');
      } else {
        const owner = await tx.userOrgRel.findFirst({
          where: { orgId: input.orgId, position: 'OWNER', joinStatus: 'ACTIVE' },
          orderBy: { id: 'asc' },
        });
        if (!owner || owner.id !== actor.id) throw conflict('组织主管已发生变化，请刷新后重试');
      }
      const beforePosition = target.position;
      if (beforePosition === input.position) return this.positionResponse(target, beforePosition);
      if (actor.position === 'OWNER' && target.id === actor.id)
        throw invalid('主管不能直接降低自己的角色，请先将主管转让给其他成员');
      const addsAdmin =
        (input.position === 'ADMIN' && beforePosition !== 'ADMIN') ||
        (input.position === 'OWNER' && beforePosition !== 'ADMIN');
      if (addsAdmin) {
        const count = await tx.userOrgRel.count({
          where: {
            orgId: input.orgId,
            position: 'ADMIN',
            joinStatus: { in: ['PENDING', 'PENDING_ACTIVATION', ...participatingStatuses] },
          },
        });
        if (count >= 5) throw invalid('每个组织最多5名管理员');
      }
      if (input.position === 'OWNER') await this.writePosition(tx, actor, 'ADMIN', principal.uid);
      const updated = await this.writePosition(tx, target, input.position, principal.uid);
      return this.positionResponse(updated, beforePosition);
    });
  }
  private positionResponse(rel: UserOrgRel, beforePosition: string) {
    return {
      memberId: rel.id,
      beforePosition,
      position: rel.position,
      updatedAt: rel.updatedAt.toISOString(),
    };
  }
  private writePosition(
    tx: Prisma.TransactionClient,
    rel: UserOrgRel,
    position: string,
    uid: string,
  ) {
    return tx.userOrgRel.update({
      where: { id: rel.id },
      data: { position, versionNo: { increment: 1 }, updatedBy: uid, updatedAt: new Date() },
    });
  }
  private async manager(tx: Prisma.TransactionClient, orgId: string, userId: string) {
    const rel = await tx.userOrgRel.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (!rel || !participatingStatuses.includes(rel.joinStatus))
      throw new AppError(403, 'FORBIDDEN', '当前用户不属于该组织');
    if (!['OWNER', 'ADMIN'].includes(rel.position))
      throw new AppError(403, 'FORBIDDEN', '仅组织主管或管理员可管理组织人员');
    return rel;
  }
  private async organization(tx: Prisma.TransactionClient, orgId: string) {
    if (!(await tx.organization.findFirst({ where: { id: orgId, deleted: false } })))
      throw new AppError(404, 'NOT_FOUND', '组织不存在');
  }
  private async member(tx: Prisma.TransactionClient, orgId: string, memberId: string) {
    const rel = await tx.userOrgRel.findFirst({ where: { id: memberId, orgId } });
    if (!rel) throw new AppError(404, 'NOT_FOUND', '组织成员不存在');
    return rel;
  }
}
