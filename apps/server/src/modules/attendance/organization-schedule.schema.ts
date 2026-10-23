import { attendanceResponse, scheduleBody, scheduleResponse } from './attendance.schema.js';
type Schema = Record<string, unknown>;
const object = (
  description: string,
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', additionalProperties: false, description, properties, required });
const text = (description: string, extra: Schema = {}): Schema => ({
  type: 'string',
  description,
  ...extra,
});
const integer = (description: string, minimum = 0, maximum = 2147483647): Schema => ({
  type: 'integer',
  description,
  minimum,
  maximum,
});
const uuid = (description: string) => text(description, { format: 'uuid' });
const enumeration = (description: string, values: string[]): Schema =>
  text(description, { enum: values });
const orgId = uuid('目标组织UUID；按当前会话EXPERT及该组织有效OWNER/ADMIN关系鉴权。');
const id = '00000000-0000-4000-8000-000000000001';
const personalProperties = (scheduleBody as Schema).properties as Record<string, Schema>;
const item = (personalProperties.schedules!.items as Schema).properties as Record<string, Schema>;
const timezone = personalProperties.timezone!;
export const organizationScheduleQuery = {
  ...object(
    '组织月排班查询；成员在数据库筛选分页，默认包含待激活及尚未离组成员。',
    {
      orgId,
      month: text('查询月份YYYY-MM，1900年起。', { pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }),
      keyword: text(
        '姓名/昵称/UID模糊匹配；成员和用户UUID模糊匹配，手机号完整匹配，入组上海时间支持YYYY-MM-DD HH:mm:ss前缀；省略/null/空白不筛选。',
        { nullable: true, maxLength: 100 },
      ),
      employmentType: enumeration('人员属性，省略/null不限：FULL_TIME全职、PART_TIME兼职。', [
        'FULL_TIME',
        'PART_TIME',
      ]),
      joinStatus: enumeration(
        '成员状态；省略/null默认PENDING_ACTIVATION待激活、ACTIVE在职、EXIT_APPROVING退出审批中、PENDING_LEAVE待离组。其他：PENDING待审、LEFT已离组、REMOVED已移除。',
        [
          'PENDING',
          'PENDING_ACTIVATION',
          'ACTIVE',
          'EXIT_APPROVING',
          'PENDING_LEAVE',
          'LEFT',
          'REMOVED',
        ],
      ),
      position: enumeration('组织角色：OWNER主管、ADMIN管理员、MEMBER成员；省略/null不限。', [
        'OWNER',
        'ADMIN',
        'MEMBER',
      ]),
      projectId: {
        ...integer('项目ID，省略/null不限；仅匹配目标组织成员的ACTIVE项目成员关系。', 1),
        nullable: true,
      },
      current: { ...integer('人员页码，从1开始，默认1。', 1), default: 1 },
      size: { ...integer('每页人员数，默认20，最大100。', 1, 100), default: 20 },
    },
    ['orgId', 'month'],
  ),
  examples: [{ orgId: id, month: '2026-10', current: 1, size: 20 }],
};
// 可选枚举显式支持null，与旧DTO保持一致。
for (const field of ['employmentType', 'joinStatus', 'position']) {
  const schema = ((organizationScheduleQuery as Schema).properties as Record<string, Schema>)[
    field
  ]!;
  schema.nullable = true;
  schema.enum = [...(schema.enum as string[]), null];
}
export const organizationBatchBody = {
  ...object(
    '按成员×日期批量排班。日期最多366天，展开最多5000条；weekday筛选后排除法定放假日，调休工作日仍按weekdays筛选；无可排日期400。',
    {
      orgId,
      memberIds: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description:
          '目标组织成员关系UUID，最多500项，重复去重；仅ACTIVE/EXIT_APPROVING/PENDING_LEAVE可排班，主管/管理员亦可作为目标。',
        items: uuid('成员关系UUID。'),
      },
      startDate: { ...item.scheduleDate, description: '起始自然日YYYY-MM-DD，包含当天。' },
      endDate: {
        ...item.scheduleDate,
        description: '结束自然日YYYY-MM-DD，包含当天，不早于startDate；范围最多366天。',
      },
      weekdays: {
        type: 'array',
        nullable: true,
        maxItems: 7,
        description: 'ISO星期值1周一至7周日；省略/null/空数组默认[1,2,3,4,5]；重复值去重。',
        items: integer('ISO星期值。', 1, 7),
      },
      dayType: item.dayType!,
      startTime: item.startTime!,
      endTime: item.endTime!,
      timezone,
      overwrite: personalProperties.overwrite!,
    },
    ['orgId', 'memberIds', 'startDate', 'endDate', 'dayType', 'overwrite'],
  ),
  examples: [
    {
      orgId: id,
      memberIds: [id],
      startDate: '2026-10-12',
      endDate: '2026-10-16',
      weekdays: [1, 2, 3, 4, 5],
      dayType: 'WORK',
      startTime: '09:00',
      endTime: '18:00',
      timezone: 'Asia/Shanghai',
      overwrite: false,
    },
  ],
};
export const organizationDetailsBody = {
  ...object(
    '按成员每日明细排班；不套用星期或法定放假日过滤，每条独立班次/时区。',
    {
      orgId,
      schedules: {
        type: 'array',
        minItems: 1,
        maxItems: 5000,
        description:
          '1至5000条，每成员日期不能重复，最多500个不同成员；仅目标组织尚未离组的有效成员。',
        items: object(
          '一条成员每日班次。',
          {
            memberId: uuid('目标组织成员关系UUID。'),
            ...item,
            timezone: {
              ...timezone,
              description: '本条IANA时区，省略/null/空白使用请求默认时区。',
            },
          },
          ['memberId', 'scheduleDate', 'dayType'],
        ),
      },
      timezone,
      overwrite: personalProperties.overwrite!,
    },
    ['orgId', 'schedules', 'overwrite'],
  ),
  examples: [
    {
      orgId: id,
      schedules: [
        {
          memberId: id,
          scheduleDate: '2026-10-01',
          dayType: 'WORK',
          startTime: '09:00',
          endTime: '18:00',
        },
      ],
      timezone: 'Asia/Shanghai',
      overwrite: false,
    },
  ],
};
const personal = (attendanceResponse as Schema).properties as Record<string, Schema>;
const days = structuredClone(personal.days!);
(days.items as Schema).description = '成员一天排班考勤；不包含本人申请权限，读取不创建日考勤。';
const dayProps = (days.items as Schema).properties as Record<string, Schema>;
delete dayProps.application;
delete dayProps.permissions;
(days.items as Schema).required = Object.keys(dayProps);
export const organizationSchedulesResponse = {
  ...object('组织成员整月排班与考勤；按成员分页，日期连续补齐，无持久化副作用。', {
    month: text('查询月份YYYY-MM。'),
    total: integer('符合筛选的成员总数。'),
    pages: integer('总页数，无成员为0。'),
    current: integer('当前页码。', 1),
    size: integer('每页人员数。', 1, 100),
    members: {
      type: 'array',
      description: '当前页成员，按关系UUID升序；超出末页为空。',
      items: object('成员月历。', {
        memberId: uuid('成员关系UUID。'),
        userId: uuid('用户UUID。'),
        realName: text('真实姓名，未填写null。', { nullable: true }),
        nickname: text('昵称。', { nullable: true }),
        joinStatus: text('成员当前状态，取值见查询joinStatus说明。'),
        canSchedule: {
          type: 'boolean',
          description: '仅ACTIVE/EXIT_APPROVING/PENDING_LEAVE为true。',
        },
        summary: personal.summary!,
        days,
      }),
    },
  }),
  examples: [{ month: '2026-10', total: 0, pages: 0, current: 1, size: 20, members: [] }],
};
export const organizationScheduleResult: Schema = structuredClone(scheduleResponse);
organizationScheduleResult.description =
  '组织批量排班结果；排班、已有日考勤回算、PENDING通知及幂等回执同事务。原始事件重放随079接入，实际通知投递尚未接入。';
const resultProps = organizationScheduleResult.properties as Record<string, Schema>;
const conflictItem = resultProps.conflicts!.items as Schema;
(conflictItem.properties as Record<string, Schema>).memberId = uuid('冲突的组织成员关系UUID。');
(conflictItem.required as string[]).push('memberId');
resultProps.batchNo!.description = '组织排班批次编号，SCH前缀。';
organizationScheduleResult.examples = [
  {
    batchNo: 'SCH-EXAMPLE',
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 1,
    conflicts: [{ memberId: id, scheduleDate: '2026-10-01', scheduleId: 1, versionNo: 0 }],
  },
];
export const organizationScheduleHeaders = {
  type: 'object',
  additionalProperties: true,
  description: '组织排班幂等头，不代替认证。',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': text(
      '唯一请求键，1至128字符；按目标组织、操作者、BATCH/DETAIL接口隔离。同标准化参数重放首次结果，参数变化409；重放仍校验当前管理权限。',
      { minLength: 1, maxLength: 128 },
    ),
  },
};
