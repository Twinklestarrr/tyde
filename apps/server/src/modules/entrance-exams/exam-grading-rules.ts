import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';

export interface GradingItemInput {
  questionId: number;
  correctness: 'CORRECT' | 'INCORRECT';
  gradingOpinion?: string | null;
}
export function normalizeGradingItems(items: GradingItemInput[]) {
  if (!Array.isArray(items) || !items.length || items.length > 500)
    throw new AppError(400, 'VALIDATION_ERROR', '逐题判卷结果须为1至500道');
  const result = new Map<number, GradingItemInput>();
  for (const item of items) {
    if (
      !item ||
      !Number.isInteger(item.questionId) ||
      item.questionId < 1 ||
      !['CORRECT', 'INCORRECT'].includes(item.correctness) ||
      (item.gradingOpinion != null &&
        (typeof item.gradingOpinion !== 'string' || item.gradingOpinion.length > 5000)) ||
      result.has(item.questionId)
    )
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        '题目ID不得重复，所有题目必须选择正确或错误，意见最多5000字',
      );
    result.set(item.questionId, { ...item, gradingOpinion: item.gradingOpinion?.trim() || null });
  }
  return result;
}
export function gradePaper(
  questions: { id: number; score: Prisma.Decimal }[],
  items: Map<number, GradingItemInput>,
  passScore: Prisma.Decimal,
) {
  if (
    !questions.length ||
    questions.length !== items.size ||
    questions.some((q) => !items.has(q.id))
  )
    throw new AppError(400, 'VALIDATION_ERROR', '必须完整判定考生实际试卷中的所有题目');
  const score = questions.reduce(
    (total, q) => (items.get(q.id)!.correctness === 'CORRECT' ? total.add(q.score) : total),
    new Prisma.Decimal(0),
  );
  return { score, roundResult: score.greaterThanOrEqualTo(passScore) ? 'ADMITTED' : 'ELIMINATED' };
}
export function decideGradingResult(
  version: { decisionRule: string; tieBreakRule: string | null },
  rounds: { id: number; gradingMode: string }[],
  records: { gradingRoundId: number; status: string; roundResult: string | null }[],
) {
  const byRound = new Map(records.map((r) => [r.gradingRoundId, r]));
  if (!rounds.length || rounds.some((r) => byRound.get(r.id)?.status !== 'COMPLETED')) return null;
  const effective =
    version.decisionRule === 'MANUAL_PRIORITY'
      ? rounds.filter((r) => r.gradingMode === 'MANUAL')
      : rounds;
  if (
    !effective.length ||
    effective.some(
      (r) => !['ADMITTED', 'ELIMINATED'].includes(byRound.get(r.id)!.roundResult ?? ''),
    )
  )
    throw new AppError(500, 'INTERNAL_ERROR', '绑定版本的裁决配置或轮次结论异常');
  const admittedCount = effective.filter(
    (r) => byRound.get(r.id)!.roundResult === 'ADMITTED',
  ).length;
  const eliminatedCount = effective.length - admittedCount;
  const finalResult =
    admittedCount > eliminatedCount ||
    (admittedCount === eliminatedCount &&
      version.decisionRule === 'MAJORITY' &&
      version.tieBreakRule === 'LENIENT')
      ? 'ADMITTED'
      : 'ELIMINATED';
  return {
    decisionRule: version.decisionRule,
    ...(version.tieBreakRule ? { tieBreakRule: version.tieBreakRule } : {}),
    effectiveRoundCount: effective.length,
    admittedCount,
    eliminatedCount,
    finalResult,
  };
}
