import {
  Controller,
  useFieldArray,
  useWatch,
  type FieldPath,
  type UseFormReturn,
} from 'react-hook-form';
import { Plus, X } from 'lucide-react';
import type { ProjectProductionPlan } from '@tyde/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  emptyProductionStage,
  productionPlanNumber,
  productionPlanToday,
  productionStageEstimate,
  type ProductionPlanValues,
} from './production-plan-form';

/** 当前后端生产计划的四个分区，共享现有控件和主题，不引入额外日历。 */
export function ProductionPlanFields({
  form,
  plan,
  readOnly,
}: {
  form: UseFormReturn<ProductionPlanValues>;
  plan: ProjectProductionPlan;
  readOnly: boolean;
}) {
  const crowds = useFieldArray({ control: form.control, name: 'crowds' });
  const stages = useFieldArray({ control: form.control, name: 'stages' });
  const values = useWatch({ control: form.control });
  const today = productionPlanToday();
  const reference = plan.projectReference;
  const education = {
    PHD: '博士',
    MASTER: '硕士',
    BACHELOR: '本科',
    COLLEGE: '大专',
    BELOW_COLLEGE: '大专以下',
  };
  const employment = { FULL_TIME: '全职', PART_TIME: '兼职', UNLIMITED: '不限' };

  /** 字段标签同时作为可访问名称，错误在用户修改时清除，避免失焦引起布局跳动。 */
  function field(
    name: FieldPath<ProductionPlanValues>,
    label: string,
    options: {
      type?: 'number' | 'date';
      required?: boolean;
      multiline?: boolean;
      maxLength?: number;
      min?: string;
      placeholder?: string;
      description?: string;
    } = {},
  ) {
    const id = `production-plan-${name.replaceAll('.', '-')}`;
    return (
      <FormField
        key={name}
        controlId={id}
        label={label}
        required={options.required}
        error={form.getFieldState(name, form.formState).error?.message}
        description={options.description}
      >
        {({ invalid, describedBy }) =>
          options.multiline ? (
            <Textarea
              id={id}
              rows={3}
              maxLength={options.maxLength}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              {...form.register(name, { onChange: () => form.clearErrors(name) })}
            />
          ) : (
            <Input
              id={id}
              size="profile"
              type={options.type ?? 'text'}
              step={options.type === 'number' ? 'any' : undefined}
              min={options.min ?? (options.type === 'number' ? '0' : undefined)}
              maxLength={options.maxLength}
              placeholder={options.placeholder}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              {...form.register(name, { onChange: () => form.clearErrors(name) })}
            />
          )
        }
      </FormField>
    );
  }

  /** 人群和阶段结构错误仍需在集合标题附近可见。 */
  function collectionError(name: 'crowds' | 'stages') {
    const message = form.getFieldState(name, form.formState).error?.message;
    return message ? (
      <p role="alert" className="text-[13px] text-destructive">
        {message}
      </p>
    ) : null;
  }

  return (
    <div className="space-y-[28px]">
      <section aria-label="预估数据" className="space-y-[18px]">
        <h3 id="production-estimates-title" className="text-[16px] font-semibold">
          预估数据
        </h3>
        <p className="text-[13px] text-muted-foreground">
          CPD 为每人每天的产能。项目需求人数：{productionPlanNumber(reference.requiredHeadcount)}{' '}
          人。
        </p>
        <div className="grid gap-[18px] sm:grid-cols-2 xl:grid-cols-4">
          {field('operatorHeadcount', '作业人数', { type: 'number', required: true })}
          {field('operatorCpd', '作业 CPD', { type: 'number', required: true })}
          {field('inspectorHeadcount', '质检人数（选填）', { type: 'number' })}
          {field('inspectorCpd', '质检 CPD（选填）', {
            type: 'number',
            description: '质检人数与 CPD 同时填写或同时留空。',
          })}
        </div>
      </section>
      <section aria-label="考核设置" className="space-y-[18px] border-t pt-[24px]">
        <h3 id="production-assessments-title" className="text-[16px] font-semibold">
          考核设置
        </h3>
        <div className="flex flex-wrap gap-x-[28px] gap-y-[16px]">
          <label className="flex min-h-11 cursor-pointer items-center gap-[10px] text-[14px]">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              {...form.register('needWrittenExam')}
            />
            需要笔试
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-[10px] text-[14px]">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              {...form.register('needInterview')}
            />
            需要面试
          </label>
        </div>
        <div className="max-w-[320px]">
          {field('maxActiveExamCount', '准入考试数量', {
            type: 'number',
            required: true,
            description: '允许同时进行的准入考试数量。',
          })}
        </div>
      </section>
      <section aria-label="人群画像" className="space-y-[18px] border-t pt-[24px]">
        <header className="flex flex-wrap items-center justify-between gap-[12px]">
          <h3 id="production-crowds-title" className="text-[16px] font-semibold">
            人群画像
          </h3>
          {!readOnly && (
            <Button
              variant="outline"
              size="mobileTouch"
              disabled={crowds.fields.length >= 50}
              onClick={() => {
                crowds.append({ crowdName: '', profileRequirement: '' });
                form.clearErrors('crowds');
              }}
            >
              <Plus className="size-4" aria-hidden />
              添加人群
            </Button>
          )}
        </header>
        <details className="rounded-[10px] border bg-muted p-[14px] text-[13px] leading-6">
          <summary className="cursor-pointer font-medium">查看项目创建时的人员要求</summary>
          <dl className="mt-[12px] grid gap-x-[20px] gap-y-[8px] sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">需求人数</dt>
              <dd>{productionPlanNumber(reference.requiredHeadcount)} 人</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">学历 / 人员属性</dt>
              <dd>
                {reference.educationRequirement
                  ? education[reference.educationRequirement]
                  : '未填写'}{' '}
                / {reference.employmentType ? employment[reference.employmentType] : '未填写'}
              </dd>
            </div>
            {[
              ['经验要求', reference.experienceRequirement],
              ['工作内容', reference.workSummary],
              ['必备要求', reference.mandatoryRequirement],
              ['特殊要求', reference.specialRequirement],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="whitespace-pre-wrap break-words">{value || '未填写'}</dd>
              </div>
            ))}
          </dl>
        </details>
        {collectionError('crowds')}
        {crowds.fields.map((crowd, index) => (
          <fieldset key={crowd.id} className="space-y-[14px] rounded-[12px] border p-[16px]">
            <legend className="px-[4px] text-[14px] font-medium">人群 {index + 1}</legend>
            <div className="grid gap-[16px] sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
              {field(`crowds.${index}.crowdName`, `人群${index + 1}名称`, {
                required: true,
                maxLength: 100,
              })}
              {field(`crowds.${index}.profileRequirement`, `人群${index + 1}画像要求`, {
                required: true,
                multiline: true,
              })}
              {!readOnly && (
                <Button
                  variant="dangerGhost"
                  size="iconTouch"
                  aria-label={`删除人群${index + 1}`}
                  disabled={crowds.fields.length <= 1}
                  onClick={() => crowds.remove(index)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          </fieldset>
        ))}
      </section>
      <section aria-label="生产阶段" className="space-y-[18px] border-t pt-[24px]">
        <header className="flex flex-wrap items-center justify-between gap-[12px]">
          <h3 id="production-stages-title" className="text-[16px] font-semibold">
            生产阶段
          </h3>
          {!readOnly && (
            <Button
              variant="outline"
              size="mobileTouch"
              disabled={stages.fields.length >= 50}
              onClick={() => {
                stages.append(emptyProductionStage());
                form.clearErrors('stages');
              }}
            >
              <Plus className="size-4" aria-hidden />
              添加阶段
            </Button>
          )}
        </header>
        <p className="text-[13px] leading-6 text-muted-foreground">
          项目量级：{productionPlanNumber(reference.projectQuantity)} {reference.quantityUnit} ·
          截止时间：{reference.deadline || '未填写'}
          （上海时间）。自动工作日只计算周一至周五，不扣除节假日；手动天数可按实际安排填写。
        </p>
        {collectionError('stages')}
        {stages.fields.map((stage, index) => {
          const current = values.stages?.[index];
          const snapshot = form.getValues(`stages.${index}`);
          const estimate = productionStageEstimate(snapshot, values.operatorCpd ?? '');
          const source = current?.workdayCountSource ?? 'AUTO';
          const id = `production-plan-stages-${index}-workdayCount`;
          const daysError = form.getFieldState(`stages.${index}.workdayCount`, form.formState).error
            ?.message;
          return (
            <fieldset key={stage.id} className="space-y-[16px] rounded-[12px] border p-[16px]">
              <legend className="px-[4px] text-[14px] font-medium">阶段 {index + 1}</legend>
              <div className="flex items-start gap-[12px]">
                <div className="min-w-0 flex-1">
                  {field(`stages.${index}.stageName`, `阶段${index + 1}名称`, {
                    required: true,
                    maxLength: 100,
                  })}
                </div>
                {!readOnly && (
                  <Button
                    variant="dangerGhost"
                    size="iconTouch"
                    aria-label={`删除阶段${index + 1}`}
                    disabled={stages.fields.length <= 1}
                    onClick={() => stages.remove(index)}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
              <div className="grid gap-[18px] sm:grid-cols-2 xl:grid-cols-3">
                {field(`stages.${index}.startDate`, `阶段${index + 1}开始日期`, {
                  required: true,
                  type: 'date',
                  min: readOnly ? undefined : today,
                })}
                {field(`stages.${index}.endDate`, `阶段${index + 1}结束日期`, {
                  required: true,
                  type: 'date',
                  min: readOnly ? undefined : current?.startDate || today,
                })}
                <FormField
                  controlId={`production-plan-stages-${index}-source`}
                  label={`阶段${index + 1}天数来源`}
                  required
                >
                  <Controller
                    control={form.control}
                    name={`stages.${index}.workdayCountSource`}
                    render={({ field: control }) => (
                      <Select
                        value={control.value}
                        onValueChange={(value) => {
                          if (value === 'AUTO' || value === 'MANUAL') {
                            control.onChange(value);
                            form.clearErrors(`stages.${index}.workdayCount`);
                          }
                        }}
                      >
                        <SelectTrigger
                          ref={control.ref}
                          id={`production-plan-stages-${index}-source`}
                          size="profile"
                          onBlur={control.onBlur}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AUTO">自动工作日</SelectItem>
                          <SelectItem value="MANUAL">手动填写</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>
                {source === 'MANUAL' ? (
                  field(`stages.${index}.workdayCount`, `阶段${index + 1}有效生产天数`, {
                    type: 'number',
                    required: true,
                  })
                ) : (
                  <FormField
                    controlId={id}
                    label={`阶段${index + 1}有效生产天数`}
                    error={daysError}
                    description="自动统计周一至周五。"
                  >
                    {({ invalid, describedBy }) => (
                      <Input
                        id={id}
                        size="profile"
                        readOnly
                        value={
                          readOnly
                            ? (plan.stages[index]?.workdayCount ?? '')
                            : (estimate.workdays ?? '')
                        }
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                      />
                    )}
                  </FormField>
                )}
                {field(`stages.${index}.operatorHeadcount`, `阶段${index + 1}作业人数`, {
                  required: true,
                  type: 'number',
                })}
                {field(`stages.${index}.operatorCpd`, `阶段${index + 1}作业 CPD（选填）`, {
                  type: 'number',
                  placeholder: '留空使用计划作业 CPD',
                })}
                {field(`stages.${index}.accuracyRate`, `阶段${index + 1}准确率（选填）`, {
                  type: 'number',
                  description: '百分数，大于 0 且不超过 100，最多 4 位小数。',
                })}
              </div>
              <p className="text-right text-[13px] text-muted-foreground">
                自然天数：
                {readOnly
                  ? productionPlanNumber(plan.stages[index]?.naturalDayCount ?? null)
                  : productionPlanNumber(estimate.naturalDays)}{' '}
                天 · {readOnly ? `阶段${index + 1}已确认产出` : `阶段${index + 1}预计产出（估算）`}
                ：
                <strong className="font-medium text-foreground">
                  {productionPlanNumber(
                    readOnly
                      ? (plan.stages[index]?.expectedOutput ?? null)
                      : estimate.expectedOutput,
                  )}{' '}
                  {reference.quantityUnit}
                </strong>
              </p>
            </fieldset>
          );
        })}
      </section>
    </div>
  );
}
