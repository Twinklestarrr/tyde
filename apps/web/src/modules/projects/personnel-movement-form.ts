import type {
  PersonnelMovement,
  PersonnelMovementCreateInput,
  PersonnelMovementProcessInput,
  PersonnelMovementType,
} from '@tyde/shared';
import { productionPlanToday } from './production-plan-form';

export interface PersonnelMovementForm {
  movementType: PersonnelMovementType;
  reason: string;
  plannedEffectiveDate: string;
  targetProjectId: string;
}

function positiveId(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function personnelMovementCreateInput(
  projectId: number,
  memberIds: number[],
  form: PersonnelMovementForm,
  now = new Date(),
  role: 'PM' | 'EXPERT' = 'PM',
): PersonnelMovementCreateInput {
  if (
    !positiveId(projectId) ||
    !memberIds.length ||
    memberIds.length > 100 ||
    !memberIds.every(positiveId)
  )
    throw new Error('请选择1至100名本项目在项成员。');
  if (!['REMOVAL', 'TRANSFER'].includes(form.movementType)) throw new Error('请选择变动类型。');
  if (role !== 'PM') throw new Error('人员汰换和转项只能由原项目主策略官发起。');
  if (!form.reason.trim() || form.reason.length > 500) throw new Error('变动原因必填，最多500字。');
  if (!validDate(form.plannedEffectiveDate) || form.plannedEffectiveDate < productionPlanToday(now))
    throw new Error('预计生效日期须为有效日期，且不能早于上海当天。');
  const target = form.targetProjectId.trim();
  const targetProjectId = Number(target);
  if (
    form.movementType === 'TRANSFER' &&
    (!/^\d+$/.test(target) || !positiveId(targetProjectId) || targetProjectId === projectId)
  )
    throw new Error('转项须填写不同于原项目的有效目标项目ID。');
  return {
    projectId,
    memberIds: [...new Set(memberIds)].sort((a, b) => a - b),
    movementType: form.movementType,
    reason: form.reason.trim(),
    plannedEffectiveDate: form.plannedEffectiveDate,
    ...(form.movementType === 'TRANSFER' ? { targetProjectId } : {}),
  };
}

/** 优先使用服务端本人节点；旧响应仅允许唯一候选，不借历史operatorId猜测。 */
export function personnelMovementApprovalStep(
  movement: PersonnelMovement,
  role: 'PM' | 'EXPERT' = 'PM',
) {
  const codes = role === 'PM' ? ['TARGET_MANAGER'] : ['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER'];
  const steps = movement.approvalSteps.filter(
    (step) =>
      step.nodeSeq === movement.currentNode &&
      codes.includes(step.nodeCode) &&
      step.nodeStatus === 'PENDING',
  );
  if (movement.actionableNodeId != null)
    return steps.find((step) => step.nodeId === movement.actionableNodeId) ?? null;
  return steps.length === 1 ? steps[0]! : null;
}

/** 只处理当前角色可精确定位的人工节点，保留节点与流程双版本。 */
export function personnelMovementProcessInput(
  projectId: number,
  movement: PersonnelMovement,
  action: 'APPROVE' | 'REJECT',
  comment: string,
  role: 'PM' | 'EXPERT' = 'PM',
): PersonnelMovementProcessInput {
  const step = personnelMovementApprovalStep(movement, role);
  const version = (value: number | null) =>
    value !== null && Number.isInteger(value) && value >= 0 && value <= 2147483647;
  if (
    ![movement.sourceProjectId, movement.targetProjectId].includes(projectId) ||
    movement.status !== 'PROCESSING' ||
    !movement.allowedActions.includes(action) ||
    !movement.flowNo ||
    !version(movement.flowVersionNo) ||
    !step ||
    !version(step.nodeVersionNo)
  )
    throw new Error('当前没有可精确定位的本角色人工审批节点，请重新读取变动详情。');
  if (comment.length > 500 || (action === 'REJECT' && !comment.trim()))
    throw new Error('驳回意见必填，审批意见最多500字。');
  return {
    projectId,
    movementId: movement.movementId,
    flowNo: movement.flowNo,
    nodeId: step.nodeId,
    nodeVersionNo: step.nodeVersionNo,
    flowVersionNo: movement.flowVersionNo!,
    action,
    ...(comment.trim() ? { actionComment: comment.trim() } : {}),
  };
}

/** 精确节点动作核实目标已达到，不用整体状态或“已无待办”推断某次写入成功。 */
export function personnelMovementProcessConfirmed(
  input: PersonnelMovementProcessInput,
  current: PersonnelMovement,
  userId: string,
) {
  if (current.movementId !== input.movementId || current.flowNo !== input.flowNo) return false;
  const step = current.approvalSteps.find((item) => item.nodeId === input.nodeId);
  return !!(
    step &&
    step.nodeVersionNo > input.nodeVersionNo &&
    step.operatorId === userId &&
    step.action === input.action &&
    (step.actionComment ?? '').trim() === (input.actionComment ?? '').trim()
  );
}

export function personnelMovementDateFilters(start: string, end: string) {
  if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end))
    throw new Error('请填写有效且先后顺序正确的发起日期范围。');
  return {
    ...(start ? { createdStartAt: `${start} 00:00:00` } : {}),
    ...(end ? { createdEndAt: `${end} 23:59:59` } : {}),
  };
}
