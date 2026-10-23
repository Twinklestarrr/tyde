import type { Prisma, OrgMemberSchedule, OrgAttendanceDaily } from '@prisma/client';
import { calculateClockDaily } from './attendance-clock.domain.js';
// 有原始事件时以事件为唯一计算依据；迁移前仅有首末快照的历史日考勤保留原证据。
export async function replayClockDaily(
  tx: Prisma.TransactionClient,
  schedule: OrgMemberSchedule,
  daily: OrgAttendanceDaily,
  today: string,
) {
  const events = await tx.attendanceClockEvent.findMany({
    where: {
      scopeKey: daily.scopeKey,
      userId: daily.userId,
      attendanceDate: daily.attendanceDate,
    },
  });
  return calculateClockDaily(schedule, daily, today, events.length ? events : undefined);
}
