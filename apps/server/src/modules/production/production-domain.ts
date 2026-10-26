import { Prisma } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import { todayText } from '../personnel/personnel-domain.js';
import { parseDate } from '../attendance/attendance-domain.js';
export interface TaskQuery {
  projectId: number;
  keyword?: string | null;
  current?: number;
  size?: number;
  statuses?: string[] | null;
}
export interface TaskInput {
  projectId: number;
  subtaskName: string;
  expectedDeliveryDate: string;
  expectedQuantity: number | string;
  distributionMode: 'POOL' | 'DESIGNATED';
  memberIds?: number[] | null;
}
export const taskStatuses = ['IN_PROGRESS', 'PENDING_ACCEPTANCE', 'REWORK_REQUIRED', 'ACCEPTED'];
export const invalidTask = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
export function validateTask(input: TaskInput, now: Date) {
  const name = input.subtaskName?.trim();
  if (!name || name.length > 128) throw invalidTask('子任务名称不能为空且最多128字');
  parseDate(input.expectedDeliveryDate);
  if (input.expectedDeliveryDate < todayText(now))
    throw invalidTask('预期交付日期不能早于上海当天');
  let quantity: string;
  try {
    quantity =
      typeof input.expectedQuantity === 'number'
        ? new Prisma.Decimal(input.expectedQuantity).toFixed()
        : input.expectedQuantity;
  } catch {
    throw invalidTask('预期交付量须为有效十进制数量');
  }
  if (!/^\d{1,26}(\.\d{1,4})?$/.test(quantity) || Number(quantity) <= 0)
    throw invalidTask('预期交付量须大于0，最多26位整数和4位小数');
  const rawIds = input.memberIds ?? [];
  if (
    rawIds.length > 1000 ||
    rawIds.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
  )
    throw invalidTask('memberIds须为最多1000个32位正整数');
  const ids = [...new Set(rawIds)].sort((a, b) => a - b);
  if (
    input.distributionMode === 'POOL'
      ? ids.length > 0
      : input.distributionMode !== 'DESIGNATED' || !ids.length
  )
    throw invalidTask('任务池不能指定人员，指定模式至少需要1人');
  return { name, quantity, ids };
}
