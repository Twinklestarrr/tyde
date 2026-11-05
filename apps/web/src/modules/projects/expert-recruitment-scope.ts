/** 定义智能推荐候选范围的本地草稿与数值校验，不映射未约定的接口枚举。 */

/** 各多选条件的本地显示值；未选择任何项表示不限。 */
export const RECRUITMENT_SCOPE_OPTIONS = {
  projectStatuses: [
    '未招募',
    '待接单',
    '待准入',
    '准入未通过',
    '已拒绝',
    '准入中',
    '待入项',
    '已入项',
    '放弃入项',
    '待离项',
    '待转项',
    '已离项',
    '已取消',
  ],
  occupancyStatuses: ['空闲中', '已占用', '已排班'],
  admissionStatuses: ['未准入', '未通过', '已通过'],
  materials: ['学历证明', '其他证书', '作品集'],
} as const;

/** 当前项目组件持有的范围草稿，空数值用于保留输入过程中的未填写状态。 */
export interface RecruitmentScope {
  projectStatuses: readonly string[];
  occupancyStatuses: readonly string[];
  admissionStatuses: readonly string[];
  materials: readonly string[];
  matchMin: number | null;
  matchMax: number | null;
  recommendationCount: number | null;
}

/** 需要本地数值校验的字段。 */
export type RecruitmentScopeNumberField = 'matchMin' | 'matchMax' | 'recommendationCount';
/** 按字段回显的错误，不对未知召回总数设置虚构上限。 */
export type RecruitmentScopeErrors = Partial<Record<RecruitmentScopeNumberField, string>>;

/** 为每个新项目创建互不共享的默认候选范围。 */
export function createRecruitmentScope(): RecruitmentScope {
  return {
    projectStatuses: ['未招募'],
    occupancyStatuses: ['空闲中'],
    admissionStatuses: [],
    materials: ['学历证明'],
    matchMin: 0,
    matchMax: 100,
    recommendationCount: 20,
  };
}

/** 检查匹配分是否为百分制整数。 */
function isMatchScore(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** 校验暂存条件，不触发匹配、请求或持久化。 */
export function validateRecruitmentScope(scope: RecruitmentScope): RecruitmentScopeErrors {
  const errors: RecruitmentScopeErrors = {};
  if (!isMatchScore(scope.matchMin)) errors.matchMin = '匹配分下限须为 0–100 的整数';
  if (!isMatchScore(scope.matchMax)) errors.matchMax = '匹配分上限须为 0–100 的整数';
  if (
    isMatchScore(scope.matchMin) &&
    isMatchScore(scope.matchMax) &&
    scope.matchMin > scope.matchMax
  ) {
    errors.matchMax = '匹配分上限不能低于下限';
  }
  if (
    scope.recommendationCount === null ||
    !Number.isSafeInteger(scope.recommendationCount) ||
    scope.recommendationCount <= 0
  ) {
    errors.recommendationCount = '推荐人员数量须为大于 0 的整数';
  }
  return errors;
}

/** 将空的多选范围按“不限”展示，避免把空条件解释为没有候选。 */
export function formatRecruitmentScopeSelection(values: readonly string[]): string {
  return values.length ? values.join('、') : '不限';
}
