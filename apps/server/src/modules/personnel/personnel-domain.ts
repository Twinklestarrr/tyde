import type { ProjectMember } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import { parseDate } from '../attendance/attendance-domain.js';
import { projectTime } from '../projects/project-time.js';
export const memberStatuses = [
  'PENDING_CONFIRM',
  'PENDING_ENTRY',
  'ACTIVE',
  'ENTRY_DECLINED',
  'PENDING_EXIT',
  'PENDING_TRANSFER',
  'LEFT',
  'REMOVED',
];
export const statusNames = [
  '待确认',
  '待入项',
  '在项',
  '已放弃入项',
  '待离项',
  '转项中',
  '已离开',
  '已移除',
];
export interface RosterQuery {
  projectId: number;
  keyword?: string | null;
  accountTypes?: string[] | null;
  orgPositions?: string[] | null;
  organizationIds?: string[] | null;
  employmentTypes?: string[] | null;
  responsibleUserIds?: string[] | null;
  statuses?: string[] | null;
  current?: number;
  size?: number;
}
export interface EntryInput {
  projectId: number;
  memberIds: number[];
  entryDecision: 'YES' | 'NO';
  plannedEntryDate?: string | null;
  declineReason?: string | null;
}
export const invalidPersonnel = (message: string) =>
  new AuthError(400, 'VALIDATION_ERROR', message);
export const todayText = (now: Date) => projectTime(now).slice(0, 10);
export function canSetEntry(
  member: Pick<ProjectMember, 'status' | 'entryDecision' | 'plannedEntryDate'>,
  today: string,
) {
  return (
    ['PENDING_CONFIRM', 'PENDING_ENTRY'].includes(member.status) &&
    member.entryDecision !== 'NO' &&
    (!member.plannedEntryDate || member.plannedEntryDate.toISOString().slice(0, 10) > today)
  );
}
export function validateEntry(input: EntryInput, now: Date) {
  if (
    !Number.isInteger(input.projectId) ||
    input.projectId < 1 ||
    input.projectId > 2147483647 ||
    !input.memberIds?.length ||
    input.memberIds.length > 100 ||
    input.memberIds.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
  )
    throw invalidPersonnel('项目和成员ID须为32位正整数，memberIds须有1至100项');
  if (input.entryDecision === 'YES') {
    if (!input.plannedEntryDate || input.plannedEntryDate < todayText(now))
      throw invalidPersonnel('确认入项时plannedEntryDate必填且不能早于上海当天');
    parseDate(input.plannedEntryDate);
  } else if (
    input.entryDecision !== 'NO' ||
    !input.declineReason?.trim() ||
    input.declineReason.length > 500
  )
    throw invalidPersonnel('放弃入项时declineReason必填且最多500字');
  return [...new Set(input.memberIds)].sort((a, b) => a - b);
}
