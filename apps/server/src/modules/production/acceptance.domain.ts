import { Prisma } from '@prisma/client';
import { parseDate } from '../attendance/attendance.domain.js';
import { todayText } from '../personnel/personnel.domain.js';
import { type AcceptanceReview, type AcceptanceSubmit } from './acceptance.types.js';
import { reportQuantity } from './output-report.domain.js';
import { invalidTask } from './production.domain.js';

export const acceptanceTypes = [
  'SUBTASK_ACCEPTANCE',
  'SUBTASK_REWORK_REVIEW',
  'SUBTASK_REWORK_SUBMIT',
];

export function acceptanceReady(counts: { verified: number; pending: number; returned: number }) {
  return counts.verified > 0 && counts.pending === 0 && counts.returned === 0;
}

export function validateAcceptance(q: AcceptanceSubmit, reported: Prisma.Decimal, now: Date) {
  const actualQuantity = reportQuantity(q.actualQuantity);
  if (!actualQuantity.gt(0)) throw invalidTask('实际交付量须大于0');
  const actualDeliveryDate = parseDate(q.actualDeliveryDate);
  if (q.actualDeliveryDate < todayText(now)) throw invalidTask('实际交付日期不能早于上海当天');
  let quantityAdjustmentRemark = q.quantityAdjustmentRemark?.trim() || null;
  if ((q.quantityAdjustmentRemark?.length ?? 0) > 1000) throw invalidTask('调整备注不能超过1000字');
  if (!actualQuantity.eq(reported) && !quantityAdjustmentRemark)
    throw invalidTask('调整实际交付量时必须填写备注');
  if (actualQuantity.eq(reported)) quantityAdjustmentRemark = null;
  return { actualQuantity, actualDeliveryDate, quantityAdjustmentRemark };
}

export function acceptanceDecision(q: AcceptanceReview) {
  const rejectReason = q.rejectReason?.trim() || null;
  if (
    !['ACCEPT', 'REJECT'].includes(q.decision) ||
    (q.rejectReason?.length ?? 0) > 500 ||
    (q.decision === 'REJECT' ? !rejectReason : !!rejectReason)
  )
    throw invalidTask('驳回须填写原因，通过不能填写原因；原因最多500字');
  return { status: q.decision === 'ACCEPT' ? 'ACCEPTED' : 'REWORK_REQUIRED', rejectReason };
}
