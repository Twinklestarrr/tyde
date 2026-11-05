import type { ProjectJsonValue } from './projects.js';
import type { WorkbenchAttendanceStatus } from './workbench.js';

export type AttendanceClockType = 'CLOCK_IN' | 'CLOCK_OUT';
export interface AttendanceClockQuery {
  /** 有效组织成员须指定真实组织；无有效组织的EXPERT本人省略或null。 */
  orgId?: string | null;
  /** IANA时区，省略、null或空白默认Asia/Shanghai。 */
  timezone?: string | null;
}
export interface AttendanceClockInput extends AttendanceClockQuery {
  /** 每次真实点击新建；未知结果重试须保留原键和原作用域，跨日也返回原事件。 */
  idempotencyKey: string;
  /** 可选预期类型，仅检测状态变化；最终类型由服务端判定。 */
  clockType?: AttendanceClockType | null;
  sourceRef?: string | null;
  extJson?: ProjectJsonValue;
}
export interface AttendanceClockContext {
  orgId: string | null;
  attendanceDate: string;
  /** 请求时区的服务端墙上时间；不转换为本机时区。 */
  serverTime: string;
  scheduleId: number | null;
  dayType: 'WORK' | 'REST' | null;
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  firstClockInAt: string | null;
  lastClockOutAt: string | null;
  nextClockType: AttendanceClockType | null;
  buttonText: string;
  canClock: boolean;
  warning: string | null;
}
export interface AttendanceClockResult {
  eventId: number;
  eventNo: string;
  orgId: string | null;
  /** 组织成员关系UUID，个人为null；不是项目花名册成员ID。 */
  memberId: string | null;
  userId: string;
  clockType: AttendanceClockType;
  /** 原事件时区的墙上时间，YYYY-MM-DD HH:mm:ss.SSS。 */
  clockAt: string;
  timezone: string;
  sourceType: 'WORKBENCH_CLICK';
  dailyAttendance: {
    id: number;
    attendanceDate: string;
    scheduleId: number | null;
    expectedStartAt: string | null;
    expectedEndAt: string | null;
    firstClockInAt: string | null;
    lastClockOutAt: string | null;
    autoStatus: WorkbenchAttendanceStatus | null;
    finalStatus: WorkbenchAttendanceStatus | null;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    workedMinutes: number;
    reviewRequired: boolean;
    reviewReason: string | null;
    versionNo: number;
  };
}
export interface AttendanceClockApi {
  getAttendanceClockContext(input?: AttendanceClockQuery): Promise<AttendanceClockContext>;
  /** 同键重试只返回原事件及其原归属日最新考勤；不自动换键或重发未知请求。 */
  clockAttendance(input: AttendanceClockInput): Promise<AttendanceClockResult>;
}
