import type { FastifySchema } from 'fastify';
import { taskStatuses } from './production-domain.js';
export const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
export const text = (description: string, nullable = false) => ({
  type: 'string',
  description,
  nullable,
});
export const choice = (description: string, values: string[]) => ({
  type: 'string',
  enum: values,
  description,
});
export const day = (description: string, nullable = false) => ({
  ...text(description, nullable),
  format: 'date',
});
export const quantity = (description: string, nullable = false) => ({
  type: 'number',
  description,
  nullable,
});
export const stamp = (description: string) => ({
  ...text(description, true),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
export const object = (
  description: string,
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: 'object', description, additionalProperties: false, properties, required });
export const array = (description: string, items: object) => ({
  type: 'array',
  description,
  items,
});
export const pagination = {
  current: { ...id('页码，从1开始，省略默认1。'), default: 1 },
  size: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: '每页条数，省略默认20，最多100。',
  },
};
export const base = {
  projectId: id('已发布项目ID，32位正整数；必须具有当前会话角色对应的项目权限。'),
  keyword: {
    ...text('去首尾空白的搜索词，null或空白不筛选；人员按姓名/昵称/UID，任务按名称/编号。', true),
    maxLength: 100,
  },
  ...pagination,
};
export const membersBody = {
  ...object(
    '查询已接单、原准入且实际入项的可指定人员；仅当前主策略官和招募协作负责人可查。',
    base,
    ['projectId'],
  ),
  examples: [{ projectId: 1, keyword: null, current: 1, size: 20 }],
};
export const listBody = {
  ...object(
    '子任务分页；管理角色按项目关系、专家按职责组织范围；普通成员仅本人已报量任务。按真实报量来源查询，退回修正范围由服务端计算。',
    {
      ...base,
      keyword: { ...base.keyword, maxLength: 128 },
      statuses: {
        ...array(
          '状态筛选，null或空数组不筛选；IN_PROGRESS=进行中、PENDING_ACCEPTANCE=待验收、REWORK_REQUIRED=返修、ACCEPTED=已验收。',
          choice('子任务状态。', taskStatuses),
        ),
        nullable: true,
        maxItems: 4,
      },
    },
    ['projectId'],
  ),
  examples: [{ projectId: 1, statuses: ['IN_PROGRESS'], keyword: null, current: 1, size: 20 }],
};
export const createBody = {
  ...object(
    '仅当前主策略官创建；日期按上海当天校验，成员ID去重并在事务内重校资格；同项目同名返回409。',
    {
      projectId: base.projectId,
      subtaskName: { ...text('必填名称，去首尾空白，项目内唯一。'), minLength: 1, maxLength: 128 },
      expectedDeliveryDate: day('必填预期交付日期，YYYY-MM-DD，不得早于上海当天。'),
      expectedQuantity: {
        description:
          '必填正数量，最多26位整数和4位小数；数字或十进制字符串。大数量建议字符串以保留精度；单位取项目快照。',
        anyOf: [
          { type: 'number', exclusiveMinimum: 0, description: 'JSON正数，最多4位小数。' },
          {
            type: 'string',
            pattern: '^\\d{1,26}(\\.\\d{1,4})?$',
            maxLength: 31,
            description: '精确十进制正数字符串，不能为0。',
          },
        ],
      },
      distributionMode: choice(
        '分发方式：POOL=任务池，禁止携带人员；DESIGNATED=指定人员，至少1名。',
        ['POOL', 'DESIGNATED'],
      ),
      memberIds: {
        ...array(
          '项目成员整数ID，最多1000项；重复ID去重，省略/null视为空。',
          id('项目成员ID，非用户UUID。'),
        ),
        nullable: true,
        maxItems: 1000,
      },
    },
    ['projectId', 'subtaskName', 'expectedDeliveryDate', 'expectedQuantity', 'distributionMode'],
  ),
  examples: [
    {
      projectId: 1,
      subtaskName: '首批生产',
      expectedDeliveryDate: '2099-12-31',
      expectedQuantity: 100.5,
      distributionMode: 'DESIGNATED',
      memberIds: [1],
    },
    {
      projectId: 1,
      subtaskName: '公共任务池',
      expectedDeliveryDate: '2099-12-31',
      expectedQuantity: 10,
      distributionMode: 'POOL',
      memberIds: [],
    },
  ],
};
export const member = object('候选项目成员；不把候选人当作已分配或已认领。', {
  memberId: id('项目成员ID，创建时提交到memberIds。'),
  userId: { ...text('用户UUID。'), format: 'uuid' },
  uid: text('平台UID。'),
  displayName: text('昵称(真实姓名)，缺失时回退现有名称或UID。'),
  subjectType: choice('接单主体：ORGANIZATION=组织、INDIVIDUAL=个人。', [
    'ORGANIZATION',
    'INDIVIDUAL',
  ]),
  organizationId: { ...text('来源组织UUID；个人为null。', true), format: 'uuid' },
  organizationName: text('来源组织名称；个人为null。', true),
  assignmentType: {
    ...text('候选人员为null；后续人员明细中DESIGNATED=指定、CLAIMED=认领。', true),
    enum: ['DESIGNATED', 'CLAIMED', null],
  },
  assignedAt: stamp('候选为null；已分配时间为上海时间YYYY-MM-DD HH:mm:ss。'),
});
const task = object(
  '子任务；报量来源及已接入动作按权限计算，验收事实为最近一次提交/审核快照，尚无时为null。',
  {
    subtaskId: id('子任务ID。'),
    subtaskNo: text('服务端生成的全局唯一编号。'),
    subtaskName: text('项目内唯一名称。'),
    status: choice(
      'IN_PROGRESS=进行中、PENDING_ACCEPTANCE=待验收、REWORK_REQUIRED=返修、ACCEPTED=已验收。',
      taskStatuses,
    ),
    distributionMode: choice('POOL=任务池、DESIGNATED=指定人员。', ['POOL', 'DESIGNATED']),
    assigneeCount: {
      type: 'integer',
      minimum: 0,
      description: '实际已指定或已认领人数；空任务池为0。',
    },
    assigneeNames: {
      ...array('按分配ID升序的前3个人员名称。', text('昵称(真实姓名)，缺失按名称或UID回退。')),
      maxItems: 3,
    },
    pendingReportCount: {
      type: 'integer',
      minimum: 0,
      description: '当前范围内退回待修正条数；仅统计当前身份可修正的退回记录。',
    },
    expectedDeliveryDate: day('预期交付日期YYYY-MM-DD。'),
    expectedQuantity: quantity('预期交付量，最多4位小数。'),
    quantityUnit: text('创建时项目量级单位快照。'),
    actualDeliveryDate: day('最近提交实际交付日期YYYY-MM-DD；尚未提交为null。', true),
    actualQuantity: quantity('最近提交实际交付量；尚未提交为null。', true),
    reportedQuantity: quantity('最近提交时已核准报量总量；尚未提交为null。', true),
    quantityAdjustmentRemark: text('调整数量的说明；尚无为null。', true),
    submittedByName: text('最近提交人名称；尚无为null。', true),
    submittedAt: stamp('最近提交上海时间；尚无为null。'),
    reviewedByName: text('最近验收人名称；尚无为null。', true),
    reviewedAt: stamp('最近验收上海时间；尚无为null。'),
    rejectReason: text('最近驳回原因；尚无为null。', true),
    operationHint: text('操作提示；领航员等待提交时提示，其他情况为null。', true),
    allowedActions: {
      ...array(
        '当前身份可执行的已接入动作；CHECK_DATA=核查数据、CORRECT_REPORT=修正退回报量；SUBMIT_ACCEPTANCE=提交验收、ACCEPT=通过、REJECT=驳回。',
        choice(
          'CHECK_DATA=核查数据、CORRECT_REPORT=修正、SUBMIT_ACCEPTANCE=提交、ACCEPT=通过、REJECT=驳回。',
          ['CHECK_DATA', 'CORRECT_REPORT', 'SUBMIT_ACCEPTANCE', 'ACCEPT', 'REJECT'],
        ),
      ),
      maxItems: 2,
    },
  },
);
export const page = (record: object) =>
  object('完整服务端筛选后分页；无数据records为空且pages=0。', {
    total: { type: 'integer', minimum: 0, description: '筛选后的总条数。' },
    current: pagination.current,
    size: pagination.size,
    pages: { type: 'integer', minimum: 0, description: '总页数，向上取整。' },
    records: array('当前页记录。', record),
  });
export const memberExample = {
  current: 1,
  size: 20,
  total: 1,
  pages: 1,
  records: [
    {
      memberId: 1,
      userId: '11111111-1111-4111-8111-111111111111',
      uid: '123456',
      displayName: '小明(张明)',
      subjectType: 'INDIVIDUAL',
      organizationId: null,
      organizationName: null,
      assignmentType: null,
      assignedAt: null,
    },
  ],
};
export const taskExample = {
  current: 1,
  size: 20,
  total: 1,
  pages: 1,
  records: [
    {
      subtaskId: 1,
      subtaskNo: 'ST20261026090000A1B2C3D4',
      subtaskName: '首批生产',
      status: 'IN_PROGRESS',
      distributionMode: 'POOL',
      assigneeCount: 0,
      assigneeNames: [],
      pendingReportCount: 0,
      expectedDeliveryDate: '2099-12-31',
      expectedQuantity: 10,
      quantityUnit: '条',
      actualDeliveryDate: null,
      actualQuantity: null,
      reportedQuantity: null,
      quantityAdjustmentRemark: null,
      submittedByName: null,
      submittedAt: null,
      reviewedByName: null,
      reviewedAt: null,
      rejectReason: null,
      operationHint: null,
      allowedActions: [],
    },
  ],
};
export const membersResponse = { ...page(member), examples: [memberExample] };
export const listResponse = { ...page(task), examples: [taskExample] };
export function productionSchema(
  operationId: string,
  summary: string,
  body: object,
  data: object,
): FastifySchema {
  const result = (schema: object) =>
    object('统一业务响应。', {
      code: { type: 'integer', description: '业务状态码，同HTTP状态。' },
      message: text('中文操作结果。'),
      data: schema,
    });
  return {
    operationId,
    summary,
    tags: ['生产任务'],
    security: [{ webSession: [] }, { desktopSession: [] }],
    body,
    response: {
      200: result(data),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 500].map((s) => [
          s,
          result({ type: 'null', description: '失败data为null。' }),
        ]),
      ),
    },
  };
}
