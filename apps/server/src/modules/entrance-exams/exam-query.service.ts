import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { displayName } from '../projects/project-detail.js';
import { projectTime } from '../projects/project-time.js';
import { requireExamViewer, requireProjectExam, type ExamLocator } from './exam-access.js';
import { queryExamAdmissions, type ExamAdmissionInput } from './exam-admission.js';
import { queryExamGradingDetail, type ExamGradingDetailInput } from './exam-grading-query.js';
export type { ExamLocator } from './exam-access.js';
export interface ExamRosterInput extends ExamLocator {
  keyword?: string | null;
  finalResult?: 'PENDING' | 'ADMITTED' | 'ELIMINATED' | null;
  current?: number | null;
  size?: number | null;
}
const jsonObject = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = (value: Date | null) => (value ? projectTime(value) : null);
export class ExamQueryService {
  constructor(readonly db: PrismaClient) {}
  async gradingDetail(input: ExamGradingDetailInput, principal: AuthPrincipal) {
    return this.db.$transaction((tx) => queryExamGradingDetail(tx, input, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async admissions(input: ExamAdmissionInput, principal: AuthPrincipal) {
    return this.db.$transaction((tx) => queryExamAdmissions(tx, input, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async detail(input: ExamLocator, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        await requireExamViewer(tx, input.projectId, principal);
        const exam = await requireProjectExam(tx, input);
        if (exam.status !== 'ACTIVE')
          throw new AppError(400, 'VALIDATION_ERROR', '已关闭考试不允许编辑');
        if (exam.currentVersionId == null)
          throw new AppError(500, 'INTERNAL_ERROR', '考试当前配置版本异常');
        const version = await tx.entranceExamVersion.findFirst({
          where: { id: exam.currentVersionId, examId: exam.id },
          include: {
            papers: {
              orderBy: { sequenceNo: 'asc' },
              include: { questions: { orderBy: { sequenceNo: 'asc' } } },
            },
            gradingRounds: { orderBy: { roundNo: 'asc' } },
          },
        });
        if (!version) throw new AppError(500, 'INTERNAL_ERROR', '考试当前配置版本异常');
        const ids = [
          ...new Set(
            version.gradingRounds.flatMap((round) =>
              Array.isArray(round.reviewersJson)
                ? round.reviewersJson.flatMap((item) =>
                    jsonObject(item) && typeof item.userId === 'string' && uuid.test(item.userId)
                      ? [item.userId.toLowerCase()]
                      : [],
                  )
                : [],
            ),
          ),
        ];
        const users = ids.length
          ? await tx.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, uid: true, displayName: true, realName: true },
            })
          : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        const reviewers = (value: Prisma.JsonValue | null) => {
          const copy = structuredClone(value);
          if (Array.isArray(copy))
            for (const item of copy) {
              if (!jsonObject(item) || typeof item.userId !== 'string') continue;
              const user = userById.get(item.userId.toLowerCase());
              if (user)
                item.name = displayName(
                  user.displayName,
                  user.realName,
                  typeof item.name === 'string' && item.name ? item.name : user.uid,
                );
            }
          return copy;
        };
        return {
          projectId: input.projectId,
          examId: exam.id,
          examNo: exam.examNo,
          status: exam.status,
          currentVersionId: version.id,
          versionNo: version.versionNo,
          examName: exam.examName,
          durationMinutes: version.durationMinutes,
          registrationDeadline: projectTime(version.registrationDeadline),
          fullScore: version.fullScore.toNumber(),
          passScore: version.passScore.toNumber(),
          decisionRule: version.decisionRule,
          tieBreakRule: version.tieBreakRule,
          papers: version.papers.map((paper) => ({
            paperId: paper.id,
            sequenceNo: paper.sequenceNo,
            paperName: paper.paperName,
            totalScore: paper.totalScore.toNumber(),
            questions: paper.questions.map((q) => ({
              questionId: q.id,
              sequenceNo: q.sequenceNo,
              questionContent: q.questionContent,
              questionFiles: structuredClone(q.questionFilesJson),
              requiredFlag: q.requiredFlag,
              score: q.score.toNumber(),
              scoreSource: q.scoreSource,
              referenceAnswer: q.referenceAnswer,
              referenceFiles: structuredClone(q.referenceFilesJson),
            })),
          })),
          gradingRounds: version.gradingRounds.map((round) => {
            const config = structuredClone(round.toolConfigJson);
            let toolConfig = config,
              toolFiles: Prisma.JsonValue | null = null;
            if (config && jsonObject(config)) {
              toolFiles = config.files ?? null;
              delete config.files;
              toolConfig = Object.keys(config).length ? config : null;
            }
            return {
              gradingRoundId: round.id,
              roundNo: round.roundNo,
              gradingMode: round.gradingMode,
              toolCode: round.toolCode,
              toolName: round.toolName,
              toolConfig,
              toolFiles,
              reviewers: reviewers(round.reviewersJson),
            };
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async management(projectId: number, principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const access = await requireExamViewer(tx, projectId, principal);
        const plan = await tx.projectProductionPlan.findUnique({
          where: { projectId },
          select: { needWrittenExam: true, maxActiveExamCount: true },
        });
        const exams = await tx.projectEntranceExam.findMany({
          where: { projectId, deleted: false },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const stats = exams.length
          ? await tx.entranceExamAttempt.groupBy({
              by: ['examId', 'finalResult'],
              where: { examId: { in: exams.map((e) => e.id) }, submittedAt: { not: null } },
              _count: { _all: true },
            })
          : [];
        const counts = new Map<number, { submitted: number; admitted: number }>();
        for (const row of stats) {
          const count = counts.get(row.examId) ?? { submitted: 0, admitted: 0 };
          count.submitted += row._count._all;
          if (row.finalResult === 'ADMITTED') count.admitted += row._count._all;
          counts.set(row.examId, count);
        }
        const activeExamCount = exams.filter((e) => e.status === 'ACTIVE').length,
          maxActiveExamCount = plan?.maxActiveExamCount ?? 1,
          needWrittenExam = plan?.needWrittenExam ?? false;
        const canCreateExam =
          access.canManage && needWrittenExam && activeExamCount < maxActiveExamCount;
        const createDisabledReason = !access.canManage
          ? '阅卷人仅可查看考试信息'
          : !needWrittenExam
            ? '生产计划未配置准入考试'
            : !canCreateExam
              ? '进行中考试数量已达项目配置上限'
              : null;
        return {
          projectId,
          needWrittenExam,
          activeExamCount,
          maxActiveExamCount,
          canCreateExam,
          createDisabledReason,
          exams: exams.map((exam) => {
            const count = counts.get(exam.id) ?? { submitted: 0, admitted: 0 };
            return {
              examId: exam.id,
              examNo: exam.examNo,
              examName: exam.examName,
              status: exam.status,
              examineeCount: count.submitted,
              admittedCount: count.admitted,
              admissionRate: count.submitted
                ? new Prisma.Decimal(count.admitted)
                    .mul(100)
                    .div(count.submitted)
                    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
                    .toNumber()
                : 0,
              currentVersionId: exam.currentVersionId,
              createdAt: projectTime(exam.createdAt),
              closedAt: time(exam.closedAt),
            };
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async roster(input: ExamRosterInput, principal: AuthPrincipal) {
    const current = Math.max(1, input.current ?? 1),
      size = Math.min(100, Math.max(1, input.size ?? 20));
    if (
      !Number.isSafeInteger(current) ||
      !Number.isInteger(size) ||
      !Number.isSafeInteger((current - 1) * size)
    )
      throw new AppError(400, 'VALIDATION_ERROR', '分页参数超出安全整数范围');
    return this.db.$transaction(
      async (tx) => {
        await requireExamViewer(tx, input.projectId, principal);
        await requireProjectExam(tx, input);
        const keyword = input.keyword?.trim();
        // contains保留旧LIKE中%/_的通配语义；不增加手机号等搜索字段。
        const where: Prisma.EntranceExamAttemptWhereInput = {
          examId: input.examId,
          ...(input.finalResult != null
            ? { submittedAt: { not: null }, finalResult: input.finalResult }
            : {}),
          ...(keyword
            ? {
                OR: [
                  { candidateName: { contains: keyword } },
                  { candidateUid: { contains: keyword } },
                  { organizationName: { contains: keyword } },
                ],
              }
            : {}),
        };
        const total = await tx.entranceExamAttempt.count({ where });
        const attempts =
          (current - 1) * size >= total
            ? []
            : await tx.entranceExamAttempt.findMany({
                where,
                skip: (current - 1) * size,
                take: size,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                include: { candidate: { select: { displayName: true, realName: true } } },
              });
        const grades = attempts.length
          ? await tx.entranceExamGradingRecord.findMany({
              where: { attemptId: { in: attempts.map((a) => a.id) } },
              orderBy: { gradingRoundId: 'asc' },
              include: { gradingRound: { select: { roundNo: true, gradingMode: true } } },
            })
          : [];
        const byAttempt = new Map<number, typeof grades>();
        for (const grade of grades) {
          const list = byAttempt.get(grade.attemptId) ?? [];
          list.push(grade);
          byAttempt.set(grade.attemptId, list);
        }
        return {
          current,
          size,
          total,
          pages: Math.ceil(total / size),
          records: attempts.map((a) => ({
            attemptId: a.id,
            attemptNo: a.attemptNo,
            candidateUserId: a.candidateUserId,
            candidateUid: a.candidateUid,
            candidateName: displayName(
              a.candidate.displayName,
              a.candidate.realName,
              a.candidateName?.trim() || a.candidateUid,
            ),
            organizationId: a.organizationId,
            organizationName: a.organizationName,
            finalResult: a.submittedAt ? a.finalResult : null,
            roundScores: (byAttempt.get(a.id) ?? []).map((g) => ({
              roundNo: g.gradingRound.roundNo,
              gradingMode: g.gradingRound.gradingMode,
              score: g.score?.toNumber() ?? null,
              roundResult: g.roundResult,
            })),
            enteredAt: time(a.enteredAt),
            submittedAt: time(a.submittedAt),
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
