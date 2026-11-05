import {
  ApiError,
  type ProductionTaskCreateInput,
  type ProductionOutputReviewInput,
} from '@tyde/shared';
import { personnelBody, personnelDay } from './personnel-form';
import { productionPlanToday } from './production-plan-form';

export const PRODUCTION_TASKS_LEAVE_REQUEST = 'tyde:before-production-tasks-leave';

/** 超时及2xx业务错误无法证明未写入；仅明确拒绝状态允许后续恢复。 */
export function productionFailureIsUnknown(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    ['SESSION_CHANGED', 'INVALID_RESPONSE'].includes(String(error.code)) ||
    ![400, 401, 403, 404, 409, 413, 422, 429].includes(error.status)
  );
}
/** 以万分单位保留26位整数和4位小数；不经过Number或科学记数法。 */
export function productionQuantityUnits(raw: string): bigint | null {
  const value = raw.trim().replace(/^\+/, '');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  const decimal = fraction.replace(/0+$/, '');
  if (integer.length > 26 || decimal.length > 4) return null;
  return BigInt(integer) * 10000n + BigInt(decimal.padEnd(4, '0'));
}
export function productionQuantity(raw: string, allowZero = false): string {
  const units = productionQuantityUnits(raw);
  if (units === null || (!allowZero && units === 0n))
    throw new Error(`数量须${allowZero ? '非负' : '大于0'}，最多26位整数和4位小数。`);
  const integer = units / 10000n;
  const decimal = (units % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${integer}${decimal ? `.${decimal}` : ''}`;
}
export interface ProductionTaskDraft {
  name: string;
  date: string;
  quantity: string;
  mode: 'POOL' | 'DESIGNATED';
  memberIds: number[];
}
export function productionTaskInput(
  projectId: number,
  draft: ProductionTaskDraft,
  now = new Date(),
): ProductionTaskCreateInput {
  if (!draft.name.trim() || draft.name.length > 128) throw new Error('子任务名称必填，最多128字。');
  if (!personnelDay(draft.date) || draft.date < productionPlanToday(now))
    throw new Error('预期交付日期须为上海当天或之后的有效日期。');
  if (
    draft.memberIds.length > 1000 ||
    draft.memberIds.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
  )
    throw new Error('指定成员须为有效项目成员，每次最多1000名。');
  if (draft.mode === 'DESIGNATED' && !draft.memberIds.length)
    throw new Error('指定人员模式至少选择1名成员。');
  return personnelBody({
    projectId,
    subtaskName: draft.name.trim(),
    expectedDeliveryDate: draft.date,
    expectedQuantity: productionQuantity(draft.quantity),
    distributionMode: draft.mode,
    memberIds: draft.mode === 'POOL' ? [] : [...new Set(draft.memberIds)],
  });
}
export function productionReviewInput(
  projectId: number,
  subtaskId: number | null,
  mode: 'ALL' | 'SELECTED' | 'RETURN',
  ids: number[],
  reason: string,
): ProductionOutputReviewInput {
  if (ids.length > 1000 || ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647))
    throw new Error('每次最多核查1000条有效报量。');
  const unique = [...new Set(ids)];
  if (mode === 'SELECTED' && !unique.length)
    throw new Error('请先选择需要核准的报量，不会自动改为全部核准。');
  if (mode === 'RETURN' && (unique.length !== 1 || !reason.trim() || reason.length > 500))
    throw new Error('退回须选择1条报量并填写原因，最多500字。');
  return personnelBody({
    projectId,
    subtaskId,
    action: mode === 'RETURN' ? 'RETURN' : 'VERIFY',
    reportIds: mode === 'ALL' ? [] : unique,
    ...(mode === 'RETURN' ? { reason: reason.trim() } : {}),
  });
}
