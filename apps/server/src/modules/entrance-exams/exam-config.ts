import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { parseProjectTime } from '../projects/project-time.js';
import type { ExamConfigInput } from './exam-config.types.js';
const bad = (message: string): never => {
  throw new AppError(400, 'VALIDATION_ERROR', message);
};
export function examScore(value: number | null | undefined, label: string): Prisma.Decimal {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad(`${label}必须为正数`);
  const score = new Prisma.Decimal(value);
  if (score.lte(0) || score.gt('99999999.99') || score.decimalPlaces() > 2)
    return bad(`${label}必须大于0且最多两位小数`);
  return score;
}
function sensitiveKey(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => sensitiveKey(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, v]) =>
        ['secret', 'password', 'apikey', 'accesstoken', 'token'].includes(
          key.replaceAll('_', '').replaceAll('-', '').toLowerCase(),
        ) || sensitiveKey(v, depth + 1),
    );
  return false;
}
export function prepareExamConfig(input: ExamConfigInput, now = new Date()) {
  if (
    !input.projectId ||
    !input.examName?.trim() ||
    !input.registrationDeadline ||
    !input.papers?.length ||
    !input.gradingRounds?.length
  )
    return bad('必填信息未填写');
  const examName = input.examName.trim();
  if (examName.length > 128 || input.papers.length > 20 || input.gradingRounds.length > 20)
    return bad('考试名称、试卷或轮次数量超过限制');
  const durationMinutes = input.durationMinutes ?? null;
  if (
    durationMinutes != null &&
    (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 2147483647)
  )
    return bad('答题时限必须为32位正整数或不限时');
  const registrationDeadline = parseProjectTime(input.registrationDeadline);
  if (registrationDeadline <= now) return bad('截止时间异常');
  const fullScore = examScore(input.fullScore, '试卷满分'),
    passScore = examScore(input.passScore, '准入分数线');
  if (passScore.gt(fullScore)) return bad('准入分数线不能超过试卷满分');
  const papers = input.papers.map((paper, index) => {
    if (
      !paper.questions?.length ||
      paper.questions.length > 200 ||
      (paper.paperName?.trim().length ?? 0) > 100
    )
      return bad('试卷名称或题目数量异常');
    const base = fullScore
      .div(paper.questions.length)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
    const last = fullScore.sub(base.mul(paper.questions.length - 1));
    if (paper.questions.length > 1 && base.lte(0)) return bad('试卷满分不足以为每道题分配有效分值');
    const questions = paper.questions.map((question, q) => {
      if (!question.questionContent?.trim() && !question.questionFiles?.length)
        return bad('题干或题干附件至少填写一项');
      if ((question.questionFiles?.length ?? 0) > 20 || (question.referenceFiles?.length ?? 0) > 20)
        return bad('每道题每类附件最多20个');
      const scoreSource = question.scoreSource ?? (question.score == null ? 'AUTO' : 'MANUAL');
      if (!['AUTO', 'MANUAL'].includes(scoreSource)) return bad('题目分值来源无效');
      const score =
        scoreSource === 'AUTO'
          ? q === paper.questions.length - 1
            ? last
            : base
          : examScore(question.score, '题目分值');
      return { request: question, score, scoreSource, sequenceNo: q + 1 };
    });
    if (!questions.reduce((sum, q) => sum.add(q.score), new Prisma.Decimal(0)).equals(fullScore))
      return bad(`试卷${index + 1}题目分值合计必须等于试卷满分`);
    return { paperName: paper.paperName?.trim() || null, sequenceNo: index + 1, questions };
  });
  const decisionRule = input.decisionRule ?? 'MAJORITY';
  if (!['MAJORITY', 'MANUAL_PRIORITY'].includes(decisionRule)) return bad('裁决规则无效');
  if (input.tieBreakRule != null && !['STRICT', 'LENIENT'].includes(input.tieBreakRule))
    return bad('平局规则无效');
  for (const round of input.gradingRounds) {
    if (round.gradingMode === 'AUTO') {
      if (
        !round.toolCode?.trim() ||
        !round.toolName?.trim() ||
        round.toolCode.length > 64 ||
        round.toolName.length > 128 ||
        round.reviewerUserIds?.length
      )
        return bad('自动阅卷轮次工具必填且不能配置阅卷人');
      if (sensitiveKey(round.toolConfig)) return bad('阅卷工具密钥或超深配置不得写入考试配置');
      if ((round.toolFiles?.length ?? 0) > 10) return bad('工具附件最多10个');
    } else if (round.gradingMode === 'MANUAL') {
      if (
        !round.reviewerUserIds?.length ||
        round.reviewerUserIds.length > 100 ||
        new Set(round.reviewerUserIds).size !== round.reviewerUserIds.length ||
        round.reviewerUserIds.some((id) => !id)
      )
        return bad('手动轮次阅卷人必填且不得重复');
      if (
        round.toolCode?.trim() ||
        round.toolName?.trim() ||
        round.toolConfig != null ||
        round.toolFiles?.length
      )
        return bad('手动阅卷轮次不能配置自动阅卷工具');
    } else return bad('阅卷模式无效');
  }
  if (
    decisionRule === 'MANUAL_PRIORITY' &&
    !input.gradingRounds.some((r) => r.gradingMode === 'MANUAL')
  )
    return bad('人工优先规则必须至少配置一轮手动阅卷');
  const needsTieBreak = decisionRule === 'MAJORITY' && input.gradingRounds.length % 2 === 0;
  if (needsTieBreak && !input.tieBreakRule) return bad('多数原则偶数轮必须配置平局规则');
  return {
    examName,
    durationMinutes,
    registrationDeadline,
    fullScore,
    passScore,
    decisionRule,
    tieBreakRule: needsTieBreak ? input.tieBreakRule! : null,
    papers,
    rounds: input.gradingRounds,
  };
}
