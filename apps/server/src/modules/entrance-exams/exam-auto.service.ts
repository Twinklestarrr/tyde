import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { requireExamManager, requireProjectExam } from './exam-access.js';
import { collectGradingTasks } from './exam-grading-tasks.js';
import {
  ExamGradingCommandService,
  gradingResponse,
  syncGradingTasks,
} from './exam-grading-command.service.js';
import type { AutoCallbackInput, AutoRetryInput } from './exam-auto.types.js';

// 仅持久化模拟执行状态，不构造真实Agent地址或外部附件凭证。
export class ExamAutoService {
  constructor(readonly db: PrismaClient) {}
  async retry(input: AutoRetryInput, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
        await requireExamManager(tx, input.projectId, principal);
        await requireProjectExam(tx, input);
        const { record, attempt } = await lockedAutoRecord(tx, input.gradingRecordId);
        if (attempt.examId !== input.examId)
          throw new AuthError(404, 'NOT_FOUND', '判卷记录不属于该考试');
        if (record.status !== 'FAILED')
          throw new AuthError(400, 'VALIDATION_ERROR', '只有自动阅卷失败记录可以重试');
        const before = await collectGradingTasks(tx, input.projectId),
          now = new Date();
        const pending = await tx.entranceExamGradingRecord.update({
          where: { id: record.id },
          data: {
            status: 'PENDING',
            toolTraceId: null,
            callbackDigest: null,
            score: null,
            roundResult: null,
            conclusionSummary: null,
            errorMessage: null,
            reviewerUserId: null,
            startedAt: null,
            completedAt: null,
            updatedBy: principal.uid,
          },
        });
        await tx.entranceExamGradingItem.updateMany({
          where: { gradingRecordId: record.id },
          data: { correctness: 'PENDING', gradingOpinion: null, updatedBy: principal.uid },
        });
        const updated = await tx.entranceExamAttempt.update({
          where: { id: attempt.id },
          data: { gradingStatus: 'PENDING', updatedBy: principal.uid },
        });
        const cardChanges = await syncGradingTasks(tx, input.projectId, before, now);
        await tx.projectEventOutbox.create({
          data: {
            projectId: input.projectId,
            eventType: 'EXAM_AUTO_DISPATCH_REQUESTED',
            operation: 'entrance-exam.auto.retry',
            actorUserId: principal.userId,
            payload: {
              ...cardChanges,
              gradingRecordId: record.id,
              provider: 'mock',
              executionStatus: 'NOT_EXECUTED',
            },
          },
        });
        return gradingResponse(updated, pending);
      },
      { timeout: 30000 },
    );
  }
  async claim(recordId: number): Promise<AutoCallbackInput | null> {
    const located = await this.db.entranceExamGradingRecord.findUnique({
      where: { id: recordId },
      include: { attempt: { include: { exam: true } } },
    });
    if (!located) return null;
    const projectId = located.attempt.exam.projectId;
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deleted" = false FOR UPDATE`;
        await requireProjectExam(tx, { projectId, examId: located.attempt.examId });
        const { record, attempt } = await lockedAutoRecord(tx, recordId);
        if (record.status !== 'PENDING') return null;
        const now = new Date(),
          toolTraceId = randomUUID();
        await tx.entranceExamGradingRecord.update({
          where: { id: record.id },
          data: {
            status: 'PROCESSING',
            toolTraceId,
            callbackDigest: null,
            startedAt: now,
            updatedBy: 'SYSTEM',
          },
        });
        await tx.entranceExamAttempt.update({
          where: { id: attempt.id },
          data: { gradingStatus: 'IN_PROGRESS', updatedBy: 'SYSTEM' },
        });
        await tx.projectEventOutbox.create({
          data: {
            projectId,
            eventType: 'EXAM_AUTO_MOCK_CLAIMED',
            operation: 'entrance-exam.auto.mock',
            payload: { gradingRecordId: record.id, provider: 'mock', toolTraceId },
          },
        });
        return {
          projectId,
          attemptId: attempt.id,
          examVersionId: attempt.examVersionId!,
          paperId: attempt.paperId!,
          roundNo: record.gradingRound.roundNo,
          gradingRecordId: record.id,
          toolTraceId,
          status: 'SUCCEEDED',
        };
      },
      { timeout: 30000 },
    );
  }
  async expireTimedOut(now = new Date(), minutes = 60) {
    const records = await this.db.entranceExamGradingRecord.findMany({
      where: {
        status: 'PROCESSING',
        gradingRound: { gradingMode: 'AUTO' },
        startedAt: { lte: new Date(now.getTime() - minutes * 60000) },
      },
      include: { gradingRound: true, attempt: { include: { exam: true } } },
      take: 100,
      orderBy: { startedAt: 'asc' },
    });
    let expired = 0;
    for (const r of records) {
      if (!r.toolTraceId || !r.attempt.examVersionId || !r.attempt.paperId) continue;
      try {
        await new ExamGradingCommandService(this.db).callback({
          projectId: r.attempt.exam.projectId,
          attemptId: r.attemptId,
          examVersionId: r.attempt.examVersionId,
          paperId: r.attempt.paperId,
          roundNo: r.gradingRound.roundNo,
          gradingRecordId: r.id,
          toolTraceId: r.toolTraceId,
          status: 'FAILED',
          errorCode: 'MOCK_TIMEOUT',
          errorMessage: '模拟执行回调超时',
        });
        expired++;
      } catch (error) {
        if (!(error instanceof AuthError && error.status === 409)) throw error;
      }
    }
    return expired;
  }
  // 显式运行的可控mock；deliver可接真实本地HTTP回调，执行不依赖远程Agent。
  async executeMock(
    recordId: number,
    outcome: 'correct' | 'incorrect' | 'failed' | 'timeout',
    deliver: (input: AutoCallbackInput) => Promise<unknown>,
  ) {
    const callback = await this.claim(recordId);
    if (!callback) return { provider: 'mock', claimed: false };
    if (outcome === 'timeout') return { provider: 'mock', claimed: true, callback: null };
    if (outcome === 'failed')
      Object.assign(callback, {
        status: 'FAILED',
        errorCode: 'MOCK_FAILURE',
        errorMessage: '可控模拟执行失败',
      });
    else {
      const items = await this.db.entranceExamGradingItem.findMany({
        where: { gradingRecordId: recordId },
        orderBy: { questionId: 'asc' },
      });
      callback.items = items.map((i) => ({
        questionId: i.questionId,
        correctness: outcome === 'correct' ? 'CORRECT' : 'INCORRECT',
        gradingOpinion: '模拟来源：可控mock判定',
      }));
      callback.summary = '模拟来源：可控mock执行完成';
    }
    try {
      await deliver(callback);
    } catch (error) {
      // 接收成功但响应丢失时，已完成结果不得被传输错误覆盖；业务层按当前trace与状态检查。
      try {
        await new ExamGradingCommandService(this.db).callback({
          ...callback,
          items: null,
          summary: null,
          status: 'FAILED',
          errorCode: 'MOCK_DELIVERY_FAILED',
          errorMessage: '本地模拟回调投递失败',
        });
      } catch (failure) {
        if (!(failure instanceof AuthError && failure.status === 409)) throw failure;
      }
      throw error;
    }
    return { provider: 'mock', claimed: true, delivered: true };
  }
}
async function lockedAutoRecord(tx: Prisma.TransactionClient, id: number) {
  const located = await tx.entranceExamGradingRecord.findUnique({ where: { id } });
  if (!located) throw new AuthError(404, 'NOT_FOUND', '判卷记录不存在');
  await tx.$queryRaw`SELECT "id" FROM "EntranceExamAttempt" WHERE "id" = ${located.attemptId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "EntranceExamGradingRecord" WHERE "id" = ${id} FOR UPDATE`;
  const record = await tx.entranceExamGradingRecord.findUniqueOrThrow({
    where: { id },
    include: { gradingRound: true, attempt: true },
  });
  const attempt = record.attempt,
    round = record.gradingRound;
  if (
    !attempt.submittedAt ||
    !attempt.examVersionId ||
    !attempt.paperId ||
    round.gradingMode !== 'AUTO' ||
    round.examVersionId !== attempt.examVersionId
  )
    throw new AuthError(400, 'VALIDATION_ERROR', '不是已交卷绑定版本的自动阅卷记录');
  const earlier = await tx.entranceExamGradingRound.findMany({
    where: { examVersionId: attempt.examVersionId, roundNo: { lt: round.roundNo } },
    include: { records: { where: { attemptId: attempt.id }, select: { status: true } } },
  });
  if (earlier.some((r) => r.records.length !== 1 || r.records[0]!.status !== 'COMPLETED'))
    throw new AuthError(400, 'VALIDATION_ERROR', '前一轮阅卷尚未完成');
  return { record, attempt };
}
