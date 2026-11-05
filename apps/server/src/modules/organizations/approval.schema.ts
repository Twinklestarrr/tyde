import {
  attendanceFormProperties,
  attendanceProcessExample,
  attendanceProcessFields,
} from '../attendance/attendance-application.schema.js';
import { orgIdField } from './organization.schema.js';
type Schema = Record<string, unknown>;
const orgId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const nodeId = '00000000-0000-4000-8000-000000000004';
const userId = '00000000-0000-4000-8000-000000000001';
const flowNo = 'OMX' + 'A'.repeat(40);
const text = (description: string, example: string | null, nullable = false): Schema => ({
  type: 'string',
  description,
  examples: [example],
  ...(nullable ? { nullable: true } : {}),
});
const id = (description: string, example: string, nullable = false): Schema => ({
  ...text(description + '；新项目UUID字符串，与旧Long不同。', example, nullable),
  format: 'uuid',
});
const count = (description: string, value = 0, minimum = 0): Schema => ({
  type: 'integer',
  minimum,
  maximum: 2147483647,
  description,
  examples: [value],
});
const enumeration = (
  description: string,
  values: string[],
  example: string,
  nullable = false,
): Schema => ({
  ...text(description, example, nullable),
  enum: nullable ? [...values, null] : values,
});
const flowStatus = enumeration(
  '流程状态：PENDING=待审批、APPROVED=通过、REJECTED=拒绝、WITHDRAWN=已撤回、CANCELED=取消。撤回/取消写入口本阶段未开放。',
  ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELED'],
  'PENDING',
);
const nodeStatus = enumeration(
  '节点状态：WAITING=等待、PENDING=待审批、APPROVED=通过、REJECTED=拒绝、SKIPPED=跳过、CANCELED=取消、TRANSFERRED=转交。当前退出仅单节点通过/拒绝。',
  ['WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'CANCELED', 'TRANSFERRED'],
  'APPROVED',
);
const joinStatus = enumeration(
  '成员状态：PENDING=待审核、PENDING_ACTIVATION=待激活、ACTIVE=在组、EXIT_APPROVING=退出审批中、PENDING_LEAVE=待离职、LEFT=离组、REMOVED=已移除。',
  ['PENDING', 'PENDING_ACTIVATION', 'ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE', 'LEFT', 'REMOVED'],
  'EXIT_APPROVING',
  true,
);
const time = (description: string, nullable = false): Schema =>
  text(
    `${description}；ISO 8601 UTC响应时间；未记录为null（若可空）。旧本地日期格式兼容待验收。`,
    nullable ? null : '2026-10-19T06:00:00.000Z',
    nullable,
  );
const date = (description: string, nullable = false): Schema => ({
  ...text(description + '；yyyy-MM-dd，按Asia/Shanghai自然日解释。', '2099-01-01', nullable),
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
});
const legacyTime = (description: string): Schema => ({
  ...text(
    description + '；可选，yyyy-MM-dd HH:mm:ss按上海解释，null不筛选，起止边界均包含。',
    '2026-10-19 00:00:00',
    true,
  ),
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
const object = (
  description: string,
  properties: Record<string, Schema>,
  required = Object.keys(properties),
  example?: unknown,
): Schema => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties,
  required,
  ...(example ? { examples: [example] } : {}),
});
export const exitHeaders = {
  type: 'object',
  description: '退出请求幂等头；允许其他标准HTTP头。',
  required: ['idempotency-key'],
  additionalProperties: true,
  properties: {
    'idempotency-key': {
      ...text(
        '必填唯一键，1—128字符，trim后不能为空。同组织、同申请人、同键复用流程，不比较新payload；即使本人已离组也可取自己的结果。不能复用作另一业务操作。',
        'org-exit-example-001',
      ),
      minLength: 1,
      maxLength: 128,
    },
  },
};
export const exitBody = object(
  '发起本人退出或合法代操作退出；只有本人退出需要主管待办。',
  {
    orgId: orgIdField,
    memberId: id(
      '代操作目标组织关系ID；本人退出可省略/null，显式传自己也视为本人退出',
      memberId,
      true,
    ),
    reason: {
      ...text('必填退出原因，trim后非空，最长1000字符；写入申请和动作日志。', '个人发展安排'),
      minLength: 1,
      maxLength: 1000,
    },
    plannedLeaveDate: date('必填拟离职日期，不得早于服务端上海当天'),
  },
  ['orgId', 'reason', 'plannedLeaveDate'],
  { orgId, reason: '个人发展安排', plannedLeaveDate: '2099-01-01' },
);
const queryProperties = {
  orgId: orgIdField,
  businessType: {
    ...text(
      '可选业务类型精确筛选；trim后空白/null不筛选。ORG_MEMBER_EXIT=组织成员退出，其他业务查询可保留，处理接口支持退出、ATTENDANCE_LEAVE=请假、ATTENDANCE_CORRECTION=考勤修正。',
      'ORG_MEMBER_EXIT',
      true,
    ),
    maxLength: 64,
  },
  current: count('页码，从1开始，省略默认1。', 1, 1),
  size: { ...count('每页条数，省略默认20，范围1—100。', 20, 1), maximum: 100 },
};
export const pendingBody = object(
  '仅查询本人在指定组织的待办，无其他审批人参数。',
  queryProperties,
  ['orgId'],
  { orgId, businessType: 'ORG_MEMBER_EXIT', current: 1, size: 20 },
);
export const recordsBody = object(
  '按已处理节点分页；同一工单多个节点分别返回，不限定为当前用户处理的节点。',
  {
    ...queryProperties,
    status: {
      ...nodeStatus,
      nullable: true,
      enum: [
        'WAITING',
        'PENDING',
        'APPROVED',
        'REJECTED',
        'SKIPPED',
        'CANCELED',
        'TRANSFERRED',
        null,
      ],
      description:
        String(nodeStatus.description) + '可选，null不筛选；只返回approvedAt非null的节点。',
    },
    startAt: legacyTime('节点处理时间起点'),
    endAt: legacyTime('节点处理时间终点，起点不得晚于终点'),
  },
  ['orgId'],
  {
    orgId,
    status: 'APPROVED',
    current: 1,
    size: 20,
    startAt: '2026-10-01 00:00:00',
    endAt: '2026-10-31 23:59:59',
  },
);
export const processBody = object(
  '审批处理必须提交最新待办中的流程/节点双版本号；过期或状态已推进返回409。',
  {
    orgId: orgIdField,
    flowNo: {
      ...text('必填流程编号，trim后非空，最长64字符；取自待办。', flowNo),
      minLength: 1,
      maxLength: 64,
    },
    nodeId: id('必填待处理节点ID', nodeId),
    nodeVersionNo: count('必填节点版本号，从0开始，取最新待办。'),
    flowVersionNo: count('必填流程版本号，从0开始，取最新待办。'),
    action: enumeration('审批动作：APPROVE=通过、REJECT=驳回。', ['APPROVE', 'REJECT'], 'APPROVE'),
    actionComment: {
      ...text(
        '可选意见，最长1000字符，trim后空白视为null；action=REJECT时条件必填且不能空白。',
        '同意申请',
        true,
      ),
      maxLength: 1000,
    },
  },
  ['orgId', 'flowNo', 'nodeId', 'nodeVersionNo', 'flowVersionNo', 'action'],
  {
    orgId,
    flowNo,
    nodeId,
    nodeVersionNo: 0,
    flowVersionNo: 0,
    action: 'REJECT',
    actionComment: '请补充离组安排',
  },
);
export const exitExample = {
  flowNo,
  businessType: 'ORG_MEMBER_EXIT',
  businessId: memberId,
  flowStatus: 'PENDING',
  memberId,
  joinStatus: 'EXIT_APPROVING',
  plannedLeaveDate: '2099-01-01',
  appliedAt: '2026-10-19T06:00:00.000Z',
};
export const exitResponse = object(
  '退出流程结果；幂等重取沿用旧Service：flowStatus为流程当前状态，joinStatus/拟离职日来自最初表单快照，非成员实时状态。项目清退未接入，LEFT会同事务登记待补偿任务。',
  {
    flowNo: text('审批流程编号，OMX加40位大写哈希。', flowNo),
    businessType: text('业务类型，固定ORG_MEMBER_EXIT。', 'ORG_MEMBER_EXIT'),
    businessId: text('退出目标成员关系ID字符串，与memberId相同。', memberId),
    flowStatus,
    memberId: id('目标成员关系ID', memberId),
    joinStatus,
    plannedLeaveDate: date('最初申请的拟离职日期', true),
    appliedAt: time('流程申请时间'),
  },
  undefined,
  exitExample,
);
const commonProperties = {
  flowNo: text('审批流程编号。', flowNo),
  businessType: text(
    '业务类型：ORG_MEMBER_EXIT=退出组织、ATTENDANCE_LEAVE=请假、ATTENDANCE_CORRECTION=考勤修正；其余类型沿实际业务值返回。',
    'ORG_MEMBER_EXIT',
  ),
  businessId: text(
    '业务主键；退出为成员关系UUID，考勤为申请人UUID:yyyy-MM-dd，须结合业务类型及组织解释。',
    memberId,
  ),
  businessNo: text('业务单号，无则null。', null, true),
  title: text('申请标题快照。', '小张(张三)退出组织'),
  applicantName: text(
    '当前申请人显示名，昵称(姓名)，账号缺失时回退快照；无数据可为null。',
    '小张(张三)',
    true,
  ),
  applyReason: text('申请原因，无则null。', '个人发展安排', true),
  targetMemberId: id('退出目标成员关系ID；其他业务无此字段时null', memberId, true),
  targetMemberName: text(
    '当前目标成员显示名，组织关系或账号缺失时回退表单快照；未知为null。',
    '小张(张三)',
    true,
  ),
  plannedLeaveDate: date('表单中的拟离职日期，非实时状态；其他业务无此项为null', true),
  appliedAt: time('申请时间'),
};
const commonExample = {
  flowNo,
  businessType: 'ORG_MEMBER_EXIT',
  businessId: memberId,
  businessNo: null,
  title: '小张(张三)退出组织',
  applicantName: '小张(张三)',
  applyReason: '个人发展安排',
  targetMemberId: memberId,
  targetMemberName: '小张(张三)',
  plannedLeaveDate: '2099-01-01',
  appliedAt: '2026-10-19T06:00:00.000Z',
};
const formData = {
  ...object(
    '完整业务表单快照，按businessType解释：退出使用拟离职日期/成员状态，考勤使用日期/目标状态/时段/版本。仅业务自身字段存在，不强制其他业务字段；不包含登录凭据。',
    {
      targetMemberId: id('退出目标组织关系ID', memberId),
      targetMemberName: text('目标显示名创建时快照。', '小张(张三)'),
      plannedLeaveDate: date('申请拟离职日期'),
      joinStatus,
      ...attendanceFormProperties,
    },
  ),
  required: [],
  nullable: true,
  additionalProperties: true,
};
const pendingProperties = {
  ...commonProperties,
  nodeId: id('当前待办节点ID', nodeId),
  nodeVersionNo: count('节点版本，处理时原样传回。'),
  nodeName: text('节点名称。', '组织主管审批'),
  flowVersionNo: count('流程版本，处理时原样传回。'),
  applicantId: id('申请人用户ID', userId),
  applicantOrgId: id('申请组织ID；无则null', orgId, true),
  formData,
  dueAt: time('节点到期时间，当前退出无超时配置', true),
};
export const pendingExample = {
  ...commonExample,
  nodeId,
  nodeVersionNo: 0,
  nodeName: '组织主管审批',
  flowVersionNo: 0,
  applicantId: userId,
  applicantOrgId: orgId,
  formData: {
    targetMemberId: memberId,
    targetMemberName: '小张(张三)',
    plannedLeaveDate: '2099-01-01',
    joinStatus: 'EXIT_APPROVING',
  },
  dueAt: null,
};
const actionType = enumeration(
  '动作：SUBMIT=提交、APPROVE=通过、REJECT=拒绝、WITHDRAW=撤回、TRANSFER=转交、AUTO_PASS=自动通过、AUTO_REJECT=自动拒绝、CANCEL=取消、SKIP=跳过；无动作日志时null。',
  [
    'SUBMIT',
    'APPROVE',
    'REJECT',
    'WITHDRAW',
    'TRANSFER',
    'AUTO_PASS',
    'AUTO_REJECT',
    'CANCEL',
    'SKIP',
  ],
  'APPROVE',
  true,
);
const recordProperties = {
  ...commonProperties,
  nodeId: id('已处理节点ID', nodeId),
  nodeSeq: count('节点序号，从1开始。', 1, 1),
  nodeCode: text('节点编码。', 'OWNER_APPROVAL'),
  nodeName: text('节点名称。', '组织主管审批'),
  nodeStatus,
  actionType,
  operatorName: text('实际操作人当前显示名，缺失时回退最后动作或审批人快照。', '主管(李四)'),
  actionComment: text('最后一条节点动作的意见，无则回退节点意见，均无则null。', '同意申请', true),
  actionAt: time('最后节点动作时间，无动作回退节点处理时间'),
  applicantOrgName: text('申请组织名称快照，无则null。', '示例组织', true),
  flowStatus,
  finishedAt: time('流程结束时间，未结束时null', true),
};
export const recordExample = {
  ...commonExample,
  nodeId,
  nodeSeq: 1,
  nodeCode: 'OWNER_APPROVAL',
  nodeName: '组织主管审批',
  nodeStatus: 'APPROVED',
  actionType: 'APPROVE',
  operatorName: '主管(李四)',
  actionComment: '同意申请',
  actionAt: '2026-10-19T06:00:00.000Z',
  applicantOrgName: '示例组织',
  flowStatus: 'APPROVED',
  finishedAt: '2026-10-19T06:00:00.000Z',
};
const page = (properties: Record<string, Schema>, example: unknown, description: string): Schema =>
  object(
    description,
    {
      total: count('匹配节点总数。', 1),
      pages: count('总页数，无结果为0。', 1),
      current: count('当前页码。', 1, 1),
      size: count('请求每页容量，默认20。', 20, 1),
      records: {
        type: 'array',
        description: '当前页节点列表，无匹配/超出页数为空数组。',
        items: object('单个审批节点及工单上下文。', properties),
      },
    },
    undefined,
    { total: 1, pages: 1, current: 1, size: 20, records: [example] },
  );
export const pendingResponse = page(
  pendingProperties,
  pendingExample,
  '仅组织内当前审批人PENDING节点且流程PENDING的待办分页；按申请时间升序。',
);
const attendancePendingExample = {
  ...pendingExample,
  flowNo: 'ATAEXAMPLE',
  businessType: 'ATTENDANCE_CORRECTION',
  businessId: `${userId}:2020-01-01`,
  title: '小张考勤修正申请',
  plannedLeaveDate: null,
  formData: {
    schemaVersion: 1,
    orgId,
    attendanceDate: '2020-01-01',
    applicationType: 'CORRECTION',
    finalStatus: 'PRESENT',
    reason: '补充出勤说明',
    versionNo: null,
    dailyId: null,
    targetMemberId: memberId,
    targetMemberName: '小张(张三)',
    scheduleId: 1,
    scheduleVersionNo: 0,
    timezone: 'Asia/Shanghai',
    leaveStartAt: null,
    leaveEndAt: null,
  },
};
(pendingResponse.examples as unknown[]).push({
  total: 1,
  pages: 1,
  current: 1,
  size: 20,
  records: [attendancePendingExample],
});
export const recordsResponse = page(
  recordProperties,
  recordExample,
  '按approvedAt非null节点分页；同一流程多个已处理节点逐条返回，按处理时间倒序。代操作退出没有节点，因此不会出现在节点记录中。',
);
export const processExample = {
  flowNo,
  nodeId,
  action: 'APPROVE',
  nodeStatus: 'APPROVED',
  flowStatus: 'APPROVED',
  currentNode: null,
  joinStatus: 'PENDING_LEAVE',
  plannedLeaveDate: '2099-01-01',
  processedAt: '2026-10-19T06:00:00.000Z',
  finishedAt: '2026-10-19T06:00:00.000Z',
};
const exitProcessResponse = object(
  '节点/流程/成员状态同事务结果；审批通过日已到立即LEFT并留项目补偿记录，未来日期PENDING_LEAVE；驳回恢复ACTIVE并清空拟离职日。',
  {
    flowNo: text('处理的流程编号。', flowNo),
    nodeId: id('处理的节点ID', nodeId),
    action: processBody.properties
      ? (processBody.properties as Record<string, Schema>).action!
      : {},
    nodeStatus,
    flowStatus,
    currentNode: {
      type: ['integer', 'null'],
      description: '下一节点序号；当前单节点审批终结固定null。',
      examples: [null],
    },
    joinStatus,
    plannedLeaveDate: date('通过时的拟离职日期；驳回为null', true),
    processedAt: time('处理时间'),
    finishedAt: time('流程结束时间', true),
  },
  undefined,
  processExample,
);

export const processResponse = {
  ...exitProcessResponse,
  description:
    '退出或考勤单节点审批结果，全部状态及副作用同事务；退出返回成员状态，考勤分支成员状态/离职日期为null，并返回日考勤与流程版本。',
  properties: {
    ...(exitProcessResponse.properties as Record<string, Schema>),
    ...attendanceProcessFields,
    joinStatus: {
      ...joinStatus,
      description: String(joinStatus.description) + '考勤审批固定null，不变更组织成员状态。',
    },
    plannedLeaveDate: date('退出审批通过时的拟离职日期；驳回或考勤审批固定null', true),
  },
  examples: [processExample, attendanceProcessExample],
};
