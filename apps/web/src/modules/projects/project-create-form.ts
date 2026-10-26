import type { ProjectDraft, ProjectSaveInput } from '@tyde/shared';

/** 保留输入中的空值，数字仅在提交边界转换。 */
export interface ProjectCreateValues {
  projectName: string;
  projectDescription: string;
  categoryLevel1Id: string;
  categoryLevel2Id: string;
  categoryLevel3Ids: number[];
  difficultyLevel: string;
  projectQuantity: string;
  quantityUnit: string;
  deadline: string;
  requiredHeadcount: string;
  educationRequirement: string;
  employmentType: string;
  experienceRequirement: string;
  workSummary: string;
  specialRequirement: string;
  mandatoryRequirement: string;
  standardContent: string;
  standardLink: string;
}

export const projectCreateSteps = ['基础信息', '人员画像', '标准配置'] as const;
export const projectStepFields: (keyof ProjectCreateValues)[][] = [
  [
    'projectName',
    'categoryLevel1Id',
    'categoryLevel2Id',
    'categoryLevel3Ids',
    'difficultyLevel',
    'projectQuantity',
    'quantityUnit',
    'deadline',
  ],
  ['requiredHeadcount', 'educationRequirement', 'employmentType', 'mandatoryRequirement'],
  ['standardContent', 'standardLink'],
];

/** 草稿是唯一持久化来源，保留上海日期与时间，不进行浏览器时区转换。 */
export function projectCreateValues(draft: ProjectDraft | null): ProjectCreateValues {
  return {
    projectName: draft?.projectName ?? '',
    projectDescription: draft?.projectDescription ?? '',
    categoryLevel1Id: draft?.categoryLevel1Id?.toString() ?? '',
    categoryLevel2Id: draft?.categoryLevel2Id?.toString() ?? '',
    categoryLevel3Ids: draft?.categoryLevel3Ids ?? [],
    difficultyLevel: draft?.difficultyLevel ?? (draft ? '' : 'MEDIUM'),
    projectQuantity: draft?.projectQuantity?.toString() ?? '',
    quantityUnit: draft?.quantityUnit ?? '',
    deadline: draft?.deadline?.replace(' ', 'T') ?? '',
    requiredHeadcount: draft?.requiredHeadcount?.toString() ?? '',
    educationRequirement: draft?.educationRequirement ?? 'BACHELOR',
    employmentType: draft?.employmentType ?? (draft ? '' : 'UNLIMITED'),
    experienceRequirement: draft?.experienceRequirement ?? '',
    workSummary: draft?.workSummary ?? '',
    specialRequirement: draft?.specialRequirement ?? '',
    mandatoryRequirement: draft?.mandatoryRequirement ?? '',
    standardContent: draft?.standardContent ?? '',
    standardLink: draft?.standardLink ?? '',
  };
}

/** 在保存草稿时校验已填值，在发布时额外校验业务必填字段。 */
export function validateProjectCreate(
  values: ProjectCreateValues,
  publish: boolean,
  createdAt?: string,
) {
  const errors: Partial<Record<keyof ProjectCreateValues, string>> = {};
  const required: (keyof ProjectCreateValues)[] = [...projectStepFields.flat()].filter(
    (name) => name !== 'standardLink',
  );
  if (publish)
    for (const name of required) {
      const value = values[name];
      if (Array.isArray(value) ? !value.length : !value.trim()) errors[name] = '请填写此项';
    }
  if (values.projectName.trim().length > 128) errors.projectName = '项目名称最多 128 字';
  if (values.quantityUnit.trim().length > 30) errors.quantityUnit = '量级单位最多 30 字';
  if (values.standardLink.trim().length > 2000) errors.standardLink = '文档链接最多 2000 字符';
  if (values.categoryLevel3Ids.length > 20) errors.categoryLevel3Ids = '最多选择 20 个三级类型';
  if (
    values.projectQuantity &&
    (!Number.isFinite(Number(values.projectQuantity)) || Number(values.projectQuantity) <= 0)
  )
    errors.projectQuantity = '项目量级须大于 0';
  if (
    values.requiredHeadcount &&
    (!Number.isInteger(Number(values.requiredHeadcount)) ||
      Number(values.requiredHeadcount) < 1 ||
      Number(values.requiredHeadcount) > 2147483647)
  )
    errors.requiredHeadcount = '需求人数须为大于 0 的整数';
  if (values.deadline) {
    const deadline = projectDeadline(values.deadline);
    const parsed = new Date(`${deadline.replace(' ', 'T')}Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(deadline) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 19).replace('T', ' ') === deadline;
    if (!valid) errors.deadline = '请填写有效的截止日期与时间';
    else {
      const initialTime =
        createdAt ??
        new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(new Date());
      if (deadline <= initialTime) errors.deadline = '截止时间须晚于草稿创建时间';
    }
  }
  return errors;
}

/** 将原生日期时间输入转换为后端要求的上海墙钟格式并保留秒。 */
function projectDeadline(value: string) {
  const result = value.replace('T', ' ');
  return result.length === 16 ? `${result}:00` : result;
}

/** 提交完整快照，空文本显式清空，不误保留上次草稿内容。 */
export function projectCreateInput(
  values: ProjectCreateValues,
): Omit<ProjectSaveInput, 'operation'> {
  const text = (value: string) => value.trim() || null;
  return {
    projectName: text(values.projectName),
    projectDescription: text(values.projectDescription),
    categoryLevel1Id: values.categoryLevel1Id ? Number(values.categoryLevel1Id) : null,
    categoryLevel2Id: values.categoryLevel2Id ? Number(values.categoryLevel2Id) : null,
    categoryLevel3Ids: values.categoryLevel3Ids,
    difficultyLevel:
      values.difficultyLevel === 'EASY' ||
      values.difficultyLevel === 'MEDIUM' ||
      values.difficultyLevel === 'HARD'
        ? values.difficultyLevel
        : null,
    projectQuantity: values.projectQuantity ? Number(values.projectQuantity) : null,
    quantityUnit: text(values.quantityUnit),
    deadline: values.deadline ? projectDeadline(values.deadline) : null,
    requiredHeadcount: values.requiredHeadcount ? Number(values.requiredHeadcount) : null,
    educationRequirement:
      values.educationRequirement === 'PHD' ||
      values.educationRequirement === 'MASTER' ||
      values.educationRequirement === 'BACHELOR' ||
      values.educationRequirement === 'COLLEGE' ||
      values.educationRequirement === 'BELOW_COLLEGE'
        ? values.educationRequirement
        : null,
    employmentType:
      values.employmentType === 'FULL_TIME' ||
      values.employmentType === 'PART_TIME' ||
      values.employmentType === 'UNLIMITED'
        ? values.employmentType
        : null,
    experienceRequirement: text(values.experienceRequirement),
    workSummary: text(values.workSummary),
    specialRequirement: text(values.specialRequirement),
    mandatoryRequirement: text(values.mandatoryRequirement),
    standardContent: text(values.standardContent),
    standardLink: text(values.standardLink),
  };
}
