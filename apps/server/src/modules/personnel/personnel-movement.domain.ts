import { AuthError } from '../auth/auth.error.js';
import { parseDate } from '../attendance/attendance-domain.js';
import { todayText } from './personnel-domain.js';
export interface MovementInput {
  projectId: number;
  memberIds: number[];
  movementType: 'REMOVAL' | 'TRANSFER';
  reason: string;
  targetProjectId?: number | null;
  plannedEffectiveDate: string;
}
export const transferSteps = (organization: boolean) =>
  organization
    ? [
        'SOURCE_ORG_OWNER',
        'MEMBER_CONFIRM',
        'TARGET_ENTRANCE_EXAM',
        'TARGET_MANAGER',
        'TARGET_ORG_OWNER',
      ]
    : ['MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM', 'TARGET_MANAGER'];
export const movementInvalid = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
export const movementConflict = (message: string) => new AuthError(409, 'DUPLICATE', message);
export function validateMovement(input: MovementInput, now: Date) {
  const id = (v: number) => Number.isInteger(v) && v > 0 && v <= 2147483647;
  if (
    !id(input.projectId) ||
    !Array.isArray(input.memberIds) ||
    !input.memberIds.length ||
    input.memberIds.length > 100 ||
    !input.memberIds.every(id)
  )
    throw movementInvalid('项目和成员ID须为32位正整数，成员须有1至100项');
  if (
    !['REMOVAL', 'TRANSFER'].includes(input.movementType) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 500
  )
    throw movementInvalid('变动类型须为REMOVAL或TRANSFER，原因必填且最多500字');
  if (
    input.movementType === 'TRANSFER'
      ? !id(input.targetProjectId!) || input.targetProjectId === input.projectId
      : input.targetProjectId != null
  )
    throw movementInvalid('转项须指定不同的目标项目，汰换不能指定目标项目');
  if (typeof input.plannedEffectiveDate !== 'string' || input.plannedEffectiveDate < todayText(now))
    throw movementInvalid('预计生效日期必填且不能早于上海当天');
  parseDate(input.plannedEffectiveDate);
  return [...new Set(input.memberIds)].sort((a, b) => a - b);
}
