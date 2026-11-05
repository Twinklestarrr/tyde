import { type EntranceExamAttempt, type ProjectMember } from '@prisma/client';

export function admissionStatus(
  attempts: Pick<
    EntranceExamAttempt,
    'finalResult' | 'gradingStatus' | 'enteredAt' | 'submittedAt' | 'finalDecidedAt'
  >[],
) {
  if (attempts.some((a) => a.finalResult === 'ADMITTED')) return 'PASSED';
  if (
    attempts.some(
      (a) =>
        !['ADMITTED', 'ELIMINATED'].includes(a.finalResult) &&
        (['PENDING', 'IN_PROGRESS'].includes(a.gradingStatus) ||
          (a.submittedAt && !a.finalDecidedAt)),
    )
  )
    return 'PENDING';
  return attempts.some((a) => a.enteredAt) ? 'NOT_PASSED' : 'NOT_EXAMINED';
}

export function expertProgress(
  needExam: boolean,
  passed: boolean,
  member?: Pick<
    ProjectMember,
    'status' | 'entryDecision' | 'joinedAt' | 'standardTrainingConfirmedAt'
  >,
) {
  if (needExam && !passed) return 'ENTRANCE_EXAM';
  if (
    member &&
    ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(member.status) &&
    member.entryDecision !== 'NO' &&
    member.joinedAt &&
    member.standardTrainingConfirmedAt
  )
    return 'PRODUCTION_TASK';
  // 沿旧my-projects展示回退；不表示已完成准入或实际入项，也不授予后续动作。
  return 'STANDARD_TRAINING';
}

export const expertNodeNames: Record<string, string> = {
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
  OUTPUT_DATA_REVIEW: '检查数据',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
};
