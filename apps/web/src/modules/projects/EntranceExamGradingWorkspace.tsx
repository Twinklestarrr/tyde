import { useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthUser,
  type EntranceExamAutoCompensateInput,
  type EntranceExamAutoRetryInput,
  type EntranceExamGradingDetail,
  type EntranceExamManualGradingInput,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { EntranceExamFiles } from './EntranceExamFiles';
import { EntranceExamText } from './EntranceExamText';
import {
  entranceExamGradingActions,
  entranceExamGradingInput,
  entranceExamGradingPreview,
  entranceExamGradingValues,
  type EntranceExamGradingValues,
} from './entrance-exam-grading';

interface EntranceExamGradingWorkspaceProps {
  user: AuthUser;
  projectId: number;
  examId: number;
  attemptId: number;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onBack: () => void;
}

type Write =
  | { kind: 'manual'; input: EntranceExamManualGradingInput }
  | { kind: 'retry'; input: EntranceExamAutoRetryInput }
  | { kind: 'compensate'; input: EntranceExamAutoCompensateInput };
type Lock = 'unknown' | 'conflict' | 'success' | 'access';
type LockMap = Record<string, Lock>;

const statusLabel = {
  WAITING: '等待前轮完成',
  PENDING: '待阅卷',
  PROCESSING: '阅卷中',
  COMPLETED: '已完成',
  FAILED: '阅卷失败',
};
const finalLabel = { PENDING: '待确定', ADMITTED: '已录取', ELIMINATED: '已淘汰' };
const roundResultLabel = { ADMITTED: '本轮通过', ELIMINATED: '本轮未通过' };
const confirmLabel = {
  manual: '确认提交人工阅卷',
  retry: '确认重试模拟阅卷',
  compensate: '确认人工补偿',
};

function gradingKey(props: EntranceExamGradingWorkspaceProps, roundNo: number) {
  return [
    'entrance-exam-grading',
    props.user.id,
    'PM',
    props.projectId,
    props.examId,
    props.attemptId,
    roundNo,
  ] as const;
}

/** 正文由名单所在弹框承载；每个轮次均读取本次应试绑定的历史试卷。 */
export function EntranceExamGradingWorkspace(props: EntranceExamGradingWorkspaceProps) {
  const [roundNo, setRoundNo] = useState(1);
  const query = useQuery({
    queryKey: gradingKey(props, roundNo),
    queryFn: () =>
      api.getEntranceExamGradingDetail({
        projectId: props.projectId,
        examId: props.examId,
        attemptId: props.attemptId,
        roundNo,
      }),
    enabled: (props.user.selectedRole ?? props.user.role) === 'PM',
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if ((props.user.selectedRole ?? props.user.role) !== 'PM') return null;
  if (query.isError)
    return (
      <section aria-label="阅卷详情" className="space-y-4">
        <Button variant="outline" size="account" onClick={props.onBack}>
          返回考试名单
        </Button>
        <ErrorNotice error={query.error} />
        <Button
          variant="outline"
          size="account"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重新读取阅卷状态
        </Button>
      </section>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在读取阅卷详情…
      </p>
    );
  return (
    <GradingRound
      key={`${props.user.id}:${props.projectId}:${props.examId}:${props.attemptId}:${roundNo}`}
      {...props}
      detail={query.data}
      roundNo={roundNo}
      onRoundChange={setRoundNo}
    />
  );
}

function GradingRound(
  props: EntranceExamGradingWorkspaceProps & {
    detail: EntranceExamGradingDetail;
    roundNo: number;
    onRoundChange: (roundNo: number) => void;
  },
) {
  const { user, projectId, examId, attemptId, detail, roundNo, canManage } = props;
  const cache = useQueryClient();
  const locksKey = [
    'entrance-exam-grading-write-locks',
    user.id,
    'PM',
    projectId,
    examId,
    attemptId,
  ];
  const locks = useQuery<LockMap>({
    queryKey: locksKey,
    queryFn: async () => ({}),
    initialData: {},
    enabled: false,
    gcTime: Infinity,
  });
  const [values, setValues] = useState(() => entranceExamGradingValues(detail));
  const initial = useRef(JSON.stringify(values));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [compensating, setCompensating] = useState(false);
  const [confirming, setConfirming] = useState<Write['kind'] | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const mounted = useRef(false);
  const working = useRef(false);
  const round = detail.selectedRound;
  const recordId = round.gradingRecordId;
  const lock = recordId === null ? undefined : locks.data[String(recordId)];
  const actions = entranceExamGradingActions(detail, canManage);
  const mutation = useMutation({
    mutationFn: (write: Write) =>
      write.kind === 'manual'
        ? api.submitEntranceExamManualGrading(write.input)
        : write.kind === 'retry'
          ? api.retryEntranceExamAutoGrading(write.input)
          : api.compensateEntranceExamAutoGrading(write.input),
    retry: false,
    networkMode: 'always',
  });
  const busy = reading || mutation.isPending;
  const editable = (actions.manual || (compensating && actions.compensate)) && !lock;
  const disabled = !editable || busy || confirming !== null;
  const dirty = JSON.stringify(values) !== initial.current;
  const preview = entranceExamGradingPreview(detail, values);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function sessionMatches() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && current?.id === user.id && (current.selectedRole ?? current.role) === 'PM'
    );
  }

  function mayLeave(message = '未提交的阅卷内容将会丢失，确认离开？') {
    return !working.current && (!dirty || window.confirm(message));
  }

  useEffect(() => {
    function beforeLeave(event: Event) {
      if (working.current || (dirty && !window.confirm('未提交的阅卷内容将会丢失，确认离开？')))
        event.preventDefault();
    }
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    window.addEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
      window.removeEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, beforeLeave);
    };
  }, [dirty]);

  useBlocker({
    shouldBlockFn: () => {
      const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      if (current && (current.id !== user.id || (current.selectedRole ?? current.role) !== 'PM'))
        return false;
      return working.current || (dirty && !window.confirm('未提交的阅卷内容将会丢失，确认离开？'));
    },
    enableBeforeUnload: () => working.current || dirty,
  });

  /** 关闭、切轮或重开弹框均保留尚未核实的写入结果，不提供直接重发入口。 */
  function setLock(next: Lock | null) {
    if (recordId === null) return;
    cache.setQueryData<LockMap>(locksKey, (current = {}) => {
      const result = { ...current };
      if (next) result[String(recordId)] = next;
      else delete result[String(recordId)];
      return result;
    });
  }

  async function readFresh() {
    const result = await api.getEntranceExamGradingDetail({
      projectId,
      examId,
      attemptId,
      roundNo,
    });
    if (!sessionMatches()) return;
    cache.setQueryData(gradingKey(props, roundNo), result);
    const next = entranceExamGradingValues(result);
    initial.current = JSON.stringify(next);
    setValues(next);
    setCompensating(false);
    setConfirming(null);
    setErrors({});
    await props.onChanged();
    if (!sessionMatches()) return;
    const currentLock =
      recordId === null ? undefined : cache.getQueryData<LockMap>(locksKey)?.[String(recordId)];
    // 详情读取不证明历史轮次阅卷资格，提交403后仍保持只读。
    if (currentLock !== 'access') setLock(null);
    setError(null);
    setReadError(null);
    setNotice(
      currentLock === 'access'
        ? '当前账号没有本轮写入权限，仅可查看。'
        : '已读取最新阅卷状态，请核对本轮与最终准入结果。',
    );
  }

  async function reread() {
    if (working.current || !sessionMatches()) return;
    if (!mayLeave('重新读取将替换未提交的阅卷内容，确认继续？')) return;
    working.current = true;
    setReading(true);
    setReadError(null);
    try {
      await readFresh();
    } catch (failure) {
      if (sessionMatches()) {
        setReadError(failure);
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setLock('access');
      }
    } finally {
      working.current = false;
      if (mounted.current) setReading(false);
    }
  }

  function payload(kind: Write['kind']): Write | null {
    if (recordId === null) return null;
    const base = { projectId, examId, gradingRecordId: recordId };
    if (kind === 'retry') return { kind, input: base };
    const result = entranceExamGradingInput(detail, values, kind === 'compensate');
    setErrors(result.errors);
    if (!result.input) return null;
    return kind === 'manual'
      ? {
          kind,
          input: {
            ...base,
            attemptId,
            conclusionSummary: result.input.summary,
            items: result.input.items,
          },
        }
      : { kind, input: { ...base, ...result.input } };
  }

  function permitted(kind: Write['kind']) {
    return (
      !lock &&
      (kind === 'manual' ? actions.manual : kind === 'retry' ? actions.retry : actions.compensate)
    );
  }

  function confirm(kind: Write['kind']) {
    if (working.current || !sessionMatches() || !permitted(kind) || !payload(kind)) return;
    setConfirming(kind);
  }

  /** 每次意图只写一次；成功后的回读失败和未知结果都保留锁，恢复动作只有读取。 */
  async function submit() {
    if (!confirming || working.current || !sessionMatches() || !permitted(confirming)) return;
    const write = payload(confirming);
    if (!write) {
      setConfirming(null);
      return;
    }
    working.current = true;
    setError(null);
    setReadError(null);
    setNotice('');
    try {
      try {
        await mutation.mutateAsync(write);
      } catch (failure) {
        if (sessionMatches()) {
          setError(failure);
          if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
            setLock('access');
          else if (failure instanceof ApiError && failure.status === 409) setLock('conflict');
          else if (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500)
            setLock('unknown');
        }
        return;
      }
      if (!sessionMatches()) return;
      setLock('success');
      initial.current = JSON.stringify(values);
      setNotice(
        write.kind === 'retry'
          ? '模拟阅卷重试已提交，正在读取最新结果。'
          : '阅卷结果已提交，正在读取最新结果。',
      );
      setReading(true);
      try {
        await readFresh();
      } catch (failure) {
        if (sessionMatches()) {
          setReadError(failure);
          setNotice('操作已成功提交，最新状态读取失败。请重新读取阅卷状态，不能重复提交。');
        }
      }
    } finally {
      working.current = false;
      if (mounted.current) {
        setReading(false);
        setConfirming(null);
      }
    }
  }

  function changeItem(
    questionId: number,
    change: Partial<EntranceExamGradingValues['items'][number]>,
  ) {
    setValues((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.questionId === questionId ? { ...item, ...change } : item,
      ),
    }));
  }

  return (
    <section ref={setPortal} aria-label="阅卷详情" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="outline"
          size="account"
          disabled={busy}
          onClick={() => {
            if (mayLeave()) props.onBack();
          }}
        >
          返回考试名单
        </Button>
        <Button
          variant="outline"
          size="account"
          loading={reading}
          disabled={busy}
          onClick={() => void reread()}
        >
          重新读取阅卷状态
        </Button>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{detail.candidateName}的阅卷详情</h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">UID：{detail.candidateUid}</p>
          <p className="mt-2 text-sm">最终准入结果：{finalLabel[detail.finalResult]}</p>
        </div>
        <div className="w-full space-y-2 sm:w-64">
          <label htmlFor={`grading-round-${attemptId}`} className="text-sm font-medium">
            判卷轮次
          </label>
          <Select
            value={String(roundNo)}
            disabled={busy || confirming !== null}
            onValueChange={(value) => {
              if (mayLeave('未提交的阅卷内容将会丢失，确认切换判卷轮次？'))
                props.onRoundChange(Number(value));
            }}
          >
            <SelectTrigger id={`grading-round-${attemptId}`} aria-label="判卷轮次">
              <SelectValue />
            </SelectTrigger>
            <SelectContent container={portal}>
              {detail.rounds.map((item) => (
                <SelectItem key={item.gradingRoundId} value={String(item.roundNo)}>
                  第{item.roundNo}轮 · {item.gradingMode === 'AUTO' ? '模拟自动阅卷' : '人工阅卷'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <div className="rounded-xl border bg-muted/30 p-4 text-sm">
        <p>
          第{round.roundNo}轮 · {round.gradingMode === 'AUTO' ? '模拟自动阅卷' : '人工阅卷'} ·{' '}
          {round.status ? statusLabel[round.status] : '尚未生成阅卷记录'}
        </p>
        <p className="mt-2">
          本轮得分：{round.score === null ? '待确定' : `${round.score}分`} · 通过分数：
          {detail.passScore}分 ·{' '}
          {round.roundResult ? roundResultLabel[round.roundResult] : '本轮结论待确定'}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          单轮结论不代表最终准入。各轮全部完成后的最终结果以上方准入状态为准。
        </p>
        {round.conclusionSummary && (
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted-foreground">本轮已有总结</p>
            <EntranceExamText value={round.conclusionSummary} />
          </div>
        )}
        {round.errorMessage && (
          <div className="mt-3 whitespace-pre-wrap break-words text-destructive">
            阅卷错误：{round.errorMessage}
          </div>
        )}
      </div>
      {!canManage && <Alert>当前为协作查看，仅可读取应试和阅卷结果。</Alert>}
      {!actions.previousComplete && <Alert>前轮阅卷尚未全部完成，本轮暂不可操作。</Alert>}
      {round.status === 'WAITING' && <Alert>本轮正在等待前轮完成，请稍后重新读取阅卷状态。</Alert>}
      {round.gradingMode === 'AUTO' && (
        <Alert>自动阅卷使用现有模拟处理接口。失败时可重试模拟阅卷，或填写原因进行人工补偿。</Alert>
      )}
      {actions.manual && !lock && (
        <p className="text-xs text-muted-foreground">
          请逐题判定；本轮阅卷人资格在提交时由服务端核验。
        </p>
      )}
      {lock && (
        <Alert>
          {lock === 'success'
            ? '操作已成功提交，等待核实最新状态，当前不能重复提交。'
            : lock === 'access'
              ? '当前账号没有本轮写入权限，仅可查看。'
              : '上次操作结果尚未核实，已暂停写入。请先重新读取阅卷状态。'}
        </Alert>
      )}
      {notice && <Alert>{notice}</Alert>}
      <ErrorNotice error={error} />
      <ErrorNotice error={readError} />
      {errors.questions && <Alert variant="destructive">{errors.questions}</Alert>}
      {detail.questions.map((question) => {
        const item = values.items.find((value) => value.questionId === question.questionId);
        const judgementId = `grading-${attemptId}-${roundNo}-${question.questionId}`;
        return (
          <section
            key={question.questionId}
            aria-label={`题目${question.sequenceNo}`}
            className="space-y-4 rounded-xl border p-4"
          >
            <h4 className="font-semibold">
              题目 {question.sequenceNo}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {question.score}分
              </span>
            </h4>
            <EntranceExamText
              value={question.questionContent}
              empty="题干未填写文字，请查看附件。"
            />
            <EntranceExamFiles
              value={question.questionFiles}
              label={`题目${question.sequenceNo}题干附件`}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                <h5 className="text-xs font-medium text-muted-foreground">参考答案</h5>
                <EntranceExamText value={question.referenceAnswer} />
                <EntranceExamFiles
                  value={question.referenceFiles}
                  label={`题目${question.sequenceNo}参考附件`}
                />
              </div>
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                <h5 className="text-xs font-medium text-muted-foreground">
                  考生作答{!question.answeredFlag ? ' · 未作答' : ''}
                </h5>
                <EntranceExamText value={question.answerContent} empty="无文字作答" />
                <EntranceExamFiles
                  value={question.answerFiles}
                  label={`题目${question.sequenceNo}作答附件`}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
              <div className="space-y-2">
                <label htmlFor={judgementId} className="text-sm font-medium">
                  题目{question.sequenceNo}判定
                </label>
                <Select
                  value={item?.correctness || 'PENDING'}
                  disabled={disabled}
                  onValueChange={(value) =>
                    changeItem(question.questionId, {
                      correctness:
                        value === 'CORRECT' ? 'CORRECT' : value === 'INCORRECT' ? 'INCORRECT' : '',
                    })
                  }
                >
                  <SelectTrigger
                    id={judgementId}
                    aria-label={`题目${question.sequenceNo}判定`}
                    aria-invalid={!!errors[`question:${question.questionId}`]}
                    aria-describedby={
                      errors[`question:${question.questionId}`] ? `${judgementId}-error` : undefined
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent container={portal}>
                    <SelectItem value="PENDING">待判定</SelectItem>
                    <SelectItem value="CORRECT">正确</SelectItem>
                    <SelectItem value="INCORRECT">错误</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {item?.correctness === 'CORRECT'
                    ? `得分 ${question.score}分`
                    : item?.correctness === 'INCORRECT'
                      ? '得分 0分'
                      : '正确得满分，错误得零分。'}
                </p>
                {errors[`question:${question.questionId}`] && (
                  <p id={`${judgementId}-error`} className="text-xs text-destructive">
                    {errors[`question:${question.questionId}`]}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor={`${judgementId}-opinion`} className="text-sm font-medium">
                  阅卷意见{question.sequenceNo}
                </label>
                <Textarea
                  id={`${judgementId}-opinion`}
                  value={item?.gradingOpinion ?? ''}
                  readOnly={!editable}
                  disabled={busy || confirming !== null}
                  maxLength={5000}
                  rows={3}
                  aria-invalid={!!errors[`opinion:${question.questionId}`]}
                  aria-describedby={
                    errors[`opinion:${question.questionId}`]
                      ? `${judgementId}-opinion-error`
                      : undefined
                  }
                  onChange={(event) =>
                    changeItem(question.questionId, { gradingOpinion: event.target.value })
                  }
                />
                {errors[`opinion:${question.questionId}`] && (
                  <p id={`${judgementId}-opinion-error`} className="text-xs text-destructive">
                    {errors[`opinion:${question.questionId}`]}
                  </p>
                )}
              </div>
            </div>
          </section>
        );
      })}
      <div className="space-y-2">
        <label htmlFor={`grading-summary-${attemptId}-${roundNo}`} className="text-sm font-medium">
          本轮总结
        </label>
        <Textarea
          id={`grading-summary-${attemptId}-${roundNo}`}
          value={values.summary}
          readOnly={!editable}
          disabled={busy || confirming !== null}
          maxLength={5000}
          rows={4}
          aria-invalid={!!errors.summary}
          aria-describedby={errors.summary ? 'grading-summary-error' : undefined}
          onChange={(event) =>
            setValues((current) => ({ ...current, summary: event.target.value }))
          }
        />
        {errors.summary && (
          <p id="grading-summary-error" className="text-xs text-destructive">
            {errors.summary}
          </p>
        )}
        {editable && (
          <p className="text-xs text-muted-foreground">
            判定预览：{preview === null ? '请完成全部题目判定' : `${preview}分`}
            。提交后以服务端本轮得分为准。
          </p>
        )}
      </div>
      {compensating && (
        <div className="space-y-2">
          <label htmlFor={`grading-reason-${attemptId}-${roundNo}`} className="text-sm font-medium">
            补偿原因
          </label>
          <Textarea
            id={`grading-reason-${attemptId}-${roundNo}`}
            value={values.compensationReason}
            maxLength={1000}
            rows={3}
            disabled={disabled}
            aria-required
            aria-invalid={!!errors.compensationReason}
            aria-describedby={errors.compensationReason ? 'grading-reason-error' : undefined}
            onChange={(event) =>
              setValues((current) => ({ ...current, compensationReason: event.target.value }))
            }
          />
          {errors.compensationReason && (
            <p id="grading-reason-error" className="text-xs text-destructive">
              {errors.compensationReason}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        {actions.retry && !compensating && (
          <Button
            variant="outline"
            size="account"
            disabled={busy || !!lock || confirming !== null}
            onClick={() => confirm('retry')}
          >
            重试模拟阅卷
          </Button>
        )}
        {actions.compensate && (
          <Button
            variant={compensating ? 'default' : 'outline'}
            size="account"
            disabled={busy || !!lock || confirming !== null}
            onClick={() => {
              if (compensating) confirm('compensate');
              else setCompensating(true);
            }}
          >
            人工补偿
          </Button>
        )}
        {actions.manual && (
          <Button
            size="account"
            disabled={busy || !!lock || confirming !== null}
            onClick={() => confirm('manual')}
          >
            提交人工阅卷
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={confirmLabel[confirming]}
          className="space-y-4 rounded-xl border bg-accent p-4"
        >
          <h4 className="font-semibold">{confirmLabel[confirming]}</h4>
          <p className="text-sm">
            {confirming === 'retry'
              ? '本次仅重试当前失败轮次的模拟阅卷。'
              : confirming === 'compensate'
                ? '将用当前逐题判定补偿本轮结果，并由服务端重新汇总最终准入状态。'
                : '确认提交全部题目的判定与本轮总结？提交后不能再次修改本轮人工阅卷。'}
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="outline"
              size="account"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              取消
            </Button>
            <Button size="account" loading={busy} disabled={busy} onClick={() => void submit()}>
              {confirming === 'retry' ? '确认重试' : '确认提交'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
