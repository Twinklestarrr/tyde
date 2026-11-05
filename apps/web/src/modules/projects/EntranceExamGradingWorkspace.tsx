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
import { Dialog } from '@/components/ui/dialog';
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
  entranceExamGradingFailureIsUnknown,
  entranceExamGradingInput,
  entranceExamGradingPreview,
  entranceExamGradingSourceMatches,
  entranceExamGradingValues,
  type EntranceExamGradingValues,
} from './entrance-exam-grading';

interface EntranceExamGradingWorkspaceProps {
  user: AuthUser;
  projectId: number;
  examId: number;
  attemptId: number;
  canManage: boolean;
  candidateUserId?: string;
  role?: 'PM' | 'NAVIGATOR';
  onChanged: (written?: boolean) => Promise<void>;
  onBack: () => void;
}

type Write =
  | { kind: 'manual'; input: EntranceExamManualGradingInput }
  | { kind: 'retry'; input: EntranceExamAutoRetryInput }
  | { kind: 'compensate'; input: EntranceExamAutoCompensateInput };
type Lock = 'unknown' | 'conflict' | 'success' | 'access';
interface GradingWrite {
  id: string;
  originRole: 'PM' | 'NAVIGATOR';
  status: Lock;
  write: Write;
  values: EntranceExamGradingValues;
}
// 读取缓存可按角色清空，未核实命令仍按账号和真实判卷记录互斥；刷新不持久化。
const pendingWrites = new Map<string, GradingWrite>();

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
    props.role ?? 'PM',
    props.projectId,
    props.examId,
    props.attemptId,
    roundNo,
  ] as const;
}

/** 正文由名单所在弹框承载；每个轮次均读取本次应试绑定的历史试卷。 */
export function EntranceExamGradingWorkspace(props: EntranceExamGradingWorkspaceProps) {
  const cache = useQueryClient();
  const role = props.role ?? 'PM';
  function requireSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== props.user.id || (current.selectedRole ?? current.role) !== role)
      throw new Error('当前身份已变化，请重新打开阅卷详情。');
  }
  const [roundNo, setRoundNo] = useState(1);
  const query = useQuery({
    queryKey: gradingKey(props, roundNo),
    queryFn: async () => {
      requireSession();
      const result = await api.getEntranceExamGradingDetail({
        projectId: props.projectId,
        examId: props.examId,
        attemptId: props.attemptId,
        roundNo,
      });
      requireSession();
      return result;
    },
    enabled: (props.user.selectedRole ?? props.user.role) === role,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if ((props.user.selectedRole ?? props.user.role) !== role) return null;
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
      key={`${props.user.id}:${role}:${props.projectId}:${props.examId}:${props.attemptId}:${roundNo}`}
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
  const role = props.role ?? 'PM';
  const round = detail.selectedRound;
  const recordId = round.gradingRecordId;
  const writeKey = JSON.stringify([user.id, recordId]);
  const lockKey = ['entrance-exam-grading-write', user.id, role, recordId];
  const retained = useQuery<GradingWrite | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: () => pendingWrites.get(writeKey) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  const pending = retained.data;
  const foreignLock = !!pending && pending.originRole !== role;
  const lock = pending?.status;
  const [values, setValues] = useState(() =>
    pending && !foreignLock ? pending.values : entranceExamGradingValues(detail),
  );
  const initial = useRef(JSON.stringify(values));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [compensating, setCompensating] = useState(false);
  const [confirming, setConfirming] = useState<Write['kind'] | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const allowLeave = useRef(false);
  const actions = entranceExamGradingActions(detail, canManage, role);
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
  const accessDenied = readError instanceof ApiError && [401, 403, 404].includes(readError.status);
  const editable =
    (actions.manual || (compensating && actions.compensate)) && !lock && !accessDenied;
  const disabled = !editable || busy || confirming !== null;
  const dirty = !lock && JSON.stringify(values) !== initial.current;
  const preview = entranceExamGradingPreview(detail, values);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function sameIdentity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return current?.id === user.id && (current.selectedRole ?? current.role) === role;
  }
  function sessionMatches() {
    return mounted.current && sameIdentity();
  }
  function requireSession() {
    if (!sessionMatches()) throw new Error('当前身份已变化，请重新打开阅卷详情。');
  }
  function mayLeave(message = '未提交的阅卷内容将会丢失，确认离开？') {
    return allowLeave.current || (!working.current && (!dirty || window.confirm(message)));
  }
  useEffect(() => {
    function beforeLeave(event: Event) {
      if (sameIdentity() && !mayLeave()) event.preventDefault();
    }
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    window.addEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
      window.removeEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, beforeLeave);
    };
  }, [dirty, role, user.id]);
  useBlocker({
    shouldBlockFn: () => sameIdentity() && !mayLeave(),
    enableBeforeUnload: () => sameIdentity() && !allowLeave.current && (working.current || dirty),
  });
  function requireOrigin() {
    const state = pendingWrites.get(writeKey);
    if (state && state.originRole !== role)
      throw new Error('本轮存在其他角色的待核实阅卷，请切回原角色核实；不能换角色清锁或重复提交。');
  }
  function setPending(next: GradingWrite | null, expectedId?: string) {
    if (recordId === null) return;
    const previous = pendingWrites.get(writeKey);
    if (expectedId && previous?.id !== expectedId) return;
    if (previous && previous.originRole !== role) return;
    if (next) pendingWrites.set(writeKey, next);
    else pendingWrites.delete(writeKey);
    cache.setQueryData(lockKey, next);
    cache.setQueriesData(
      {
        queryKey: ['entrance-exam-grading-write', user.id],
        predicate: (query) => query.queryKey[3] === recordId,
      },
      next,
    );
  }
  async function freshDetail() {
    requireSession();
    const result = await api.getEntranceExamGradingDetail({
      projectId,
      examId,
      attemptId,
      roundNo,
    });
    requireSession();
    return result;
  }
  async function readFresh() {
    const previous = pendingWrites.get(writeKey);
    if (previous?.originRole !== undefined && previous.originRole !== role) {
      const result = await freshDetail();
      cache.setQueryData(gradingKey(props, roundNo), result);
      requireOrigin();
      return;
    }
    if (previous?.status === 'success') {
      allowLeave.current = true;
      try {
        await props.onChanged(true);
        if (!sameIdentity()) return;
        if (mounted.current) {
          const result = await freshDetail();
          cache.setQueryData(gradingKey(props, roundNo), result);
          const next = entranceExamGradingValues(result);
          initial.current = JSON.stringify(next);
          setValues(next);
        }
        setPending(null, previous.id);
        if (sessionMatches()) {
          setCompensating(false);
          setConfirming(null);
          setErrors({});
          setError(null);
          setReadError(null);
          setNotice('已读取最新阅卷状态，请核对本轮与最终准入结果。');
        }
      } finally {
        allowLeave.current = false;
      }
      return;
    }
    const result = await freshDetail();
    cache.setQueryData(gradingKey(props, roundNo), result);
    if (previous?.status === 'unknown') {
      setNotice('已读取当前轮次，上次命令结果仍无法精确确认；原阅卷内容保留，继续暂停重发。');
      return;
    }
    if (previous) {
      allowLeave.current = true;
      try {
        await props.onChanged();
        if (!sameIdentity()) return;
        requireOrigin();
        setPending(null, previous.id);
      } finally {
        allowLeave.current = false;
      }
    } else {
      const next = entranceExamGradingValues(result);
      initial.current = JSON.stringify(next);
      setValues(next);
    }
    if (sessionMatches()) {
      setCompensating(false);
      setConfirming(null);
      setErrors({});
      setError(null);
      setReadError(null);
      setNotice('已读取最新阅卷状态，请核对本轮与最终准入结果。');
    }
  }
  async function reread() {
    if (reading || working.current || !sessionMatches()) return;
    if (!mayLeave('重新读取将替换未提交的阅卷内容，确认继续？')) return;
    working.current = true;
    setReading(true);
    setReadError(null);
    try {
      await readFresh();
    } catch (failure) {
      if (sessionMatches()) setReadError(failure);
    } finally {
      working.current = false;
      allowLeave.current = false;
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
    const write: Write =
      kind === 'manual'
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
    if (
      write.kind === 'manual' &&
      new TextEncoder().encode(JSON.stringify(write.input)).byteLength > 16 * 1024
    ) {
      setError(new Error('阅卷内容超过当前可提交大小，请缩短阅卷意见或本轮总结后重试。'));
      return null;
    }
    return write;
  }

  function permitted(kind: Write['kind']) {
    return (
      !pendingWrites.has(writeKey) &&
      !accessDenied &&
      (kind === 'manual' ? actions.manual : kind === 'retry' ? actions.retry : actions.compensate)
    );
  }

  function confirm(kind: Write['kind']) {
    if (working.current || !sessionMatches() || !permitted(kind)) return;
    setError(null);
    if (!payload(kind)) return;
    setConfirming(kind);
  }

  /** 先重读同一绑定来源；写前保留原稿，角色切换或回读失败均不能再次发送。 */
  async function submit() {
    if (!confirming || working.current || !sessionMatches() || !permitted(confirming)) return;
    const write = payload(confirming);
    if (!write) {
      setConfirming(null);
      return;
    }
    working.current = true;
    setReading(true);
    setError(null);
    setReadError(null);
    setNotice('');
    let state: GradingWrite | undefined;
    let written = false;
    try {
      requireOrigin();
      const latest = await freshDetail();
      if (!entranceExamGradingSourceMatches(detail, latest))
        throw new Error('应试绑定轮次、记录或题目已变化，请重新读取阅卷状态。');
      const latestActions = entranceExamGradingActions(latest, canManage, role);
      const eligible =
        write.kind === 'manual'
          ? latestActions.manual
          : write.kind === 'retry'
            ? latestActions.retry
            : latestActions.compensate;
      if (!eligible) throw new Error('本轮状态或阅卷资格已变化，请重新读取阅卷状态。');
      requireSession();
      if (pendingWrites.has(writeKey)) return;
      state = {
        id: crypto.randomUUID(),
        originRole: role,
        status: 'unknown',
        write,
        values: structuredClone(values),
      };
      setPending(state);
      await mutation.mutateAsync(write);
      written = true;
      setPending({ ...state, status: 'success' }, state.id);
      if (!sessionMatches()) return;
      initial.current = JSON.stringify(values);
      setConfirming(null);
      setNotice(
        write.kind === 'retry'
          ? '模拟阅卷重试已提交，正在读取最新结果。'
          : '阅卷结果已提交，正在读取最新结果。',
      );
      await readFresh();
    } catch (failure) {
      if (state && !written) {
        const unknown = entranceExamGradingFailureIsUnknown(failure);
        setPending(
          {
            ...state,
            status: unknown
              ? 'unknown'
              : failure instanceof ApiError && [401, 403, 404].includes(failure.status)
                ? 'access'
                : 'conflict',
          },
          state.id,
        );
      }
      if (sessionMatches()) {
        if (written) {
          setReadError(failure);
          setNotice('操作已成功提交，最新状态读取失败。请重新读取阅卷状态，不能重复提交。');
        } else setError(failure);
      }
    } finally {
      working.current = false;
      allowLeave.current = false;
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
          {props.candidateUserId && (
            <p className="mt-1 break-all text-xs text-muted-foreground">
              用户 ID：{props.candidateUserId}
            </p>
          )}

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
          {(round.status && statusLabel[round.status]) || '状态待确认'}
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
      {role === 'NAVIGATOR' && !actions.manual && (
        <Alert>当前仅可查看绑定的历史阅卷；人工提交须匹配本人当前可核实的配置轮次资格。</Alert>
      )}
      {role === 'PM' && !canManage && (
        <Alert>
          当前人工阅卷资格由提交接口核验；考试配置、自动阅卷重试与补偿仍由主策略官维护。
        </Alert>
      )}
      {!actions.previousComplete && <Alert>前轮阅卷尚未全部完成，本轮暂不可操作。</Alert>}
      {round.status === 'WAITING' && <Alert>本轮正在等待前轮完成，请稍后重新读取阅卷状态。</Alert>}
      {round.gradingMode === 'AUTO' && (
        <Alert>
          {role === 'PM'
            ? '自动阅卷使用现有模拟处理接口。失败时可重试模拟阅卷，或填写原因进行人工补偿。'
            : '自动阅卷轮次仅可查看；领航员不开放重试或人工补偿。'}
        </Alert>
      )}
      {actions.manual && !lock && (
        <p className="text-xs text-muted-foreground">
          请逐题判定；本轮阅卷人资格在提交时由服务端核验。
        </p>
      )}
      {lock && (
        <Alert>
          {foreignLock
            ? '本轮存在其他角色的待核实操作，请切回原角色核实；当前不展示原稿，也不能清锁或重发。'
            : lock === 'success'
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
        <Dialog
          role="alertdialog"
          aria-label={confirmLabel[confirming]}
          title={confirmLabel[confirming]}
          size="sm"
          busy={busy}
          onClose={() => setConfirming(null)}
          footer={
            <>
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
            </>
          }
        >
          <p className="text-[13px] leading-5 text-muted-foreground">
            {confirming === 'retry'
              ? '本次仅重试当前失败轮次的模拟阅卷。'
              : confirming === 'compensate'
                ? '将用当前逐题判定补偿本轮结果，并由服务端重新汇总最终准入状态。'
                : '确认提交全部题目的判定与本轮总结？提交后不能再次修改本轮人工阅卷。'}
          </p>
        </Dialog>
      )}
    </section>
  );
}
