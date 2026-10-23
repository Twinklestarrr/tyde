import { attendanceStatuses } from './attendance-domain.js';
import { scheduleHeaders } from './attendance.schema.js';
type Schema = Record<string, unknown>;
const text = (description: string, nullable = false): Schema => ({
  type: 'string',
  description,
  ...(nullable ? { nullable: true } : {}),
});
const integer = (description: string, nullable = false): Schema => ({
  type: 'integer',
  minimum: 0,
  maximum: 2147483647,
  description,
  ...(nullable ? { nullable: true } : {}),
});
const object = (
  description: string,
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', description, properties, required, additionalProperties: false });
const time = (description: string): Schema =>
  text(description + '；指定时区墙上时间，YYYY-MM-DD HH:mm:ss[.SSS]；无记录为null。', true);
const type = (description: string, nullable = false): Schema => ({
  ...text(description + '；CLOCK_IN=上班卡、CLOCK_OUT=下班卡。', nullable),
  enum: nullable ? ['CLOCK_IN', 'CLOCK_OUT', null] : ['CLOCK_IN', 'CLOCK_OUT'],
});
const orgId = {
  ...text('组织UUID；省略或null表示无有效组织的EXPERT本人；其他组织身份不能串用。', true),
  format: 'uuid',
};
const timezone = {
  ...text(
    'IANA时区；省略、空白或null默认Asia/Shanghai，服务端按该时区的当前自然日归属；不归并昨日班次。',
    true,
  ),
  maxLength: 64,
};
export const clockQuery = object(
  '本人当前打卡上下文；读取不生成事件或日考勤。',
  { orgId, timezone },
  [],
);
export const clockBody = {
  ...object(
    '本人工作台打卡；只接收预期类型，不接收用户ID、打卡时间或日期。',
    {
      orgId,
      timezone,
      clockType: {
        ...type('可选预期类型，仅用于检测页面状态过期，最终类型由服务端决定；null表示不校验', true),
        deprecated: true,
      },
      sourceRef: {
        ...text('可选前端流水号；省略、空白或null记null；仅追踪，不用于幂等。', true),
        maxLength: 128,
      },
      extJson: {
        description: '设备、浏览器或定位扩展JSON；省略或null不保存；不得包含凭证。不用于业务判型。',
      },
    },
    [],
  ),
  examples: [
    {
      timezone: 'Asia/Shanghai',
      clockType: 'CLOCK_IN',
      sourceRef: 'workbench-001',
      extJson: { device: 'desktop' },
    },
  ],
};
export const clockHeaders = scheduleHeaders;
export const clockContextResponse = {
  ...object('当前自然日打卡上下文；仅依据当前有效排班和原始事件。', {
    orgId,
    attendanceDate: { ...text('服务端在请求时区的当前自然日；YYYY-MM-DD。'), format: 'date' },
    serverTime: text('服务端在请求时区的当前时间；YYYY-MM-DD HH:mm:ss。'),
    scheduleId: integer('当前有效排班ID，无排班为null。', true),
    dayType: {
      ...text('排班类型；WORK=工作、REST=休息；无排班为null。', true),
      enum: ['WORK', 'REST', null],
    },
    shiftStartAt: time('预计上班'),
    shiftEndAt: time('预计下班'),
    firstClockInAt: time('今日最早上班卡'),
    lastClockOutAt: time('今日最晚下班卡'),
    nextClockType: type('下一次类型；排班不完整或跨天为null', true),
    buttonText: text('按钮文案：上班打卡、下班打卡或暂不可打卡。'),
    canClock: {
      type: 'boolean',
      description: '是否允许当前点击；提交时重新校验，页面状态可能过期。',
    },
    warning: text('无排班、休息日、缺上班卡或禁用提示；正常为null。', true),
  }),
  examples: [
    {
      orgId: null,
      attendanceDate: '2026-10-23',
      serverTime: '2026-10-23 09:00:00',
      scheduleId: null,
      dayType: null,
      shiftStartAt: null,
      shiftEndAt: null,
      firstClockInAt: null,
      lastClockOutAt: null,
      nextClockType: 'CLOCK_IN',
      buttonText: '上班打卡',
      canClock: true,
      warning: '当日未配置排班，本次打卡将记录为未排班',
    },
  ],
};
const status = (description: string): Schema => ({
  ...text(
    description +
      '；PRESENT=正常、LATE=迟到、EARLY_LEAVE=早退、LATE_EARLY=迟到且早退、LEAVE=请假、ABSENT=缺勤、REST=休息、UNSCHEDULED=未排班、REVIEW_REQUIRED=历史待复核；尚未出勤为null。',
    true,
  ),
  enum: [...attendanceStatuses, null],
});
export const clockResponse = {
  ...object('不可变打卡事件和当前日考勤；幂等重试返回原事件及最新日考勤，不增加版本或通知。', {
    eventId: integer('原始事件ID。'),
    eventNo: text('全局唯一事件号；由作用域、本人和幂等键确定。'),
    orgId,
    memberId: { ...text('用户组织关系UUID；个人为null。', true), format: 'uuid' },
    userId: { ...text('当前用户UUID。'), format: 'uuid' },
    clockType: type('本次服务端判定类型'),
    clockAt: text('服务端事件墙上时间，YYYY-MM-DD HH:mm:ss.SSS；不由客户端提交。'),
    timezone,
    sourceType: { ...text('来源；WORKBENCH_CLICK=工作台点击。'), enum: ['WORKBENCH_CLICK'] },
    dailyAttendance: object('基于当日事件重新计算的日考勤；人工修正最终状态保留。', {
      id: integer('日考勤ID。'),
      attendanceDate: { ...text('事件归属自然日；YYYY-MM-DD。'), format: 'date' },
      scheduleId: integer('排班ID，无排班为null。', true),
      expectedStartAt: time('预计上班'),
      expectedEndAt: time('预计下班'),
      firstClockInAt: time('最早上班卡'),
      lastClockOutAt: time('最晚下班卡'),
      autoStatus: status('自动状态'),
      finalStatus: status('最终状态'),
      lateMinutes: integer('迟到分钟数，向下取整，缺上班卡为0。'),
      earlyLeaveMinutes: integer('早退分钟数，向下取整，缺下班卡为0。'),
      workedMinutes: integer('最早上班至最晚下班跨度分钟数，向下取整，缺卡或反向为0；不扣休息。'),
      reviewRequired: { type: 'boolean', description: '是否需复核；新重算固定false。' },
      reviewReason: text('复核原因；新重算为null。', true),
      versionNo: integer('日考勤乐观锁版本；新事件递增，幂等重试不变。'),
    }),
  }),
  examples: [
    {
      eventId: 1,
      eventNo: 'CLK0123456789ABCDEF0123456789ABCDEF01234567',
      orgId: null,
      memberId: null,
      userId: '00000000-0000-4000-8000-000000000001',
      clockType: 'CLOCK_IN',
      clockAt: '2026-10-23 09:00:00.000',
      timezone: 'Asia/Shanghai',
      sourceType: 'WORKBENCH_CLICK',
      dailyAttendance: {
        id: 1,
        attendanceDate: '2026-10-23',
        scheduleId: null,
        expectedStartAt: null,
        expectedEndAt: null,
        firstClockInAt: '2026-10-23 09:00:00.000',
        lastClockOutAt: null,
        autoStatus: 'UNSCHEDULED',
        finalStatus: 'UNSCHEDULED',
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        workedMinutes: 0,
        reviewRequired: false,
        reviewReason: null,
        versionNo: 1,
      },
    },
  ],
};
