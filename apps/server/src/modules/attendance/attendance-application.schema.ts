import { attendanceStatuses, manualStatuses } from './attendance.domain.js';
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
const uuid = (description: string, nullable = false): Schema => ({
  ...text(description, nullable),
  format: 'uuid',
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
const date = {
  ...text('考勤自然日，yyyy-MM-dd；请假可历史/当天/未来，修正仅当天或历史。'),
  format: 'date',
};
const localTime = (description: string): Schema => ({
  ...text(
    description + '；yyyy-MM-dd HH:mm:ss，按排班timezone解释；同日且在班次内，不支持跨日。',
    true,
  ),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
const orgId = '00000000-0000-4000-8000-000000000002';
const applicationId = '00000000-0000-4000-8000-000000000003';
export const attendanceApplicationBody = {
  ...object(
    '本人请假/修正申请：MEMBER/ADMIN提交，由有效主管审批；主管本人不能自审。使用日考勤乐观锁，versionNo必须显式传值或null。',
    {
      orgId: uuid('目标组织UUID，必须是本人有效组织；不接受其他申请人/成员ID。'),
      attendanceDate: date,
      applicationType: enumeration('申请类型：LEAVE=请假、CORRECTION=考勤修正。', [
        'LEAVE',
        'CORRECTION',
      ]),
      finalStatus: enumeration(
        '批准后目标日状态：PRESENT=正常、LATE=迟到、EARLY_LEAVE=早退、LATE_EARLY=迟到且早退、LEAVE=请假、ABSENT=缺勤、REST=休息。LEAVE申请只能LEAVE；CORRECTION不能LEAVE。',
        manualStatuses,
      ),
      reason: {
        ...text('必填申请原因，trim后1至1000字符，进入表单快照、审批日志及批准后的人工修正备注。'),
        minLength: 1,
        maxLength: 1000,
      },
      versionNo: {
        ...integer(
          '必填当前日考勤dailyVersionNo；尚无日考勤必须显式传null，不使用排班versionNo代替。审批前再次检查，变化409。',
          true,
        ),
        maximum: 2147483646,
      },
      dailyId: integer(
        '可选日考勤ID，提供时必须与本人该日实际日考勤一致；无日考勤省略或null。',
        true,
      ),
      leaveStartAt: localTime('LEAVE条件必填的请假开始时间；CORRECTION须省略/null'),
      leaveEndAt: localTime('LEAVE条件必填的请假结束时间且晚于开始；CORRECTION须省略/null'),
    },
    ['orgId', 'attendanceDate', 'applicationType', 'finalStatus', 'reason', 'versionNo'],
  ),
  examples: [
    {
      orgId,
      attendanceDate: '2099-01-01',
      applicationType: 'LEAVE',
      finalStatus: 'LEAVE',
      reason: '个人事务',
      versionNo: null,
      leaveStartAt: '2099-01-01 09:00:00',
      leaveEndAt: '2099-01-01 12:00:00',
    },
    {
      orgId,
      attendanceDate: '2020-01-01',
      applicationType: 'CORRECTION',
      finalStatus: 'PRESENT',
      reason: '补充出勤说明',
      dailyId: 1,
      versionNo: 0,
    },
  ],
};
export const attendanceWithdrawBody = {
  ...object('本人撤回待审考勤申请；离组后仍可撤回自己的待审申请，不恢复组织关系。', {
    applicationId: uuid(
      '申请主键UUID，使用apply响应或本人申请记录的applicationId；不接受flowNo替代。',
    ),
    flowVersionNo: integer(
      '当前流程版本号，使用apply/本人申请记录/月历返回值；旧版本或已审批/撤回时409。',
    ),
  }),
  examples: [{ applicationId, flowVersionNo: 0 }],
};
const resultProperties = {
  applicationId: uuid('申请主键UUID。'),
  flowNo: text('审批流水号，供既有组织审批处理接口使用。'),
  flowVersionNo: integer('当前审批流程版本，从0开始，终态推进后增加1。'),
  businessType: enumeration('业务类型：ATTENDANCE_LEAVE=请假、ATTENDANCE_CORRECTION=考勤修正。', [
    'ATTENDANCE_LEAVE',
    'ATTENDANCE_CORRECTION',
  ]),
  applicationType: enumeration('申请类型：LEAVE=请假、CORRECTION=考勤修正。', [
    'LEAVE',
    'CORRECTION',
  ]),
  attendanceDate: date,
  finalStatus: enumeration(
    '申请请求的批准目标日状态；提交/撤回时尚未生效，不等于当前实际考勤。',
    manualStatuses,
  ),
  status: enumeration(
    '流程状态：PENDING=待主管审批、APPROVED=通过、REJECTED=驳回、WITHDRAWN=本人已撤回、CANCELED=取消。',
    ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELED'],
  ),
  versionNo: integer('提交时日考勤版本，尚无日考勤null；不是流程版本。', true),
  dailyId: integer('提交时日考勤ID，尚无日考勤null。', true),
  leaveStartAt: localTime('请假开始时间，修正申请null'),
  leaveEndAt: localTime('请假结束时间，修正申请null'),
  appliedAt: text('申请时间，ISO 8601 UTC。'),
  finishedAt: text('结束时间，ISO 8601 UTC；待审null。', true),
};
export const attendanceApplicationExample = {
  applicationId,
  flowNo: 'ATAEXAMPLE',
  flowVersionNo: 0,
  businessType: 'ATTENDANCE_LEAVE',
  applicationType: 'LEAVE',
  attendanceDate: '2099-01-01',
  finalStatus: 'LEAVE',
  status: 'PENDING',
  versionNo: null,
  dailyId: null,
  leaveStartAt: '2099-01-01 09:00:00',
  leaveEndAt: '2099-01-01 12:00:00',
  appliedAt: '2026-10-21T06:00:00.000Z',
  finishedAt: null,
};
export const attendanceApplicationResponse = {
  ...object(
    '申请提交/撤回结果；提交不写考勤，只有主管审批通过才生效。撤回不修改考勤。',
    resultProperties,
  ),
  examples: [
    attendanceApplicationExample,
    {
      ...attendanceApplicationExample,
      status: 'WITHDRAWN',
      flowVersionNo: 1,
      finishedAt: '2026-10-21T07:00:00.000Z',
    },
  ],
};
export const attendanceProcessFields = {
  applicationId: uuid('仅考勤审批返回的申请主键UUID。'),
  flowVersionNo: integer('仅考勤审批返回的推进后流程版本号。'),
  businessType: resultProperties.businessType,
  attendanceDate: date,
  dailyId: integer('批准后实际日考勤ID；驳回null。', true),
  dailyVersionNo: integer('批准后实际日考勤版本；新建日考勤从0开始，驳回null。', true),
  finalStatus: enumeration('批准后实际日考勤最终状态；驳回null。', attendanceStatuses, true),
  adjustmentId: integer('批准后追加的考勤修正审计ID；驳回null。', true),
};
export const attendanceProcessExample = {
  flowNo: 'ATAEXAMPLE',
  nodeId: '00000000-0000-4000-8000-000000000004',
  action: 'APPROVE',
  nodeStatus: 'APPROVED',
  flowStatus: 'APPROVED',
  currentNode: null,
  joinStatus: null,
  plannedLeaveDate: null,
  processedAt: '2026-10-21T07:00:00.000Z',
  finishedAt: '2026-10-21T07:00:00.000Z',
  applicationId,
  flowVersionNo: 1,
  businessType: 'ATTENDANCE_LEAVE',
  attendanceDate: '2099-01-01',
  dailyId: 1,
  dailyVersionNo: 0,
  finalStatus: 'LEAVE',
  adjustmentId: 1,
};
export const calendarApplicationSchema = {
  ...object('本人当日最新一条考勤申请；无申请null。包含已结束申请，是否可撤回以canWithdraw为准。', {
    applicationId: resultProperties.applicationId,
    flowNo: resultProperties.flowNo,
    flowVersionNo: resultProperties.flowVersionNo,
    applicationType: resultProperties.applicationType,
    status: resultProperties.status,
    finalStatus: {
      ...resultProperties.finalStatus,
      description: '该申请请求的目标日状态，尚未批准时不影响当前考勤。',
    },
    canWithdraw: {
      type: 'boolean',
      description: '当前为本人PENDING申请时true；撤回时服务端仍重新检查流程版本。',
    },
  }),
  nullable: true,
};
export const calendarDayPermissions = object('当天实际操作权限提示；服务端写入时重新校验。', {
  canApplyLeave: {
    type: 'boolean',
    description:
      '本人非主管有效组织成员、有ACTIVE工作排班、无待审考勤申请且日考勤尚非LEAVE时true；具体时段仍须校验。',
  },
  canApplyCorrection: {
    type: 'boolean',
    description: '本人非主管有效组织成员、当天/历史有日考勤或ACTIVE工作排班且无待审申请时true。',
  },
  canWithdraw: { type: 'boolean', description: '本人该日存在待审申请时true。' },
  canDirectUpdate: {
    type: 'boolean',
    description: '有效OWNER/ADMIN、当天/历史且已有日考勤时true。',
  },
});

export const attendanceFormProperties: Record<string, Schema> = {
  ...((attendanceApplicationBody as Schema).properties as Record<string, Schema>),
  schemaVersion: {
    type: 'integer',
    enum: [1],
    description: '考勤申请表单版本，当前固定1；仅服务端生成。',
  },
  targetMemberId: uuid('考勤申请人的组织关系UUID快照，由服务端按本人有效组织关系生成。'),
  targetMemberName: text('考勤申请人昵称(真实姓名)快照。'),
  scheduleId: integer('提交时排班ID；无排班null，审批前复查，不能由请求指定。', true),
  scheduleVersionNo: integer(
    '提交时排班版本号；无排班null，审批前复查，不能使用日考勤版本代替。',
    true,
  ),
  timezone: text('申请时排班IANA时区快照，无排班默认Asia/Shanghai。'),
};
