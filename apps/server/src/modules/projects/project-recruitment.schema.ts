import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { productionPlanQuery } from './project-production-plan.schema.js';
import { handlerBody } from './project-recruitment-handler.schema.js';
const integer = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
const number = (description: string) => ({ type: 'number', description });
const text = (description: string) => ({ type: 'string', description });
const nullableText = (description: string) => ({ ...text(description), nullable: true });
const object = (description: string, properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  description,
  required: Object.keys(properties),
  properties,
});
const subjectType = {
  type: 'string',
  enum: ['INDIVIDUAL', 'ORGANIZATION'],
  description: '主体类型：INDIVIDUAL=个人，ORGANIZATION=组织；不按账号类型推导。',
};
const quantity = {
  type: 'number',
  minimum: 0.0001,
  exclusiveMaximum: 1e16,
  description:
    '必填生产量级，至少0.0001，最多16位整数及4位小数；单位沿项目，不限制总和小于项目总量。',
};
export const recruitmentBody = {
  type: 'object',
  additionalProperties: false,
  description: '追加下发1—100项；同批主体和拒单来源不可重复，不覆盖历史。',
  required: ['projectId', 'assignments'],
  properties: {
    projectId: handlerBody.properties.projectId,
    assignments: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description: '本次新增个人/组织分配项，全部成功或全部回滚。',
      items: {
        type: 'object',
        additionalProperties: false,
        description: '显式接单主体及生产要求。',
        required: ['subjectType', 'subjectId', 'productionRequirement', 'operatorHeadcount'],
        properties: {
          subjectType,
          subjectId: {
            type: 'string',
            format: 'uuid',
            description: '必填主体UUID；个人为User.id，组织为Organization.id，新旧数值ID不互通。',
          },
          productionRequirement: quantity,
          operatorHeadcount: integer('必填作业人数，32位正整数。'),
          inspectorHeadcount: {
            ...integer('质检人数，可省略/null表示无需质检，填写须为32位正整数。'),
            nullable: true,
          },
          sourceRejectedAssignmentId: {
            ...integer(
              '补招时可传本项目尚未被替代的已拒绝分配ID；允许更换接单主体，仅形成追溯链。缺省/null为普通招募。',
            ),
            nullable: true,
          },
        },
      },
    },
  },
  examples: [
    {
      projectId: 3001,
      assignments: [
        {
          subjectType: 'INDIVIDUAL',
          subjectId: '00000000-0000-4000-8000-000000000003',
          productionRequirement: 10.1234,
          operatorHeadcount: 2,
          inspectorHeadcount: null,
          sourceRejectedAssignmentId: null,
        },
      ],
    },
    {
      projectId: 3001,
      assignments: [
        {
          subjectType: 'ORGANIZATION',
          subjectId: '00000000-0000-4000-8000-000000000004',
          productionRequirement: 100,
          operatorHeadcount: 10,
          inspectorHeadcount: 2,
          sourceRejectedAssignmentId: 12,
        },
      ],
    },
  ],
};
const brief = {
  ...object('策略官用户摘要；未指定或用户不存在为null。', {
    userId: { type: 'string', format: 'uuid', description: '用户UUID。' },
    uid: text('平台UID。'),
    name: text('昵称(真实姓名)；缺失时回退已有名称或UID。'),
    avatarUrl: nullableText('头像URL；未设置为null。'),
  }),
  nullable: true,
};
const count = (description: string) => ({ type: 'integer', minimum: 0, description });
export const recruitmentDetail = object('招募页面一致快照。', {
  projectId: integer('项目数值ID。'),
  projectName: nullableText('项目名称，历史缺失为null。'),
  projectQuantity: { ...number('项目生产总量，历史未配置为null。'), nullable: true },
  quantityUnit: nullableText('生产量级单位，未配置为null。'),
  currentNodeCode: {
    type: 'string',
    nullable: true,
    enum: [
      'RECRUIT_PROJECT_MANAGER',
      'PRODUCTION_PLAN',
      'ENTRANCE_EXAM',
      'STANDARD_TRAINING',
      'RECRUIT_EXECUTION_EXPERT',
      'PERSONNEL_MANAGEMENT',
      'PRODUCTION_TASK',
      'COMPLETED',
      null,
    ],
    description:
      '共享节点：依次为招募策略官、生产计划、准入考试、标准培训、招募专家、人员管理、生产任务、结项；历史未设置为null。',
  },
  primaryManager: brief,
  handler: brief,
  currentOperatorRole: {
    type: 'string',
    enum: ['PRIMARY_MANAGER', 'EXPERT_RECRUITMENT_HANDLER'],
    description: '当前操作者身份；兼任时优先主策略官。',
  },
  canChangeHandler: { type: 'boolean', description: '只有当前主策略官为true。' },
  summary: object('全部分配历史汇总；拒单不占生产量级。', {
    activeAssignmentCount: count('有效分配数=待接单+已接单。'),
    pendingAcceptanceCount: count('待接单分配数。'),
    acceptedCount: count('已接单分配数。'),
    rejectedCount: count('历史已拒绝分配数。'),
    assignedProductionRequirement: number('待接单与已接单量级合计；历史缺失量级按0。'),
    remainingProductionRequirement: number('项目总量减已分配量级，最低0；未配置总量为0。'),
  }),
});
const assignment = {
  ...object('最近分配摘要；从未招募时null。', {
    assignmentId: integer('分配记录ID。'),
    status: {
      type: 'string',
      enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED', 'REPLACED'],
      description:
        'PENDING_ACCEPTANCE=待接单、ACCEPTED=已接单、REJECTED=已拒绝、REPLACED=已被更换。',
    },
    productionRequirement: { ...number('本分配生产量级；历史缺失为null。'), nullable: true },
    operatorHeadcount: { ...integer('本分配作业人数；历史缺失为null。'), nullable: true },
    inspectorHeadcount: {
      ...integer('本分配质检人数；无需质检或历史缺失为null。'),
      nullable: true,
    },
  }),
  nullable: true,
};
export const recruitmentPage = object('候选分页；已有分配优先、组织优先、主体UUID升序。', {
  records: {
    type: 'array',
    description: '本页候选卡片，无匹配或越界为空数组。',
    items: object('候选卡片，不暴露手机号、证件或内部账号类型。', {
      subjectId: {
        type: 'string',
        format: 'uuid',
        description: '主体UUID，含义由subjectType决定。',
      },
      subjectType,
      realName: nullableText('个人真实姓名；组织或未填写为null。'),
      nickname: nullableText('个人昵称；组织为null。'),
      organizationName: nullableText('组织名称；个人为null。'),
      avatarUrl: nullableText('个人头像或组织Logo URL；未设置为null。'),
      supervisorName: nullableText('组织有效主管真实姓名；个人或未填写为null。'),
      supervisorNickname: nullableText('组织有效主管昵称；个人为null。'),
      description: nullableText('个人或组织简介；未填写为null。'),
      assignment,
      availableAction: {
        type: 'string',
        enum: ['RECRUIT', 'RECRUIT_AGAIN', 'NONE'],
        description:
          'RECRUIT=从未招募，RECRUIT_AGAIN=最近分配已拒绝，NONE=已有待接单/已接单或历史已被更换。写入时仍重新校验。',
      },
    }),
  },
  total: count('匹配总记录数。'),
  current: integer('当前页码，从1开始。'),
  size: integer('每页数量，最大100。'),
  pages: count('总页数，向上取整；无记录为0。'),
});
export const recruitmentDetailExample = {
  projectId: 3001,
  projectName: '数据生产',
  projectQuantity: 100,
  quantityUnit: '条',
  currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
  primaryManager: {
    userId: '00000000-0000-4000-8000-000000000001',
    uid: 'manager',
    name: '小明',
    avatarUrl: null,
  },
  handler: null,
  currentOperatorRole: 'PRIMARY_MANAGER',
  canChangeHandler: true,
  summary: {
    activeAssignmentCount: 0,
    pendingAcceptanceCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    assignedProductionRequirement: 0,
    remainingProductionRequirement: 100,
  },
};
export const recruitmentPageExample = {
  records: [
    {
      subjectId: '00000000-0000-4000-8000-000000000003',
      subjectType: 'INDIVIDUAL',
      realName: null,
      nickname: '小王',
      organizationName: null,
      avatarUrl: null,
      supervisorName: null,
      supervisorNickname: null,
      description: null,
      assignment: null,
      availableAction: 'RECRUIT',
    },
  ],
  total: 1,
  current: 1,
  size: 20,
  pages: 1,
};
export function recruitmentSchema(kind: 'detail' | 'candidates' | 'submit'): FastifySchema {
  const response =
    kind === 'submit'
      ? { type: 'null', description: '成功无业务数据，固定null。' }
      : kind === 'detail'
        ? recruitmentDetail
        : recruitmentPage;
  const example =
    kind === 'submit'
      ? null
      : kind === 'detail'
        ? recruitmentDetailExample
        : recruitmentPageExample;
  return {
    tags: ['Project'],
    operationId: `expertRecruitment_${kind}`,
    summary: {
      detail: '查询招募执行专家页面信息',
      candidates: '分页查询执行专家候选卡片',
      submit: '批量新增下发执行专家',
    }[kind],
    description:
      '当前PM会话且为本项目当前ASSIGNED主策略官或招募环节负责人；不按当前节点限制。候选排除项目创建人、主策略官、招募负责人及其有效主管组织。统一ACTIVE账号可个人接单；组织须有效且有正常主管；待激活导入成员不能作为个人主体。' +
      (kind === 'submit'
        ? '项目锁串行，分配、节点、管理轮次与PENDING outbox同事务。首次单向推进至人员管理，后续不回退，不递增项目版本。实际投递归14、接单归07，跨领域卡片重算归04；不连接真实业务Agent。'
        : '只读RepeatableRead一致快照，不修改节点或数据。'),
    security: [{ webSession: [] }, { desktopSession: [] }],
    ...(kind === 'submit'
      ? { body: recruitmentBody }
      : {
          querystring: {
            ...productionPlanQuery,
            description: '必填项目ID；候选接口支持主体类型、关键词及分页。',
            properties: {
              projectId: productionPlanQuery.properties.projectId,
              ...(kind === 'candidates'
                ? {
                    subjectType: {
                      ...subjectType,
                      description: subjectType.description + '可省略，同时查询两类。',
                    },
                    keyword: {
                      ...text(
                        '可省略，trim后按姓名、昵称、组织名称或UID字面子串匹配；空白不筛选。',
                      ),
                      maxLength: 100,
                    },
                    current: {
                      type: 'string',
                      pattern: '^[1-9][0-9]{0,9}$',
                      description:
                        'URL十进制页码文本，从1开始；省略默认1，最大2147483647，服务端显式转换。',
                    },
                    size: {
                      type: 'string',
                      pattern: '^([1-9]|[1-9][0-9]|100)$',
                      description: 'URL十进制每页数量文本，1—100；省略默认20，服务端显式转换。',
                    },
                  }
                : {}),
            },
            examples: [
              { projectId: '3001', ...(kind === 'candidates' ? { current: '1', size: '20' } : {}) },
            ],
          },
        }),
    response: {
      200: {
        ...resultSchema(response),
        examples: [{ code: 200, message: '操作成功', data: example }],
      },
      ...Object.fromEntries(
        Object.entries({
          400: '参数或主体/拒单来源无效',
          401: '会话失效',
          403: '角色或项目任职不符',
          404: '项目不存在',
          409: '已有有效分配',
          500: '事务内部失败',
          503: '数据库不可用',
        }).map(([code, message]) => [
          code,
          {
            ...resultSchema({ type: 'null', description: '失败无业务数据，固定null。' }),
            description: message,
            examples: [{ code: Number(code), message, data: null }],
          },
        ]),
      ),
    },
  };
}
