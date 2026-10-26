import type { FastifySchema } from 'fastify';
import { memberStatuses, statusNames } from './personnel-domain.js';
const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
const uuid = (description: string, nullable = false) => ({
  type: 'string',
  format: 'uuid',
  nullable,
  description,
});
const text = (description: string, nullable = false) => ({ type: 'string', nullable, description });
const list = (description: string, items: object, maxItems: number) => ({
  type: 'array',
  nullable: true,
  maxItems,
  description,
  items,
});
const choice = (description: string, values: string[], nullable = false) => ({
  type: 'string',
  enum: nullable ? [...values, null] : values,
  nullable,
  description,
});
const day = (description: string, nullable = true) => ({
  type: 'string',
  format: 'date',
  nullable,
  description,
});
const stamp = (description: string) => ({
  ...text(description, true),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
const pagination = {
  current: { ...id('页码，从1开始；省略默认1。'), default: 1 },
  size: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: '每页条数；省略默认20，最多100。',
  },
};
export const rosterBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '花名册数据库筛选及分页；各非空筛选条件取交集，null或空数组不筛选。组织和用户ID为UUID，成员ID为整数。',
  required: ['projectId'],
  properties: {
    projectId: id('必填项目ID，32位正整数。'),
    keyword: {
      ...text('姓名、昵称或UID模糊搜索，去首尾空白；null/空文本不筛选。', true),
      maxLength: 100,
    },
    accountTypes: list(
      '成员接单身份：INDIVIDUAL=个人、ORGANIZATION=组织；按成员来源组织判定。',
      choice('成员身份。', ['INDIVIDUAL', 'ORGANIZATION']),
      2,
    ),
    orgPositions: list(
      '具体组织关系职位：OWNER=主管、ADMIN=管理员、MEMBER=成员。',
      choice('组织职位。', ['OWNER', 'ADMIN', 'MEMBER']),
      3,
    ),
    organizationIds: list(
      '成员来源组织ID；与当前用户有权限的组织取交集。',
      uuid('组织UUID。'),
      100,
    ),
    employmentTypes: list(
      '用工类型：FULL_TIME=全职、PART_TIME=兼职。',
      choice('用工类型。', ['FULL_TIME', 'PART_TIME']),
      2,
    ),
    responsibleUserIds: list(
      '平级项目负责人用户ID；支持历史单值负责人回退。',
      uuid('负责人用户UUID。'),
      100,
    ),
    statuses: list(
      '成员状态：' + memberStatuses.map((s, i) => `${s}=${statusNames[i]}`).join('、') + '。',
      choice('成员状态。', memberStatuses),
      8,
    ),
    ...pagination,
  },
  examples: [
    {
      projectId: 1,
      keyword: '',
      accountTypes: ['ORGANIZATION'],
      statuses: ['PENDING_CONFIRM'],
      current: 1,
      size: 20,
    },
  ],
};
export const entryBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '单人或批量入项决定；同一批全成或全败，成员ID去重。仅未生效且仍具备接单/准入资格的成员可改；已生效重复返回409。',
  required: ['projectId', 'memberIds', 'entryDecision'],
  properties: {
    projectId: id('必填项目ID。'),
    memberIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description: '必填项目成员ID，1至100项；不是用户或组织关系ID。',
      items: id('项目成员ID。'),
    },
    entryDecision: choice('必填：YES=确认入项，NO=放弃入项。', ['YES', 'NO']),
    plannedEntryDate: day(
      'YES时必填；YYYY-MM-DD，不早于上海当天；当天ACTIVE，未来PENDING_ENTRY；NO时忽略并清空。',
    ),
    declineReason: {
      ...text('NO时必填且非空白，最多500字；YES时忽略并清空。', true),
      maxLength: 500,
    },
  },
  examples: [
    { projectId: 1, memberIds: [1, 2], entryDecision: 'YES', plannedEntryDate: '2099-10-24' },
    { projectId: 1, memberIds: [1], entryDecision: 'NO', declineReason: '无法按期参加' },
  ],
};
const rowProperties = {
  memberId: id('项目成员ID。'),
  userId: uuid('用户UUID。'),
  uid: text('平台UID。'),
  displayName: text('昵称(姓名)，缺失回退已有名称或UID。'),
  avatarUrl: text('头像地址；未设置为null。', true),
  accountType: choice('接单身份：INDIVIDUAL=个人、ORGANIZATION=组织。', [
    'INDIVIDUAL',
    'ORGANIZATION',
  ]),
  organizationId: uuid('来源组织UUID；个人为null。', true),
  organizationName: text('组织名称；个人或组织删除为null。', true),
  orgPosition: choice(
    '具体组织关系职位；OWNER=主管、ADMIN=管理员、MEMBER=成员；个人为null。',
    ['OWNER', 'ADMIN', 'MEMBER'],
    true,
  ),
  employmentType: choice(
    'FULL_TIME=全职、PART_TIME=兼职；未设置或个人为null。',
    ['FULL_TIME', 'PART_TIME'],
    true,
  ),
  responsibleUserId: uuid('兼容负责人用户UUID；恰好一人时返回，否则null。', true),
  responsibleUserName: text('兼容负责人名称；恰好一人时返回，否则null。', true),
  projectOwners: {
    type: 'array',
    description: '当前有效平级负责人；无负责人为空。历史单值仅在无集合历史时回退。',
    items: {
      type: 'object',
      additionalProperties: false,
      description: '平级负责人。',
      required: ['userId', 'name', 'avatarUrl'],
      properties: {
        userId: uuid('负责人用户UUID。'),
        name: text('负责人显示名称。'),
        avatarUrl: text('头像地址，未设置为null。', true),
      },
    },
  },
  admittedAt: stamp('准入时间，上海yyyy-MM-dd HH:mm:ss；旧数据未记录为null。'),
  entryDecision: choice('YES=确认、NO=放弃；尚未决定为null。', ['YES', 'NO'], true),
  plannedEntryDate: day('预计入项日期，YYYY-MM-DD；未确认或放弃为null。'),
  joinedAt: stamp('实际入项时间，上海yyyy-MM-dd HH:mm:ss；未生效为null。'),
  plannedLeaveDate: day('预计离项日期，YYYY-MM-DD；未安排为null。'),
  leftAt: stamp('实际离项时间，上海yyyy-MM-dd HH:mm:ss；尚未离项为null。'),
  status: choice(
    '成员状态：' +
      memberStatuses.map((s, i) => `${s}=${statusNames[i]}`).join('、') +
      '；旧PENDING_ENTRY无日期映射待确认。',
    memberStatuses,
  ),
  statusName: text('成员状态中文名称。'),
  allowedActions: {
    type: 'array',
    description:
      '当前已接入操作；SET_ENTRY=设置入项。协作负责人只读返回空数组；人员变动归12，暂不开放。',
    items: choice('可执行操作。', ['SET_ENTRY']),
  },
};
export const rosterExample = {
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
  records: [
    {
      memberId: 1,
      userId: '00000000-0000-4000-8000-000000000001',
      uid: 'tester',
      displayName: '测试成员',
      avatarUrl: null,
      accountType: 'INDIVIDUAL',
      organizationId: null,
      organizationName: null,
      orgPosition: null,
      employmentType: null,
      responsibleUserId: null,
      responsibleUserName: null,
      projectOwners: [],
      admittedAt: '2026-10-23 18:00:00',
      entryDecision: null,
      plannedEntryDate: null,
      joinedAt: null,
      plannedLeaveDate: null,
      leftAt: null,
      status: 'PENDING_CONFIRM',
      statusName: '待确认',
      allowedActions: ['SET_ENTRY'],
    },
  ],
};
export const rosterResponse = {
  type: 'object',
  additionalProperties: false,
  description: '花名册分页结果；仅当前PM任职或当前EXPERT职责组织范围。读取不创建/激活成员。',
  required: ['total', 'current', 'size', 'pages', 'records'],
  properties: {
    total: { type: 'integer', minimum: 0, description: '筛选后的总记录数。' },
    current: pagination.current,
    size: pagination.size,
    pages: { type: 'integer', minimum: 0, description: '总页数，空集合为0。' },
    records: {
      type: 'array',
      description: '当前页成员，按创建时间和ID倒序。',
      items: {
        type: 'object',
        additionalProperties: false,
        description: '花名册成员。',
        required: Object.keys(rowProperties),
        properties: rowProperties,
      },
    },
  },
  examples: [rosterExample],
};
export const entryResponse = {
  type: 'null',
  description:
    '成功data为null；入项决定、项目单向节点、相关轮次及PENDING通知同事务。未来成员不具备生产资格，实际投递归14。',
  examples: [null],
};
export function personnelSchema(
  operationId: string,
  summary: string,
  body: object,
  data: object,
): FastifySchema {
  return {
    tags: ['项目人员管理'],
    operationId,
    summary,
    description:
      '当前会话PM按当前任职鉴权，主策略官可写/招募协作负责人只读；EXPERT仅有效主管或项目负责人管理的已接单组织范围。',
    security: [{ webSession: [] }, { desktopSession: [] }],
    body,
    response: Object.fromEntries(
      [200, 400, 401, 403, 404, 409, 500].map((status) => [
        status,
        {
          type: 'object',
          description: status === 200 ? '统一成功响应。' : '统一错误响应；data为null。',
          required: ['code', 'message', 'data'],
          properties: {
            code: { type: 'integer', description: 'HTTP业务状态码。' },
            message: text('中文结果说明。'),
            data: status === 200 ? data : { type: 'null', description: '错误无业务数据。' },
          },
        },
      ]),
    ),
  };
}
