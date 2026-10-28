import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { projectDraftDetail } from './project-creation.schema.js';
import { projectPublishedExample } from './project-query.schema.js';
const base = projectDraftDetail.properties;
const fields = [
  'projectNo',
  'projectName',
  'projectDescription',
  'requesterType',
  'requesterId',
  'requesterName',
  'categoryLevel1Id',
  'categoryLevel1Name',
  'categoryLevel2Id',
  'categoryLevel2Name',
  'categoryLevel3Ids',
  'categoryLevel3Names',
  'difficultyLevel',
  'projectQuantity',
  'quantityUnit',
  'deadline',
  'requiredHeadcount',
  'educationRequirement',
  'employmentType',
  'experienceRequirement',
  'workSummary',
  'specialRequirement',
  'mandatoryRequirement',
  'standardContent',
  'standardLink',
  'status',
  'currentNodeCode',
] as const;
const projectId = {
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description: '项目ID，32位正整数。',
};
const time = (description: string) => ({
  type: 'string',
  nullable: true,
  description: `${description}，上海时区yyyy-MM-dd HH:mm:ss；尚未发生为null。`,
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$',
});
export const boardBasicBody = {
  type: 'object',
  additionalProperties: false,
  description: '查询项目基础详情；角色只取当前会话，不接受组织或身份覆盖参数。',
  required: ['projectId'],
  properties: { projectId },
  examples: [{ projectId: 3001 }],
};
export const boardBasicExample = {
  ...Object.fromEntries(
    fields.map((key) => [key, (projectPublishedExample as Record<string, unknown>)[key]]),
  ),
  projectId: 3001,
  publishedAt: '2026-10-26 10:00:00',
  closedAt: null,
};
export const boardBasicDetail = {
  type: 'object',
  additionalProperties: false,
  description:
    '项目基础详情；只返回基础字段和有序分类快照，不含附件、生产指标、审批记录、任务轮次或内部JSON。读取不写任何业务事实。',
  required: ['projectId', ...fields, 'publishedAt', 'closedAt'],
  properties: {
    ...Object.fromEntries(fields.map((key) => [key, (base as Record<string, unknown>)[key]])),
    projectId,
    requesterId: {
      ...base.requesterId,
      description: '需求方用户ID，UUID；历史组织需求方仍为组织账号用户ID，不是组织ID。',
    },
    status: {
      type: 'string',
      enum: ['DRAFT', 'PUBLISHED'],
      description:
        '项目状态：DRAFT=草稿、PUBLISHED=已发布；结项由currentNodeCode=COMPLETED表示，本接口不按发布状态筛选。',
    },
    publishedAt: time('发布时间'),
    closedAt: time('关闭时间'),
  },
  examples: [boardBasicExample],
};
export const boardBasicSchema: FastifySchema = {
  operationId: 'getProjectBoardBasicDetail',
  summary: '查询看板项目基础详情',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-108；当前NAVIGATOR限本人创建项目，PM限PENDING_ACCEPTANCE/ASSIGNED候选策略官或ASSIGNED招募协作负责人；EXPERT限未删除组织的有效主管/有效项目负责人且组织已接单，普通成员与个人接单不授权。负责人关系表只要存在记录就禁止回退旧单负责人，离组即失权。组织关系ACTIVE、EXIT_APPROVING、PENDING_LEAVE有效。同账号其他会话角色独立。以旧Mapper实际ACCEPTED条件为准，旧Controller声称的待接单负责人访问未开放。非本人、逻辑删除或不存在均403；允许有合法关系的草稿和已结项项目。个人需求方取实时昵称(姓名)，组织取名称快照。',
  body: boardBasicBody,
  response: {
    200: {
      ...resultSchema(boardBasicDetail),
      examples: [{ code: 200, message: '操作成功', data: boardBasicExample }],
    },
    ...Object.fromEntries(
      Object.entries({
        400: 'projectId必须为32位正整数。',
        401: '未登录或会话失效。',
        403: '项目不存在、已删除、当前角色无合法关系或来源不可信。',
        500: '内部处理失败。',
        503: '服务不可用。',
      }).map(([status, message]) => [
        status,
        {
          ...resultSchema({ type: 'null', description: '失败无业务数据，固定null。' }),
          description: message,
          examples: [{ code: Number(status), message, data: null }],
        },
      ]),
    ),
  },
};

export const boardStatisticsExamples = [
  { mode: 'TASK', pendingTaskCount: 3, completedTaskCount: 2, involvedProjectCount: 1 },
  {
    mode: 'BOARD',
    totalProjectCount: 10,
    startupProjectCount: 2,
    assemblyProjectCount: 3,
    productionProjectCount: 4,
  },
];
const statisticsFields = {
  TASK: {
    pendingTaskCount:
      '真实待办按项目和任务类型归并的轮次数；同类多个来源只计1，排除日常生产报量与退回修正，不按卡片数统计。',
    completedTaskCount:
      '当前可见项目中每种任务最新一轮在上海当天完成的数量；00:00至次日00:00半开区间。OPEN/CANCELLED或有真实待办不计；首次验收和返修复验归并。',
    involvedProjectCount: '当前真实待办涉及的去重项目数量，无待办为0。',
  },
  BOARD: {
    totalProjectCount:
      '当前创建人、在任PM或协作人、已接单组织主管或有效负责人可见的已发布且未删除项目总数，含已结项项目。',
    startupProjectCount:
      '主节点为招募策略官、生产计划、准入考试或标准培训的项目数量；null节点不计入阶段。',
    assemblyProjectCount: '主节点为招募执行专家的项目数量。',
    productionProjectCount:
      '主节点为生产任务且存在同项目子任务关联报量的项目数量；项目级报量不计，不限制数量和核准状态，按项目去重。',
  },
};
export const boardStatisticsData = {
  description:
    '工作台统计；只返回mode对应字段，无数据为0，不返回另一模式字段或null，三个阶段合计可以小于总数。',
  oneOf: Object.entries(statisticsFields).map(([mode, fields], i) => ({
    type: 'object',
    additionalProperties: false,
    description: `${mode}模式统计，当前会话角色及实时关系口径。`,
    required: ['mode', ...Object.keys(fields)],
    properties: {
      mode: {
        type: 'string',
        enum: [mode],
        description: `${mode}= ${mode === 'TASK' ? '任务轮次' : '项目阶段'}统计。`,
      },
      ...Object.fromEntries(
        Object.entries(fields).map(([key, description]) => [
          key,
          { type: 'integer', minimum: 0, description },
        ]),
      ),
    },
    examples: [boardStatisticsExamples[i]],
  })),
};
export const boardStatisticsSchema: FastifySchema = {
  operationId: 'getProjectWorkbenchStatistics',
  summary: '查询任务轮次或项目阶段统计',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-109；按当前会话NAVIGATOR/PM/EXPERT和实时项目关系计算，其他会话角色独立。TASK读取真实业务来源和历史轮次，含个人考试/培训、历史人工阅卷；BOARD仅管理关系，待接受PM、普通组织成员和个人接单不计。离组和负责人移除即时失权，负责人有任意关系行时不回退旧单值。只读RepeatableRead事务，不修复轮次、不修改节点、不写outbox。业务Agent继续mock，实际投递未接入。',
  querystring: {
    type: 'object',
    additionalProperties: false,
    description: '统计模式查询参数，无默认模式。',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['TASK', 'BOARD'],
        description: '必填且区分大小写：TASK=任务轮次，BOARD=项目阶段。',
      },
    },
    examples: [{ mode: 'TASK' }, { mode: 'BOARD' }],
  },
  response: {
    200: {
      ...resultSchema(boardStatisticsData),
      examples: boardStatisticsExamples.map((data) => ({ code: 200, message: '操作成功', data })),
    },
    ...Object.fromEntries(
      Object.entries({
        400: 'mode缺失或不为TASK/BOARD。',
        401: '未登录或会话失效。',
        403: '当前角色无权限或来源不可信。',
        409: '转入身份状态冲突，需刷新或由管理员核对。',
        500: '内部处理失败。',
        503: '服务不可用。',
      }).map(([status, message]) => [
        status,
        {
          ...resultSchema({ type: 'null', description: '失败无业务数据，固定null。' }),
          description: message,
          examples: [{ code: Number(status), message, data: null }],
        },
      ]),
    ),
  },
};

const boardProjectFields = {
  projectId,
  assignmentId: {
    ...projectId,
    nullable: true,
    description: 'EXPERT本人可管理的已接单分配最大ID；其他角色为null。',
  },
  deadline: time('项目截止时间；未配置为null'),
  projectNo: base.projectNo,
  projectName: { type: 'string', description: '项目名称。' },
  requesterName: {
    type: 'string',
    description: '个人需求方实时昵称(姓名)，缺失回退快照；组织需求方为名称快照。',
  },
  needWrittenExam: {
    type: 'boolean',
    description: '生产计划是否需要准入考试；未配置计划为false。',
  },
  primaryProjectManager: {
    type: 'boolean',
    description: '仅PM返回，是否为当前ASSIGNED主策略官；其他角色省略。',
  },
  expertRecruitmentHandler: {
    type: 'boolean',
    description: '仅PM返回，是否为当前ASSIGNED招募协作负责人；其他角色省略。',
  },
  currentNodeCode: {
    ...base.currentNodeCode,
    nullable: false,
    description: `${base.currentNodeCode.description}；历史null按是否有ASSIGNED策略官回退PRODUCTION_PLAN或RECRUIT_PROJECT_MANAGER，只读不回写。`,
  },
  currentNodeName: {
    type: 'string',
    nullable: true,
    description: '公共主线节点中文名称；未知历史节点为null。',
  },
  progressQuantity: {
    type: 'number',
    description:
      '全项目全部子任务actualQuantity合计，最多4位小数；无实际交付为0，不使用报量或组织范围数量。单位同quantityUnit。',
  },
  targetQuantity: {
    type: 'number',
    description: '项目创建量级，最多4位小数；未配置为0，单位同quantityUnit。',
  },
  progressPercent: {
    type: 'number',
    description:
      'progressQuantity/targetQuantity*100，百分数，四舍五入保留两位小数；分母小于等于0返回0，允许超过100。',
  },
  quantityUnit: {
    type: 'string',
    nullable: true,
    description: '项目量级单位快照；历史未配置为null。',
  },
};
export const boardProjectsBody = {
  type: 'object',
  additionalProperties: false,
  description: '看板项目列表查询；空对象按第1页每页20条，不接受角色或组织范围参数。',
  properties: {
    current: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 1,
      description: '页码，从1开始，默认1；超出总页数返回空records，保留total。',
    },
    size: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: '每页条数，1至100，默认20。',
    },
    keyword: {
      type: 'string',
      nullable: true,
      maxLength: 128,
      description:
        '项目名或需求方名称快照包含匹配，最多128字符；去首尾空白，null/空串/纯空白不筛选。',
    },
  },
  examples: [{ current: 1, size: 20, keyword: null }],
};
export const boardProjectsExample = {
  total: 1,
  pages: 1,
  current: 1,
  size: 20,
  records: [
    {
      projectId: 3001,
      assignmentId: null,
      deadline: '2099-12-31 23:59:59',
      projectNo: 'PRJ202610260001',
      projectName: '示例项目',
      requesterName: '小明(王小明)',
      needWrittenExam: true,
      primaryProjectManager: true,
      expertRecruitmentHandler: false,
      currentNodeCode: 'PRODUCTION_TASK',
      currentNodeName: '生产任务',
      progressQuantity: 1250.1256,
      targetQuantity: 1000,
      progressPercent: 125.01,
      quantityUnit: '条',
    },
  ],
};
export const boardProjectsData = {
  type: 'object',
  additionalProperties: false,
  description:
    '已发布未删除项目分页；按发布时间倒序（null最后）、ID倒序，项目去重。空范围records为空，total/pages为0。',
  required: ['total', 'pages', 'current', 'size', 'records'],
  properties: {
    total: { type: 'integer', minimum: 0, description: '权限和关键词筛选后项目总数。' },
    pages: { type: 'integer', minimum: 0, description: '总页数，total/size向上取整，无数据为0。' },
    current: boardProjectsBody.properties.current,
    size: boardProjectsBody.properties.size,
    records: {
      type: 'array',
      description: '当前页项目卡片；无匹配或超出总页数为空数组。',
      items: {
        type: 'object',
        additionalProperties: false,
        description: '项目卡片，进度始终采用全项目口径。',
        required: Object.keys(boardProjectFields).filter(
          (key) => !['primaryProjectManager', 'expertRecruitmentHandler'].includes(key),
        ),
        properties: boardProjectFields,
      },
    },
  },
  examples: [boardProjectsExample],
};
export const boardProjectsSchema: FastifySchema = {
  operationId: 'listProjectBoardProjects',
  summary: '查询看板项目列表',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-110；当前会话NAVIGATOR限本人创建，PM限ASSIGNED主策略官或招募协作负责人，EXPERT限有效组织主管/有效项目负责人且组织已接单。离组/负责人移除即时失权，有任意负责人关系行不回退旧单。只查已发布未删除项目，含结项；EXPERT空页仍校验实时管理身份，普通成员/个人接单403，有管理身份但无匹配项目返回空页。全页在RepeatableRead只读事务内，不写轮次、节点或outbox。业务Agent保持mock。',
  body: boardProjectsBody,
  response: {
    200: {
      ...resultSchema(boardProjectsData),
      examples: [{ code: 200, message: '操作成功', data: boardProjectsExample }],
    },
    ...Object.fromEntries(
      Object.entries({
        400: '分页参数无效或关键词过长。',
        401: '未登录或会话失效。',
        403: '无看板管理身份、角色无权或来源不可信。',
        500: '内部处理失败。',
        503: '服务不可用。',
      }).map(([status, message]) => [
        status,
        {
          ...resultSchema({ type: 'null', description: '失败无业务数据，固定null。' }),
          description: message,
          examples: [{ code: Number(status), message, data: null }],
        },
      ]),
    ),
  },
};

export const boardSubtasksExample = [
  {
    subtaskId: 5201,
    subtaskNo: 'ST202610270001',
    subtaskName: '第一批数据标注',
    status: 'IN_PROGRESS',
    statusName: '进行中',
    distributionMode: 'DESIGNATED',
    plannedStartDate: '2026-10-26',
    expectedDeliveryDate: '2026-10-30',
    expectedQuantityToDate: 10,
    progressLowRisk: false,
    reportedQuantity: 15,
    targetQuantity: 25,
    progressPercent: 60,
    quantityUnit: '条',
    overdueRisk: false,
  },
];
const boardDate = (description: string) => ({
  type: 'string',
  format: 'date',
  description: `${description}，格式yyyy-MM-dd。`,
});
const boardQuantity = (description: string) => ({ type: 'number', description });
const subtaskProperties = {
  subtaskId: { ...projectId, description: '生产子任务ID，32位正整数。' },
  subtaskNo: { type: 'string', description: '系统生成的全局唯一子任务编号。' },
  subtaskName: { type: 'string', description: '创建时填写的子任务名称。' },
  status: {
    type: 'string',
    enum: ['IN_PROGRESS', 'PENDING_ACCEPTANCE', 'REWORK_REQUIRED', 'ACCEPTED'],
    description:
      '状态：IN_PROGRESS进行中、PENDING_ACCEPTANCE待验收、REWORK_REQUIRED驳回返修、ACCEPTED已验收。',
  },
  statusName: {
    type: 'string',
    nullable: true,
    description: '状态对应中文名；历史未知编码为null。',
  },
  distributionMode: {
    type: 'string',
    enum: ['POOL', 'DESIGNATED'],
    description: '分发方式：POOL任务池、DESIGNATED指定人员。',
  },
  plannedStartDate: boardDate('创建时间对应的上海业务日期，计划含首尾日期'),
  expectedDeliveryDate: boardDate('预计交付日期'),
  expectedQuantityToDate: {
    ...boardQuantity(
      '截至上海今天应完成量，目标按含首尾的计划天数均摊，创建日前为0，交付日后封顶目标，四舍五入4位；结束早于开始或目标非正数为null。单位同quantityUnit。',
    ),
    nullable: true,
  },
  progressLowRisk: {
    type: 'boolean',
    description: '报量严格低于未舍入的应完成量时为true；无有效计划、待验收和已验收为false。',
  },
  reportedQuantity: boardQuantity(
    '累计报量，不按核查状态或报量日期过滤；全项目取全部报量，组织任务池取可管理组织报量，组织指定人员取组织报量/组织指定人数；人数为0返回0。单位同quantityUnit。',
  ),
  targetQuantity: boardQuantity(
    '进度目标：全项目及组织任务池取预期交付量；组织指定人员取预期交付量/全部指定人数，人数为0返回0。单位同quantityUnit。',
  ),
  progressPercent: boardQuantity(
    'reportedQuantity/targetQuantity*100，四舍五入两位，可超过100；目标非正数为0。单位百分比。',
  ),
  quantityUnit: { type: 'string', description: '创建子任务时保存的量级单位快照。' },
  overdueRisk: {
    type: 'boolean',
    description: '上海今天到达或超过交付日且非待验收/已验收时为true。',
  },
};
export const boardSubtasksData = {
  type: 'array',
  description: '按预计交付日期、ID升序的子任务进度；无可见子任务返回空数组，不分页。',
  items: {
    type: 'object',
    additionalProperties: false,
    description: '当前角色范围内的单个子任务交付进度与风险。',
    required: Object.keys(subtaskProperties),
    properties: subtaskProperties,
  },
  examples: [boardSubtasksExample],
};
export const boardSubtasksSchema: FastifySchema = {
  operationId: 'getProjectBoardSubtasks',
  summary: '查询子任务交付进度',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-111；仅已发布未删除项目。当前NAVIGATOR限创建人，PM限在任主策略官/招募协作负责人，待接受不授权；EXPERT限已接单组织当前有效主管/负责人，多组织取实际可管理组织并集，离组失权，存在负责人关系行时不回退旧负责人。普通成员/个人接单不授权。组织仅返回有本组织指定或报量的子任务，历史离项成员报量与指定仍计入。累计报量取真实日报，不取子任务reportedQuantity/actualQuantity快照、不按核查状态过滤；读取无副作用，RepeatableRead事务。',
  body: {
    ...boardBasicBody,
    description: '目标项目ID；按当前会话角色及实时关系鉴权，不接受组织或身份覆盖。',
  },
  response: {
    ...(boardBasicSchema.response as Record<string, unknown>),
    200: {
      ...resultSchema(boardSubtasksData),
      examples: [{ code: 200, message: '操作成功', data: boardSubtasksExample }],
    },
  },
};

const riskItemProperties = {
  code: {
    type: 'string',
    enum: [
      'PROJECT_OVERDUE',
      'SUBTASK_OVERDUE',
      'SUBTASK_PROGRESS_LOW',
      'MEMBER_EFFICIENCY',
      'MEMBER_QUALITY',
    ],
    description:
      '风险编码：PROJECT_OVERDUE项目逾期、SUBTASK_OVERDUE子任务逾期、SUBTASK_PROGRESS_LOW子任务进度偏低、MEMBER_EFFICIENCY人员效率不达标、MEMBER_QUALITY人员质量不达标。',
  },
  severity: {
    type: 'string',
    enum: ['URGENT', 'WARNING'],
    description: '严重程度：URGENT紧急（逾期）、WARNING警告（进度或人员不达标）。',
  },
  targetId: { ...projectId, description: '风险对象ID：按code分别为项目、子任务或实际项目成员ID。' },
  targetName: {
    type: 'string',
    nullable: true,
    description:
      '项目名、子任务名或成员实时昵称(姓名)，成员缺失姓名回退昵称/姓名/UID；历史项目未填名称为null。',
  },
  message: {
    type: 'string',
    description: '可直接展示的中文风险原因；进度含百分比与截至今天应完成量。',
  },
  overdueDays: {
    type: 'integer',
    minimum: 0,
    nullable: true,
    description: '逾期自然日数，按上海日期计算，到期当天为0；非逾期风险固定null。',
  },
};
const riskCard = (description: string) => ({
  type: 'object',
  additionalProperties: false,
  description,
  required: ['pendingCount', 'urgentCount', 'items'],
  properties: {
    pendingCount: {
      type: 'integer',
      minimum: 0,
      description: '当前卡片风险明细数，等于items长度；同一对象可产生多条风险。',
    },
    urgentCount: { type: 'integer', minimum: 0, description: '当前卡片severity=URGENT的明细数。' },
    items: {
      type: 'array',
      description:
        '风险明细，无风险返回[]。子任务先按交付日/ID列出逾期，再按同序列出进度风险；人员按成员ID、效率再质量。',
      items: {
        type: 'object',
        additionalProperties: false,
        description: '单条风险明细。',
        required: Object.keys(riskItemProperties),
        properties: riskItemProperties,
      },
    },
  },
});
export const boardRisksExample = {
  viewScope: 'FULL_PROJECT',
  project: {
    pendingCount: 1,
    urgentCount: 1,
    items: [
      {
        code: 'PROJECT_OVERDUE',
        severity: 'URGENT',
        targetId: 3001,
        targetName: '示例项目',
        message: '项目已逾期，不足一天',
        overdueDays: 0,
      },
    ],
  },
  subtasks: {
    pendingCount: 1,
    urgentCount: 0,
    items: [
      {
        code: 'SUBTASK_PROGRESS_LOW',
        severity: 'WARNING',
        targetId: 5201,
        targetName: '第一批数据标注',
        message: '交付进度偏低（20%），截至今天应完成 50',
        overdueDays: null,
      },
    ],
  },
  members: {
    pendingCount: 1,
    urgentCount: 0,
    items: [
      {
        code: 'MEMBER_EFFICIENCY',
        severity: 'WARNING',
        targetId: 6201,
        targetName: '小明(王小明)',
        message: '今日作业量低于CPD要求',
        overdueDays: null,
      },
    ],
  },
};
export const boardRisksData = {
  type: 'object',
  additionalProperties: false,
  description: '三类独立风险卡片；空卡片计数0且items=[]，不会将子任务风险重复计入项目卡片。',
  required: ['viewScope', 'project', 'subtasks', 'members'],
  properties: {
    viewScope: {
      type: 'string',
      enum: ['FULL_PROJECT', 'ORGANIZATION'],
      description:
        '数据范围：FULL_PROJECT为NAVIGATOR/PM全项目；ORGANIZATION为EXPERT当前可管理的已接单组织并集。',
    },
    project: riskCard(
      '项目自身逾期风险；截止时刻严格早于现在且主节点非COMPLETED，截止相等不触发。',
    ),
    subtasks: riskCard('复用API-111组织/全项目口径的逾期和低进度风险；待验收和已验收不触发。'),
    members: riskCard(
      '仅PM/EXPERT且主节点PRODUCTION_TASK时计算；NAVIGATOR固定空。实际成员ACTIVE/PENDING_EXIT/PENDING_TRANSFER纳入，当天零报量仍参与效率比较。',
    ),
  },
  examples: [boardRisksExample],
};
export const boardRisksSchema: FastifySchema = {
  operationId: 'getProjectBoardRisks',
  summary: '查询项目、子任务、人员风险预警明细',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-112；沿用111已发布未删除项目、当前角色及实时创建人/在任PM/协作人/组织主管或负责人权限，多组织按实际可管理组织合并，离组立即失权。当前上海日期命中的最小sequenceNo阶段提供CPD及准确率阈值；未命中阶段则CPD回退主计划、质量阈值为null，不用其他阶段补值。效率用上海当日报量总和严格比较；质量为全部日期每笔报量最新ID质量记录的合计合格数/合计抽检数*100，四舍五入两位后严格比较；不按报量核查状态过滤，无抽检不触发质量风险。全部查询在只读RepeatableRead事务内，不写轮次、卡片、版本或outbox。',
  body: { ...boardBasicBody, description: '目标项目ID；角色与组织范围由会话和实时关系确定。' },
  response: {
    ...(boardBasicSchema.response as Record<string, unknown>),
    200: {
      ...resultSchema(boardRisksData),
      examples: [{ code: 200, message: '操作成功', data: boardRisksExample }],
    },
  },
};

const trendMetric = {
  type: 'string',
  enum: ['QUANTITY', 'ACCURACY', 'CPD'],
  description:
    '指标，必填且无默认值：QUANTITY=当日报量；ACCURACY=当日加权正确率（%）；CPD=截至当日近7自然日日均报量。',
};
const trendDay = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: '业务日期，yyyy-MM-dd，上海自然日，年份0001—9999。',
};
export const boardTrendsBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '人员趋势查询；四字段均必填，日期包含首尾，须正序且最多366天；范围和角色由当前会话确定。',
  required: ['projectId', 'metric', 'startDate', 'endDate'],
  properties: {
    projectId,
    metric: trendMetric,
    startDate: { ...trendDay, description: '起始上海业务日期，yyyy-MM-dd，包含该日。' },
    endDate: {
      ...trendDay,
      description: '结束上海业务日期，yyyy-MM-dd，包含该日，不能早于起始或超过366天。',
    },
  },
  examples: [
    { projectId: 3001, metric: 'QUANTITY', startDate: '2026-10-26', endDate: '2026-10-27' },
  ],
};
export const boardTrendsExample = {
  metric: 'QUANTITY',
  viewScope: 'FULL_PROJECT',
  dates: ['2026-10-26', '2026-10-27'],
  series: [
    {
      memberId: 3801,
      userId: '00000000-0000-4000-8000-000000000083',
      displayName: '小张(张三)',
      quantityUnit: '条',
      values: [0, 32.5],
    },
  ],
};
export const boardTrendsData = {
  type: 'object',
  additionalProperties: false,
  description: '人员趋势；日期与每条曲线数值按下标对应。',
  required: ['metric', 'viewScope', 'dates', 'series'],
  properties: {
    metric: trendMetric,
    viewScope: {
      type: 'string',
      enum: ['FULL_PROJECT', 'ORGANIZATION'],
      description: '范围：FULL_PROJECT=领航员或策略官全项目；ORGANIZATION=执行专家可管理组织并集。',
    },
    dates: { type: 'array', description: '含首尾、升序且连续的上海业务日期轴。', items: trendDay },
    series: {
      type: 'array',
      description:
        '按成员ID升序的曲线，ACTIVE/PENDING_EXIT/PENDING_TRANSFER人员保留零报量；领航员或无人时为空数组。',
      items: {
        type: 'object',
        additionalProperties: false,
        description: '单个实际项目成员曲线；同一用户不同成员身份不合并。',
        required: ['memberId', 'userId', 'displayName', 'quantityUnit', 'values'],
        properties: {
          memberId: { type: 'integer', description: '项目成员关系主键，不是用户ID。' },
          userId: {
            type: 'string',
            format: 'uuid',
            description: '平台用户UUID；新系统使用UUID替代旧数字用户ID。',
          },
          displayName: {
            type: 'string',
            description: '实时昵称(姓名)；缺失时回退已有昵称、姓名或UID。',
          },
          quantityUnit: {
            type: 'string',
            nullable: true,
            description: '项目作业量级单位，供QUANTITY/CPD使用；未配置为null。',
          },
          values: {
            type: 'array',
            description:
              '与dates等长；数量缺日报量补0，正确率无抽检为null且加权后四舍五入两位，CPD按近7自然日补零并固定除7、四舍五入两位。',
            items: {
              type: 'number',
              nullable: true,
              description: '该日指标值；数量/CPD单位同quantityUnit，正确率单位%，无抽检为null。',
            },
          },
        },
      },
    },
  },
};
export const boardTrendsSchema: FastifySchema = {
  operationId: 'getProjectBoardTrends',
  summary: '查询人员作业量、正确率或CPD趋势',
  tags: ['ProjectWorkbench'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  description:
    'API-113；沿用111实时权限，仅已发布未删除项目，创建人/在任PM或协作人/当前已接单组织主管或负责人；多组织合并、离组立即失权。领航员仅返回日期轴及空series。日报量涵盖项目级和子任务级且不按核查状态过滤；正确率按每笔报量最新ID质检的合格总量/抽检总量*100计算。CPD向前多取6天，不采用阶段CPD或工作日分母。只读RepeatableRead，不写业务、轮次、卡片或outbox。',
  body: boardTrendsBody,
  response: {
    ...(boardBasicSchema.response as Record<string, unknown>),
    200: {
      ...resultSchema(boardTrendsData),
      examples: [{ code: 200, message: '操作成功', data: boardTrendsExample }],
    },
  },
};
