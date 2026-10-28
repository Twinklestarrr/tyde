import { useState, type Dispatch, type SetStateAction } from 'react';
import { Plus, X } from 'lucide-react';
import type { AuthUser, EntranceExamReviewer } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
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
import { StrategistExamFiles } from './StrategistExamFiles';
import {
  examPaperScores,
  newExamPaper,
  newExamQuestion,
  newExamRound,
  type EntranceExamFormValues,
  type EntranceExamFormErrors,
  type ExamDraftFile,
  type ExamDraftPaper,
  type ExamDraftQuestion,
  type ExamDraftRound,
} from './entrance-exam-form';

export function StrategistExamFields({
  values,
  onChange,
  errors,
  user,
  disabled,
  reviewerCandidates,
  reviewersLoading,
  reviewersError,
  onRetryReviewers,
}: {
  values: EntranceExamFormValues;
  onChange: Dispatch<SetStateAction<EntranceExamFormValues>>;
  errors: EntranceExamFormErrors;
  user: AuthUser;
  disabled: boolean;
  reviewerCandidates: EntranceExamReviewer[];
  reviewersLoading: boolean;
  reviewersError: unknown;
  onRetryReviewers: () => void;
}) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  function text(
    path: string,
    label: string,
    value: string,
    onValue: (value: string) => void,
    options: {
      type?: 'number' | 'datetime-local';
      required?: boolean;
      multiline?: boolean;
      maxLength?: number;
      description?: string;
      readOnly?: boolean;
    } = {},
  ) {
    const id = `exam-field-${path.replaceAll('.', '-')}`;
    return (
      <FormField
        controlId={id}
        label={label}
        required={options.required}
        error={errors[path]}
        description={options.description}
      >
        {({ invalid, describedBy }) =>
          options.multiline ? (
            <Textarea
              id={id}
              rows={3}
              value={value}
              maxLength={options.maxLength}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onValue(event.target.value)}
            />
          ) : (
            <Input
              id={id}
              size="profile"
              value={value}
              type={options.type ?? 'text'}
              step={
                options.type === 'datetime-local'
                  ? 1
                  : options.type === 'number'
                    ? 'any'
                    : undefined
              }
              readOnly={options.readOnly}
              maxLength={options.maxLength}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onValue(event.target.value)}
            />
          )
        }
      </FormField>
    );
  }
  function select(
    path: string,
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onValue: (value: string) => void,
  ) {
    const id = `exam-field-${path.replaceAll('.', '-')}`;
    return (
      <FormField controlId={id} label={label} required error={errors[path]}>
        {({ invalid, describedBy }) => (
          <Select value={value} onValueChange={onValue}>
            <SelectTrigger
              id={id}
              size="profile"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent container={portal}>
              {options.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
    );
  }
  const update = <K extends keyof EntranceExamFormValues>(
    key: K,
    value: EntranceExamFormValues[K],
  ) => onChange((current) => ({ ...current, [key]: value }));
  const paper = (key: string, change: (value: ExamDraftPaper) => ExamDraftPaper) =>
    onChange((current) => ({
      ...current,
      papers: current.papers.map((item) => (item.key === key ? change(item) : item)),
    }));
  const question = (
    paperKey: string,
    key: string,
    change: (value: ExamDraftQuestion) => ExamDraftQuestion,
  ) =>
    paper(paperKey, (value) => ({
      ...value,
      questions: value.questions.map((item) => (item.key === key ? change(item) : item)),
    }));
  const round = (key: string, change: (value: ExamDraftRound) => ExamDraftRound) =>
    onChange((current) => ({
      ...current,
      gradingRounds: current.gradingRounds.map((item) => (item.key === key ? change(item) : item)),
    }));
  const fileError = (path: string) =>
    errors[path] ? (
      <p role="alert" className="text-[13px] text-destructive">
        {errors[path]}
      </p>
    ) : null;
  return (
    <div ref={setPortal} className="space-y-[28px]">
      <section aria-label="考试基础设置" className="space-y-[18px]">
        <h3 className="text-[16px] font-semibold">基础设置</h3>
        {text('examName', '考试名称', values.examName, (value) => update('examName', value), {
          required: true,
          maxLength: 128,
        })}
        <div className="grid gap-[18px] sm:grid-cols-2">
          {select(
            'durationMode',
            '答题方式',
            values.durationMode,
            [
              { value: 'LIMITED', label: '限时作答' },
              { value: 'UNLIMITED', label: '不限时' },
            ],
            (value) => {
              if (value === 'LIMITED' || value === 'UNLIMITED') update('durationMode', value);
            },
          )}
          {values.durationMode === 'LIMITED' &&
            text(
              'durationMinutes',
              '答题时限（分钟）',
              values.durationMinutes,
              (value) => update('durationMinutes', value),
              { type: 'number', required: true },
            )}
          {text(
            'registrationDeadline',
            '截止时间（上海时间）',
            values.registrationDeadline,
            (value) => update('registrationDeadline', value),
            { type: 'datetime-local', required: true },
          )}
          {text('fullScore', '试卷满分', values.fullScore, (value) => update('fullScore', value), {
            type: 'number',
            required: true,
            description: '修改满分后仅自动题重新计算；手动题请核对合计。',
          })}
          {text(
            'passScore',
            '准入分数线',
            values.passScore,
            (value) => update('passScore', value),
            {
              type: 'number',
              required: true,
              description: '大于0且不超过试卷满分，最多两位小数。',
            },
          )}
        </div>
      </section>
      <section aria-label="考试试卷配置" className="space-y-[18px] border-t pt-[24px]">
        <header className="flex flex-wrap items-center justify-between gap-[12px]">
          <h3 className="text-[16px] font-semibold">试卷与题目</h3>
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={values.papers.length >= 20}
            onClick={() =>
              onChange((current) => ({ ...current, papers: [...current.papers, newExamPaper()] }))
            }
          >
            <Plus className="size-4" aria-hidden />
            添加试卷
          </Button>
        </header>
        <p className="text-[13px] leading-6 text-muted-foreground">
          考生随机绑定其中一张试卷。每卷1–200题、合计须等于满分；自动分值向下均分，最后一题承接尾差。
        </p>
        {fileError('papers')}
        {values.papers.map((item, p) => {
          const scores = examPaperScores(item, values.fullScore),
            prefix = `papers.${p}`;
          return (
            <fieldset
              key={item.key}
              className="min-w-0 space-y-[18px] rounded-[12px] border p-[16px]"
            >
              <legend className="px-[4px] text-[14px] font-semibold">试卷{p + 1}</legend>
              <div className="flex items-start gap-[12px]">
                <div className="min-w-0 flex-1">
                  {text(
                    `${prefix}.paperName`,
                    `试卷${p + 1}名称（选填）`,
                    item.paperName,
                    (value) => paper(item.key, (previous) => ({ ...previous, paperName: value })),
                    { maxLength: 100 },
                  )}
                </div>
                <Button
                  variant="dangerGhost"
                  size="iconTouch"
                  aria-label={`删除试卷${p + 1}`}
                  disabled={values.papers.length <= 1}
                  onClick={() =>
                    update(
                      'papers',
                      values.papers.filter((entry) => entry.key !== item.key),
                    )
                  }
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              {fileError(`${prefix}.questions`)}
              {item.questions.map((entry, q) => {
                const path = `${prefix}.questions.${q}`,
                  label = `试卷${p + 1}题目${q + 1}`;
                const set = <K extends keyof ExamDraftQuestion>(
                  key: K,
                  value: ExamDraftQuestion[K],
                ) => question(item.key, entry.key, (previous) => ({ ...previous, [key]: value }));
                return (
                  <section
                    key={entry.key}
                    aria-label={label}
                    className="min-w-0 space-y-[16px] rounded-[10px] border bg-muted/30 p-[14px]"
                  >
                    <header className="flex items-center justify-between gap-[12px]">
                      <h4 className="text-[14px] font-medium">题目{q + 1}</h4>
                      <Button
                        variant="dangerGhost"
                        size="iconTouch"
                        aria-label={`删除${label}`}
                        disabled={item.questions.length <= 1}
                        onClick={() =>
                          paper(item.key, (previous) => ({
                            ...previous,
                            questions: previous.questions.filter(
                              (candidate) => candidate.key !== entry.key,
                            ),
                          }))
                        }
                      >
                        <X className="size-4" aria-hidden />
                      </Button>
                    </header>
                    <div className="grid gap-[18px] sm:grid-cols-2">
                      {select(
                        `${path}.scoreSource`,
                        `${label}分值来源`,
                        entry.scoreSource,
                        [
                          { value: 'AUTO', label: '自动均分' },
                          { value: 'MANUAL', label: '手动分值' },
                        ],
                        (value) => {
                          if (value === 'AUTO' || value === 'MANUAL')
                            question(item.key, entry.key, (previous) => ({
                              ...previous,
                              scoreSource: value,
                              score:
                                value === 'MANUAL' && previous.score === ''
                                  ? String((scores[q] ?? 0) / 100)
                                  : previous.score,
                            }));
                        },
                      )}
                      {text(
                        `${path}.score`,
                        `${label}分值`,
                        entry.scoreSource === 'AUTO'
                          ? scores[q] == null
                            ? ''
                            : String(scores[q]! / 100)
                          : entry.score,
                        (value) => set('score', value),
                        { type: 'number', required: true, readOnly: entry.scoreSource === 'AUTO' },
                      )}
                    </div>
                    <label className="flex min-h-11 items-center gap-[10px] text-[14px]">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={entry.requiredFlag}
                        onChange={(event) => set('requiredFlag', event.target.checked)}
                      />
                      {label}必答
                    </label>
                    {text(
                      `${path}.questionContent`,
                      `${label}题干`,
                      entry.questionContent,
                      (value) => set('questionContent', value),
                      { multiline: true, description: '题干文字或题干附件至少填写一项。' },
                    )}
                    <StrategistExamFiles
                      label={`${label}题干附件`}
                      files={entry.questionFiles}
                      limit={20}
                      disabled={disabled}
                      user={user}
                      onChange={(change) =>
                        question(item.key, entry.key, (previous) => ({
                          ...previous,
                          questionFiles: change(previous.questionFiles),
                        }))
                      }
                    />
                    {fileError(`${path}.questionFiles`)}
                    {text(
                      `${path}.referenceAnswer`,
                      `${label}参考答案（选填）`,
                      entry.referenceAnswer,
                      (value) => set('referenceAnswer', value),
                      { multiline: true },
                    )}
                    <StrategistExamFiles
                      label={`${label}参考答案附件`}
                      files={entry.referenceFiles}
                      limit={20}
                      disabled={disabled}
                      user={user}
                      onChange={(change) =>
                        question(item.key, entry.key, (previous) => ({
                          ...previous,
                          referenceFiles: change(previous.referenceFiles),
                        }))
                      }
                    />
                    {fileError(`${path}.referenceFiles`)}
                  </section>
                );
              })}
              <div className="flex flex-wrap items-center justify-between gap-[12px]">
                <p className="text-[13px] text-muted-foreground">
                  本卷分值合计：
                  {scores.every((score) => score !== null)
                    ? scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) / 100
                    : '未完整填写'}{' '}
                  分
                </p>
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={item.questions.length >= 200}
                  onClick={() =>
                    paper(item.key, (previous) => ({
                      ...previous,
                      questions: [...previous.questions, newExamQuestion()],
                    }))
                  }
                >
                  <Plus className="size-4" aria-hidden />
                  添加题目
                </Button>
              </div>
            </fieldset>
          );
        })}
      </section>
      <section aria-label="考试判卷配置" className="space-y-[18px] border-t pt-[24px]">
        <header className="flex flex-wrap items-center justify-between gap-[12px]">
          <h3 className="text-[16px] font-semibold">判卷轮次</h3>
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={values.gradingRounds.length >= 20}
            onClick={() => update('gradingRounds', [...values.gradingRounds, newExamRound()])}
          >
            <Plus className="size-4" aria-hidden />
            添加判卷轮次
          </Button>
        </header>
        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <p className="text-[13px] leading-6 text-muted-foreground">
            可混合人工与自动轮次，最多20轮。自动判卷当前使用模拟服务。
          </p>
          <Button
            variant="outline"
            size="mobileTouch"
            loading={reviewersLoading}
            onClick={onRetryReviewers}
          >
            重新读取阅卷人
          </Button>
        </div>
        <ErrorNotice error={reviewersError} />
        {fileError('gradingRounds')}
        {values.gradingRounds.map((item, index) => {
          const path = `gradingRounds.${index}`,
            label = `第${index + 1}轮`;
          const set = <K extends keyof ExamDraftRound>(key: K, value: ExamDraftRound[K]) =>
            round(item.key, (previous) => ({ ...previous, [key]: value }));
          return (
            <fieldset
              key={item.key}
              className="min-w-0 space-y-[16px] rounded-[12px] border p-[16px]"
            >
              <legend className="px-[4px] text-[14px] font-medium">{label}判卷</legend>
              <div className="flex items-start gap-[12px]">
                <div className="min-w-0 flex-1">
                  {select(
                    `${path}.gradingMode`,
                    `${label}判卷方式`,
                    item.gradingMode,
                    [
                      { value: 'MANUAL', label: '人工阅卷' },
                      { value: 'AUTO', label: '自动阅卷' },
                    ],
                    (value) => {
                      if (value === 'MANUAL' || value === 'AUTO') set('gradingMode', value);
                    },
                  )}
                </div>
                <Button
                  variant="dangerGhost"
                  size="iconTouch"
                  aria-label={`删除${label}判卷`}
                  disabled={values.gradingRounds.length <= 1}
                  onClick={() =>
                    update(
                      'gradingRounds',
                      values.gradingRounds.filter((entry) => entry.key !== item.key),
                    )
                  }
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              {item.gradingMode === 'MANUAL' ? (
                <div role="group" aria-label={`${label}阅卷人`} className="space-y-[10px]">
                  <p className="text-[13px] font-medium">
                    {label}阅卷人{' '}
                    <span className="text-destructive" aria-hidden>
                      *
                    </span>
                  </p>
                  {reviewersLoading && (
                    <p role="status" className="text-[13px] text-muted-foreground">
                      正在读取阅卷人…
                    </p>
                  )}
                  {!reviewersLoading && !reviewerCandidates.length && (
                    <p className="text-[13px] text-muted-foreground">
                      暂无可选阅卷人，请重试读取。
                    </p>
                  )}
                  {reviewerCandidates.map((candidate) => (
                    <label
                      key={candidate.userId}
                      className="flex min-h-11 items-center gap-[10px] text-[14px]"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={item.reviewerUserIds.includes(candidate.userId)}
                        onChange={(event) =>
                          set(
                            'reviewerUserIds',
                            event.target.checked
                              ? [...item.reviewerUserIds, candidate.userId]
                              : item.reviewerUserIds.filter((id) => id !== candidate.userId),
                          )
                        }
                      />
                      {candidate.name} · {candidate.uid}
                    </label>
                  ))}
                  {item.reviewerUserIds
                    .filter(
                      (id) => !reviewerCandidates.some((candidate) => candidate.userId === id),
                    )
                    .map((id) => (
                      <div
                        key={id}
                        className="flex min-w-0 items-center gap-[8px] rounded-lg border p-[8px] text-[13px]"
                      >
                        <span className="min-w-0 flex-1 break-all">已配置阅卷人 · {id}</span>
                        <Button
                          variant="dangerGhost"
                          size="iconTouch"
                          aria-label={`移除阅卷人${id}`}
                          onClick={() =>
                            set(
                              'reviewerUserIds',
                              item.reviewerUserIds.filter((value) => value !== id),
                            )
                          }
                        >
                          <X className="size-4" aria-hidden />
                        </Button>
                      </div>
                    ))}
                  {fileError(`${path}.reviewerUserIds`)}
                </div>
              ) : (
                <>
                  <div className="grid gap-[18px] sm:grid-cols-2">
                    {text(
                      `${path}.toolCode`,
                      `${label}工具编码`,
                      item.toolCode,
                      (value) => set('toolCode', value),
                      { required: true, maxLength: 64 },
                    )}
                    {text(
                      `${path}.toolName`,
                      `${label}工具名称`,
                      item.toolName,
                      (value) => set('toolName', value),
                      { required: true, maxLength: 128 },
                    )}
                  </div>
                  {text(
                    `${path}.toolConfigText`,
                    `${label}工具配置（选填）`,
                    item.toolConfigText,
                    (value) => set('toolConfigText', value),
                    { multiline: true, description: '填写非敏感JSON配置，不能包含密钥；可留空。' },
                  )}
                  <StrategistExamFiles
                    label={`${label}工具附件`}
                    files={item.toolFiles}
                    limit={10}
                    disabled={disabled}
                    user={user}
                    onChange={(change: (current: ExamDraftFile[]) => ExamDraftFile[]) =>
                      round(item.key, (previous) => ({
                        ...previous,
                        toolFiles: change(previous.toolFiles),
                      }))
                    }
                  />
                  {fileError(`${path}.toolFiles`)}
                </>
              )}
            </fieldset>
          );
        })}
        <div className="grid gap-[18px] sm:grid-cols-2">
          {select(
            'decisionRule',
            '最终裁决规则',
            values.decisionRule,
            [
              { value: 'MAJORITY', label: '多数原则' },
              { value: 'MANUAL_PRIORITY', label: '人工优先' },
            ],
            (value) => {
              if (value === 'MAJORITY' || value === 'MANUAL_PRIORITY')
                update('decisionRule', value);
            },
          )}
          {values.decisionRule === 'MAJORITY' &&
            values.gradingRounds.length % 2 === 0 &&
            select(
              'tieBreakRule',
              '平局裁决规则',
              values.tieBreakRule,
              [
                { value: 'STRICT', label: '从严（淘汰）' },
                { value: 'LENIENT', label: '从宽（准入）' },
              ],
              (value) => {
                if (value === 'STRICT' || value === 'LENIENT') update('tieBreakRule', value);
              },
            )}
        </div>
      </section>
    </div>
  );
}
