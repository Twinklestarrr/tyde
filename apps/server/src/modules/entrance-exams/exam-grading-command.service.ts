import { tryConsumeTransferResult } from '../personnel/personnel-transfer-exam.js';
import { createHash } from 'node:crypto';
import type { AutoCallbackInput, AutoCompensateInput } from './exam-auto.types.js';
import { Prisma, type PrismaClient, type EntranceExamAttempt } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { reconcileTaskRounds } from '../projects/project-task-rounds.js';
import { requireExamManager, requireProjectExam, type ExamLocator } from './exam-access.js';
import {
  decideGradingResult,
  gradePaper,
  normalizeGradingItems,
  type GradingItemInput,
} from './exam-grading-rules.js';
import {
  collectGradingTasks,
  gradingTaskTypes,
  reviewerIds,
  refreshGradingSnapshots,
} from './exam-grading-tasks.js';

export interface ManualGradingInput extends ExamLocator {
  attemptId: number;
  gradingRecordId: number;
  conclusionSummary?: string | null;
  items: GradingItemInput[];
}
const bad = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const conflict = (message: string) => new AuthError(409, 'DUPLICATE', message);
export class ExamGradingCommandService {
  constructor(readonly db: PrismaClient) {}
  async manual(input: ManualGradingInput, principal: AuthPrincipal) {
    return this.submit(input, principal);
  }
  async compensate(input: AutoCompensateInput, principal: AuthPrincipal) {
    const record = await this.db.entranceExamGradingRecord.findUnique({
      where: { id: input.gradingRecordId },
      include: { attempt: true },
    });
    if (!record || record.attempt.examId !== input.examId)
      throw new AuthError(404, 'NOT_FOUND', '判卷记录不存在');
    return this.submit(
      { ...input, attemptId: record.attemptId, conclusionSummary: input.summary },
      principal,
      { compensate: input },
    );
  }
  async callback(input: AutoCallbackInput) {
    const record = await this.db.entranceExamGradingRecord.findUnique({
      where: { id: input.gradingRecordId },
      include: { attempt: true },
    });
    if (!record || record.attemptId !== input.attemptId)
      throw new AuthError(404, 'NOT_FOUND', '判卷记录不存在');
    return this.submit(
      {
        ...input,
        examId: record.attempt.examId,
        conclusionSummary: input.summary,
        items: input.items ?? [],
      },
      null,
      { callback: input },
    );
  }
  private async submit(
    input: ManualGradingInput,
    principal: AuthPrincipal | null,
    auto?: { callback?: AutoCallbackInput; compensate?: AutoCompensateInput },
  ) {
    if (auto?.callback?.status === 'FAILED' && auto.callback.items != null)
      throw bad('失败回调不得携带逐题判定');
    const submitted =
      auto?.callback?.status === 'FAILED'
        ? new Map<number, GradingItemInput>()
        : normalizeGradingItems(input.items);
    const actor = principal?.uid ?? 'SYSTEM';
    const operation = auto?.callback
      ? 'entrance-exam.auto.callback'
      : auto
        ? 'entrance-exam.auto.compensate'
        : 'entrance-exam.manual';
    if (
      input.conclusionSummary != null &&
      (typeof input.conclusionSummary !== 'string' || input.conclusionSummary.length > 5000)
    )
      throw bad('结论总结最多5000字');
    if (!auto?.callback && (!principal || !['NAVIGATOR', 'PM', 'EXPERT'].includes(principal.role)))
      throw new AuthError(403, 'FORBIDDEN', '当前角色不允许提交阅卷');
    try {
      const result = await this.db.$transaction(
        async (tx) => {
          // 与配置、任职和待办写入统一项目锁；再锁应试、执行记录，避免跨轮提交遗漏裁决。
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} AND "deleted" = false FOR UPDATE`;
          if (auto?.compensate) await requireExamManager(tx, input.projectId, principal!);
          await requireProjectExam(tx, input);
          await tx.$queryRaw`SELECT "id" FROM "EntranceExamAttempt" WHERE "id" = ${input.attemptId} AND "examId" = ${input.examId} FOR UPDATE`;
          const attempt = await tx.entranceExamAttempt.findFirst({
            where: { id: input.attemptId, examId: input.examId },
          });
          if (!attempt) throw new AuthError(404, 'NOT_FOUND', '应试记录不存在');
          await tx.$queryRaw`SELECT "id" FROM "EntranceExamGradingRecord" WHERE "id" = ${input.gradingRecordId} AND "attemptId" = ${attempt.id} FOR UPDATE`;
          const record = await tx.entranceExamGradingRecord.findFirst({
            where: { id: input.gradingRecordId, attemptId: attempt.id },
            include: { gradingRound: true },
          });
          if (!record) throw new AuthError(404, 'NOT_FOUND', '判卷记录不存在');
          const round = record.gradingRound;
          if (
            round.gradingMode !== (auto ? 'AUTO' : 'MANUAL') ||
            round.examVersionId !== attempt.examVersionId
          )
            throw bad('判卷模式或绑定版本不匹配');
          let callbackDigest: string | null = null;
          if (auto?.callback) {
            const cb = auto.callback;
            if (
              cb.examVersionId !== attempt.examVersionId ||
              cb.paperId !== attempt.paperId ||
              cb.roundNo !== round.roundNo
            )
              throw bad('回调版本、试卷或轮次不匹配');
            if (!record.toolTraceId || cb.toolTraceId !== record.toolTraceId)
              throw conflict('不是当前自动阅卷执行的回调');
            callbackDigest = createHash('sha256')
              .update(
                JSON.stringify({
                  status: cb.status,
                  summary: cb.summary?.trim() || null,
                  errorCode: cb.errorCode?.trim() || null,
                  errorMessage: cb.errorMessage?.trim() || null,
                  items: [...submitted.values()]
                    .sort((a, b) => a.questionId - b.questionId)
                    .map((i) => ({
                      questionId: i.questionId,
                      correctness: i.correctness,
                      gradingOpinion: i.gradingOpinion ?? null,
                    })),
                }),
              )
              .digest('hex');
            if (['COMPLETED', 'FAILED'].includes(record.status)) {
              if (record.callbackDigest !== callbackDigest)
                throw conflict('重复回调内容与已保存结果不同');
              return gradingResponse(attempt, record);
            }
            if (record.status !== 'PROCESSING') throw conflict('当前判卷记录不接受回调');
          } else if (auto?.compensate) {
            if (!['FAILED', 'COMPLETED'].includes(record.status))
              throw bad('只有失败或已完成的自动阅卷记录可以补偿');
          } else {
            if (!reviewerIds(round.reviewersJson).includes(principal!.userId))
              throw new AuthError(403, 'FORBIDDEN', '当前用户不是本轮配置的阅卷人');
            if (record.status === 'COMPLETED') throw conflict('本轮阅卷结果已提交，不可修改');
            if (!['PENDING', 'PROCESSING'].includes(record.status))
              throw bad('当前判卷记录状态不允许提交人工阅卷');
          }
          if (!attempt.submittedAt || !attempt.examVersionId || !attempt.paperId)
            throw bad('考生尚未提交或绑定答卷');
          const version = await tx.entranceExamVersion.findFirst({
            where: { id: attempt.examVersionId, examId: input.examId },
            include: { gradingRounds: { orderBy: { roundNo: 'asc' } } },
          });
          if (!version) throw new AuthError(500, 'INTERNAL_ERROR', '应试记录绑定的考试版本异常');
          const records = await tx.entranceExamGradingRecord.findMany({
            where: { attemptId: attempt.id },
          });
          if (
            version.gradingRounds
              .filter((r) => r.roundNo < round.roundNo)
              .some(
                (r) => !records.some((v) => v.gradingRoundId === r.id && v.status === 'COMPLETED'),
              )
          )
            throw bad('前一轮阅卷尚未完成');
          if (auto?.callback?.status === 'FAILED') {
            const before = await collectGradingTasks(tx, input.projectId),
              now = new Date();
            const cb = auto.callback;
            const failed = await tx.entranceExamGradingRecord.update({
              where: { id: record.id },
              data: {
                status: 'FAILED',
                callbackDigest,
                completedAt: now,
                errorMessage:
                  `${cb.errorCode?.trim() ? cb.errorCode.trim() + ': ' : ''}${cb.errorMessage?.trim() || '模拟自动阅卷失败'}`.slice(
                    0,
                    1000,
                  ),
                updatedBy: actor,
              },
            });
            const updated = await tx.entranceExamAttempt.update({
              where: { id: attempt.id },
              data: { gradingStatus: 'IN_PROGRESS', updatedBy: actor },
            });
            const cardChanges = await syncGradingTasks(tx, input.projectId, before, now);
            await tx.projectEventOutbox.create({
              data: {
                projectId: input.projectId,
                eventType: 'EXAM_AUTO_FAILED',
                operation,
                payload: {
                  ...cardChanges,
                  provider: 'mock',
                  gradingRecordId: record.id,
                  toolTraceId: record.toolTraceId,
                },
              },
            });
            return gradingResponse(updated, failed);
          }
          const paper = await tx.entranceExamPaper.findFirst({
            where: { id: attempt.paperId, examVersionId: version.id },
            include: { questions: true },
          });
          if (!paper) throw new AuthError(500, 'INTERNAL_ERROR', '应试记录绑定的试卷异常');
          const items = await tx.entranceExamGradingItem.findMany({
            where: { gradingRecordId: record.id },
            include: { answer: true },
          });
          if (
            items.length !== paper.questions.length ||
            items.some(
              (i) =>
                i.attemptId !== attempt.id ||
                i.answer.attemptId !== attempt.id ||
                i.answer.paperId !== paper.id ||
                i.answer.questionId !== i.questionId ||
                !paper.questions.some((q) => q.id === i.questionId),
            )
          )
            throw bad('逐题判卷来源不完整或与实际试卷不一致');
          const result = gradePaper(paper.questions, submitted, version.passScore);
          const before = await collectGradingTasks(tx, input.projectId),
            now = new Date();
          for (const item of items)
            await tx.entranceExamGradingItem.update({
              where: { id: item.id },
              data: {
                correctness: submitted.get(item.questionId)!.correctness,
                gradingOpinion: submitted.get(item.questionId)!.gradingOpinion,
                updatedBy: actor,
              },
            });
          const completed = await tx.entranceExamGradingRecord.update({
            where: { id: record.id },
            data: {
              ...result,
              status: 'COMPLETED',
              reviewerUserId: principal?.userId ?? null,
              ...(auto
                ? { toolTraceId: auto.compensate ? null : record.toolTraceId, callbackDigest }
                : {}),
              conclusionSummary:
                input.conclusionSummary?.trim() ||
                `考生得分为${result.score.toString()}，本轮结论为${result.roundResult === 'ADMITTED' ? '准入' : '淘汰'}`,
              errorMessage: null,
              startedAt: record.startedAt ?? now,
              completedAt: now,
              updatedBy: actor,
            },
          });
          const next =
            auto?.compensate && record.status === 'COMPLETED'
              ? undefined
              : version.gradingRounds.find((r) => r.roundNo > round.roundNo);
          if (next) {
            const nextRecord = records.find((r) => r.gradingRoundId === next.id);
            if (!nextRecord || nextRecord.status !== 'WAITING')
              throw conflict('下一轮阅卷状态已发生变化');
            await tx.entranceExamGradingRecord.update({
              where: { id: nextRecord.id },
              data: { status: 'PENDING', updatedBy: actor },
            });
            if (next.gradingMode === 'AUTO')
              await tx.projectEventOutbox.create({
                data: {
                  projectId: input.projectId,
                  eventType: 'EXAM_AUTO_DISPATCH_REQUESTED',
                  operation,
                  actorUserId: principal?.userId,
                  payload: {
                    gradingRecordId: nextRecord.id,
                    provider: 'mock',
                    executionStatus: 'NOT_EXECUTED',
                  },
                },
              });
          }
          const decision = decideGradingResult(
            version,
            version.gradingRounds,
            records.map((r) => (r.id === completed.id ? completed : r)),
          );
          const updatedAttempt = await tx.entranceExamAttempt.update({
            where: { id: attempt.id },
            data: decision
              ? {
                  gradingStatus: 'COMPLETED',
                  finalResult: decision.finalResult,
                  finalDecidedAt: now,
                  decisionDetailJson: decision,
                  updatedBy: actor,
                }
              : { gradingStatus: 'IN_PROGRESS', updatedBy: actor },
          });
          if (
            decision &&
            auto?.compensate &&
            attempt.finalResult !== 'PENDING' &&
            attempt.finalResult !== decision.finalResult
          ) {
            if (attempt.sourceBizType === 'PROJECT_MEMBER_TRANSFER')
              throw bad('转项考试结论已被审批使用，不允许反转');
            if (attempt.finalResult === 'ADMITTED') {
              await tx.$queryRaw`SELECT "id" FROM "ProjectMember" WHERE "admissionAttemptId" = ${attempt.id} FOR UPDATE`;
              const member = await tx.projectMember.findUnique({
                where: { admissionAttemptId: attempt.id },
              });
              if (member) {
                if (
                  member.projectId !== input.projectId ||
                  member.status !== 'PENDING_CONFIRM' ||
                  member.joinedAt
                )
                  throw bad('该结论已被入项流程使用，不允许修正为淘汰');
                await tx.projectMember.delete({ where: { id: member.id } });
              }
            }
          }
          if (auto?.compensate)
            await tx.projectEventOutbox.create({
              data: {
                projectId: input.projectId,
                eventType: 'EXAM_AUTO_COMPENSATED',
                operation,
                actorUserId: principal?.userId,
                payload: {
                  gradingRecordId: record.id,
                  previousFinalResult: attempt.finalResult,
                  finalResult: updatedAttempt.finalResult,
                  reason: auto.compensate.compensationReason?.trim() || null,
                  provider: 'mock',
                },
              },
            });
          if (decision) {
            if (
              decision.finalResult === 'ADMITTED' &&
              attempt.sourceBizType !== 'PROJECT_MEMBER_TRANSFER'
            )
              await ensurePendingMember(tx, input.projectId, updatedAttempt, now);
            await tx.projectEventOutbox.create({
              data: {
                projectId: input.projectId,
                eventType: 'EXAM_RESULT_DECIDED',
                operation,
                actorUserId: principal?.userId,
                payload: {
                  attemptId: attempt.id,
                  sourceBizType: attempt.sourceBizType,
                  sourceBizId: attempt.sourceBizId,
                  finalResult: decision.finalResult,
                },
              },
            });
          }
          const after = await collectGradingTasks(tx, input.projectId);
          await reconcileTaskRounds(
            tx,
            input.projectId,
            before,
            after,
            !principal || principal.role === 'EXPERT'
              ? null
              : { userId: principal.userId, role: principal.role as 'NAVIGATOR' | 'PM' },
            ['ENTRANCE_EXAM_GRADING'],
            [],
            gradingTaskTypes,
            now,
          );
          const cardChanges = await refreshGradingSnapshots(tx, input.projectId, after, now);
          await tx.projectEventOutbox.create({
            data: {
              projectId: input.projectId,
              eventType: 'EXAM_REVIEW_QUEUE_CHANGED',
              operation,
              actorUserId: principal?.userId,
              payload: {
                attemptId: attempt.id,
                ...cardChanges,
                completedRoundId: round.id,
                nextRoundId: next?.id ?? null,
                reviewerUserIds: [
                  ...new Set([
                    ...reviewerIds(round.reviewersJson),
                    ...(next?.gradingMode === 'MANUAL' ? reviewerIds(next.reviewersJson) : []),
                  ]),
                ],
                deliveryStatus: 'NOT_DELIVERED',
              },
            },
          });
          return gradingResponse(updatedAttempt, completed);
        },
        { timeout: 30000 },
      );
      await tryConsumeTransferResult(this.db, input.attemptId);
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      )
        throw conflict('阅卷状态或准入来源发生冲突，请刷新后重试');
      throw error;
    }
  }
}

async function ensurePendingMember(
  tx: Prisma.TransactionClient,
  projectId: number,
  attempt: EntranceExamAttempt,
  now: Date,
) {
  if (attempt.sourceBizType !== 'EXPERT_ORDER' || !attempt.sourceBizId)
    throw new AuthError(500, 'INTERNAL_ERROR', '准入成员接单来源不完整');
  await tx.$queryRaw`SELECT "id" FROM "ProjectExpertAssignment" WHERE "id" = ${attempt.sourceBizId} AND "projectId" = ${projectId} FOR UPDATE`;
  const assignment = await tx.projectExpertAssignment.findFirst({
    where: { id: attempt.sourceBizId, projectId },
  });
  if (!assignment) throw new AuthError(500, 'INTERNAL_ERROR', '准入成员接单来源不存在');
  if (assignment.status !== 'ACCEPTED') return; // 保留考试结论，但失效接单不再获得席位。
  if (assignment.subjectType === 'INDIVIDUAL') {
    if (
      assignment.expertUserId !== attempt.candidateUserId ||
      attempt.organizationId !== null ||
      attempt.userOrgRelId !== null
    )
      throw new AuthError(500, 'INTERNAL_ERROR', '个人接单与考生来源不一致');
  } else if (
    assignment.subjectType === 'ORGANIZATION' &&
    assignment.organizationId === attempt.organizationId &&
    attempt.userOrgRelId
  ) {
    const membership = await tx.userOrgRel.findFirst({
      where: {
        id: attempt.userOrgRelId,
        userId: attempt.candidateUserId,
        orgId: attempt.organizationId!,
      },
    });
    if (!membership) throw new AuthError(500, 'INTERNAL_ERROR', '组织考生来源不一致');
  } else throw new AuthError(500, 'INTERNAL_ERROR', '接单与考生组织来源不一致');
  const existing = await tx.projectMember.findUnique({ where: { admissionAttemptId: attempt.id } });
  if (existing) {
    if (
      existing.projectId !== projectId ||
      existing.userId !== attempt.candidateUserId ||
      existing.expertAssignmentId !== assignment.id
    )
      throw conflict('准入成员来源冲突');
    return;
  }
  await tx.projectMember.create({
    data: {
      projectId,
      userId: attempt.candidateUserId,
      userOrgRelId: attempt.userOrgRelId,
      organizationId: attempt.organizationId,
      expertAssignmentId: assignment.id,
      admissionAttemptId: attempt.id,
      admittedAt: now,
      status: 'PENDING_CONFIRM',
      projectRole: 'MEMBER',
      createdBy: 'SYSTEM',
      updatedBy: 'SYSTEM',
    },
  });
  await tx.projectEventOutbox.create({
    data: {
      projectId,
      eventType: 'MEMBER_ENTRY_CONFIRMATION_REQUIRED',
      operation: 'entrance-exam.admission',
      payload: { attemptId: attempt.id, userId: attempt.candidateUserId },
    },
  });
}

export function gradingResponse(
  attempt: { id: number; gradingStatus: string; finalResult: string },
  record: { id: number; status: string; score: Prisma.Decimal | null; roundResult: string | null },
) {
  return {
    attemptId: attempt.id,
    gradingRecordId: record.id,
    recordStatus: record.status,
    score: record.score?.toNumber() ?? null,
    roundResult: record.roundResult,
    gradingStatus: attempt.gradingStatus,
    finalResult: attempt.finalResult,
  };
}
export async function syncGradingTasks(
  tx: Prisma.TransactionClient,
  projectId: number,
  before: Awaited<ReturnType<typeof collectGradingTasks>>,
  now: Date,
) {
  const after = await collectGradingTasks(tx, projectId);
  await reconcileTaskRounds(
    tx,
    projectId,
    before,
    after,
    null,
    ['ENTRANCE_EXAM_GRADING'],
    [],
    gradingTaskTypes,
    now,
  );
  return refreshGradingSnapshots(tx, projectId, after, now);
}
