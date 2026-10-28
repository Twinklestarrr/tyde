import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { loadBoardSubtasks, resolveBoardAccess } from './project-board-subtasks.js';
import { displayName } from './project-detail.js';
import { projectTime } from './project-time.js';

const Decimal = Prisma.Decimal.clone({ precision: 64 });
type RiskCode =
  | 'PROJECT_OVERDUE'
  | 'SUBTASK_OVERDUE'
  | 'SUBTASK_PROGRESS_LOW'
  | 'MEMBER_EFFICIENCY'
  | 'MEMBER_QUALITY';
interface RiskItem {
  code: RiskCode;
  severity: 'URGENT' | 'WARNING';
  targetId: number;
  targetName: string | null;
  message: string;
  overdueDays: number | null;
}
const card = () => ({ pendingCount: 0, urgentCount: 0, items: [] as RiskItem[] });
const daysBetween = (start: string, end: string) =>
  (Date.parse(end) - Date.parse(start)) / 86_400_000;
function add(target: ReturnType<typeof card>, item: RiskItem) {
  target.items.push(item);
  target.pendingCount++;
  if (item.severity === 'URGENT') target.urgentCount++;
}

// 从成员基表出发保留当天零报量人员；质量仅取每笔日报量的最新追加记录。
// 聚合在数据库执行，避免加载所有日报和历史质量记录，也不因多次质检放大报量。
async function memberMetrics(
  tx: Prisma.TransactionClient,
  projectId: number,
  organizationIds: string[] | undefined,
  today: string,
) {
  return tx.$queryRaw<
    {
      id: number;
      displayName: string;
      realName: string | null;
      uid: string;
      todayQuantity: Prisma.Decimal;
      inspected: Prisma.Decimal;
      qualified: Prisma.Decimal;
    }[]
  >(Prisma.sql`
    SELECT m.id, u."displayName", u."realName", u.uid,
      COALESCE(SUM(CASE WHEN r."reportDate" = ${today}::date THEN r.quantity ELSE 0 END), 0) AS "todayQuantity",
      COALESCE(SUM(q."inspectedQuantity"), 0) AS inspected,
      COALESCE(SUM(q."qualifiedQuantity"), 0) AS qualified
    FROM "ProjectMember" m
    JOIN "User" u ON u.id = m."userId"
    LEFT JOIN "ProjectOutputReport" r ON r."memberId" = m.id AND r."projectId" = m."projectId"
    LEFT JOIN LATERAL (
      SELECT "inspectedQuantity", "qualifiedQuantity"
      FROM "ProjectOutputQuality" WHERE "outputReportId" = r.id ORDER BY id DESC LIMIT 1
    ) q ON true
    WHERE m."projectId" = ${projectId}
      AND m.status IN ('ACTIVE', 'PENDING_EXIT', 'PENDING_TRANSFER')
      ${
        organizationIds === undefined
          ? Prisma.empty
          : organizationIds.length
            ? Prisma.sql`AND m."organizationId" IN (${Prisma.join(organizationIds.map((id) => Prisma.sql`${id}::uuid`))})`
            : Prisma.sql`AND false`
      }
    GROUP BY m.id, u."displayName", u."realName", u.uid
    ORDER BY m.id
  `);
}

export async function boardRisks(
  tx: Prisma.TransactionClient,
  projectId: number,
  principal: AuthPrincipal,
  now: Date,
) {
  const { project, organizationIds } = await resolveBoardAccess(tx, projectId, principal);
  const subtasks = await loadBoardSubtasks(tx, projectId, organizationIds, now);
  const result = {
    viewScope: principal.role === 'EXPERT' ? 'ORGANIZATION' : 'FULL_PROJECT',
    project: card(),
    subtasks: card(),
    members: card(),
  };
  const today = projectTime(now).slice(0, 10);
  if (project.deadline && now > project.deadline && project.currentNodeCode !== 'COMPLETED') {
    const days = daysBetween(projectTime(project.deadline).slice(0, 10), today);
    add(result.project, {
      code: 'PROJECT_OVERDUE',
      severity: 'URGENT',
      targetId: project.id,
      targetName: project.projectName,
      message: days === 0 ? '项目已逾期，不足一天' : `项目已逾期 ${days} 天`,
      overdueDays: days,
    });
  }
  for (const task of subtasks) {
    if (!task.overdueRisk) continue;
    const days = daysBetween(task.expectedDeliveryDate, today);
    add(result.subtasks, {
      code: 'SUBTASK_OVERDUE',
      severity: 'URGENT',
      targetId: task.subtaskId,
      targetName: task.subtaskName,
      message: days === 0 ? '子任务已到交付日，尚未提交验收' : `子任务已逾期 ${days} 天`,
      overdueDays: days,
    });
  }
  for (const task of subtasks) {
    if (!task.progressLowRisk) continue;
    add(result.subtasks, {
      code: 'SUBTASK_PROGRESS_LOW',
      severity: 'WARNING',
      targetId: task.subtaskId,
      targetName: task.subtaskName,
      message: `交付进度偏低（${task.progressPercent}%），截至今天应完成 ${task.expectedQuantityToDate}`,
      overdueDays: null,
    });
  }
  if (principal.role === 'NAVIGATOR' || project.currentNodeCode !== 'PRODUCTION_TASK')
    return result;
  const day = new Date(today);
  const plan = await tx.projectProductionPlan.findUnique({
    where: { projectId },
    select: {
      operatorCpd: true,
      stages: {
        where: { startDate: { lte: day }, endDate: { gte: day } },
        orderBy: { sequenceNo: 'asc' },
        take: 1,
        select: { operatorCpd: true, accuracyRate: true },
      },
    },
  });
  const stage = plan?.stages[0];
  const cpdTarget = stage?.operatorCpd ?? plan?.operatorCpd;
  const accuracyTarget = stage?.accuracyRate;
  if (cpdTarget == null && accuracyTarget == null) return result;
  const members = await memberMetrics(tx, projectId, organizationIds, today);
  for (const member of members) {
    const targetName = displayName(member.displayName, member.realName, member.uid);
    if (cpdTarget != null && new Decimal(member.todayQuantity).lt(cpdTarget))
      add(result.members, {
        code: 'MEMBER_EFFICIENCY',
        severity: 'WARNING',
        targetId: member.id,
        targetName,
        message: '今日作业量低于CPD要求',
        overdueDays: null,
      });
    // 旧契约先将累计抽检正确率四舍五入两位，再与阶段阈值严格比较。
    const accuracy = new Decimal(member.inspected).gt(0)
      ? new Decimal(member.qualified)
          .mul(100)
          .div(member.inspected)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      : null;
    if (accuracy != null && accuracyTarget != null && accuracy.lt(accuracyTarget))
      add(result.members, {
        code: 'MEMBER_QUALITY',
        severity: 'WARNING',
        targetId: member.id,
        targetName,
        message: '正确率低于阶段要求',
        overdueDays: null,
      });
  }
  return result;
}
