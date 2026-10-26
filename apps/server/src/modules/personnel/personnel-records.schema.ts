import { attendanceStatuses } from '../attendance/attendance-domain.js';
const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
const text = (description: string, nullable = false) => ({ type: 'string', nullable, description });
const uuid = (description: string, nullable = false) => ({
  ...text(description, nullable),
  format: 'uuid',
});
const date = (description: string, nullable = false) => ({
  ...text(description, nullable),
  format: 'date',
});
const object = (
  description: string,
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: 'object', additionalProperties: false, description, required, properties });
const array = (description: string, items: object, maxItems?: number) => ({
  type: 'array',
  description,
  items,
  ...(maxItems === undefined ? {} : { maxItems }),
});
const choice = (description: string, values: (string | null)[], nullable = false) => ({
  type: 'string',
  enum: values,
  description,
  nullable,
});
const pagination = {
  current: { ...id('页码；从1起，省略默认1。'), default: 1 },
  size: { ...id('每页条数；省略默认20，最多100。'), maximum: 100, default: 20 },
};
const uuidExample = '00000000-0000-4000-8000-000000000001';
const statusDescription =
  'PRESENT=正常、LATE=迟到、EARLY_LEAVE=早退、LATE_EARLY=迟到且早退、LEAVE=请假、ABSENT=缺勤、REST=休息、UNSCHEDULED=未排班、REVIEW_REQUIRED=待复核';
export const attendanceBody = {
  ...object(
    '项目开放成员月考勤；筛选条件取交集，不产生或重算考勤。',
    {
      projectId: id('必填项目ID，32位正整数。'),
      month: {
        ...text('必填查询月份，YYYY-MM，1900年起。'),
        pattern: '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$',
      },
      keyword: {
        ...text('姓名、昵称或UID模糊查询；去首尾空白，null或空白不筛选。', true),
        maxLength: 100,
      },
      organizationIds: {
        ...array(
          '成员来源组织UUID；空/null不筛选，与当前职责范围取交集。',
          uuid('组织UUID。'),
          100,
        ),
        nullable: true,
      },
      attendanceStatuses: {
        ...array(
          '最终考勤状态：' +
            statusDescription +
            '。空/null返回全部；仅筛选逐日行及汇总，不过滤成员或改变总人数。',
          choice('最终考勤状态。', attendanceStatuses),
          attendanceStatuses.length,
        ),
        nullable: true,
      },
      ...pagination,
    },
    ['projectId', 'month'],
  ),
  examples: [
    { projectId: 1, month: '2026-10', attendanceStatuses: ['LATE_EARLY'], current: 1, size: 20 },
  ],
};
const performanceQueryProperties = {
  projectId: id('必填项目ID。'),
  memberId: id('必填项目成员ID；不等于用户ID。'),
  recordDateStart: date('发生日期下限，YYYY-MM-DD，含当天；可省略或null。', true),
  recordDateEnd: date('发生日期上限，YYYY-MM-DD，含当天；可省略或null，不得早于下限。', true),
  ...pagination,
};
export const performanceBody = {
  ...object('按项目成员查询历史表现；不限制成员在项状态。', performanceQueryProperties, [
    'projectId',
    'memberId',
  ]),
  examples: [
    {
      projectId: 1,
      memberId: 1,
      recordDateStart: '2026-10-01',
      recordDateEnd: '2026-10-23',
      current: 1,
      size: 20,
    },
  ],
};
export const performanceCreateBody = {
  ...object(
    '新增成员表现；记录与全部附件认领同事务。每次成功请求新增一条，不声明请求幂等。',
    {
      projectId: id('必填项目ID。'),
      memberId: id('必填项目成员ID，可为历史成员。'),
      recordDate: date('必填发生日期，YYYY-MM-DD，不晚于上海当天。'),
      content: {
        ...text('必填正文，保存时去首尾空白；原文1至2000字，不能全空白。'),
        minLength: 1,
        maxLength: 2000,
      },
      attachmentIds: {
        ...array(
          '附件上传台账UUID（上传响应fileId），最多10个，去重；省略/null为空。仅接收本人上传且未认领的MEMBER_PERFORMANCE_ATTACHMENT文件。',
          uuid('上传台账UUID。'),
          10,
        ),
        nullable: true,
      },
      attachmentUploadTokens: {
        type: 'object',
        nullable: true,
        maxProperties: 10,
        description:
          '有附件时必填，键为attachmentIds中的fileId、值为本次上传返回的uploadToken；不持久化明文。无附件可省略/null。',
        additionalProperties: {
          ...text('对应文件的一次性uploadToken，最长200字符。'),
          minLength: 1,
          maxLength: 200,
        },
      },
    },
    ['projectId', 'memberId', 'recordDate', 'content'],
  ),
  examples: [
    {
      projectId: 1,
      memberId: 1,
      recordDate: '2026-10-22',
      content: '按期完成培训',
      attachmentIds: [],
      attachmentUploadTokens: {},
    },
  ],
};
const counts = object(
  '筛选后逐日行汇总；scheduledCount按旧接口计排班行数，含休息或取消行；迟到且早退分别计入两项。',
  Object.fromEntries(
    [
      ['scheduledCount', '排班行数'],
      ['presentCount', '正常天数'],
      ['lateCount', '迟到天数'],
      ['earlyLeaveCount', '早退天数'],
      ['leaveCount', '请假天数'],
      ['absentCount', '缺勤天数'],
    ].map(([key, label]) => [
      key,
      { type: 'integer', minimum: 0, description: label + '，无记录为0。' },
    ]),
  ),
);
const stamp = (description: string, milliseconds = false) => ({
  ...text(description, true),
  pattern: milliseconds
    ? '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}$'
    : '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
const attendanceRow = object(
  '开放状态成员；PENDING_CONFIRM/PENDING_ENTRY/ACTIVE/PENDING_EXIT/PENDING_TRANSFER，无排班时明细为空。',
  {
    memberId: id('项目成员ID。'),
    userId: uuid('用户UUID。'),
    uid: text('平台UID。'),
    displayName: text('昵称(姓名)，缺失回退已有名称或UID。'),
    organizationId: uuid('成员组织UUID；个人为null。', true),
    organizationName: text('组织名称；个人或组织删除为null。', true),
    summary: counts,
    days: array(
      '按日期升序的真实排班；无排班不补日，无最终结果为null；个人取PERSONAL，组织按成员关系精确匹配。',
      object('逐日排班及最终考勤。', {
        date: date('排班日期，YYYY-MM-DD。'),
        scheduleStatus: choice('排班状态：ACTIVE=有效、CANCELLED=取消。', ['ACTIVE', 'CANCELLED']),
        shiftStartAt: stamp('班次开始，排班当地墙上时间yyyy-MM-dd HH:mm:ss；无班次为null。'),
        shiftEndAt: stamp('班次结束，排班当地墙上时间yyyy-MM-dd HH:mm:ss；无班次为null。'),
        finalAttendanceStatus: choice(
          '最终考勤：' + statusDescription + '；未产生结果为null。',
          [...attendanceStatuses, null],
          true,
        ),
        firstClockInAt: stamp(
          '首次上班打卡，排班当地墙上时间yyyy-MM-dd HH:mm:ss.SSS；未打卡为null。',
          true,
        ),
        lastClockOutAt: stamp(
          '末次下班打卡，排班当地墙上时间yyyy-MM-dd HH:mm:ss.SSS；未打卡为null。',
          true,
        ),
      }),
    ),
  },
);
const performanceRow = object('成员表现记录；按发生日期和ID倒序。', {
  performanceId: id('表现记录ID。'),
  recordDate: date('发生日期YYYY-MM-DD。'),
  content: text('已去首尾空白的正文。'),
  attachmentIds: array(
    '认领的上传台账UUID，按ID排序；无附件为空。',
    uuid('文件UUID，使用上传时objectKey通过文件代理读取。'),
    10,
  ),
  attachments: array(
    '已认领文件的代理读取信息，不包含上传凭证。',
    object('表现附件。', {
      fileId: uuid('文件台账UUID。'),
      objectKey: text('文件代理读取Key；不是URL。'),
      fileName: text('文件原始名称。'),
    }),
    10,
  ),
  recordedByName: text('记录人当前昵称(姓名)，缺失回退UID。'),
  createdAt: stamp('创建时间，上海yyyy-MM-dd HH:mm:ss。'),
});
const pageResponse = (description: string, row: object) =>
  object(description, {
    total: { type: 'integer', minimum: 0, description: '筛选后总记录数。' },
    ...pagination,
    pages: { type: 'integer', minimum: 0, description: '总页数；无记录为0。' },
    records: array('当前页记录。', row),
  });
export const attendanceExample = {
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
  records: [
    {
      memberId: 1,
      userId: uuidExample,
      uid: 'tester',
      displayName: '测试成员',
      organizationId: null,
      organizationName: null,
      summary: {
        scheduledCount: 1,
        presentCount: 0,
        lateCount: 1,
        earlyLeaveCount: 1,
        leaveCount: 0,
        absentCount: 0,
      },
      days: [
        {
          date: '2026-10-22',
          scheduleStatus: 'ACTIVE',
          shiftStartAt: '2026-10-22 09:00:00',
          shiftEndAt: '2026-10-22 18:00:00',
          finalAttendanceStatus: 'LATE_EARLY',
          firstClockInAt: '2026-10-22 09:10:00.000',
          lastClockOutAt: '2026-10-22 17:50:00.000',
        },
      ],
    },
  ],
};
export const attendanceResponse = {
  ...pageResponse('项目考勤分页；当前职责范围内的开放成员。', attendanceRow),
  examples: [attendanceExample],
};
export const performanceExample = {
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
  records: [
    {
      performanceId: 1,
      recordDate: '2026-10-22',
      content: '按期完成培训',
      attachmentIds: [],
      attachments: [],
      recordedByName: '主策略官',
      createdAt: '2026-10-23 18:00:00',
    },
  ],
};
export const performanceResponse = {
  ...pageResponse('指定成员表现分页。', performanceRow),
  examples: [performanceExample],
};
