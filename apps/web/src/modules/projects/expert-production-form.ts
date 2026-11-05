import type {
  ExpertTask,
  ProductionOutputReport,
  ProductionOutputSaveInput,
  ProductionOutputCorrectInput,
} from '@tyde/shared';
import { PRODUCTION_REPORT_REQUEST_MAX_BYTES } from '@tyde/shared';
import { personnelBody, personnelDay } from './personnel-form';
import { productionQuantity } from './production-task-form';
import { productionPlanToday } from './production-plan-form';

export const EXPERT_PRODUCTION_LEAVE_REQUEST = 'tyde:before-production-tasks-leave';
export function isExpertProductionTask(task: ExpertTask) {
  return (
    task.acceptanceStatus === 'ACCEPTED' &&
    ['PRODUCTION_TASK', 'OUTPUT_DATA_REVIEW'].includes(
      task.branchNodeCode ?? task.currentNodeCode,
    ) &&
    task.currentNodeCode !== 'COMPLETED'
  );
}
export function sameExpertProductionSource(a: ExpertTask, b: ExpertTask) {
  return (
    a.basicInfo.projectId === b.basicInfo.projectId &&
    a.sourceBizType === b.sourceBizType &&
    a.sourceBizId === b.sourceBizId &&
    a.basicInfo.organizationId === b.basicInfo.organizationId
  );
}
export interface ExpertReportDraft {
  key: string;
  subtaskId: number | null;
  memberId: number | null;
  date: string;
  quantity: string;
  remark: string;
}
export function newExpertReportDraft(subtaskId: number | null = null): ExpertReportDraft {
  return {
    key: crypto.randomUUID(),
    subtaskId,
    memberId: null,
    date: productionPlanToday(),
    quantity: '',
    remark: '',
  };
}
export function expertReportInput(
  projectId: number,
  rows: ExpertReportDraft[],
  now = new Date(),
): ProductionOutputSaveInput {
  if (!rows.length || rows.length > 100) throw new Error('每次请填写1至100条报量。');
  const keys = new Set<string>();
  const reports = rows.map((row, index) => {
    if (!personnelDay(row.date) || row.date > productionPlanToday(now))
      throw new Error(`第${index + 1}行作业日期须为不晚于上海当天的有效日期。`);
    if (row.subtaskId === null || !Number.isInteger(row.subtaskId) || row.subtaskId < 1)
      throw new Error(`第${index + 1}行请选择可报量子任务。`);
    if (row.memberId !== null) throw new Error('仅支持本人报量，不能代他人报量。');
    if (row.remark.length > 1000) throw new Error(`第${index + 1}行作业备注最多1000字。`);
    const key = JSON.stringify([row.subtaskId, row.memberId, row.date]);
    if (keys.has(key)) throw new Error('同一成员、层级和作业日期不能在一批中重复报量。');
    keys.add(key);
    return {
      subtaskId: row.subtaskId,
      reportDate: row.date,
      quantity: productionQuantity(row.quantity, true),
      remark: row.remark.trim() || null,
    };
  });
  const input = { projectId, reports };
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength > PRODUCTION_REPORT_REQUEST_MAX_BYTES
  )
    throw new Error('本次报量超过512 KiB，请减少单次内容。');
  return input;
}
export function expertCorrectionInput(
  projectId: number,
  report: ProductionOutputReport,
  quantity: string,
  remark: string,
): ProductionOutputCorrectInput {
  if (!report.allowedActions.includes('SAVE_REPORT') || report.reviewStatus !== 'RETURNED')
    throw new Error('当前报量不可修正，请重新读取本人或当前职责下的退回记录。');
  if (remark.length > 1000) throw new Error('修正备注最多1000字。');
  return personnelBody({
    projectId,
    reportId: report.reportId,
    quantity: productionQuantity(quantity, true),
    remark: remark.trim() || null,
  });
}
