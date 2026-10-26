import { Prisma } from '@prisma/client';
import { invalidTask, type TaskQuery } from './production-domain.js';
import { parseDate } from '../attendance/attendance-domain.js';
import { todayText } from '../personnel/personnel-domain.js';
export interface ReportQuery extends TaskQuery {
  subtaskId?: number | null;
  reviewStatuses?: string[] | null;
  reportDateStart?: string | null;
  reportDateEnd?: string | null;
}
export interface ReportItem {
  subtaskId?: number | null;
  memberId?: number | null;
  reportDate: string;
  quantity: number | string;
  remark?: string | null;
}
export interface ReportSave {
  projectId: number;
  reports: ReportItem[];
}
export interface ReportCorrect {
  projectId: number;
  reportId: number;
  quantity: number | string;
  remark?: string | null;
}
export interface ReportReview {
  projectId: number;
  subtaskId?: number | null;
  action: 'VERIFY' | 'RETURN';
  reportIds?: number[] | null;
  reason?: string | null;
}
export function reportQuantity(value: number | string) {
  let text: string;
  try {
    text = typeof value === 'number' ? new Prisma.Decimal(value).toFixed() : value;
  } catch {
    throw invalidTask('报量须为有效十进制数');
  }
  if (!/^\d{1,26}(\.\d{1,4})?$/.test(text))
    throw invalidTask('报量须大于等于0，最多26位整数和4位小数');
  return new Prisma.Decimal(text);
}
export function reportDay(day: string, now: Date) {
  parseDate(day);
  if (day > todayText(now)) throw invalidTask('报量日期不能晚于上海当天');
  return new Date(day);
}
export const reportTypes = ['OUTPUT_DATA_REVIEW', 'OUTPUT_REPORT_CORRECTION'];
