import type { FieldPath } from 'react-hook-form';
import type { ProjectProductionPlan, ProjectProductionPlanInput } from '@tyde/shared';

/** 数字先保留原始输入，避免空值变成零或在提交前静默丢失小数。 */
export interface ProductionPlanValues {
  operatorHeadcount: string;
  operatorCpd: string;
  inspectorHeadcount: string;
  inspectorCpd: string;
  needWrittenExam: boolean;
  maxActiveExamCount: string;
  needInterview: boolean;
  crowds: { crowdName: string; profileRequirement: string }[];
  stages: {
    stageName: string;
    startDate: string;
    endDate: string;
    workdayCountSource: 'AUTO' | 'MANUAL';
    workdayCount: string;
    operatorHeadcount: string;
    operatorCpd: string;
    accuracyRate: string;
  }[];
}
export type ProductionPlanErrors = Partial<Record<FieldPath<ProductionPlanValues>, string>>;

/** 确认时重新取上海业务日，浏览器时区和午夜前打开页面不改变日期门禁。 */
export function productionPlanToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}

/** 空阶段不自动继承人数；CPD 留空由后端继承计划值。 */
export function emptyProductionStage(stageName = ''): ProductionPlanValues['stages'][number] {
  return {
    stageName,
    startDate: '',
    endDate: '',
    workdayCountSource: 'AUTO',
    workdayCount: '',
    operatorHeadcount: '',
    operatorCpd: '',
    accuracyRate: '',
  };
}

/** 读取结果初始化当前内存表单，已确认数值保持服务端结果。 */
export function productionPlanValues(plan: ProjectProductionPlan): ProductionPlanValues {
  const value = (number: number | null) => (number == null ? '' : String(number));
  return {
    operatorHeadcount: value(
      plan.operatorHeadcount ?? (!plan.hasPlan ? plan.projectReference.requiredHeadcount : null),
    ),
    operatorCpd: value(plan.operatorCpd),
    inspectorHeadcount: value(plan.inspectorHeadcount),
    inspectorCpd: value(plan.inspectorCpd),
    needWrittenExam: plan.needWrittenExam,
    maxActiveExamCount: String(plan.maxActiveExamCount),
    needInterview: plan.needInterview,
    crowds: plan.crowds.map((crowd) => ({
      crowdName: crowd.crowdName ?? '',
      profileRequirement: crowd.profileRequirement ?? '',
    })),
    stages: plan.stages.map((stage) => ({
      stageName: stage.stageName ?? '',
      startDate: stage.startDate ?? '',
      endDate: stage.endDate ?? '',
      workdayCountSource: stage.workdayCountSource ?? 'AUTO',
      workdayCount: value(stage.workdayCount),
      operatorHeadcount: value(stage.operatorHeadcount),
      operatorCpd: value(stage.operatorCpd),
      accuracyRate: value(stage.accuracyRate),
    })),
  };
}

/** 校验日历日期并转为日序，仅用于自然日运算，不变更日期的业务时区。 */
function dayNumber(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date.getTime() / 86400000
    : null;
}

/** AUTO 严格按周一至周五计算，整周批算，不调用节假日服务。 */
export function productionWorkdays(startDate: string, endDate: string) {
  const start = dayNumber(startDate),
    end = dayNumber(endDate);
  if (start === null || end === null || end < start) return null;
  const naturalDays = end - start + 1;
  let workdays = Math.floor(naturalDays / 7) * 5;
  const weekday = new Date(start * 86400000).getUTCDay();
  for (let offset = 0; offset < naturalDays % 7; offset++)
    if ((weekday + offset) % 7 !== 0 && (weekday + offset) % 7 !== 6) workdays++;
  return { naturalDays, workdays };
}

/** 十进制按四位尺度比较；支持数字输入的科学记数法且不经浮点数舍入。 */
function scaledDecimal(text: string): bigint | null {
  const match = /^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  let digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+/, '') || '0';
  let scale = (match[2]?.length ?? 0) - exponent;
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1) || '0';
    scale--;
  }
  if (scale > 4 || digits.length > 120) return null;
  return BigInt(digits) * 10n ** BigInt(4 - scale);
}

/** 确认前按当前后端边界生成载荷，错误可直接关联到表单控件。 */
export function productionPlanInput(
  values: ProductionPlanValues,
  today = productionPlanToday(),
): { input: ProjectProductionPlanInput | null; errors: ProductionPlanErrors } {
  const errors: ProductionPlanErrors = {};
  const integer = (text: string, path: FieldPath<ProductionPlanValues>) => {
    const number = Number(text);
    if (!text.trim() || !Number.isInteger(number) || number < 1 || number > 2147483647)
      errors[path] = '请填写 1–2147483647 的整数';
    return number;
  };
  const decimal = (text: string, path: FieldPath<ProductionPlanValues>, accuracy = false) => {
    const scaled = scaledDecimal(text);
    const number = Number(text);
    if (scaled === null || scaled <= 0 || (accuracy ? scaled > 1000000n : scaled >= 10n ** 20n))
      errors[path] = accuracy
        ? '准确率须大于 0 且不超过 100，最多 4 位小数'
        : 'CPD 须大于 0、小于 10¹⁶，最多 4 位小数';
    else if (!Number.isFinite(number) || scaledDecimal(String(number)) !== scaled)
      errors[path] = '数值过大，无法精确提交，请减小数值或小数位数';
    return { number, scaled };
  };
  const operatorHeadcount = integer(values.operatorHeadcount, 'operatorHeadcount');
  const operatorCpd = decimal(values.operatorCpd, 'operatorCpd');
  const inspectorHeadcount = values.inspectorHeadcount.trim()
    ? integer(values.inspectorHeadcount, 'inspectorHeadcount')
    : null;
  const inspectorCpd = values.inspectorCpd.trim()
    ? decimal(values.inspectorCpd, 'inspectorCpd').number
    : null;
  if ((inspectorHeadcount === null) !== (inspectorCpd === null)) {
    errors.inspectorHeadcount = '质检人数与质检 CPD 须同时填写或同时留空';
    errors.inspectorCpd = errors.inspectorHeadcount;
  }
  const maxActiveExamCount = integer(values.maxActiveExamCount, 'maxActiveExamCount');
  if (values.crowds.length < 1 || values.crowds.length > 50) errors.crowds = '人群须为 1–50 项';
  const crowds = values.crowds.map((crowd, index) => {
    if (!crowd.crowdName.trim() || crowd.crowdName.length > 100)
      errors[`crowds.${index}.crowdName`] = '人群名称必填，最多 100 字';
    if (!crowd.profileRequirement.trim())
      errors[`crowds.${index}.profileRequirement`] = '请填写此人群的画像要求';
    return {
      crowdName: crowd.crowdName.trim(),
      profileRequirement: crowd.profileRequirement.trim(),
    };
  });
  if (values.stages.length < 1 || values.stages.length > 50) errors.stages = '生产阶段须为 1–50 项';
  let total = 0n;
  const stages = values.stages.map((stage, index) => {
    if (!stage.stageName.trim() || stage.stageName.length > 100)
      errors[`stages.${index}.stageName`] = '阶段名称必填，最多 100 字';
    const dates = productionWorkdays(stage.startDate, stage.endDate);
    if (dayNumber(stage.startDate) === null)
      errors[`stages.${index}.startDate`] = '请填写有效开始日期';
    else if (stage.startDate < today)
      errors[`stages.${index}.startDate`] = '开始日期不得早于确认当日（上海时间）';
    if (dayNumber(stage.endDate) === null || stage.endDate < stage.startDate)
      errors[`stages.${index}.endDate`] = '结束日期须有效且不早于开始日期';
    const workdayCount =
      stage.workdayCountSource === 'MANUAL'
        ? integer(stage.workdayCount, `stages.${index}.workdayCount`)
        : (dates?.workdays ?? 0);
    if (stage.workdayCountSource !== 'MANUAL' && stage.workdayCountSource !== 'AUTO')
      errors[`stages.${index}.workdayCountSource`] = '请选择天数来源';
    if (stage.workdayCountSource === 'AUTO' && workdayCount < 1)
      errors[`stages.${index}.workdayCount`] = '自动工作日为 0，请调整日期或手动填写有效天数';
    const headcount = integer(stage.operatorHeadcount, `stages.${index}.operatorHeadcount`);
    const cpd = stage.operatorCpd.trim()
      ? decimal(stage.operatorCpd, `stages.${index}.operatorCpd`)
      : operatorCpd;
    const accuracyRate = stage.accuracyRate.trim()
      ? decimal(stage.accuracyRate, `stages.${index}.accuracyRate`, true).number
      : null;
    if (
      cpd.scaled !== null &&
      Number.isInteger(headcount) &&
      headcount > 0 &&
      Number.isInteger(workdayCount) &&
      workdayCount > 0
    ) {
      const output = cpd.scaled * BigInt(headcount) * BigInt(workdayCount);
      total += output;
      if (output >= 10n ** 30n)
        errors[`stages.${index}.operatorCpd`] = '阶段产出超出可确认范围，请调整人数、CPD 或天数';
    }
    return {
      stageName: stage.stageName.trim(),
      startDate: stage.startDate,
      endDate: stage.endDate,
      workdayCountSource: stage.workdayCountSource,
      ...(stage.workdayCountSource === 'MANUAL' ? { workdayCount } : {}),
      operatorHeadcount: headcount,
      operatorCpd: stage.operatorCpd.trim() ? cpd.number : null,
      accuracyRate,
    };
  });
  if (total >= 10n ** 30n) errors.stages = '全部阶段合计产出超出可确认范围，请调整计划';
  return {
    input: Object.keys(errors).length
      ? null
      : {
          operatorHeadcount,
          operatorCpd: operatorCpd.number,
          inspectorHeadcount,
          inspectorCpd,
          needWrittenExam: values.needWrittenExam,
          maxActiveExamCount,
          needInterview: values.needInterview,
          crowds,
          stages,
        },
    errors,
  };
}

/** 未确认的数值只作页面估算，不能覆盖服务端已确认的精确计算结果。 */
export function productionStageEstimate(
  stage: ProductionPlanValues['stages'][number],
  operatorCpd: string,
) {
  const dates = productionWorkdays(stage.startDate, stage.endDate);
  const days = stage.workdayCountSource === 'AUTO' ? dates?.workdays : Number(stage.workdayCount);
  const headcount = Number(stage.operatorHeadcount),
    cpd = Number(stage.operatorCpd.trim() || operatorCpd);
  const output = days && headcount > 0 && cpd > 0 ? days * headcount * cpd : null;
  return {
    naturalDays: dates?.naturalDays ?? null,
    workdays: days ?? null,
    expectedOutput: output !== null && Number.isFinite(output) ? output : null,
  };
}

/** 只格式化响应中的数值，不从前端估算替换已确认产出。 */
export function productionPlanNumber(value: number | null) {
  return value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
