import { movementStatusNames } from './personnel-movement-query.js';
const text = (description: string, nullable = false) => ({ type: 'string', description, nullable });
const id = (description: string, nullable = false) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
  nullable,
});
const object = (
  description: string,
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: 'object', additionalProperties: false, description, properties, required });
const array = (description: string, items: object) => ({ type: 'array', description, items });
const timestamp = (description: string, nullable = true) => ({
  ...text(description + '；上海时间yyyy-MM-dd HH:mm:ss，null表示未发生。', nullable),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
const uuid = (description: string, nullable = false) => ({
  ...text(description, nullable),
  format: 'uuid',
});
const version = (description: string, nullable = false) => ({
  type: 'integer',
  minimum: 0,
  description,
  nullable,
});
export const movementListBody = {
  ...object(
    '查询原/目标项目变动；管理范围、本人和合法历史审批参与范围合并，筛选取交集。',
    {
      projectId: id('必填当前查看项目ID。'),
      movementId: id('精确变动ID；省略或null不筛选。', true),
      memberId: id(
        '原花名册成员ID；指定时只查询当前项目作为原项目的变动，省略或null不筛选。',
        true,
      ),
      movementTypes: {
        ...array('变动类型；REMOVAL汰换、TRANSFER转项；省略/null/空数组不筛选。', {
          ...text('变动类型。'),
          enum: ['REMOVAL', 'TRANSFER'],
        }),
        maxItems: 2,
        nullable: true,
      },
      statuses: {
        ...array(
          '状态；PROCESSING审批处理中、WAITING_EFFECTIVE待生效、EFFECTIVE已生效、REJECTED已驳回、WITHDRAWN已撤回；省略/null/空数组不筛选。',
          { ...text('变动状态。'), enum: Object.keys(movementStatusNames) },
        ),
        maxItems: 5,
        nullable: true,
      },
      keyword: {
        ...text('姓名、昵称或UID模糊搜索，去首尾空白；省略/null/空白不筛选。', true),
        maxLength: 100,
      },
      createdStartAt: timestamp('发起时间下限（含）；省略或null不限'),
      createdEndAt: timestamp('发起时间上限（含）；不得早于下限，省略或null不限'),
      current: { ...id('页码，从1起，省略默认1。'), default: 1 },
      size: { ...id('每页条数，1至100，省略默认20。'), maximum: 100, default: 20 },
    },
    ['projectId'],
  ),
  examples: [
    {
      projectId: 1,
      movementId: null,
      memberId: null,
      movementTypes: ['TRANSFER'],
      statuses: [],
      keyword: null,
      createdStartAt: null,
      createdEndAt: null,
      current: 1,
      size: 20,
    },
  ],
};
export const movementDetailBody = {
  ...object('按原项目和花名册成员读取最新变动，按发起时间、变动ID倒序；无记录或超范围返回404。', {
    projectId: id('必填原项目ID。'),
    memberId: id('必填原项目花名册成员ID，非变动ID或用户ID。'),
  }),
  examples: [{ projectId: 1, memberId: 1 }],
};
export const movementItem = object(
  '人员变动及历史审批明细；读取不会推进节点或生效，不返回试题答案和内部表单。',
  {
    movementId: id('人员变动ID。'),
    movementNo: text('人员变动业务编号。'),
    movementType: { ...text('REMOVAL汰换、TRANSFER转项。'), enum: ['REMOVAL', 'TRANSFER'] },
    status: {
      ...text(
        'PROCESSING审批处理中、WAITING_EFFECTIVE待生效、EFFECTIVE已生效、REJECTED已驳回、WITHDRAWN已撤回。',
      ),
      enum: Object.keys(movementStatusNames),
    },
    statusName: text('变动状态中文名称。'),
    memberId: id('原花名册成员ID。'),
    userId: uuid('成员平台用户UUID。'),
    uid: text('成员全局UID。'),
    displayName: text('成员当前昵称(真实姓名)，缺失回退UID。'),
    accountType: {
      ...text('来源身份：ORGANIZATION组织、INDIVIDUAL个人；不随用户其他组织变化。'),
      enum: ['ORGANIZATION', 'INDIVIDUAL'],
    },
    organizationId: uuid('来源组织UUID；个人来源null。', true),
    organizationName: text('来源组织名称；个人或组织已删除时null。', true),
    sourceProjectId: id('原项目ID。'),
    sourceProjectName: text('原项目当前名称；未设置时null。', true),
    targetProjectId: id('目标项目ID；汰换时null。', true),
    targetProjectName: text('目标项目名称；汰换或未设置时null。', true),
    reason: text('变动原因。'),
    plannedEffectiveDate: { ...text('预计生效日期，YYYY-MM-DD。'), format: 'date' },
    initiatedBy: uuid('发起人用户UUID。'),
    initiatorName: text('发起人当前展示姓名，缺失回退UID。'),
    initiatedAt: timestamp('发起时间', false),
    effectiveAt: timestamp('实际生效时间'),
    rejectedAt: timestamp('驳回时间'),
    withdrawnAt: timestamp('撤回时间'),
    examAttemptId: id('独立目标考试应试ID；未入场时null。', true),
    examStatus: text(
      '交卷后的最终考试结果ADMITTED录取/ELIMINATED淘汰/PENDING待阅卷等；未交卷为null。',
      true,
    ),
    examSubmittedAt: timestamp('目标考试交卷时间'),
    examCancelledAt: timestamp('目标考试取消时间'),
    flowNo: text('审批流业务编号；汰换为null。', true),
    flowStatus: text(
      '审批流PENDING处理中、APPROVED通过、REJECTED驳回、WITHDRAWN撤回等；无审批流为null。',
      true,
    ),
    flowVersionNo: version('审批流版本，从0开始；无审批流为null。', true),
    currentNode: id('当前审批节点序号；无当前节点时null。', true),
    approvalSteps: array(
      '按节点序号及ID排序的候选明细；保留关闭候选及历史决定，汰换为空。',
      object('审批候选节点及最后一条动作；版本和ID用于人工处理入口。', {
        nodeId: uuid('节点UUID。'),
        nodeSeq: id('节点序号，从1起。'),
        nodeCode: text(
          'SOURCE_ORG_OWNER来源负责人、MEMBER_CONFIRM本人接单、TARGET_ENTRANCE_EXAM目标考试、TARGET_MANAGER目标主策略官、TARGET_ORG_OWNER目标负责人。',
        ),
        nodeName: text('节点中文名称。'),
        nodeStatus: text(
          'WAITING未激活、PENDING待处理、APPROVED通过、REJECTED驳回、CANCELED关闭、SKIPPED跳过等。',
        ),
        operatorId: uuid('最后一次实际操作人UUID；未操作null。', true),
        operatorName: text('最后一次实际操作人姓名快照；未操作null。', true),
        action: text('最后动作类型APPROVE/REJECT等；未操作null。', true),
        actionComment: text('最后动作意见；无意见null。', true),
        actionAt: timestamp('最后动作时间'),
        nodeVersionNo: version('节点版本，从0起。'),
      }),
    ),
    allowedActions: array(
      '当前角色实时资格可执行动作；协作负责人只读为空。等待节点只能走对应业务入口。负责人替换后新待办同步仍待接入。',
      {
        ...text(
          'WITHDRAW撤回、APPROVE同意、REJECT驳回、ACCEPT_TRANSFER接受转项、REJECT_TRANSFER拒绝转项、TAKE_TARGET_EXAM参加目标考试。',
        ),
        enum: [
          'WITHDRAW',
          'APPROVE',
          'REJECT',
          'ACCEPT_TRANSFER',
          'REJECT_TRANSFER',
          'TAKE_TARGET_EXAM',
        ],
      },
    ),
  },
);
const exampleUuid = '00000000-0000-4000-8000-000000000001';
export const movementItemExample = {
  movementId: 1,
  movementNo: 'MV1',
  movementType: 'REMOVAL',
  status: 'WAITING_EFFECTIVE',
  statusName: '待生效',
  memberId: 1,
  userId: exampleUuid,
  uid: 'member',
  displayName: '成员',
  accountType: 'INDIVIDUAL',
  organizationId: null,
  organizationName: null,
  sourceProjectId: 1,
  sourceProjectName: '原项目',
  targetProjectId: null,
  targetProjectName: null,
  reason: '计划调整',
  plannedEffectiveDate: '2099-01-01',
  initiatedBy: exampleUuid,
  initiatorName: '发起人',
  initiatedAt: '2026-10-26 12:00:00',
  effectiveAt: null,
  rejectedAt: null,
  withdrawnAt: null,
  examAttemptId: null,
  examStatus: null,
  examSubmittedAt: null,
  examCancelledAt: null,
  flowNo: null,
  flowStatus: null,
  flowVersionNo: null,
  currentNode: null,
  approvalSteps: [],
  allowedActions: ['WITHDRAW'],
};
export const movementDetailResponse = {
  ...movementItem,
  examples: [
    movementItemExample,
    {
      ...movementItemExample,
      movementType: 'TRANSFER',
      status: 'PROCESSING',
      statusName: '审批处理中',
      targetProjectId: 2,
      targetProjectName: '目标项目',
      flowNo: 'TF1',
      flowStatus: 'PENDING',
      flowVersionNo: 0,
      currentNode: 1,
      approvalSteps: [
        {
          nodeId: exampleUuid,
          nodeSeq: 1,
          nodeCode: 'MEMBER_CONFIRM',
          nodeName: '本人接单',
          nodeStatus: 'PENDING',
          operatorId: null,
          operatorName: null,
          action: null,
          actionComment: null,
          actionAt: null,
          nodeVersionNo: 0,
        },
      ],
      allowedActions: ['ACCEPT_TRANSFER', 'REJECT_TRANSFER'],
    },
  ],
};
export const movementListExample = {
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
  records: [movementItemExample],
};
export const movementListResponse = {
  ...object('人员变动分页，数据库筛选和计数位于同一读取快照；按发起时间、ID倒序。', {
    total: version('匹配总数。'),
    current: id('当前页码。'),
    size: id('每页条数。'),
    pages: version('总页数，无记录为0。'),
    records: array('当前页记录，超出末页为空数组。', movementItem),
  }),
  examples: [movementListExample],
};
