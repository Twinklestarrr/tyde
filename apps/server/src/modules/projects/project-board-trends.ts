import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { resolveBoardAccess } from './project-board-subtasks.js';
import { displayName } from './project-detail.js';

const Decimal = Prisma.Decimal.clone({ precision: 64 });
const dayMs = 86_400_000;
export interface BoardTrendsQuery {
  projectId: number;
  metric: 'QUANTITY' | 'ACCURACY' | 'CPD';
  startDate: string;
  endDate: string;
}
function parseDay(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value &&
    value >= '0001-01-01'
    ? time
    : NaN;
}
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export async function boardTrends(
  tx: Prisma.TransactionClient,
  query: BoardTrendsQuery,
  principal: AuthPrincipal,
) {
  const start = parseDay(query.startDate);
  const end = parseDay(query.endDate);
  if (
    !['QUANTITY', 'ACCURACY', 'CPD'].includes(query.metric) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    (end - start) / dayMs >= 366
  )
    throw new AuthError(
      400,
      'VALIDATION_ERROR',
      'metric必须为QUANTITY、ACCURACY或CPD；日期须为有效yyyy-MM-dd，正序且包含首尾不超过366天',
    );
  const { organizationIds } = await resolveBoardAccess(tx, query.projectId, principal);
  const dates = Array.from({ length: (end - start) / dayMs + 1 }, (_, i) =>
    isoDay(start + i * dayMs),
  );
  const result = {
    metric: query.metric,
    viewScope: principal.role === 'EXPERT' ? 'ORGANIZATION' : 'FULL_PROJECT',
    dates,
    series: [] as {
      memberId: number;
      userId: string;
      displayName: string;
      quantityUnit: string | null;
      values: (number | null)[];
    }[],
  };
  if (principal.role === 'NAVIGATOR') return result;
  const queryStart = isoDay(
    Math.max(Date.parse('0001-01-01'), start - (query.metric === 'CPD' ? 6 * dayMs : 0)),
  );
  const rows = await tx.$queryRaw<
    {
      memberId: number;
      userId: string;
      displayName: string;
      realName: string | null;
      uid: string;
      quantityUnit: string | null;
      reportDate: Date | null;
      quantity: Prisma.Decimal;
      inspected: Prisma.Decimal;
      qualified: Prisma.Decimal;
    }[]
  >(Prisma.sql`
    SELECT m.id AS "memberId", m."userId", u."displayName", u."realName", u.uid,
      p."quantityUnit", r."reportDate",
      COALESCE(SUM(r.quantity), 0) AS quantity,
      COALESCE(SUM(q."inspectedQuantity"), 0) AS inspected,
      COALESCE(SUM(q."qualifiedQuantity"), 0) AS qualified
    FROM "ProjectMember" m
    JOIN "User" u ON u.id = m."userId"
    JOIN "Project" p ON p.id = m."projectId"
    LEFT JOIN "ProjectOutputReport" r ON r."memberId" = m.id AND r."projectId" = m."projectId"
      AND r."reportDate" BETWEEN ${queryStart}::date AND ${query.endDate}::date
    LEFT JOIN LATERAL (
      SELECT "inspectedQuantity", "qualifiedQuantity" FROM "ProjectOutputQuality"
      WHERE "outputReportId" = r.id ORDER BY id DESC LIMIT 1
    ) q ON true
    WHERE m."projectId" = ${query.projectId}
      AND m.status IN ('ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER')
      ${
        organizationIds === undefined
          ? Prisma.empty
          : organizationIds.length
            ? Prisma.sql`AND m."organizationId" IN (${Prisma.join(organizationIds.map((id) => Prisma.sql`${id}::uuid`))})`
            : Prisma.sql`AND false`
      }
    GROUP BY m.id, m."userId", u."displayName", u."realName", u.uid, p."quantityUnit", r."reportDate"
    ORDER BY m.id, r."reportDate"
  `);
  const members = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = members.get(row.memberId) ?? [];
    group.push(row);
    members.set(row.memberId, group);
  }
  for (const memberRows of members.values()) {
    const first = memberRows[0]!; // 分组只在插入真实行时创建，必定非空。
    const daily = new Map(
      memberRows.flatMap((r) =>
        r.reportDate ? [[r.reportDate.toISOString().slice(0, 10), r] as const] : [],
      ),
    );
    result.series.push({
      memberId: first.memberId,
      userId: first.userId,
      displayName: displayName(first.displayName, first.realName, first.uid),
      quantityUnit: first.quantityUnit,
      values: dates.map((day, i) => {
        const row = daily.get(day);
        if (query.metric === 'QUANTITY') return new Decimal(row?.quantity ?? 0).toNumber();
        if (query.metric === 'ACCURACY')
          return row && new Decimal(row.inspected).gt(0)
            ? new Decimal(row.qualified)
                .mul(100)
                .div(row.inspected)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
                .toNumber()
            : null;
        let sum = new Decimal(0);
        for (let offset = 0; offset < 7; offset++)
          sum = sum.add(daily.get(isoDay(start + (i - offset) * dayMs))?.quantity ?? 0);
        return sum.div(7).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
      }),
    });
  }
  return result;
}
