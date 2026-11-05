import type {
  PersonnelQualityContext,
  PersonnelQualityKey,
  PersonnelQualitySaveInput,
  ProductionAcceptanceContext,
  ProductionAcceptanceReviewInput,
  ProductionAcceptanceSubmitInput,
  ProductionTask,
} from '@tyde/shared';
import { personnelBody, personnelDay } from './personnel-form';
import { productionPlanToday } from './production-plan-form';
import { productionQuantity, productionQuantityUnits } from './production-task-form';

export interface QualityDraft {
  id: string;
  outputReportId: number;
  inspected: string;
  qualified: string;
  reason: string;
}
export interface AcceptanceDraft {
  quantity: string;
  date: string;
  remark: string;
}

/** 审核仅发送决定，不能改写策略官本次提交的交付信息。 */
export function acceptanceReviewInput(
  projectId: number,
  subtaskId: number,
  decision: 'ACCEPT' | 'REJECT',
  reason: string,
): ProductionAcceptanceReviewInput {
  if (decision === 'ACCEPT') return { projectId, subtaskId, decision };
  if (!reason.trim()) throw new Error('请填写驳回原因。');
  if (reason.length > 500) throw new Error('驳回原因最多500字。');
  return { projectId, subtaskId, decision, rejectReason: reason.trim() };
}

/** 写前只核对本次展示的提交；此快照不能证明未知审核命令的结果。 */
export function acceptanceReviewSnapshotMatches(previous: ProductionTask, current: ProductionTask) {
  const snapshot = (task: ProductionTask) => [
    task.subtaskId,
    task.status,
    task.submittedAt,
    task.actualQuantity,
    task.actualDeliveryDate,
    task.reportedQuantity,
    task.quantityAdjustmentRemark,
    task.quantityUnit,
    task.reviewedAt,
    task.rejectReason,
  ];
  return JSON.stringify(snapshot(previous)) === JSON.stringify(snapshot(current));
}
export function productionBodyBytes<T>(input: T, limit = 512 * 1024): T {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > limit)
    throw new Error('本次质量追加超过512 KiB，请减少单次记录。');
  return input;
}
export function qualityInput(
  key: PersonnelQualityKey,
  drafts: QualityDraft[],
  context: PersonnelQualityContext,
  dailyQuantity?: number,
): PersonnelQualitySaveInput {
  if (context.memberId !== key.memberId || context.reportDate !== key.reportDate)
    throw new Error('质量明细与成员或生产日期不一致，请重新读取。');
  if (!drafts.length || drafts.length > 100) throw new Error('每次请选择1至100条新增质量记录。');
  const reportIds = new Set<number>();
  return productionBodyBytes({
    ...key,
    items: drafts.map((draft) => {
      const reports = context.items.filter((item) => item.outputReportId === draft.outputReportId);
      if (!reports.length || reports.some((item) => !item.editable))
        throw new Error(`报量 ${draft.outputReportId} 当前不可追加质量，请重新读取。`);
      if (reportIds.has(draft.outputReportId))
        throw new Error('每条日报量在本次只能录入一条质量记录。');
      reportIds.add(draft.outputReportId);
      const reportLimit = exactResponseUnits(reports[0]!.quantity);
      const dayLimit =
        dailyQuantity === undefined ? reportLimit : exactResponseUnits(dailyQuantity);
      if (reportLimit === null || dayLimit === null)
        throw new Error('报量数量缺失或超出可精确核对范围，暂不能录入质量。');
      const inspectedQuantity = productionQuantity(draft.inspected);
      const qualifiedQuantity = productionQuantity(draft.qualified, true);
      if (productionQuantityUnits(qualifiedQuantity)! > productionQuantityUnits(inspectedQuantity)!)
        throw new Error('合格数量不能超过抽检数量。');
      const inspected = productionQuantityUnits(inspectedQuantity)!;
      const qualified = productionQuantityUnits(qualifiedQuantity)!;
      if (inspected > reportLimit || inspected > dayLimit)
        throw new Error('抽检数量不能超过该条报量和当日总作业量。');
      if (qualified < inspected && !draft.reason.trim()) throw new Error('请填写不合格数据原因。');
      if (draft.reason.length > 1000) throw new Error('不合格原因最多1000字。');
      return {
        outputReportId: draft.outputReportId,
        inspectedQuantity,
        qualifiedQuantity,
        unqualifiedReason: qualified < inspected ? draft.reason.trim() : null,
      };
    }),
  });
}
export function acceptanceInput(
  projectId: number,
  subtaskId: number,
  draft: AcceptanceDraft,
  now = new Date(),
): ProductionAcceptanceSubmitInput {
  if (!personnelDay(draft.date) || draft.date < productionPlanToday(now))
    throw new Error('实际交付日期须为有效日期，且不能早于上海当天。');
  if (draft.remark.length > 1000) throw new Error('数量调整说明最多1000字。');
  return personnelBody({
    projectId,
    subtaskId,
    actualQuantity: productionQuantity(draft.quantity),
    actualDeliveryDate: draft.date,
    // 不以响应JSON数字反推精确相等或替用户清空说明；服务端锁内比较核准合计。
    quantityAdjustmentRemark: draft.remark.trim() || null,
  });
}

function exactResponseUnits(value: number | null) {
  // 小于2^39时相邻4位小数仍可区分；更大JSON数字可能合并不同合法Decimal，不能证明精确提交量。
  if (value === null || !Number.isFinite(value) || Math.abs(value) >= 2 ** 39) return null;
  return productionQuantityUnits(String(value));
}

/** 只回填能精确表达四位小数的响应，避免把大数响应的舍入结果写回。 */
export function acceptanceDefaultQuantity(value: number): string {
  return exactResponseUnits(value) === null ? '' : productionQuantity(String(value), true);
}

/** 延续旧版在提交前提示数量调整原因，最终比较仍由服务端锁内完成。 */
export function validateAcceptanceContext(
  form: AcceptanceDraft,
  context: ProductionAcceptanceContext,
) {
  if (!context.canSubmit || context.pendingCount > 0 || context.returnedCount > 0)
    throw new Error('尚有数据需要核查或修正，暂不可提交验收。');
  const reported = exactResponseUnits(context.reportedQuantity);
  const actual = productionQuantityUnits(form.quantity);
  if (reported !== null && actual !== null && reported !== actual && !form.remark.trim())
    throw new Error('调整实际交付量级后请填写数量调整说明。');
}

export function acceptanceSnapshotConfirmed(
  input: ProductionAcceptanceSubmitInput,
  baseline: ProductionTask,
  current: ProductionTask,
) {
  const expected = productionQuantityUnits(String(input.actualQuantity));
  const actual = exactResponseUnits(current.actualQuantity);
  if (
    current.subtaskId !== input.subtaskId ||
    current.subtaskId !== baseline.subtaskId ||
    !['PENDING_ACCEPTANCE', 'ACCEPTED', 'REWORK_REQUIRED'].includes(current.status) ||
    !current.submittedAt ||
    current.submittedAt === baseline.submittedAt ||
    current.actualDeliveryDate !== input.actualDeliveryDate ||
    expected === null ||
    actual === null ||
    expected !== actual
  )
    return false;
  const remark = (current.quantityAdjustmentRemark ?? '').trim();
  return (
    remark === (input.quantityAdjustmentRemark ?? '').trim() ||
    (!remark && exactResponseUnits(current.reportedQuantity) === expected)
  );
}

export function productionDateRange(start: string, end: string) {
  if (!personnelDay(start) || !personnelDay(end)) throw new Error('请填写有效的生产日期。');
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (days < 0 || days > 30) throw new Error('生产日期范围须为1至31天。');
  return { reportDateStart: start, reportDateEnd: end };
}
