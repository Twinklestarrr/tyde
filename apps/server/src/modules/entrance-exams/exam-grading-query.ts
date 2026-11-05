import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { displayName } from '../projects/project-detail.js';
import { requireExamViewer, requireProjectExam, type ExamLocator } from './exam-access.js';

export interface ExamGradingDetailInput extends ExamLocator {
  attemptId: number;
  roundNo?: number | null;
}
export async function queryExamGradingDetail(
  tx: Prisma.TransactionClient,
  input: ExamGradingDetailInput,
  principal: AuthPrincipal,
) {
  await requireExamViewer(tx, input.projectId, principal);
  await requireProjectExam(tx, input);
  const attempt = await tx.entranceExamAttempt.findFirst({
    where: { id: input.attemptId, examId: input.examId },
    include: { candidate: { select: { displayName: true, realName: true } } },
  });
  if (!attempt) throw new AppError(404, 'NOT_FOUND', '应试记录不存在');
  if (attempt.examVersionId === null || attempt.paperId === null)
    throw new AppError(400, 'VALIDATION_ERROR', '考生尚未进入考试');
  const version = await tx.entranceExamVersion.findFirst({
    where: { id: attempt.examVersionId, examId: input.examId },
    include: { gradingRounds: { orderBy: { roundNo: 'asc' } } },
  });
  if (!version) throw new AppError(500, 'INTERNAL_ERROR', '应试记录绑定的考试版本异常');
  const selected = version.gradingRounds.find((r) => r.roundNo === (input.roundNo ?? 1));
  if (!selected) throw new AppError(400, 'VALIDATION_ERROR', '判卷轮次不存在');
  const paper = await tx.entranceExamPaper.findFirst({
    where: { id: attempt.paperId, examVersionId: version.id },
    include: { questions: { orderBy: { sequenceNo: 'asc' } } },
  });
  if (!paper) throw new AppError(500, 'INTERNAL_ERROR', '应试记录绑定的试卷异常');
  const records = await tx.entranceExamGradingRecord.findMany({ where: { attemptId: attempt.id } });
  const byRound = new Map(records.map((r) => [r.gradingRoundId, r]));
  const selectedRecord = byRound.get(selected.id);
  const answers = await tx.entranceExamAnswer.findMany({ where: { attemptId: attempt.id } });
  const items = selectedRecord
    ? await tx.entranceExamGradingItem.findMany({ where: { gradingRecordId: selectedRecord.id } })
    : [];
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const byItem = new Map(items.map((i) => [i.questionId, i]));
  const summary = (round: (typeof version.gradingRounds)[number]) => {
    const record = byRound.get(round.id);
    return {
      gradingRoundId: round.id,
      gradingRecordId: record?.id ?? null,
      roundNo: round.roundNo,
      gradingMode: round.gradingMode,
      status: record?.status ?? null,
      score: record?.score?.toNumber() ?? null,
      roundResult: record?.roundResult ?? null,
      conclusionSummary: record?.conclusionSummary ?? null,
      errorMessage: record?.errorMessage ?? null,
    };
  };
  return {
    examId: input.examId,
    attemptId: attempt.id,
    candidateUid: attempt.candidateUid,
    candidateName: displayName(
      attempt.candidate.displayName,
      attempt.candidate.realName,
      attempt.candidateName?.trim() || attempt.candidateUid,
    ),
    passScore: version.passScore.toNumber(),
    gradingStatus: attempt.gradingStatus,
    finalResult: attempt.finalResult,
    rounds: version.gradingRounds.map(summary),
    selectedRound: summary(selected),
    questions: paper.questions.map((q) => {
      const answer = byQuestion.get(q.id),
        item = byItem.get(q.id);
      return {
        questionId: q.id,
        sequenceNo: q.sequenceNo,
        questionContent: q.questionContent,
        questionFiles: structuredClone(q.questionFilesJson),
        score: q.score.toNumber(),
        referenceAnswer: q.referenceAnswer,
        referenceFiles: structuredClone(q.referenceFilesJson),
        answerId: answer?.id ?? null,
        answerContent: answer?.answerContent ?? null,
        answerFiles: structuredClone(answer?.answerFilesJson ?? null),
        answeredFlag: answer?.answeredFlag === true,
        correctness: item?.correctness ?? null,
        gradingOpinion: item?.gradingOpinion ?? null,
      };
    }),
  };
}
