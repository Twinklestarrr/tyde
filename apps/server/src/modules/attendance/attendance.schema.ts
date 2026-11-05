import { authSchema, resultSchema } from '../auth/auth.schema.js';
import {
  calendarApplicationSchema,
  calendarDayPermissions,
} from './attendance-application.schema.js';
import { attendanceStatuses, calendarDay, manualStatuses, summarize } from './attendance.domain.js';
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
const bool = (description: string, nullable = false): Schema => ({
  type: 'boolean',
  description,
  ...(nullable ? { nullable: true } : {}),
});
const enumeration = (description: string, values: string[], nullable = false): Schema => ({
  ...text(description, nullable),
  enum: nullable ? [...values, null] : values,
});
const object = (
  description: string,
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', additionalProperties: false, description, properties, required });
const date = (description: string): Schema => ({
  ...text(description + '；yyyy-MM-dd自然日。'),
  format: 'date',
});
const orgId = {
  ...text('组织UUID；省略表示无组织个人作用域，已在组织的用户必须指定有效组织。'),
  format: 'uuid',
};
const id = '00000000-0000-4000-8000-000000000001';
export const attendanceQuery = object(
  '本人月度排班考勤查询，不接收用户或成员ID。',
  {
    month: { ...text('查询月份，YYYY-MM，1900年起。'), pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    orgId,
  },
  ['month'],
);
export const holidayQuery = {
  ...attendanceQuery,
  description: '节假日日历查询，所有登录用户可查；orgId仅兼容参数，不用于权限判断。',
  properties: {
    ...(attendanceQuery.properties as Record<string, Schema>),
    orgId: {
      ...orgId,
      description: '可选组织UUID，仅兼容旧请求，不用于权限判断，不影响日历结果。',
    },
  },
};
const shiftItem = object(
  '本人单日排班。',
  {
    scheduleDate: date('排班日期，不限制历史或未来，但不能重复'),
    dayType: enumeration('日类型：WORK=工作、REST=休息。', ['WORK', 'REST']),
    startTime: {
      ...text(
        '预计上班时间，HH:mm或HH:mm:ss；WORK条件必填，REST必须省略或null；不支持跨日。',
        true,
      ),
      pattern: '^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$',
    },
    endTime: {
      ...text('预计下班时间，HH:mm或HH:mm:ss；WORK条件必填且晚于上班，REST省略或null。', true),
      pattern: '^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$',
    },
  },
  ['scheduleDate', 'dayType'],
);
export const scheduleBody = {
  ...object(
    '无有效组织的EXPERT本人排班；用户身份由会话确定。',
    {
      schedules: {
        type: 'array',
        minItems: 1,
        maxItems: 366,
        description: '1至366条本人每日班次；日期不可重复。',
        items: shiftItem,
      },
      overwrite: bool('是否覆盖已有班次，必填；false跳过并返回冲突明细，true覆盖并增加版本。'),
      timezone: {
        ...text('IANA时区，省略/null/空白默认Asia/Shanghai；班次按该时区的本地时间解释。', true),
        maxLength: 64,
      },
    },
    ['schedules', 'overwrite'],
  ),
  examples: [
    {
      schedules: [
        { scheduleDate: '2026-10-21', dayType: 'WORK', startTime: '09:00', endTime: '18:00' },
        { scheduleDate: '2026-10-22', dayType: 'REST' },
      ],
      overwrite: false,
      timezone: 'Asia/Shanghai',
    },
  ],
};
export const scheduleHeaders = {
  description: '本人批量排班的幂等请求头；不代替身份认证。',
  type: 'object',
  additionalProperties: true,
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': {
      ...text(
        '请求唯一幂等键，1至128字符；按本人作用域保存，相同标准化参数重放原结果，不同参数同键409。',
      ),
      minLength: 1,
      maxLength: 128,
    },
  },
};
const statusDescription =
  '考勤状态：PRESENT=正常、LATE=迟到、EARLY_LEAVE=早退、LATE_EARLY=迟到且早退、LEAVE=请假、ABSENT=缺勤、REST=休息、UNSCHEDULED=未排班、REVIEW_REQUIRED=历史待复核。';
const day = object('本人一天排班与考勤；查询不创建排班或日考勤。', {
  scheduleId: integer('排班ID，未排班null。', true),
  scheduleDate: date('排班考勤日期'),
  calendarStatus: enumeration(
    '月历展示状态；' +
      statusDescription +
      'PENDING_ATTENDANCE=当天或未来待出勤；过去的工作排班无考勤显示ABSENT。',
    [...attendanceStatuses, 'PENDING_ATTENDANCE'],
  ),
  dayType: enumeration('排班日类型：WORK=工作、REST=休息；未排班null。', ['WORK', 'REST'], true),
  shiftStartAt: text('班次上班本地时间yyyy-MM-dd HH:mm:ss，按timezone解释；无班次null。', true),
  shiftEndAt: text('班次下班本地时间yyyy-MM-dd HH:mm:ss，按timezone解释；无班次null。', true),
  timezone: text('班次IANA时区，未排班null。', true),
  sourceType: enumeration(
    '排班来源：MANUAL=人工、AI_ASSISTANT=助手；无排班null。',
    ['MANUAL', 'AI_ASSISTANT'],
    true,
  ),
  batchNo: text('排班批次号，未记录null。', true),
  status: enumeration(
    '排班状态：ACTIVE=生效、CANCELED=取消；未排班null。',
    ['ACTIVE', 'CANCELED'],
    true,
  ),
  versionNo: integer('排班版本号，从0开始，未排班null。', true),
  dailyId: integer('日考勤ID，尚未生成日考勤null；直接修正仅接受已有日考勤。', true),
  autoStatus: enumeration(
    '系统自动状态；' +
      statusDescription +
      '尚无结论null；旧待复核记录按当前排班及打卡仅规范化响应。',
    attendanceStatuses,
    true,
  ),
  finalStatus: enumeration(
    '人工修正优先后的最终状态；' + statusDescription + '未生成或尚无结论null。',
    attendanceStatuses,
    true,
  ),
  firstClockInAt: text(
    '最早上班打卡本地时间yyyy-MM-dd HH:mm:ss.SSS，无记录null；打卡写接口尚未迁移。',
    true,
  ),
  lastClockOutAt: text('最晚下班打卡本地时间yyyy-MM-dd HH:mm:ss.SSS，无记录null。', true),
  reviewRequired: bool('是否需复核，未生成日考勤null。', true),
  reviewReason: text('复核原因，没有或未生成null。', true),
  manualOverride: bool('是否已人工修正，未生成日考勤null。', true),
  dailyVersionNo: integer('日考勤版本号，从0开始；无日考勤null。', true),
  application: calendarApplicationSchema,
  permissions: calendarDayPermissions,
});
const summary = object(
  '月汇总按calendarStatus累计；LATE_EARLY同时计迟到和早退；休息/未排班/待出勤不计入。',
  {
    presentCount: integer('正常出勤天数。'),
    lateCount: integer('迟到天数，含迟到且早退。'),
    earlyLeaveCount: integer('早退天数，含迟到且早退。'),
    leaveCount: integer('请假天数。'),
    absentCount: integer('缺勤天数，含历史工作排班无日考勤。'),
  },
);
const permissions = object('服务端根据当前作用域与权限计算的操作能力；写请求会再次校验。', {
  canBatchSchedule: bool('是否可为本人批量排班；仅无组织EXPERT为true。'),
  canDirectUpdate: bool(
    '是否有组织考勤直接修正权限；组织主管/管理员为true，仍须已有日考勤且非未来日期。',
  ),
  canApply: bool(
    '是否具备提交本人考勤申请身份：有效组织MEMBER/ADMIN为true；逐日排班、日期和待审冲突另见days.permissions；无组织/主管为false。',
  ),
  canWithdraw: bool(
    '当月是否有本人PENDING考勤申请可撤回；逐日见days.application及permissions，实际撤回仍检查流程版本。',
  ),
});
const exampleDays = Array.from({ length: 31 }, (_, i) => ({
  ...calendarDay(`2026-10-${String(i + 1).padStart(2, '0')}`, '2026-10-21'),
  application: null,
  permissions: {
    canApplyLeave: false,
    canApplyCorrection: false,
    canWithdraw: false,
    canDirectUpdate: false,
  },
}));
export const attendanceResponse = {
  ...object('本人月度排班考勤，days包含整个月每天一项。', {
    organizationId: { ...orgId, nullable: true, description: '组织UUID，无组织个人作用域null。' },
    independentSchedule: bool('是否无组织个人排班。'),
    month: text('查询月份YYYY-MM。'),
    memberId: { ...text('本人的组织成员关系UUID；个人作用域null。', true), format: 'uuid' },
    userId: { ...text('当前登录用户UUID。'), format: 'uuid' },
    realName: text('本人真实姓名，未填写null。', true),
    nickname: text('本人昵称，未填写null。', true),
    summary,
    days: {
      type: 'array',
      description: '当月完整每日月历，按日期升序，长度等于月天数。',
      items: day,
    },
    permissions,
  }),
  examples: [
    {
      organizationId: null,
      independentSchedule: true,
      month: '2026-10',
      memberId: null,
      userId: id,
      realName: '王小明',
      nickname: '小明',
      summary: summarize(exampleDays),
      days: exampleDays,
      permissions: {
        canBatchSchedule: true,
        canDirectUpdate: false,
        canApply: false,
        canWithdraw: false,
      },
    },
  ],
};
export const scheduleResponse = {
  ...object('批量排班结果，冲突跳过，其余同事务保存；同键重放原结果。', {
    batchNo: text('本次本人排班批次编号。'),
    createdCount: integer('新增条数。'),
    updatedCount: integer('覆盖条数。'),
    skippedCount: integer('跳过冲突条数。'),
    conflicts: {
      type: 'array',
      description: 'overwrite=false时跳过的已有排班；无冲突为空。',
      items: object('一条已有排班冲突。', {
        scheduleDate: date('日期'),
        scheduleId: integer('排班ID。'),
        versionNo: integer('已有排班版本号。'),
      }),
    },
  }),
  examples: [
    {
      batchNo: 'SELF-SCH-EXAMPLE',
      createdCount: 2,
      updatedCount: 0,
      skippedCount: 0,
      conflicts: [],
    },
  ],
};
export const holidayResponse = {
  ...object(
    '月度中国节假日安排；仅公布的放假/调休日，普通日期及周末不单独列出。远程不可用时可使用官方通知核对的2026年随包基线；其他年份无可用缓存/基线则503。',
    {
      month: text('查询月份YYYY-MM。'),
      days: {
        type: 'array',
        description: '当月法定放假或调休日，按日期升序；该月无特殊日期为空数组。',
        items: object('一条已公布节假日/调休安排。', {
          date: date('日期'),
          dayOfWeek: { ...integer('星期序号，周一1至周日7。'), minimum: 1, maximum: 7 },
          weekName: text('中文星期名称。'),
          calendarDayType: enumeration(
            '日历类型：PUBLIC_HOLIDAY=法定放假日、MAKEUP_WORKDAY=调休工作日。',
            ['PUBLIC_HOLIDAY', 'MAKEUP_WORKDAY'],
          ),
          holidayName: text('节假日名称。'),
          defaultScheduleDayType: enumeration(
            '建议默认排班类型：WORK=工作、REST=休息，不自动写排班。',
            ['WORK', 'REST'],
          ),
        }),
      },
    },
  ),
  examples: [
    {
      month: '2026-10',
      days: [
        {
          date: '2026-10-01',
          dayOfWeek: 4,
          weekName: '星期四',
          calendarDayType: 'PUBLIC_HOLIDAY',
          holidayName: '国庆节',
          defaultScheduleDayType: 'REST',
        },
      ],
    },
  ],
};
export const attendanceUpdateBody = {
  ...object(
    '直接修正已有日考勤，普通成员必须走申请；没有日考勤时404。',
    {
      orgId,
      dailyId: { ...integer('日考勤ID，必须属于指定组织。'), minimum: 1 },
      finalStatus: enumeration(
        '目标状态：PRESENT=正常、LATE=迟到、EARLY_LEAVE=早退、LATE_EARLY=迟到且早退、LEAVE=请假、ABSENT=缺勤、REST=休息。',
        manualStatuses,
      ),
      manualRemark: {
        ...text(
          '修正展示备注，最多1000字符；省略/null/空白清空。沿用旧接口，不接收reason字段。',
          true,
        ),
        maxLength: 1000,
      },
      versionNo: integer('当前日考勤版本号，必须匹配。'),
    },
    ['orgId', 'dailyId', 'finalStatus', 'versionNo'],
  ),
  examples: [
    {
      orgId: id,
      dailyId: 1,
      finalStatus: 'PRESENT',
      manualRemark: '核实当日正常出勤',
      versionNo: 0,
    },
  ],
};
export const attendanceUpdateResponse = {
  ...object('直接修正结果；日考勤与审计记录同事务提交。', {
    id: integer('日考勤ID。'),
    beforeStatus: enumeration(
      '修正前最终状态；' + statusDescription + '尚无自动或人工结论时null。',
      attendanceStatuses,
      true,
    ),
    finalStatus: enumeration('修正后状态；' + statusDescription, manualStatuses),
    manualOverride: bool('是否人工修正，成功固定true。'),
    manualRemark: text('修正后展示备注，空白为null。', true),
    correctedBy: text('修正人UID。'),
    correctedAt: text('修正时间yyyy-MM-dd HH:mm:ss，Asia/Shanghai。'),
    versionNo: integer('更新后的日考勤版本号，原版本加1。'),
    adjustmentId: integer('追加的修正审计记录ID。'),
  }),
  examples: [
    {
      id: 1,
      beforeStatus: 'ABSENT',
      finalStatus: 'PRESENT',
      manualOverride: true,
      manualRemark: '核实当日正常出勤',
      correctedBy: 'example-user',
      correctedAt: '2026-10-21 12:00:00',
      versionNo: 1,
      adjustmentId: 1,
    },
  ],
};
export function attendanceSchema(
  operationId: string,
  summary: string,
  description: string,
  response: Schema,
) {
  return {
    ...authSchema(operationId, summary, resultSchema(response), true),
    tags: ['Attendance'],
    description:
      description +
      ' 仅受信Origin的Cookie客户端或无浏览器头的Bearer客户端可访问。成功code=200；400参数错误，401会话失效，403作用域/角色/来源不允许，404日考勤/组织不存在，409版本或幂等冲突，503数据库或日历源不可用。',
  };
}
