import { personnelSchema } from './personnel.schema.js';

const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
export const transferTargetBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '查询所选在项成员来源组织均已接单的其他已发布项目；成员ID去重，含个人成员返回空列表。',
  required: ['projectId', 'memberIds'],
  properties: {
    projectId: id('必填原项目ID，32位正整数。'),
    memberIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description: '必填原项目成员ID，1至100项，重复ID只校验一次；须全部为本项目ACTIVE在项成员。',
      items: id('项目花名册成员ID，不能使用用户ID或组织成员关系ID。'),
    },
    keyword: {
      type: 'string',
      nullable: true,
      maxLength: 128,
      description: '目标项目名称或项目编号的模糊搜索；去首尾空白，省略、null或空文本不筛选。',
    },
    current: { ...id('页码，从1开始，省略默认1。'), default: 1 },
    size: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: '每页条数，1至100，省略默认20。',
    },
  },
  examples: [{ projectId: 1, memberIds: [1, 2], keyword: null, current: 1, size: 20 }],
};
export const transferTargetExample = {
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
  records: [
    {
      projectId: 2,
      projectNo: 'PJ202610260001',
      projectName: '目标项目',
      requesterName: '需求方',
      examRequired: true,
    },
  ],
};
export const transferTargetResponse = {
  type: 'object',
  description: '候选项目分页；按发布时间、ID倒序，排除同一用户已存在任一开放身份的目标项目。',
  required: ['total', 'current', 'size', 'pages', 'records'],
  properties: {
    total: { type: 'integer', minimum: 0, description: '过滤后的候选总数。' },
    current: id('当前页码。'),
    size: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数。' },
    pages: { type: 'integer', minimum: 0, description: '总页数，无候选时为0。' },
    records: {
      type: 'array',
      description: '当前页候选；空数组表示无匹配项目或超出末页。',
      items: {
        type: 'object',
        description: '候选项目基础信息；查询不保证后续发起成功，发起时须重新校验。',
        required: ['projectId', 'projectNo', 'projectName', 'requesterName', 'examRequired'],
        properties: {
          projectId: id('目标项目ID。'),
          projectNo: { type: 'string', description: '目标项目业务编号。' },
          projectName: {
            type: 'string',
            nullable: true,
            description: '目标项目名称，历史未设置时为null。',
          },
          requesterName: {
            type: 'string',
            description: '个人需求方当前展示名，组织需求方保留名称快照。',
          },
          examRequired: {
            type: 'boolean',
            description: '目标项目是否要求准入考试；生产计划缺失时默认true。',
          },
        },
      },
    },
  },
  examples: [transferTargetExample],
};
export const transferTargetSchema = {
  ...personnelSchema(
    'listPersonnelTransferTargets',
    '查询转项可选项目',
    transferTargetBody,
    transferTargetResponse,
  ),
  description:
    '仅原项目当前主策略官，或EXPERT当前有效组织主管/项目负责人可查询；招募协作负责人无此权限。EXPERT仅可选择其有职责的来源组织成员，跨组织并存不替换来源关系。目标须满足全部来源组织已接单，且所选用户在目标项目无开放成员关系；无组织成员无候选。本接口仅查询，发起转项权限及接单、考试、审批在写流程独立校验。',
};

export const movementCreateBody = {
  type: 'object',
  additionalProperties: false,
  description: '发起单人或批量汰换/转项；重复成员ID去重，整个批次同事务，任一失败全部回滚。',
  required: ['projectId', 'memberIds', 'movementType', 'reason', 'plannedEffectiveDate'],
  properties: {
    projectId: id('必填原项目ID，32位正整数。'),
    memberIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description: '必填原项目成员ID集合，1至100项；只能为ACTIVE在项成员，重复去重。',
      items: id('花名册成员ID，非用户ID。'),
    },
    movementType: {
      type: 'string',
      enum: ['REMOVAL', 'TRANSFER'],
      description: '必填类型：REMOVAL汰换、TRANSFER转项；转项只允许原项目当前主策略官发起。',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      pattern: '\\S',
      description: '必填变动原因，最多500字符，去首尾空白后不能为空。',
    },
    targetProjectId: {
      ...id('转项时必填且不能是原项目；汰换省略或null。须未删除、已发布且未结项。'),
      nullable: true,
    },
    plannedEffectiveDate: {
      type: 'string',
      format: 'date',
      description:
        '必填预计生效日期，YYYY-MM-DD，不能早于上海当天；当天汰换创建即生效；转项完成全部审批且日期已到时即时生效，未来日期等待到期命令。',
    },
  },
  examples: [
    {
      projectId: 1,
      memberIds: [1],
      movementType: 'TRANSFER',
      reason: '调整项目',
      targetProjectId: 2,
      plannedEffectiveDate: '2099-01-01',
    },
    {
      projectId: 1,
      memberIds: [1, 2],
      movementType: 'REMOVAL',
      reason: '计划调整',
      targetProjectId: null,
      plannedEffectiveDate: '2099-01-01',
    },
  ],
};
export const movementCreateResponse = {
  type: 'null',
  description:
    '成功data为null；变动单、成员待离项/待转项、完整审批快照、首节点轮次及PENDING通知同事务。部分迁移：已接本人接单、独立目标考试最终结果消费、人工审批和撤回；已接项目负责人/主策略官交接时同步当前人工待办及即时/到期生效；107/07来源和旧assignmentId兼容待回补，不调用真实Agent。',
  examples: [null],
};
export const movementCreateSchema = {
  ...personnelSchema(
    'createPersonnelMovement',
    '发起单人或批量人员变动（部分迁移）',
    movementCreateBody,
    movementCreateResponse,
  ),
  description:
    '当前PM主策略官可汰换或转项；EXPERT有效主管/项目负责人仅可汰换其职责组织内成员。转项要求先交接源项目负责人，来源组织须已接单目标项目，目标无该用户任一开放身份。个人成员可由PM直接转项，不借用其其他组织。组织流程SOURCE_ORG_OWNER→MEMBER_CONFIRM→TARGET_ENTRANCE_EXAM→TARGET_MANAGER→TARGET_ORG_OWNER；个人省略两端组织节点。创建仅登记首个待办；后续接单、独立考试及人工节点由对应业务入口处理，全部通过且预计日期已到则同事务生效，否则等待到期命令。组织退出审批不能处理转项等待节点。',
};

export const movementWithdrawBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '发起人撤回；须仍有原项目对应组织管理权限。转项仅PROCESSING，汰换仅生效日前WAITING_EFFECTIVE可撤回。',
  required: ['projectId', 'movementId'],
  properties: {
    projectId: id('必填原项目ID，32位正整数。'),
    movementId: id('必填人员变动ID，32位正整数。'),
  },
  examples: [{ projectId: 1, movementId: 1 }],
};
export const movementProcessBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '处理当前人工审批节点；本人接单及目标考试等待节点不能通过此入口处理。节点ID采用本系统UUID。',
  required: [
    'projectId',
    'movementId',
    'flowNo',
    'nodeId',
    'nodeVersionNo',
    'flowVersionNo',
    'action',
  ],
  properties: {
    projectId: id('必填原项目或目标项目ID，须与变动关联。'),
    movementId: id('必填人员变动ID。'),
    flowNo: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '\\S',
      description: '必填审批流编号，须匹配此变动。',
    },
    nodeId: { type: 'string', format: 'uuid', description: '必填当前本人审批节点UUID。' },
    nodeVersionNo: {
      type: 'integer',
      minimum: 0,
      maximum: 2147483647,
      description: '必填节点版本，从0开始；旧版本返回409。',
    },
    flowVersionNo: {
      type: 'integer',
      minimum: 0,
      maximum: 2147483647,
      description: '必填流程版本，从0开始；旧版本返回409。',
    },
    action: {
      type: 'string',
      enum: ['APPROVE', 'REJECT'],
      description: '必填审批动作：APPROVE同意、REJECT驳回。',
    },
    actionComment: {
      type: 'string',
      nullable: true,
      maxLength: 500,
      description: '审批意见，最多500字；REJECT时必填非空，APPROVE可省略或null。',
    },
  },
  examples: [
    {
      projectId: 1,
      movementId: 1,
      flowNo: 'TF001',
      nodeId: '00000000-0000-4000-8000-000000000001',
      nodeVersionNo: 0,
      flowVersionNo: 0,
      action: 'APPROVE',
      actionComment: null,
    },
  ],
};
export const movementCommandResponse = {
  type: 'null',
  description:
    '成功data为null；节点、日志、流程、成员恢复、轮次快照及PENDING通知同事务。审批全部通过后为WAITING_EFFECTIVE，生效处理待后续接入。',
  examples: [null],
};
