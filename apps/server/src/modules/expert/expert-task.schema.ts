const text = (description: string, nullable = false) => ({
  type: 'string',
  description,
  ...(nullable ? { nullable: true } : {}),
});
const object = (description: string, properties: Record<string, unknown>) => ({
  type: 'object',
  description,
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const id = {
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description: '项目或分配ID，32位正整数。',
};
const uuid = (description: string) => ({
  ...text(description + '；新库UUID，缺失为null。', true),
  format: 'uuid',
});
const flag = (description: string) => ({ type: 'boolean', description });
const count = (description: string) => ({
  type: 'integer',
  nullable: true,
  description: description + '；未配置null。',
});
const status = {
  ...text(
    '本人接单状态：PENDING_ACCEPTANCE=待接单、ACCEPTED=已接单、REJECTED=拒绝、CANCELLED=取消、REPLACED=被替换；null或省略不筛选。',
    true,
  ),
  enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'REPLACED', null],
};
export const expertTasksBody = {
  type: 'object',
  description: '本人待办筛选，无分页；请求体必填，可传空对象。',
  additionalProperties: false,
  properties: {
    keyword: {
      ...text(
        '项目名或创建时需求方名称快照模糊匹配；trim，空白/null/省略不筛选，最多100字符。',
        true,
      ),
      maxLength: 100,
    },
    acceptanceStatus: status,
    status: {
      ...status,
      description:
        'acceptanceStatus旧别名，枚举同acceptanceStatus；同时传非null值必须相同，否则400。',
    },
  },
  examples: [{ keyword: '示例', acceptanceStatus: 'PENDING_ACCEPTANCE' }, {}],
};
const ownerFields = {
  userId: uuid('负责人用户ID'),
  name: text('负责人昵称(姓名)，缺失回退UID。'),
  avatarUrl: text('头像地址；未设置null。', true),
};
const basic = object('项目和当前分配信息；名称展示实时资料，搜索按需求方快照。', {
  projectId: id,
  projectName: text('项目名；历史缺失null。', true),
  projectDescription: text('项目描述；未填null。', true),
  requesterName: text('需求方展示名；组织使用项目快照。'),
  creatorId: uuid('创建人ID'),
  creatorName: text('创建人名称；缺失回退需求方快照。'),
  projectManagerId: uuid('当前主策略官ID'),
  projectManagerName: text('当前主策略官名称；未任职null。', true),
  categoryLevel1Name: text('一级分类快照；无则null。', true),
  categoryLevel2Name: text('二级分类快照；无则null。', true),
  categoryLevel3Names: {
    type: 'array',
    description: '三级分类快照；无则空数组，按排序号/ID排列。',
    items: text('三级分类名称。'),
  },
  deadline: text('项目截止时间，上海时间yyyy-MM-dd HH:mm:ss；未配置null。', true),
  subjectType: {
    ...text('分配主体：INDIVIDUAL=个人、ORGANIZATION=组织。'),
    enum: ['INDIVIDUAL', 'ORGANIZATION'],
  },
  organizationId: uuid('组织ID；个人分配为空'),
  organizationName: text('组织名称；个人分配为空。', true),
  productionRequirement: {
    type: 'number',
    nullable: true,
    description: '分配生产量级，单位沿项目quantityUnit；未配null。',
  },
  operatorHeadcount: count('要求作业人数，单位人'),
  inspectorHeadcount: count('要求质检人数，单位人'),
  projectOwners: {
    type: 'array',
    description: '已接单组织ACTIVE负责人；无关系历史才回退旧单值，无人为空数组。',
    items: object('平级负责人。', ownerFields),
  },
  projectOwnerUserId: uuid('唯一负责人ID；无人或多人null'),
  projectOwnerName: text('唯一负责人名称；无人或多人null。', true),
  projectOwnerAvatarUrl: text('唯一负责人头像；无人/多人/未配置null。', true),
  assignedAt: text('分配下发时间，上海时间yyyy-MM-dd HH:mm:ss。'),
});
export const expertTaskExample = {
  assignmentId: 1,
  movementId: null,
  sourceBizType: 'EXPERT_ASSIGNMENT',
  sourceBizId: 1,
  basicInfo: {
    projectId: 3001,
    projectName: '示例项目',
    projectDescription: null,
    requesterName: '示例需求方',
    creatorId: null,
    creatorName: '示例需求方',
    projectManagerId: null,
    projectManagerName: null,
    categoryLevel1Name: null,
    categoryLevel2Name: null,
    categoryLevel3Names: [],
    deadline: null,
    subjectType: 'INDIVIDUAL',
    organizationId: null,
    organizationName: null,
    productionRequirement: 100,
    operatorHeadcount: 1,
    inspectorHeadcount: null,
    projectOwners: [],
    projectOwnerUserId: null,
    projectOwnerName: null,
    projectOwnerAvatarUrl: null,
    assignedAt: '2026-10-22 18:00:00',
  },
  acceptanceStatus: 'PENDING_ACCEPTANCE',
  needWrittenExam: false,
  currentNodeCode: 'PERSONNEL_MANAGEMENT',
  branchNodeCode: null,
  accessContext: {
    projectOwner: false,
    acceptedOrganizationOwner: false,
    canViewOrganizationData: false,
  },
  operations: { canAccept: true, canReject: true, canReportOutput: false },
};
export const expertTasksResponse = {
  type: 'array',
  description:
    '本人待办，分配创建时间/ID倒序；无结果空数组。组织有效身份优先个人，结项及拒绝/取消/替换不推送。已聚合真实转项接单、考试、当前审批及生效成员；报量核查/修正按当前组织与实时权限读取，普通生产待办在本人上海当日已有报量（含零量）后隐藏，次日恢复；核查、退回修正及独立培训保留。其余跨域卡片仍部分迁移，067已接入待响应个人/组织主管/普通成员接单按钮。',
  items: object('本人一条分配待办。', {
    assignmentId: {
      ...id,
      nullable: true,
      description: '真实分配ID；转项来源为null，响应时使用movementId。',
    },
    movementId: { ...id, nullable: true, description: '转项变动单ID；普通分配null。' },
    sourceBizType: {
      ...text('真实来源：EXPERT_ASSIGNMENT普通分配、PROJECT_MEMBER_TRANSFER转项。'),
      enum: ['EXPERT_ASSIGNMENT', 'PROJECT_MEMBER_TRANSFER'],
    },
    sourceBizId: { ...id, description: '来源ID；按sourceBizType解释，不跨类型混用。' },
    basicInfo: basic,
    acceptanceStatus: {
      ...status,
      nullable: false,
      enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'REPLACED'],
    },
    needWrittenExam: flag('是否要求笔试；普通分配沿生产计划，无计划false；转项固定true。'),
    currentNodeCode: text(
      '项目主线；历史null回退RECRUIT_PROJECT_MANAGER=招募策略官，PRODUCTION_PLAN=生产计划、ENTRANCE_EXAM=准入考试、STANDARD_TRAINING=标准培训、RECRUIT_EXECUTION_EXPERT=招募专家、PERSONNEL_MANAGEMENT=人员管理、PRODUCTION_TASK=生产、COMPLETED=结项（不推送）。',
    ),
    branchNodeCode: text(
      '本人支线：ENTRANCE_EXAM=准入考试、MEMBER_MOVEMENT_APPROVAL=人员转项人工审批、MEMBER_ENTRY_CONFIRM=负责人确认成员入项时间、OUTPUT_DATA_REVIEW=报量核查、STANDARD_TRAINING=标准培训、PRODUCTION_TASK=生产任务；无待办null。按实际接单/准入/成员/交卷及负责人考试开放事实重算；报量核查优先入项/考试/培训，修正沿PRODUCTION_TASK且不覆盖独立培训。',
      true,
    ),
    accessContext: object('当前分配身份；下游接口独立鉴权。', {
      projectOwner: flag('是否当前组织项目负责人。'),
      acceptedOrganizationOwner: flag('是否已接单组织的有效主管。'),
      canViewOrganizationData: flag('是否负责人或已接单组织主管，仅表示数据范围身份。'),
    }),
    operations: object('当前操作；未迁移入口不开放。', {
      canAccept: flag('能否接单；有效待响应个人/组织主体或普通成员为true，其他false。'),
      canReject: flag('能否拒单；与canAccept相同，拒绝须填写原因。'),
      canReportOutput: flag(
        '能否从任务卡进入报量：已接单且本人处于生产阶段，当前卡片组织有有效本人或负责人代报成员，且本人上海当天尚未报量时为true；核查、培训、待响应及失权为false。不要求已有可写子任务，保存接口仍逐笔鉴权。',
      ),
    }),
  }),
  examples: [
    [
      expertTaskExample,
      {
        ...expertTaskExample,
        assignmentId: null,
        movementId: 7,
        sourceBizType: 'PROJECT_MEMBER_TRANSFER',
        sourceBizId: 7,
        needWrittenExam: true,
      },
    ],
  ],
};
