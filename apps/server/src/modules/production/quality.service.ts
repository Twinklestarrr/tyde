import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { personnelScope } from '../personnel/personnel-access.js';
import { lockPersonnel } from '../personnel/personnel.service.js';
import { todayText } from '../personnel/personnel-domain.js';
import { parseDate, dateText } from '../attendance/attendance-domain.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import { invalidTask } from './production-domain.js';
import { reportQuantity } from './output-report.domain.js';
export interface ProductionQuery {
  projectId: number;
  reportDateStart?: string | null;
  reportDateEnd?: string | null;
  keyword?: string | null;
  accountTypes?: string[] | null;
  organizationIds?: string[] | null;
  dataSources?: string[] | null;
  current?: number;
  size?: number;
}
export interface QualityContext {
  projectId: number;
  memberId: number;
  reportDate: string;
}
export interface QualityInput extends QualityContext {
  items: {
    outputReportId: number;
    inspectedQuantity: string | number;
    qualifiedQuantity: string | number;
    unqualifiedReason?: string | null;
  }[];
}
export function productionRange(q: ProductionQuery, now: Date) {
  const start = parseDate(q.reportDateStart ?? todayText(now));
  const end = parseDate(q.reportDateEnd ?? todayText(now));
  if (end < start || end.getTime() - start.getTime() > 30 * 86400000)
    throw invalidTask('生产日期区间须为1至31天');
  return { start, end };
}
export function qualityAmounts(i: QualityInput['items'][number]) {
  const inspectedQuantity = reportQuantity(i.inspectedQuantity),
    qualifiedQuantity = reportQuantity(i.qualifiedQuantity);
  if (!inspectedQuantity.gt(0) || qualifiedQuantity.gt(inspectedQuantity))
    throw invalidTask('抽检数须大于0，合格数须介于0和抽检数之间');
  if ((i.unqualifiedReason?.length ?? 0) > 1000) throw invalidTask('不合格原因不能超过1000字');
  return {
    inspectedQuantity,
    qualifiedQuantity,
    unqualifiedReason: i.unqualifiedReason?.trim() || null,
  };
}
const name = (u: { displayName: string | null; realName: string | null; uid: string }) =>
  displayName(u.displayName ?? '', u.realName, u.uid);
async function memberScope(
  tx: Prisma.TransactionClient,
  q: QualityContext,
  p: AuthPrincipal,
  write = false,
) {
  const scope = await personnelScope(tx, q.projectId, p, write);
  const member = await tx.projectMember.findFirst({
    where: { id: q.memberId, projectId: q.projectId },
    include: { user: true },
  });
  if (!member) throw new AuthError(404, 'NOT_FOUND', '项目成员不存在');
  if (scope.organizationIds && !scope.organizationIds.includes(member.organizationId ?? ''))
    throw new AuthError(403, 'FORBIDDEN', '只能访问职责组织内成员');
  return { scope, member };
}
// 26位整数加4位小数的数量不能使用Decimal默认20位有效精度做累加。
const ExactDecimal = Prisma.Decimal.clone({ precision: 64 });
export const sumProductionQuantities = (values: Prisma.Decimal[]) =>
  values.reduce((a, b) => a.plus(b), new ExactDecimal(0));
const sum = sumProductionQuantities;
export class QualityService {
  constructor(readonly db: PrismaClient) {}
  async list(q: ProductionQuery, p: AuthPrincipal, now = new Date()) {
    const { start, end } = productionRange(q, now);
    return this.db.$transaction(
      async (tx) => {
        const scope = await personnelScope(tx, q.projectId, p);
        const filters: Prisma.ProjectMemberWhereInput[] = [{ projectId: q.projectId }];
        if (scope.organizationIds) filters.push({ organizationId: { in: scope.organizationIds } });
        if (q.organizationIds?.length) filters.push({ organizationId: { in: q.organizationIds } });
        if (q.accountTypes?.length === 1)
          filters.push({
            organizationId: q.accountTypes[0] === 'INDIVIDUAL' ? null : { not: null },
          });
        if (q.keyword?.trim())
          filters.push({
            user: {
              OR: ['uid', 'realName', 'displayName'].map((k) => ({
                [k]: { contains: q.keyword!.trim() },
              })),
            },
          });
        const where: Prisma.ProjectOutputReportWhereInput = {
          projectId: q.projectId,
          reportDate: { gte: start, lte: end },
          member: { AND: filters },
          ...(q.dataSources?.length ? { dataSource: { in: q.dataSources } } : {}),
        };
        const groups = await tx.projectOutputReport.groupBy({
          by: ['memberId', 'reportDate'],
          where,
          orderBy: [{ reportDate: 'desc' }, { memberId: 'asc' }],
        });
        const current = q.current ?? 1,
          size = q.size ?? 20;
        const selected = groups.slice((current - 1) * size, current * size);
        const reports = selected.length
          ? await tx.projectOutputReport.findMany({
              where: {
                projectId: q.projectId,
                OR: selected.map((g) => ({ memberId: g.memberId, reportDate: g.reportDate })),
              },
              include: {
                member: { include: { user: true, organization: true } },
                subtask: true,
                qualities: { orderBy: { id: 'desc' } },
              },
              orderBy: { id: 'asc' },
            })
          : [];
        const recent = selected.length
          ? await tx.projectOutputReport.findMany({
              where: {
                projectId: q.projectId,
                OR: selected.map((g) => ({
                  memberId: g.memberId,
                  reportDate: {
                    gte: new Date(g.reportDate.getTime() - 6 * 86400000),
                    lte: g.reportDate,
                  },
                })),
              },
              select: { memberId: true, reportDate: true, quantity: true },
            })
          : [];
        const records = selected.map((g) => {
          const all = reports.filter(
            (r) => r.memberId === g.memberId && +r.reportDate === +g.reportDate,
          );
          const filtered = all.filter(
            (r) => !q.dataSources?.length || q.dataSources.includes(r.dataSource),
          );
          const r = all[0]!,
            m = r.member;
          const latest = filtered.flatMap((r) => r.qualities.slice(0, 1));
          const inspected = sum(latest.map((r) => r.inspectedQuantity)),
            qualified = sum(latest.map((r) => r.qualifiedQuantity));
          const qualities = all.flatMap((r) => r.qualities);
          return {
            memberId: m.id,
            userId: m.userId,
            uid: m.user.uid,
            displayName: name(m.user),
            accountType: m.organizationId ? 'ORGANIZATION' : 'INDIVIDUAL',
            organizationId: m.organizationId,
            organizationName: m.organization?.deleted ? null : (m.organization?.name ?? null),
            reportDate: dateText(g.reportDate),
            quantity: Number(sum(filtered.map((r) => r.quantity))),
            quantityUnit: filtered
              .map((r) => r.quantityUnit)
              .sort()
              .at(-1)!,
            recent7DayCpd: Number(
              sum(
                recent
                  .filter(
                    (r) =>
                      r.memberId === m.id &&
                      r.reportDate <= g.reportDate &&
                      +r.reportDate >= +g.reportDate - 6 * 86400000,
                  )
                  .map((r) => r.quantity),
              )
                .div(7)
                .toFixed(2),
            ),
            inspectedQuantity: Number(inspected),
            qualifiedQuantity: Number(qualified),
            unqualifiedQuantity: Number(inspected.minus(qualified)),
            accuracyRate: inspected.isZero()
              ? null
              : Number(qualified.mul(100).div(inspected).toFixed(2)),
            dataSources: [...new Set(filtered.map((r) => r.dataSource))].sort(),
            remarks:
              [...new Set(all.map((r) => r.remark?.trim()).filter(Boolean))].join('\n') || null,
            qualityRecordCount: qualities.length,
            hasManualQualityEntry: qualities.some((r) => r.dataSource === 'MANUAL'),
            allowedActions: scope.readOnly ? [] : ['SAVE_QUALITY', 'CREATE_PERFORMANCE'],
          };
        });
        return {
          current,
          size,
          total: groups.length,
          pages: Math.ceil(groups.length / size),
          records,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async context(q: QualityContext, p: AuthPrincipal) {
    const reportDate = parseDate(q.reportDate);
    return this.db.$transaction(
      async (tx) => {
        const { scope, member } = await memberScope(tx, q, p);
        const reports = await tx.projectOutputReport.findMany({
          where: { projectId: q.projectId, memberId: q.memberId, reportDate },
          include: { subtask: true, qualities: { orderBy: { id: 'desc' } } },
          orderBy: { id: 'asc' },
        });
        const operators = await tx.user.findMany({
          where: { uid: { in: reports.flatMap((r) => r.qualities.map((x) => x.recordedBy)) } },
        });
        return {
          memberId: member.id,
          displayName: name(member.user),
          reportDate: q.reportDate,
          items: reports.flatMap((r) =>
            (r.qualities.length ? r.qualities : [null]).map((x) => ({
              outputReportId: r.id,
              subtaskId: r.subtaskId,
              subtaskName: r.subtask?.subtaskName ?? null,
              quantity: Number(r.quantity),
              quantityUnit: r.quantityUnit,
              reportDataSource: r.dataSource,
              qualityId: x?.id ?? null,
              inspectedQuantity: x ? Number(x.inspectedQuantity) : null,
              qualifiedQuantity: x ? Number(x.qualifiedQuantity) : null,
              unqualifiedReason: x?.unqualifiedReason ?? null,
              operatorName: x
                ? operators.find((u) => u.uid === x.recordedBy)
                  ? name(operators.find((u) => u.uid === x.recordedBy)!)
                  : x.recordedBy
                : null,
              operationTime: x ? projectTime(x.createdAt) : null,
              qualityDataSource: x?.dataSource ?? null,
              editable:
                !scope.readOnly &&
                r.subtask?.status !== 'ACCEPTED' &&
                r.qualities[0]?.dataSource !== 'WORK_SYSTEM',
            })),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async save(q: QualityInput, p: AuthPrincipal) {
    const reportDate = parseDate(q.reportDate);
    if (!q.items.length || q.items.length > 100) throw invalidTask('质量明细须为1至100条');
    const amounts = q.items.map(qualityAmounts);
    return this.db.$transaction(
      async (tx) => {
        await lockPersonnel(tx, q.projectId, [q.memberId], p.userId);
        await memberScope(tx, q, p, true);
        // 项目锁与报量/验收写共用锁顺序，避免验收完成后仍插入质量。
        for (const [index, i] of q.items.entries()) {
          await tx.$queryRaw`SELECT "id" FROM "ProjectOutputReport" WHERE "id"=${i.outputReportId} FOR UPDATE`;
          const r = await tx.projectOutputReport.findUnique({
            where: { id: i.outputReportId },
            include: { subtask: true, qualities: { orderBy: { id: 'desc' }, take: 1 } },
          });
          if (
            !r ||
            r.projectId !== q.projectId ||
            r.memberId !== q.memberId ||
            +r.reportDate !== +reportDate
          )
            throw invalidTask('日报量与项目、成员或日期不匹配');
          if (r.subtask?.status === 'ACCEPTED')
            throw new AuthError(409, 'DUPLICATE', '已验收子任务不能新增质量记录');
          if (r.qualities[0]?.dataSource === 'WORK_SYSTEM')
            throw new AuthError(403, 'FORBIDDEN', '作业系统质量不能人工覆盖');
          await tx.projectOutputQuality.create({
            data: { outputReportId: r.id, ...amounts[index]!, recordedBy: p.uid },
          });
        }
        return null;
      },
      { timeout: 30000 },
    );
  }
}
