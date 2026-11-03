import type {
  StrategistProjectCard,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

/** 模块回归保留明确的项目待办，提交后导航以此列表响应为准。 */
export function strategistProjectCard(project: WorkbenchProjectDetail): StrategistProjectCard {
  return {
    id: project.id,
    projectNo: project.projectNo,
    projectName: project.projectName,
    projectDescription: project.projectDescription,
    categoryLevel1Name: project.categoryLevel1Name,
    categoryLevel2Name: project.categoryLevel2Name,
    categoryLevel3Names: project.categoryLevel3Names,
    categoryDisplayName: '测试项目分类',
    status: 'PUBLISHED',
    statusDescription: '已发布',
    currentNodeCode: project.currentNodeCode ?? 'PRODUCTION_PLAN',
    branchNodeCode: null,
    workbenchStatus: 'PENDING',
    workbenchStatusDescription: '待处理',
    currentAction: 'VIEW_DETAIL',
    currentActionDescription: '查看项目详情',
    primaryProjectManager: true,
    expertRecruitmentHandler: false,
    needAssistGrading: false,
    requesterName: project.requesterName,
    creatorId: project.requesterId,
    creatorName: project.creatorName,
    projectManagerId: null,
    projectManagerName: null,
    projectManagerStatusDescription: '已指定',
    projectOwners: [],
    activeExpertCount: 0,
    requiredHeadcount: project.requiredHeadcount,
    deadline: project.deadline,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}
