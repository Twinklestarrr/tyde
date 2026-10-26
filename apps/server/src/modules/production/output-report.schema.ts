import {
  id,
  text,
  choice,
  day,
  quantity,
  stamp,
  object,
  array,
  base,
  page,
  member,
} from './production.schema.js';
export const reportableBody = {
  ...object('查询本人可报量的进行中子任务；无有效成员返回空数组，不支持代报目标参数。', {
    projectId: base.projectId,
  }),
  examples: [{ projectId: 1 }],
};
const subtaskId = {
  ...id('子任务ID；省略/null仅处理项目级报量，不包含任何子任务报量。'),
  nullable: true,
};
const amount = {
  description: '非负数量，最多26位整数和4位小数；大数量使用十进制字符串以避免JSON数字精度损失。',
  anyOf: [
    { type: 'number', minimum: 0, description: '非负JSON数字。' },
    {
      type: 'string',
      pattern: '^\\d{1,26}(\\.\\d{1,4})?$',
      maxLength: 31,
      description: '精确非负十进制数字符串。',
    },
  ],
};
const remark = { ...text('作业备注；省略/null/空白清空，最多1000字。', true), maxLength: 1000 };
const statuses = ['PENDING', 'VERIFIED', 'RETURNED'];
const status = choice('PENDING=待核查、VERIFIED=核准锁定、RETURNED=退回待修正。', statuses);
export const assigneesBody = {
  ...object(
    '展开真实指定/认领人员；校验任务可见范围；任务池未认领返回空分页。',
    { ...base, subtaskId: id('必填子任务ID，须属于projectId。') },
    ['projectId', 'subtaskId'],
  ),
  examples: [{ projectId: 1, subtaskId: 1, current: 1, size: 20 }],
};
export const reportsBody = {
  ...object(
    '查询当前范围报量与同条件全量汇总；主策略官/组织职责/本人隔离，协作只读，领航员不可查询。',
    {
      ...base,
      subtaskId,
      reviewStatuses: {
        ...array('状态筛选；省略/null/空数组查询全部状态。', status),
        maxItems: 3,
        nullable: true,
      },
      reportDateStart: day('起始日期YYYY-MM-DD，含当天；省略/null不限制。', true),
      reportDateEnd: day('结束日期YYYY-MM-DD，含当天；不得早于起点。省略/null不限制。', true),
    },
    ['projectId'],
  ),
  examples: [
    {
      projectId: 1,
      subtaskId: null,
      reviewStatuses: ['RETURNED'],
      reportDateStart: '2026-10-01',
      reportDateEnd: '2026-10-26',
      current: 1,
      size: 20,
    },
  ],
};
export const saveBody = {
  ...object(
    '执行专家本人或有效项目负责人代报；批内任一明细失败全部回滚。整请求上限512KiB，超限413。重复PENDING/VERIFIED拒绝409；RETURNED仅有修正权限者可恢复PENDING。',
    {
      projectId: base.projectId,
      reports: {
        ...array(
          '1至100条日报量，不允许重复成员/层级/日期。',
          object(
            '单条日报量；所有日期按上海日期校验。',
            {
              subtaskId,
              memberId: {
                ...id('项目成员ID；省略/null自动定位本人唯一有效成员；负责人代报必填。'),
                nullable: true,
              },
              reportDate: day('必填作业日期YYYY-MM-DD，不得晚于上海当天。'),
              quantity: amount,
              remark,
            },
            ['reportDate', 'quantity'],
          ),
        ),
        minItems: 1,
        maxItems: 100,
      },
    },
  ),
  examples: [
    {
      projectId: 1,
      reports: [
        { subtaskId: 1, memberId: 1, reportDate: '2026-10-26', quantity: '10.1234', remark: null },
      ],
    },
  ],
};
export const correctBody = {
  ...object(
    '仅执行专家：在职在项本人修正，离职/离项后仅当前有效项目负责人代修正；不可改来源/日期。',
    {
      projectId: base.projectId,
      reportId: id('必填原日报量ID，须属于项目且状态为RETURNED。'),
      quantity: amount,
      remark,
    },
    ['projectId', 'reportId', 'quantity'],
  ),
  examples: [{ projectId: 1, reportId: 1, quantity: 0, remark: '已重新核对' }],
};
export const reviewBody = {
  ...object(
    '主策略官或有效组织职责核查；指定核准全成功或全回滚，空ID全部核准仅限本层级与职责范围。',
    {
      projectId: base.projectId,
      subtaskId,
      action: choice('VERIFY=核准并锁定；RETURN=单条退回。', ['VERIFY', 'RETURN']),
      reportIds: {
        ...array(
          '报量ID最多1000个，重复去重；VERIFY省略/null/空数组核准范围内全部PENDING；RETURN须恰好1条。',
          id('报量ID，须属于当前项目/层级/职责。'),
        ),
        nullable: true,
        maxItems: 1000,
      },
      reason: { ...text('RETURN时非空白必填，最多500字；VERIFY忽略。', true), maxLength: 500 },
    },
    ['projectId', 'action'],
  ),
  examples: [
    { projectId: 1, subtaskId: 1, action: 'RETURN', reportIds: [1], reason: '请核对数量' },
    { projectId: 1, action: 'VERIFY', reportIds: [] },
  ],
};
export const nullReportResponse = {
  type: 'null',
  description: '成功data为null；报量/认领/轮次/快照及PENDING通知同事务。',
  examples: [null],
};
export const reportableResponse = {
  ...array(
    '本人有效成员可报量的进行中任务，ID倒序；没有资格时空数组。',
    object('可报量子任务。', {
      subtaskId: id('子任务ID。'),
      subtaskNo: text('子任务编号。'),
      subtaskName: text('子任务名称。'),
      quantityUnit: text('量级单位快照。'),
      distributionMode: choice('POOL=任务池、DESIGNATED=指定本人。', ['POOL', 'DESIGNATED']),
    }),
  ),
  examples: [
    [
      {
        subtaskId: 1,
        subtaskNo: 'ST20261026A1B2C3',
        subtaskName: '首批生产',
        quantityUnit: '条',
        distributionMode: 'POOL',
      },
    ],
  ],
};
export const assigneesResponse = {
  ...page(member),
  examples: [
    {
      current: 1,
      size: 20,
      total: 1,
      pages: 1,
      records: [
        {
          memberId: 1,
          userId: '11111111-1111-4111-8111-111111111111',
          uid: '123456',
          displayName: '小明',
          subjectType: 'INDIVIDUAL',
          organizationId: null,
          organizationName: null,
          assignmentType: 'CLAIMED',
          assignedAt: '2026-10-26 10:00:00',
        },
      ],
    },
  ],
};
const report = object('范围内日报量明细。', {
  reportId: id('日报量ID。'),
  subtaskId,
  memberId: id('报量成员ID。'),
  userId: { ...text('成员用户UUID。'), format: 'uuid' },
  uid: text('平台UID。'),
  displayName: text('昵称(真实姓名)，缺失回退名称或UID。'),
  reportDate: day('作业日期YYYY-MM-DD。'),
  quantity: quantity('非负生产数量，最多4位小数，返回JSON数字。'),
  quantityUnit: text('保存时量级单位快照。'),
  remark,
  reviewStatus: status,
  returnReason: text('最近退回原因，非退回状态为null。', true),
  updatedAt: stamp('最后修改时间，上海YYYY-MM-DD HH:mm:ss；非null。'),
  allowedActions: array(
    '可执行动作；协作只读或不可写任务为空。',
    choice('VERIFY=核准、RETURN=退回、SAVE_REPORT=修正。', ['VERIFY', 'RETURN', 'SAVE_REPORT']),
  ),
});
export const reportsResponse = {
  ...object('同筛选条件全量汇总与分页，不以当前页替代总量。', {
    totalReportCount: { type: 'integer', minimum: 0, description: '匹配总记录数。' },
    totalQuantity: quantity('匹配全量数量总和，无数据为0。'),
    pendingCount: { type: 'integer', minimum: 0, description: '匹配待核查数。' },
    returnedCount: { type: 'integer', minimum: 0, description: '匹配已退回数。' },
    page: page(report),
  }),
  examples: [
    {
      totalReportCount: 1,
      totalQuantity: 10.1234,
      pendingCount: 1,
      returnedCount: 0,
      page: {
        current: 1,
        size: 20,
        total: 1,
        pages: 1,
        records: [
          {
            reportId: 1,
            subtaskId: null,
            memberId: 1,
            userId: '11111111-1111-4111-8111-111111111111',
            uid: '123456',
            displayName: '小明',
            reportDate: '2026-10-26',
            quantity: 10.1234,
            quantityUnit: '条',
            remark: null,
            reviewStatus: 'PENDING',
            returnReason: null,
            updatedAt: '2026-10-26 10:00:00',
            allowedActions: ['VERIFY', 'RETURN'],
          },
        ],
      },
    },
  ],
};
