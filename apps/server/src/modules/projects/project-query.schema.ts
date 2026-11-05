import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import {
  projectAttachmentResponse,
  projectDraftDetail,
  projectDraftExample,
} from './project-creation.schema.js';
import {
  productionPlanBody,
  productionPlanQuery,
  productionPlanResponse,
} from './project-production-plan.schema.js';
const base = projectDraftDetail.properties;
export const projectDetailParams = {
  type: 'object',
  additionalProperties: false,
  description: '项目详情路径参数，无请求体；不接受角色或创建人作为授权依据。',
  required: ['projectId'],
  properties: { projectId: productionPlanQuery.properties.projectId },
  examples: [{ projectId: '3001' }],
};
const plan = productionPlanResponse.properties;
export const projectProductionRequirements = {
  type: 'object',
  additionalProperties: false,
  description: '仅执行专家范围返回的只读量级要求；不含确认人、考试配置、扩展JSON或后台字段。',
  required: [
    'hasPlan',
    'planId',
    'operatorHeadcount',
    'operatorCpd',
    'inspectorHeadcount',
    'inspectorCpd',
    'totalExpectedOutput',
    'crowds',
    'stages',
  ],
  properties: {
    hasPlan: plan.hasPlan,
    planId: plan.id,
    operatorHeadcount: { ...productionPlanBody.properties.operatorHeadcount, nullable: true },
    operatorCpd: { ...productionPlanBody.properties.operatorCpd, nullable: true },
    inspectorHeadcount: { ...productionPlanBody.properties.inspectorHeadcount, nullable: true },
    inspectorCpd: { ...productionPlanBody.properties.inspectorCpd, nullable: true },
    totalExpectedOutput: plan.totalExpectedOutput,
    crowds: {
      type: 'null',
      description: '旧项目详情查询未加载人群画像，实际DTO固定null；不能用接单详情的画像数组替代。',
    },
    stages: { ...plan.stages, description: '已确认生产阶段，按sequenceNo升序；无计划为空数组。' },
  },
  examples: [
    {
      hasPlan: false,
      planId: null,
      operatorHeadcount: null,
      operatorCpd: null,
      inspectorHeadcount: null,
      inspectorCpd: null,
      totalExpectedOutput: null,
      crowds: null,
      stages: [],
    },
  ],
};
export const projectPublishedExample = {
  ...projectDraftExample,
  projectName: '示例项目',
  categoryLevel1Id: 11,
  categoryLevel2Id: 21,
  categoryLevel3Ids: [31],
  categoryLevel1Name: '标注',
  categoryLevel2Name: '图片',
  categoryLevel3Names: ['商品'],
  difficultyLevel: 'EASY',
  projectQuantity: 10000,
  quantityUnit: '条',
  deadline: '2099-12-31 23:59:59',
  requiredHeadcount: 20,
  employmentType: 'PART_TIME',
  mandatoryRequirement: '相关经验',
  standardContent: '按规范标注',
  requesterName: '小明(王小明)',
  creatorName: '小明(王小明)',
  status: 'PUBLISHED',
  currentNodeCode: 'PRODUCTION_PLAN',
  attachments: projectAttachmentResponse.examples,
};
export const projectPublishedDetail = {
  type: 'object',
  additionalProperties: false,
  description:
    '未删除PUBLISHED项目创建信息、分类快照和有效附件；只读，不推进节点或对账轮次。管理范围省略productionRequirements，仅实际在项执行专家返回该字段。',
  required: Object.keys(base),
  properties: {
    ...base,
    status: {
      type: 'string',
      enum: ['PUBLISHED'],
      description: '详情固定PUBLISHED=已发布；草稿及已删除项目404。',
    },
    requesterId: {
      ...base.requesterId,
      description: '需求方用户ID，新库UUID；组织项目此处仍为组织账号用户ID，不是组织ID。',
    },
    creatorName: {
      type: 'string',
      description:
        '创建人实时昵称(姓名)，缺一取另一项；全空/用户缺失依次回退需求方名称、创建人UID。',
    },
    createdAt: { ...base.createdAt, description: '项目首次创建时间，上海yyyy-MM-dd HH:mm:ss。' },
    updatedAt: { ...base.updatedAt, description: '项目最近更新时间，上海yyyy-MM-dd HH:mm:ss。' },
    attachments: {
      ...base.attachments,
      description: 'ACTIVE项目附件，按sortNo、id升序；只返回台账元数据，读取仍须文件接口独立鉴权。',
    },
    productionRequirements: projectProductionRequirements,
  },
  examples: [
    projectPublishedExample,
    {
      ...projectPublishedExample,
      productionRequirements: projectProductionRequirements.examples[0],
    },
  ],
};
export const projectQuerySchema: FastifySchema = {
  operationId: 'getPublishedProjectDetail',
  summary: '查询项目详情',
  tags: ['Project'],
  security: [{ webSession: [] }, { desktopSession: [] }],
  params: projectDetailParams,
  description:
    '只读已发布项目；有效会话及服务端实际关系：当前NAVIGATOR角色且为创建人、当前PM角色且为当前ASSIGNED主策略官/招募协作负责人，或ACTIVE MEMBER执行专家。管理范围优先（NAVIGATOR创建人→PM当前任职→EXPERT成员），不添加角色选择参数，不从User.role/组织身份/固定EXPERT扩大权限；只有专家范围返回productionRequirements。此优先级是固定登录身份与独立授权下的适配，兼容验收尚待完成。关联查询使用同一只读快照。未迁移接单/考试/入项写流程，不开放成员写HTTP，不按注册身份创建成员。项目列表支线聚合仍待后续，不在本入口伪造卡片。沿用Cookie/Bearer来源规则。',
  response: {
    200: {
      ...resultSchema(projectPublishedDetail),
      examples: projectPublishedDetail.examples.map((data) => ({
        code: 200,
        message: '操作成功',
        data,
      })),
    },
    ...Object.fromEntries(
      Object.entries({
        400: '项目ID必须为32位正整数。',
        401: '未登录或会话失效。',
        403: '没有合法项目关系、管理授权已撤销或传输不可信。',
        404: '已发布项目不存在、草稿或已逻辑删除。',
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
