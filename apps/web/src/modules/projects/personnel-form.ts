import type {
  ProjectPersonnelEntryInput,
  ProjectMemberPerformanceInput,
  ProjectAttachmentUploadResult,
} from '@tyde/shared';
import { productionPlanToday } from './production-plan-form';

export const PERSONNEL_LEAVE_REQUEST = 'tyde:before-project-personnel-leave';
export function personnelDay(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function personnelBody<T>(input: T): T {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16 * 1024)
    throw new Error('本次提交超过16 KiB，请减少内容或单次成员数量。');
  return input;
}
export function personnelEntryInput(
  projectId: number,
  memberIds: number[],
  decision: 'YES' | 'NO',
  date: string,
  reason: string,
  now = new Date(),
): ProjectPersonnelEntryInput {
  if (!memberIds.length || memberIds.length > 100 || new Set(memberIds).size !== memberIds.length)
    throw new Error('每次请选择1至100名不同成员。');
  if (decision === 'YES' && (!personnelDay(date) || date < productionPlanToday(now)))
    throw new Error('预计入项日期须为上海当天或之后的有效日期。');
  if (decision === 'NO' && (!reason.trim() || reason.length > 500))
    throw new Error('放弃原因必填，最多500字。');
  return personnelBody({
    projectId,
    memberIds,
    entryDecision: decision,
    ...(decision === 'YES' ? { plannedEntryDate: date } : { declineReason: reason.trim() }),
  });
}
export interface PersonnelPerformanceFile {
  key: string;
  file: File;
  uploaded?: ProjectAttachmentUploadResult;
  error?: string;
}
export function personnelPerformanceInput(
  projectId: number,
  memberId: number,
  date: string,
  content: string,
  files: PersonnelPerformanceFile[],
  now = new Date(),
): ProjectMemberPerformanceInput {
  if (!personnelDay(date) || date > productionPlanToday(now))
    throw new Error('发生日期须为不晚于上海当天的有效日期。');
  if (!content.trim() || content.length > 2000) throw new Error('表现内容必填，最多2000字。');
  if (files.length > 10 || files.some((file) => !file.uploaded))
    throw new Error('请完成附件上传，最多10个。');
  return personnelBody({
    projectId,
    memberId,
    recordDate: date,
    content: content.trim(),
    attachmentIds: files.map((file) => file.uploaded!.fileId),
    attachmentUploadTokens: Object.fromEntries(
      files.map((file) => [file.uploaded!.fileId, file.uploaded!.uploadToken]),
    ),
  });
}
