import { Controller, type UseFormReturn } from 'react-hook-form';
import type { ProjectCategory } from '@tyde/shared';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { ToggleCheckboxGroup } from '@/components/ui/shared/ToggleCheckboxGroup';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ProjectCreateValues } from './project-create-form';

interface ProjectCreateFieldsProps {
  form: UseFormReturn<ProjectCreateValues>;
  step: number;
  categories: ProjectCategory[];
  requesterName: string;
  creatorName: string;
}

/** 三步表单复用当前主题控件，分类按后端公开的独立级别选择。 */
export function ProjectCreateFields({
  form,
  step,
  categories,
  requesterName,
  creatorName,
}: ProjectCreateFieldsProps) {
  const errors = form.formState.errors;

  /** 保持单行、多行字段的标签、说明和错误关联一致。 */
  function text(
    name: Exclude<keyof ProjectCreateValues, 'categoryLevel3Ids'>,
    label: string,
    options: {
      required?: boolean;
      multiline?: boolean;
      type?: 'number' | 'datetime-local';
      maxLength?: number;
      description?: string;
    } = {},
  ) {
    const id = `project-create-${name}`;
    return (
      <FormField
        key={name}
        controlId={id}
        label={label}
        required={options.required}
        error={errors[name]?.message}
        description={options.description}
      >
        {({ invalid, describedBy }) =>
          options.multiline ? (
            <Textarea
              id={id}
              rows={4}
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
              step={
                options.type === 'datetime-local'
                  ? 1
                  : options.type === 'number'
                    ? 'any'
                    : undefined
              }
              min={options.type === 'number' ? 0 : undefined}
              maxLength={options.maxLength}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              {...form.register(name, { onChange: () => form.clearErrors(name) })}
            />
          )
        }
      </FormField>
    );
  }

  /** 下拉选择通过 Controller 更新受控状态，并允许清空尚未完成的草稿字段。 */
  function select(
    name: Exclude<keyof ProjectCreateValues, 'categoryLevel3Ids'>,
    label: string,
    options: { value: string; label: string }[],
  ) {
    const id = `project-create-${name}`;
    return (
      <FormField key={name} controlId={id} label={label} required error={errors[name]?.message}>
        {({ invalid, describedBy }) => (
          <Controller
            control={form.control}
            name={name}
            render={({ field }) => (
              <Select
                value={field.value || '__empty'}
                onValueChange={(value) => {
                  field.onChange(value === '__empty' ? '' : value);
                  form.clearErrors(name);
                }}
              >
                <SelectTrigger
                  id={id}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  size="profile"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                >
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__empty">请选择</SelectItem>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        )}
      </FormField>
    );
  }

  return (
    <div className="space-y-[22px]">
      {step === 0 && (
        <>
          {text('projectName', '项目名称', { required: true, maxLength: 128 })}
          {text('projectDescription', '项目描述', { multiline: true })}
          <div className="grid gap-[20px] sm:grid-cols-2">
            {select(
              'categoryLevel1Id',
              '一级项目类型',
              categories
                .filter((item) => item.categoryLevel === 1)
                .map((item) => ({ value: String(item.id), label: item.categoryName })),
            )}
            {select(
              'categoryLevel2Id',
              '二级项目类型',
              categories
                .filter((item) => item.categoryLevel === 2)
                .map((item) => ({ value: String(item.id), label: item.categoryName })),
            )}
          </div>
          <FormField
            controlId="project-create-categoryLevel3Ids"
            label="三级项目类型"
            required
            error={errors.categoryLevel3Ids?.message}
            description="可多选，最多 20 项。"
          >
            {({ invalid, describedBy }) => (
              <Controller
                control={form.control}
                name="categoryLevel3Ids"
                render={({ field }) => (
                  <ToggleCheckboxGroup
                    id="project-create-categoryLevel3Ids"
                    ariaLabel="三级项目类型"
                    value={field.value.map(String)}
                    options={categories
                      .filter((item) => item.categoryLevel === 3)
                      .map((item) => ({ value: String(item.id), label: item.categoryName }))}
                    onChange={(values) => {
                      field.onChange(values.map(Number));
                      form.clearErrors('categoryLevel3Ids');
                    }}
                    variant="pill"
                    invalid={invalid}
                    ariaDescribedBy={describedBy}
                  />
                )}
              />
            )}
          </FormField>
          {select('difficultyLevel', '难度等级', [
            { value: 'EASY', label: '简单' },
            { value: 'MEDIUM', label: '中等' },
            { value: 'HARD', label: '困难' },
          ])}
          <div className="grid gap-[20px] sm:grid-cols-2">
            <FormField controlId="project-create-requester" label="需求方">
              <Input id="project-create-requester" size="profile" value={requesterName} readOnly />
            </FormField>
            <FormField controlId="project-create-creator" label="创建者">
              <Input id="project-create-creator" size="profile" value={creatorName} readOnly />
            </FormField>
          </div>
          {text('deadline', '截止时间（上海时间）', {
            required: true,
            type: 'datetime-local',
            description: '按上海时间填写，包含时、分、秒。',
          })}
          <div className="grid gap-[20px] sm:grid-cols-2">
            {text('projectQuantity', '项目量级', { required: true, type: 'number' })}
            {text('quantityUnit', '量级单位', { required: true, maxLength: 30 })}
          </div>
        </>
      )}
      {step === 1 && (
        <>
          {text('requiredHeadcount', '需求人数', { required: true, type: 'number' })}
          <div className="grid gap-[20px] sm:grid-cols-2">
            {select('educationRequirement', '学历要求', [
              { value: 'PHD', label: '博士' },
              { value: 'MASTER', label: '研究生' },
              { value: 'BACHELOR', label: '本科' },
              { value: 'COLLEGE', label: '大专' },
              { value: 'BELOW_COLLEGE', label: '大专以下' },
            ])}
            {select('employmentType', '人员属性', [
              { value: 'FULL_TIME', label: '全职' },
              { value: 'PART_TIME', label: '兼职' },
              { value: 'UNLIMITED', label: '不限' },
            ])}
          </div>
          {text('experienceRequirement', '经验要求', { multiline: true })}
          {text('workSummary', '工作内容摘要', { multiline: true })}
          {text('specialRequirement', '特殊要求', { multiline: true })}
          {text('mandatoryRequirement', '必备要求', { required: true, multiline: true })}
        </>
      )}
      {step === 2 && (
        <>
          {text('standardContent', '标准说明与作业规范', { required: true, multiline: true })}
          {text('standardLink', '标准文档链接（选填）', {
            maxLength: 2000,
            description: '文档链接作为补充，仍需填写上方标准说明。',
          })}
        </>
      )}
    </div>
  );
}
