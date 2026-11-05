import {
  ApiError,
  type EntranceExamGradingDetail,
  type EntranceExamGradingItemInput,
} from '@tyde/shared';

/** 超时和2xx业务错误不证明写入被拒绝；只有明确拒绝状态可在重读后恢复。 */
export function entranceExamGradingFailureIsUnknown(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    ['SESSION_CHANGED', 'INVALID_RESPONSE'].includes(String(error.code)) ||
    ![400, 401, 403, 404, 409, 413, 422, 429].includes(error.status)
  );
}

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
export function entranceExamGradingActions(
  detail: EntranceExamGradingDetail,
  canManage: boolean,
  role: 'PM' | 'NAVIGATOR' = 'PM',
) {
  const round = detail.selectedRound;
  const previousComplete = detail.rounds
    .filter((item) => item.roundNo < round.roundNo)
    .every((item) => item.status === 'COMPLETED');
  const active = previousComplete && round.gradingRecordId !== null;
  return {
    previousComplete,
    manual:
      active &&
      round.gradingMode === 'MANUAL' &&
      (round.status === 'PENDING' || round.status === 'PROCESSING'),
    retry:
      role === 'PM' &&
      canManage &&
      active &&
      round.gradingMode === 'AUTO' &&
      round.status === 'FAILED',
    compensate:
      active &&
      role === 'PM' &&
      canManage &&
      round.gradingMode === 'AUTO' &&
      (round.status === 'FAILED' || round.status === 'COMPLETED'),
  };
}

/** 写前重读仍须是同一绑定轮次、记录和完整题目集合。 */
export function entranceExamGradingSourceMatches(
  previous: EntranceExamGradingDetail,
  current: EntranceExamGradingDetail,
) {
  const a = previous.selectedRound,
    b = current.selectedRound;
  return (
    previous.examId === current.examId &&
    previous.attemptId === current.attemptId &&
    a.gradingRecordId !== null &&
    a.gradingRecordId === b.gradingRecordId &&
    a.gradingRoundId === b.gradingRoundId &&
    a.roundNo === b.roundNo &&
    a.gradingMode === b.gradingMode &&
    JSON.stringify(previous.questions.map((item) => item.questionId).sort((x, y) => x - y)) ===
      JSON.stringify(current.questions.map((item) => item.questionId).sort((x, y) => x - y))
  );
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
