import { authSchema, resultSchema } from '../auth/auth.schema.js';
const text = (description: string, nullable = false, maxLength?: number) => ({
  type: 'string',
  description,
  ...(nullable ? { nullable: true } : {}),
  ...(maxLength ? { maxLength } : {}),
});
const integer = (description: string, minimum = 0, maximum = 2147483647) => ({
  type: 'integer',
  minimum,
  maximum,
  description,
});
const time = (description: string) => ({
  ...text(description + '；yyyy-MM-dd HH:mm:ss，按Asia/Shanghai解释，null不筛选。', true),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
export const personalApplicationBody = {
  type: 'object',
  additionalProperties: false,
  description: '仅查询登录用户自己发起的申请；不接收申请人ID。',
  properties: {
    businessType: text(
      '业务类型，省略默认ORG_MEMBER_EXIT=退出组织；null或空白查询全部。ATTENDANCE_LEAVE=请假、ATTENDANCE_CORRECTION=考勤修正、PROJECT_MEMBER_TRANSFER=人员转项；未知类型返回空结果。',
      true,
      64,
    ),
    status: {
      ...text(
        '流程状态，省略/null不筛选：PENDING=待审批、APPROVED=已通过、REJECTED=已驳回、WITHDRAWN=已撤回、CANCELED=已取消。',
        true,
      ),
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELED', null],
    },
    startAt: time('申请时间起点，含边界'),
    endAt: time('申请时间终点，含边界，不得早于startAt'),
    current: integer('页码，从1开始，省略默认1。', 1),
    size: integer('每页条数，省略默认20，最大100。', 1, 100),
  },
  examples: [
    {
      businessType: null,
      status: null,
      startAt: '2026-10-01 00:00:00',
      endAt: '2026-10-31 23:59:59',
      current: 1,
      size: 20,
    },
    {},
  ],
};
const fields = {
  applicationId: { ...text('申请主键UUID，用于定位申请；不代替本人权限校验。'), format: 'uuid' },
  flowNo: text('全局唯一审批流水号。'),
  flowVersionNo: integer('流程乐观锁版本号，从0开始。'),
  businessType: text(
    '业务类型；ORG_MEMBER_EXIT=退出组织；ATTENDANCE_LEAVE=请假、ATTENDANCE_CORRECTION=考勤修正、PROJECT_MEMBER_TRANSFER=人员转项；其他类型按实际业务保存值返回。',
  ),
  businessId: text('关联业务对象ID，字符串；格式由业务类型决定。'),
  businessNo: text('业务编号，未设置null。', true),
  title: text('申请标题。'),
  applicantOrgId: { ...text('申请时所属组织UUID，无组织null。', true), format: 'uuid' },
  applicantOrgName: text('申请时组织名称快照，无组织null。', true),
  applyReason: text('申请原因，未填写null。', true),
  status: {
    ...text(
      '流程状态：PENDING=待审批、APPROVED=通过、REJECTED=驳回、WITHDRAWN=撤回、CANCELED=取消。',
    ),
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELED'],
  },
  currentNode: { ...integer('当前节点序号，从1开始；终态或无节点null。', 1), nullable: true },
  currentNodeCode: text('当前节点编码，终态或无节点null。', true),
  formData: {
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: '原始业务表单快照；没有表单null，按businessType解释，不返回内部认证凭证。',
  },
  targetMemberId: text('退出申请目标成员关系UUID；其他业务或旧快照缺失时null。', true),
  targetMemberName: text(
    '目标成员昵称(真实姓名)，优先当前关联用户资料，否则保留表单快照；无记录null。',
    true,
  ),
  plannedLeaveDate: {
    ...text('退出申请计划离开日期，yyyy-MM-dd；缺失或历史快照日期不合法时null。', true),
    format: 'date',
  },
  transfer: {
    type: 'object',
    nullable: true,
    additionalProperties: false,
    description: '真实变动单结构化来源；非转项、缺失或不匹配流程为null，不从表单推断。',
    required: [
      'movementId',
      'memberId',
      'targetUserId',
      'targetUserName',
      'sourceProjectId',
      'targetProjectId',
      'targetProjectName',
      'organizationId',
      'movementStatus',
      'plannedEffectiveDate',
    ],
    properties: {
      movementId: integer('转项单ID。', 1),
      memberId: integer('来源项目成员ID。', 1),
      targetUserId: { ...text('被调人用户UUID。'), format: 'uuid' },
      targetUserName: text('被调人当前昵称(姓名)，缺失回退UID。'),
      sourceProjectId: integer('来源项目ID。', 1),
      targetProjectId: { ...integer('目标项目ID；历史缺失null。', 1), nullable: true },
      targetProjectName: text('目标项目当前名称；缺失null。', true),
      organizationId: { ...text('来源组织UUID；个人null。', true), format: 'uuid' },
      movementStatus: text(
        '变动状态：PROCESSING审批中、WAITING_EFFECTIVE待生效、EFFECTIVE已生效、REJECTED驳回、WITHDRAWN撤回、CANCELED取消。',
      ),
      plannedEffectiveDate: { ...text('计划生效日期，上海日期yyyy-MM-dd。'), format: 'date' },
    },
  },
  appliedAt: text('申请时间，yyyy-MM-dd HH:mm:ss，Asia/Shanghai。'),
  finishedAt: text('结束时间，yyyy-MM-dd HH:mm:ss，Asia/Shanghai；未结束null。', true),
};
export const personalApplicationExample = {
  total: 1,
  pages: 1,
  current: 1,
  size: 20,
  records: [
    {
      applicationId: '00000000-0000-4000-8000-000000000001',
      flowNo: 'OMXEXAMPLE',
      flowVersionNo: 0,
      businessType: 'ORG_MEMBER_EXIT',
      businessId: '00000000-0000-4000-8000-000000000002',
      businessNo: null,
      title: '小明退出组织',
      applicantOrgId: '00000000-0000-4000-8000-000000000003',
      applicantOrgName: '示例团队',
      applyReason: '个人发展安排',
      status: 'PENDING',
      currentNode: 1,
      currentNodeCode: 'OWNER_APPROVAL',
      formData: {
        targetMemberId: '00000000-0000-4000-8000-000000000002',
        targetMemberName: '小明',
        plannedLeaveDate: '2026-11-01',
      },
      targetMemberId: '00000000-0000-4000-8000-000000000002',
      targetMemberName: '小明',
      plannedLeaveDate: '2026-11-01',
      transfer: null,
      appliedAt: '2026-10-21 12:00:00',
      finishedAt: null,
    },
  ],
};
export const personalApplicationResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'pages', 'current', 'size', 'records'],
  description: '本人申请分页结果，无结果records为空数组、total/pages为0。',
  properties: {
    total: integer('符合条件的总条数。'),
    pages: integer('总页数。'),
    current: integer('当前页码。', 1),
    size: integer('每页条数。', 1, 100),
    records: {
      type: 'array',
      description: '本人申请，按申请时间倒序，同时间按ID倒序。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(fields),
        description: '本人发起的一条申请。',
        properties: fields,
      },
    },
  },
  examples: [
    personalApplicationExample,
    {
      ...personalApplicationExample,
      records: [
        {
          ...personalApplicationExample.records[0],
          businessType: 'PROJECT_MEMBER_TRANSFER',
          businessId: '7',
          transfer: {
            movementId: 7,
            memberId: 2,
            targetUserId: '00000000-0000-4000-8000-000000000004',
            targetUserName: '小明',
            sourceProjectId: 3001,
            targetProjectId: 3002,
            targetProjectName: '目标项目',
            organizationId: null,
            movementStatus: 'PROCESSING',
            plannedEffectiveDate: '2026-11-01',
          },
        },
      ],
    },
  ],
};
export const personalApplicationSchema = {
  ...authSchema(
    'listMyApplications',
    '获取个人申请记录',
    resultSchema(personalApplicationResponse),
    true,
  ),
  tags: ['User'],
  body: personalApplicationBody,
  description:
    '查询本人发起的申请，强制以认证用户ID限定范围；业务类型默认ORG_MEMBER_EXIT，查全部类型请显式传businessType:null。时间按上海本地解释，包含起止边界；申请时间倒序、同时间ID倒序。只读取真实审批流程，不创建申请。支持受信来源Cookie或无浏览器头的Bearer客户端。',
};
