import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { branchLabels } from './project-list.service.js';
import { managerRecruitResult } from './project-manager.schema.js';
import { projectPublishedDetail, projectPublishedExample } from './project-query.schema.js';
const text = (description: string, nullable = false) => ({
  type: 'string',
  description,
  ...(nullable ? { nullable: true } : {}),
});
const count = (description: string) => ({ type: 'integer', minimum: 0, description });
const userId = {
  type: 'string',
  format: 'uuid',
  nullable: true,
  description: '新库用户UUID；无对应人时null。',
};
const base = projectPublishedDetail.properties;
const properties = {
  id: base.id,
  projectNo: base.projectNo,
  projectName: text('项目名称，历史空值为null。', true),
  projectDescription: text('项目描述，未设置为null。', true),
  categoryLevel1Name: base.categoryLevel1Name,
  categoryLevel2Name: base.categoryLevel2Name,
  categoryLevel3Names: base.categoryLevel3Names,
  categoryDisplayName: text('分类标签：三级名称用、连接，依次回退二级、一级，均空时未分类项目。'),
  status: base.status,
  statusDescription: text('生命周期中文说明，当前列表只返回已发布。'),
  currentNodeCode: {
    ...managerRecruitResult.properties.currentNodeCode,
    description:
      '公共主线节点；历史null仅读取时回退有任职=PRODUCTION_PLAN，无任职=RECRUIT_PROJECT_MANAGER；不写回数据库，不被支线替代。' +
      managerRecruitResult.properties.currentNodeCode.description,
  },
  branchNodeCode: {
    type: 'string',
    nullable: true,
    enum: [...Object.keys(branchLabels), null],
    description:
      '本用户当前视角支线快照，未记录为null；不授予项目权限。' +
      Object.entries(branchLabels)
        .map(([code, label]) => `${code}=${label}`)
        .join('，') +
      '。快照真值重算/修复随05—13业务逐步接入。',
  },
  workbenchStatus: {
    type: 'string',
    enum: ['PENDING', 'PROCESSING'],
    description: 'PENDING=招募策略官待处理，PROCESSING=后续处理中；不返回草稿待完善卡片。',
  },
  workbenchStatusDescription: text('工作台状态中文说明：待处理或处理中。'),
  currentAction: {
    type: 'string',
    enum: ['RECRUIT_PROJECT_MANAGER', 'VIEW_DETAIL'],
    description: 'RECRUIT_PROJECT_MANAGER=招募策略官，VIEW_DETAIL=查看项目详情；协作负责人仅查看。',
  },
  currentActionDescription: text('建议操作中文文案，招募策略官或查看项目详情。'),
  primaryProjectManager: {
    type: 'boolean',
    description: '仅PM列表返回：本人是否当前主策略官。NAVIGATOR列表省略。',
  },
  expertRecruitmentHandler: {
    type: 'boolean',
    description:
      '仅PM列表返回：本人是否当前招募协作负责人；本人同时为主策略官时按主视角。NAVIGATOR列表省略。',
  },
  needAssistGrading: {
    type: 'boolean',
    description:
      'NAVIGATOR按本人是否在未删除ACTIVE考试当前版本MANUAL轮次reviewersJson中计算；不要求尚有未阅卷记录。PM沿旧查询未赋值，固定false。考试配置/版本写流程待05，不等于已实现考试。',
  },
  requesterName: base.requesterName,
  creatorId: userId,
  creatorName: text('创建人实时昵称(姓名)，缺失回退需求方名称快照。'),
  projectManagerId: userId,
  projectManagerName: text(
    '当前ASSIGNED策略官实时昵称(姓名)，缺一取另一、全空回退UID；无任职null。',
    true,
  ),
  projectManagerStatusDescription: text(
    '按当前策略官用户ID判断：已指定或招募中；停用账号仍按旧SQL展示。',
  ),
  projectOwners: {
    type: 'array',
    description:
      '已接单组织的ACTIVE负责人关系；该assignment完全无关系行时回退旧单负责人，REMOVED关系行也阻止回退。不把组织主管当作负责人。按项目/用户ID排序，沿旧SQL UNION ALL不跨assignment去重（与旧DTO按用户去重文案不符，兼容待验收）。无匹配为空数组，实际读取新来源表；写流程/容量与权限仍待07。',
    items: {
      type: 'object',
      additionalProperties: false,
      description: '执行专家组织接单负责人公开资料，不返回assignmentId/projectId。',
      required: ['userId', 'name', 'avatarUrl'],
      properties: {
        userId: { ...userId, nullable: false, description: '负责人用户ID，新库UUID。' },
        name: text('负责人实时昵称(姓名)，缺失回退UID。'),
        avatarUrl: text('头像地址，未设置null。', true),
      },
    },
  },
  activeExpertCount: count(
    '项目全部ACTIVE成员记录数，沿旧SQL COUNT(*)不区分projectRole，不按用户去重；不等于PM任职数。',
  ),
  requiredHeadcount: { ...count('需求人数，未设置为null。'), nullable: true },
  deadline: text('项目截止时间，上海yyyy-MM-dd HH:mm:ss，未设置为null。', true),
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
};
export const projectCardExample = {
  id: 3001,
  projectNo: projectPublishedExample.projectNo,
  projectName: '示例项目',
  projectDescription: null,
  categoryLevel1Name: '标注',
  categoryLevel2Name: '图片',
  categoryLevel3Names: ['商品'],
  categoryDisplayName: '商品',
  status: 'PUBLISHED',
  statusDescription: '已发布',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  branchNodeCode: null,
  workbenchStatus: 'PENDING',
  workbenchStatusDescription: '待处理',
  currentAction: 'RECRUIT_PROJECT_MANAGER',
  currentActionDescription: '招募策略官',
  needAssistGrading: false,
  requesterName: '小明(王小明)',
  creatorId: projectPublishedExample.requesterId,
  creatorName: '小明(王小明)',
  projectManagerId: null,
  projectManagerName: null,
  projectManagerStatusDescription: '招募中',
  projectOwners: [],
  activeExpertCount: 0,
  requiredHeadcount: 20,
  deadline: '2099-12-31 23:59:59',
  createdAt: '2026-10-21 10:00:00',
  updatedAt: '2026-10-21 10:00:00',
};
export const projectCardsResponse = {
  type: 'array',
  description:
    '本人该角色待办项目卡片，按updatedAt降序、id降序，无分页；无实际匹配时空数组，列表不是全部可见项目清单。',
  items: {
    type: 'object',
    additionalProperties: false,
    description: '一张待办项目卡片。',
    required: Object.keys(properties).filter(
      (k) => !['primaryProjectManager', 'expertRecruitmentHandler'].includes(k),
    ),
    properties,
  },
  examples: [
    [projectCardExample],
    [
      {
        ...projectCardExample,
        currentNodeCode: 'PRODUCTION_PLAN',
        workbenchStatus: 'PROCESSING',
        workbenchStatusDescription: '处理中',
        currentAction: 'VIEW_DETAIL',
        currentActionDescription: '查看项目详情',
        projectManagerId: '00000000-0000-4000-8000-000000000002',
        projectManagerName: '策略官(李明)',
        projectOwners: [
          { userId: '00000000-0000-4000-8000-000000000003', name: '负责人(张三)', avatarUrl: null },
        ],
        projectManagerStatusDescription: '已指定',
        primaryProjectManager: true,
        expertRecruitmentHandler: false,
      },
    ],
    [],
  ],
};
export function projectListSchema(manager: boolean): FastifySchema {
  const message =
    '仅本人对应角色的PUBLISHED且未删除项目，结项COMPLETED即使有陈旧支线也隐藏；只读快照，不刷新支线、不推进节点或轮次。' +
    (manager
      ? '当前PM角色+当前ASSIGNED主策略官或招募协作负责人；主策略官四个主节点或本人支线才推送，协作负责人只接招募主节点或EXPERT_RECRUITMENT_RETRY。'
      : '当前NAVIGATOR角色+本人创建，招募策略官主节点或本人NAVIGATOR支线才推送。') +
    '无请求参数、无请求体。注册自带三角色，登录默认EXPERT，User.role及客户端角色不授权。支线读取按人/项目/视角唯一快照；重算、修复、事件和考试/接单写流程待后续05/07/10—14；接口保留部分迁移。仅实际来源表查询，失败向外传播，不把来源失败当无待办。沿用Cookie/Bearer来源规则。';
  return {
    operationId: manager ? 'listManagedProjects' : 'listOwnedProjects',
    summary: manager ? '查询策略官项目列表' : '查询项目列表',
    tags: ['Project'],
    security: [{ webSession: [] }, { desktopSession: [] }],
    description: message,
    response: {
      200: {
        ...resultSchema(projectCardsResponse),
        examples: projectCardsResponse.examples.map((data) => ({
          code: 200,
          message: '操作成功',
          data,
        })),
      },
      ...Object.fromEntries(
        Object.entries({
          401: '未登录或会话失效。',
          403: '缺所需当前会话角色或来源不可信。',
          500: '内部处理失败，来源查询失败不返回伪造空列表。',
          503: '服务不可用。',
        }).map(([status, message]) => [
          status,
          {
            ...resultSchema({ type: 'null', description: '失败固定null。' }),
            description: message,
            examples: [{ code: Number(status), message, data: null }],
          },
        ]),
      ),
    },
  };
}
