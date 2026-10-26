import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { projectTime } from '../projects/project-time.js';
import { displayName } from '../projects/project-detail.js';
import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import {
  collectManagementTasks,
  managementTaskTypes,
  reconcileTaskRounds,
} from '../projects/project-task-rounds.js';
import { entryTasks, syncEntrySnapshots } from './personnel-progress.js';
import { personnelScope, memberInclude, qualifiedForEntry } from './personnel-access.js';
import {
  canSetEntry,
  statusNames,
  memberStatuses,
  todayText,
  validateEntry,
  type RosterQuery,
  type EntryInput,
} from './personnel-domain.js';
const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const time = (d: Date | null) => (d ? projectTime(d) : null);
export async function lockPersonnel(
  tx: Prisma.TransactionClient,
  projectId: number,
  ids: number[],
  actorUserId: string,
  relatedProjectIds: number[] = [],
) {
  const projectIds = [...new Set([projectId, ...relatedProjectIds])].sort((a, b) => a - b);
  const initial = await tx.projectMember.findMany({
    where: { projectId: projectId, id: { in: ids } },
  });
  const users = [...new Set([actorUserId, ...initial.map((m) => m.userId)])].sort();
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(ARRAY[${Prisma.join(users)}]::uuid[]) ORDER BY "id" FOR SHARE`;
  // 组织成员变更采用用户→组织→成员关系→项目；项目内业务统一先锁项目再锁成员。
  const organizations = await tx.projectExpertAssignment.findMany({
    where: { projectId: { in: projectIds }, organizationId: { not: null } },
    select: { organizationId: true },
  });
  const orgIds = [
    ...new Set([
      ...organizations.map((a) => a.organizationId!),
      ...initial.flatMap((m) => (m.organizationId ? [m.organizationId] : [])),
    ]),
  ].sort();
  if (orgIds.length) {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ANY(ARRAY[${Prisma.join(orgIds)}]::uuid[]) ORDER BY "id" FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "UserOrgRel" WHERE "orgId" = ANY(ARRAY[${Prisma.join(orgIds)}]::uuid[]) ORDER BY "id" FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR UPDATE`;
}
export class PersonnelService {
  constructor(readonly db: PrismaClient) {}
  async roster(query: RosterQuery, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const scope = await personnelScope(tx, query.projectId, principal);
        const current = query.current ?? 1,
          size = query.size ?? 20;
        const filters: Prisma.ProjectMemberWhereInput[] = [{ projectId: query.projectId }];
        if (scope.organizationIds) filters.push({ organizationId: { in: scope.organizationIds } });
        if (query.keyword?.trim())
          filters.push({
            user: {
              OR: ['uid', 'realName', 'displayName'].map((key) => ({
                [key]: { contains: query.keyword!.trim() },
              })),
            },
          });
        if (query.accountTypes?.length === 1)
          filters.push({
            organizationId: query.accountTypes[0] === 'INDIVIDUAL' ? null : { not: null },
          });
        if (query.organizationIds?.length)
          filters.push({ organizationId: { in: query.organizationIds } });
        if (query.orgPositions?.length)
          filters.push({ organizationMembership: { position: { in: query.orgPositions } } });
        if (query.employmentTypes?.length)
          filters.push({
            organizationMembership: { employmentType: { in: query.employmentTypes } },
          });
        if (query.statuses?.length)
          filters.push({
            OR: query.statuses.map((status) =>
              status === 'PENDING_CONFIRM'
                ? { OR: [{ status }, { status: 'PENDING_ENTRY', plannedEntryDate: null }] }
                : status === 'PENDING_ENTRY'
                  ? { status, plannedEntryDate: { not: null } }
                  : { status },
            ),
          });
        if (query.responsibleUserIds?.length)
          filters.push({
            expertAssignment: {
              OR: [
                {
                  owners: { some: { status: 'ACTIVE', userId: { in: query.responsibleUserIds } } },
                },
                { owners: { none: {} }, projectOwnerUserId: { in: query.responsibleUserIds } },
              ],
            },
          });
        const where = { AND: filters };
        const total = await tx.projectMember.count({ where });
        const rows = await tx.projectMember.findMany({
          where,
          include: memberInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * size,
          take: size,
        });
        const plan = await tx.projectProductionPlan.findUnique({
          where: { projectId: query.projectId },
        });
        return {
          total,
          current,
          size,
          pages: Math.ceil(total / size),
          records: rows.map((m) => {
            const a = m.expertAssignment;
            const owners =
              !a || a.status !== 'ACCEPTED'
                ? []
                : a.owners.length
                  ? a.owners.filter((o) => o.status === 'ACTIVE').map((o) => o.user)
                  : a.legacyOwner
                    ? [a.legacyOwner]
                    : [];
            const projectOwners = owners.map((u) => ({
              userId: u.id,
              name: displayName(u.displayName, u.realName, u.uid),
              avatarUrl: u.avatarUrl,
            }));
            const status =
              m.status === 'PENDING_ENTRY' && !m.plannedEntryDate ? 'PENDING_CONFIRM' : m.status;
            return {
              memberId: m.id,
              userId: m.userId,
              uid: m.user.uid,
              displayName: displayName(m.user.displayName, m.user.realName, m.user.uid),
              avatarUrl: m.user.avatarUrl,
              accountType: m.organizationId ? 'ORGANIZATION' : 'INDIVIDUAL',
              organizationId: m.organizationId,
              organizationName: m.organization?.deleted ? null : (m.organization?.name ?? null),
              orgPosition: m.organizationMembership?.position ?? null,
              employmentType: m.organizationMembership?.employmentType ?? null,
              responsibleUserId: projectOwners.length === 1 ? projectOwners[0]!.userId : null,
              responsibleUserName: projectOwners.length === 1 ? projectOwners[0]!.name : null,
              projectOwners,
              admittedAt: time(m.admittedAt),
              entryDecision: m.entryDecision,
              plannedEntryDate: date(m.plannedEntryDate),
              joinedAt: time(m.joinedAt),
              plannedLeaveDate: date(m.plannedLeaveDate),
              leftAt: time(m.leftAt),
              status,
              statusName: statusNames[memberStatuses.indexOf(status)] ?? status,
              allowedActions:
                !scope.readOnly &&
                scope.project.currentNodeCode !== 'COMPLETED' &&
                canSetEntry(m, todayText(new Date())) &&
                qualifiedForEntry(m, plan?.needWrittenExam ?? false)
                  ? ['SET_ENTRY']
                  : [],
            };
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async saveEntry(input: EntryInput, principal: AuthPrincipal, now = new Date()) {
    const ids = validateEntry(input, now);
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, input.projectId, ids, principal.userId);
        const scope = await personnelScope(tx, input.projectId, principal, true);
        if (scope.project.currentNodeCode === 'COMPLETED')
          throw new AuthError(409, 'DUPLICATE', '项目已结项');
        await tx.$queryRaw`SELECT "id" FROM "ProjectMember" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
        const members = await tx.projectMember.findMany({
          where: { projectId: input.projectId, id: { in: ids } },
          include: memberInclude,
        });
        if (members.length !== ids.length) throw new AuthError(404, 'NOT_FOUND', '项目成员不存在');
        const plan = await tx.projectProductionPlan.findUnique({
          where: { projectId: input.projectId },
        });
        for (const m of members) {
          if (
            scope.organizationIds &&
            (!m.organizationId || !scope.organizationIds.includes(m.organizationId))
          )
            throw new AuthError(403, 'FORBIDDEN', '只能管理职责组织内成员');
          if (!canSetEntry(m, todayText(now)))
            throw new AuthError(409, 'DUPLICATE', '成员入项状态已生效，不能再次修改');
          if (!qualifiedForEntry(m, plan?.needWrittenExam ?? false))
            throw new AuthError(409, 'DUPLICATE', '成员接单、组织或准入资格已失效');
        }
        const before = await collectManagementTasks(tx, scope.project);
        const beforeEntry = await entryTasks(tx, input.projectId);
        for (const m of members)
          await tx.projectMember.update({
            where: { id: m.id },
            data: {
              entryDecision: input.entryDecision,
              plannedEntryDate:
                input.entryDecision === 'YES' ? new Date(input.plannedEntryDate!) : null,
              entryDeclineReason: input.entryDecision === 'NO' ? input.declineReason!.trim() : null,
              status:
                input.entryDecision === 'NO'
                  ? 'ENTRY_DECLINED'
                  : input.plannedEntryDate === todayText(now)
                    ? 'ACTIVE'
                    : 'PENDING_ENTRY',
              joinedAt:
                input.entryDecision === 'YES' && input.plannedEntryDate === todayText(now)
                  ? now
                  : null,
              updatedBy: principal.uid,
            },
          });
        const project =
          input.entryDecision === 'YES' && scope.project.currentNodeCode !== 'PRODUCTION_TASK'
            ? await tx.project.update({
                where: { id: input.projectId },
                data: { currentNodeCode: 'PRODUCTION_TASK', updatedBy: principal.uid },
              })
            : scope.project;
        await reconcileTaskRounds(
          tx,
          input.projectId,
          before,
          await collectManagementTasks(tx, project),
          { userId: principal.userId, role: principal.role as 'PM' | 'EXPERT' },
          [],
          [],
          managementTaskTypes,
          now,
        );
        const afterEntry = await entryTasks(tx, input.projectId);
        await reconcileTaskRounds(
          tx,
          input.projectId,
          beforeEntry,
          afterEntry,
          { userId: principal.userId, role: principal.role as 'PM' | 'EXPERT' },
          ['MEMBER_ENTRY_CONFIRM'],
          [],
          ['MEMBER_ENTRY_CONFIRM'],
          now,
        );
        await refreshOwnerProgress(
          tx,
          input.projectId,
          [...new Set(members.map((m) => m.userId))],
          now,
        );
        await syncEntrySnapshots(tx, input.projectId, beforeEntry, afterEntry, now);
        await tx.projectEventOutbox.create({
          data: {
            projectId: input.projectId,
            eventType: 'PROJECT_MEMBER_ENTRY_CHANGED',
            operation: 'SAVE_ENTRY',
            actorUserId: principal.userId,
            payload: {
              schemaVersion: 1,
              projectId: input.projectId,
              memberIds: ids,
              entryDecision: input.entryDecision,
              plannedEntryDate: input.entryDecision === 'YES' ? input.plannedEntryDate! : null,
              actorUserId: principal.userId,
            },
          },
        });
        return null;
      },
      { timeout: 30_000 },
    );
  }
  async processDue(now = new Date()) {
    const today = new Date(todayText(now));
    const due = await this.db.projectMember.findMany({
      where: {
        status: 'PENDING_ENTRY',
        entryDecision: 'YES',
        plannedEntryDate: { lte: today },
        project: { deleted: false, currentNodeCode: { not: 'COMPLETED' } },
      },
      orderBy: { id: 'asc' },
    });
    let activated = 0,
      skipped = 0,
      failed = 0;
    for (const initial of due) {
      try {
        const changed = await this.db.$transaction(
          async (tx) => {
            await lockPersonnel(tx, initial.projectId, [initial.id], initial.userId);
            const m = await tx.projectMember.findUnique({
              where: { id: initial.id },
              include: memberInclude,
            });
            const project = await tx.project.findUniqueOrThrow({
              where: { id: initial.projectId },
            });
            const plan = await tx.projectProductionPlan.findUnique({
              where: { projectId: initial.projectId },
            });
            if (
              !m ||
              project.deleted ||
              project.currentNodeCode === 'COMPLETED' ||
              m.status !== 'PENDING_ENTRY' ||
              m.entryDecision !== 'YES' ||
              !m.plannedEntryDate ||
              m.plannedEntryDate > today ||
              !qualifiedForEntry(m, plan?.needWrittenExam ?? false)
            )
              return false;
            const before = await collectManagementTasks(tx, project);
            await tx.projectMember.update({
              where: { id: m.id },
              data: {
                status: 'ACTIVE',
                joinedAt: new Date(
                  m.plannedEntryDate.toISOString().slice(0, 10) + 'T00:00:00+08:00',
                ),
                updatedBy: 'SYSTEM',
              },
            });
            const updated =
              project.currentNodeCode === 'PRODUCTION_TASK'
                ? project
                : await tx.project.update({
                    where: { id: project.id },
                    data: { currentNodeCode: 'PRODUCTION_TASK', updatedBy: 'SYSTEM' },
                  });
            await reconcileTaskRounds(
              tx,
              project.id,
              before,
              await collectManagementTasks(tx, updated),
              null,
              [],
              [],
              managementTaskTypes,
              now,
            );
            await refreshOwnerProgress(tx, project.id, [m.userId], now);
            await tx.projectEventOutbox.create({
              data: {
                projectId: project.id,
                eventType: 'PROJECT_MEMBER_ENTRY_ACTIVATED',
                operation: 'PROCESS_DUE_ENTRY',
                actorUserId: null,
                payload: { schemaVersion: 1, projectId: project.id, memberIds: [m.id] },
              },
            });
            return true;
          },
          { timeout: 30_000 },
        );
        if (changed) activated++;
        else skipped++;
      } catch {
        failed++;
      }
    }
    return { activated, skipped, failed };
  }
}
