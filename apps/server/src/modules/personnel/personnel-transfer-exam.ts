import type { PrismaClient } from '@prisma/client';
import { consumeTransferExam } from './personnel-transfer.service.js';

// Grading/cancellation is already committed. A failed consumer leaves authoritative final facts
// available to the explicit compensation command; never lock a second project under an exam lock.
export async function tryConsumeTransferResult(db: PrismaClient, attemptId: number) {
  try {
    const a = await db.entranceExamAttempt.findUnique({ where: { id: attemptId } });
    if (a?.sourceBizType !== 'PROJECT_MEMBER_TRANSFER' || !a.sourceBizId) return;
    await consumeTransferExam(db, a.sourceBizId);
  } catch {
    console.warn('考试结果消费待补偿', { attemptId });
  }
}

export async function compensateTransferResults(db: PrismaClient) {
  const pending = await db.projectMemberMovement.findMany({
    where: {
      status: 'PROCESSING',
      flow: { status: 'PENDING', currentNodeCode: 'TARGET_ENTRANCE_EXAM' },
      targetExamAttempt: {
        OR: [{ cancelledAt: { not: null } }, { finalDecidedAt: { not: null } }],
      },
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  let completed = 0,
    skipped = 0,
    failed = 0;
  for (const m of pending) {
    try {
      if (await consumeTransferExam(db, m.id)) completed++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  return { completed, skipped, failed };
}
