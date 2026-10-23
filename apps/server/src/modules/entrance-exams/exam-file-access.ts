import { requireCandidate } from './exam-candidate.service.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { AuthError } from '../auth/auth.error.js';
import type { PrismaClient } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { ManagementService } from '../management/management.service.js';
// 考生只读取本人绑定卷题干与答案；组织职责仅授予本组织答案，不放开参考答案。
export async function canReadManagedExamFile(
  db: PrismaClient,
  examId: number,
  principal: AuthPrincipal,
  objectKey?: string,
) {
  const exam = await db.projectEntranceExam.findFirst({
    where: { id: examId, deleted: false, project: { deleted: false } },
    select: { projectId: true, project: { select: { requesterId: true, createdBy: true } } },
  });
  if (!exam) return false;
  if (principal.role === 'EXPERT' && objectKey) {
    return db.$transaction(
      async (tx) => {
        let candidate: Awaited<ReturnType<typeof requireCandidate>> | undefined;
        try {
          candidate = await requireCandidate(tx, exam.projectId, principal.userId);
        } catch (error) {
          if (!(error instanceof AuthError) || ![403, 404].includes(error.status)) throw error;
        }
        const own = candidate
          ? await tx.entranceExamAttempt.findMany({
              where: {
                examId,
                candidateUserId: principal.userId,
                enteredAt: { not: null },
                sourceBizType: 'EXPERT_ORDER',
                organizationId: candidate.assignment.organizationId,
                userOrgRelId: candidate.relation?.id ?? null,
                sourceBizId: candidate.assignment.id,
              },
              select: { id: true, paperId: true },
            })
          : [];
        const questions = own.length
          ? await tx.entranceExamQuestion.findMany({
              where: {
                paperId: { in: own.flatMap((a) => (a.paperId === null ? [] : [a.paperId])) },
              },
              select: { questionFilesJson: true },
            })
          : [];
        const hasKey = (value: unknown) =>
          Array.isArray(value) &&
          value.some(
            (f) => f && typeof f === 'object' && !Array.isArray(f) && f.objectKey === objectKey,
          );
        if (questions.some((q) => hasKey(q.questionFilesJson))) return true;
        // 组织职责范围仅授予本组织考生答案；不把职责权限用于读取参考答案或其他组织答卷。
        const managed = await tx.projectExpertAssignment.findMany({
          where: {
            projectId: exam.projectId,
            subjectType: 'ORGANIZATION',
            status: 'ACCEPTED',
            organization: {
              deleted: false,
              memberships: {
                some: { userId: principal.userId, joinStatus: { in: participatingStatuses } },
              },
            },
          },
          include: {
            owners: true,
            organization: {
              include: {
                memberships: {
                  where: { userId: principal.userId, joinStatus: { in: participatingStatuses } },
                },
              },
            },
          },
        });
        const scopes = managed.filter(
          (a) =>
            a.organization?.memberships.some((r) => r.position === 'OWNER') ||
            (a.owners.length
              ? a.owners.some((o) => o.userId === principal.userId && o.status === 'ACTIVE')
              : a.projectOwnerUserId === principal.userId),
        );
        if (!own.length && !scopes.length) return false;
        const answers = await tx.entranceExamAnswer.findMany({
          where: {
            attempt: {
              examId,
              OR: [
                { id: { in: own.map((a) => a.id) } },
                ...scopes.map((a) => ({
                  organizationId: a.organizationId,
                  sourceBizType: 'EXPERT_ORDER',
                  sourceBizId: a.id,
                })),
              ],
            },
          },
          select: { answerFilesJson: true },
        });
        return answers.some((a) => hasKey(a.answerFilesJson));
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  const management = new ManagementService(db);
  if (
    (principal.userId === exam.project.requesterId || principal.uid === exam.project.createdBy) &&
    (await management.hasRole(principal, 'NAVIGATOR'))
  )
    return true;
  if (await management.hasRole(principal, 'NAVIGATOR')) {
    if (
      await db.entranceExamGradingRound.findFirst({
        where: {
          gradingMode: 'MANUAL',
          version: { examId },
          reviewersJson: { array_contains: [{ userId: principal.userId }] },
        },
        select: { id: true },
      })
    )
      return true;
  }
  if (await management.hasRole(principal, 'PM'))
    return Boolean(
      await db.projectManagerRecruitment.findFirst({
        where: {
          projectId: exam.projectId,
          status: 'ASSIGNED',
          OR: [
            { candidateUserId: principal.userId },
            { expertRecruitmentHandlerUserId: principal.userId },
          ],
        },
        select: { id: true },
      }),
    );
  return false;
}
