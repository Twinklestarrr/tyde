import type { EntranceExamGradingDetail, EntranceExamGradingItemInput } from '@tyde/shared';

export interface EntranceExamGradingValues {
  items: {
    questionId: number;
    correctness: '' | 'CORRECT' | 'INCORRECT';
    gradingOpinion: string;
  }[];
  summary: string;
  compensationReason: string;
}

export function entranceExamGradingValues(
  detail: EntranceExamGradingDetail,
): EntranceExamGradingValues {
  return {
    items: detail.questions.map((question) => ({
      questionId: question.questionId,
      correctness:
        question.correctness === 'CORRECT' || question.correctness === 'INCORRECT'
          ? question.correctness
          : '',
      gradingOpinion: question.gradingOpinion ?? '',
    })),
    summary: detail.selectedRound.conclusionSummary ?? '',
    compensationReason: '',
  };
}

/** 门禁只使用本次应试绑定的轮次；人工阅卷人的最终资格仍由提交接口核验。 */
export function entranceExamGradingActions(detail: EntranceExamGradingDetail, canManage: boolean) {
  const round = detail.selectedRound;
  const previousComplete = detail.rounds
    .filter((item) => item.roundNo < round.roundNo)
    .every((item) => item.status === 'COMPLETED');
  const active = canManage && previousComplete && round.gradingRecordId !== null;
  return {
    previousComplete,
    manual:
      active &&
      round.gradingMode === 'MANUAL' &&
      (round.status === 'PENDING' || round.status === 'PROCESSING'),
    retry: active && round.gradingMode === 'AUTO' && round.status === 'FAILED',
    compensate:
      active &&
      round.gradingMode === 'AUTO' &&
      (round.status === 'FAILED' || round.status === 'COMPLETED'),
  };
}

/** 必须覆盖同一应试的全部题目；每题只有正确满分或错误零分，不接受任意分值。 */
export function entranceExamGradingInput(
  detail: EntranceExamGradingDetail,
  values: EntranceExamGradingValues,
  compensate: boolean,
) {
  const errors: Record<string, string> = {};
  const items: EntranceExamGradingItemInput[] = [];
  if (!detail.questions.length || detail.questions.length > 500)
    errors.questions = '当前试卷题目异常，请重新读取阅卷状态。';
  if (
    values.items.length !== detail.questions.length ||
    new Set(values.items.map((item) => item.questionId)).size !== values.items.length
  )
    errors.questions = '阅卷题目与当前试卷不一致，请重新读取阅卷状态。';
  for (const question of detail.questions) {
    const item = values.items.find((value) => value.questionId === question.questionId);
    if (!item || (item.correctness !== 'CORRECT' && item.correctness !== 'INCORRECT')) {
      errors[`question:${question.questionId}`] = '请选择正确或错误。';
      continue;
    }
    if (item.gradingOpinion.length > 5000)
      errors[`opinion:${question.questionId}`] = '阅卷意见最多 5000 字。';
    items.push({
      questionId: question.questionId,
      correctness: item.correctness,
      gradingOpinion: item.gradingOpinion.trim() || null,
    });
  }
  if (values.summary.length > 5000) errors.summary = '本轮总结最多 5000 字。';
  if (compensate && !values.compensationReason.trim())
    errors.compensationReason = '请填写人工补偿原因。';
  else if (compensate && values.compensationReason.length > 1000)
    errors.compensationReason = '补偿原因最多 1000 字。';
  return {
    errors,
    input: Object.keys(errors).length
      ? null
      : {
          items,
          summary: values.summary.trim() || null,
          compensationReason: compensate ? values.compensationReason.trim() : null,
        },
  };
}

/** 仅为判定预览；正式分数、单轮结论及最终准入始终取服务端返回值。 */
export function entranceExamGradingPreview(
  detail: EntranceExamGradingDetail,
  values: EntranceExamGradingValues,
) {
  let cents = 0;
  for (const question of detail.questions) {
    const item = values.items.find((value) => value.questionId === question.questionId);
    if (!item || !['CORRECT', 'INCORRECT'].includes(item.correctness)) return null;
    if (item.correctness === 'CORRECT') cents += Math.round(question.score * 100);
  }
  return cents / 100;
}
