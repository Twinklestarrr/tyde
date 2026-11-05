import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type ExpertTask,
  type EntranceExamCandidatePaper,
  type EntranceExamCandidateStatus,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { EntranceExamFiles } from './EntranceExamFiles';
import { EntranceExamText } from './EntranceExamText';
import { StrategistExamFiles } from './StrategistExamFiles';
import {
  expertExamDeadline,
  expertExamSubmission,
  type ExpertExamAnswer,
} from './expert-exam-form';

const statusLabels: Record<EntranceExamCandidateStatus, string> = {
  NOT_EXAMINED: '未参加考试',
  NOT_PASSED: '尚未取得通过结果',
  PENDING: '等待阅卷',
  PASSED: '已通过准入考试',
};
const currentKey = (userId: string, projectId: number) =>
  ['exam-candidate-current', userId, 'EXPERT', projectId] as const;
export const EXPERT_EXAM_LEAVE_REQUEST = 'tyde:before-expert-exam-leave';

/** 此接口只提供准入聚合状态，不把答题中、取消或落榜混成一个确定结论。 */
export function ExpertExamStatus({ user, projectId }: { user: AuthUser; projectId: number }) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: currentKey(user.id, projectId),
    queryFn: async () => {
      const result = await api.getEntranceExamCandidateCurrent(projectId);
      const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      if (current?.id !== user.id || (current.selectedRole ?? current.role) !== 'EXPERT')
        throw new Error('登录身份已变化，请重新读取。');
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <section aria-label="本人准入考试状态" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium">准入考试状态</h4>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新考试状态
        </Button>
      </div>
      {query.isPending && <p role="status">正在读取考试状态…</p>}
      <ErrorNotice error={query.error} />
      {query.data && <p role="status">{statusLabels[query.data.status]}</p>}
      {query.data?.status === 'NOT_PASSED' && (
        <p className="text-xs leading-5 text-muted-foreground">
          此状态也可能表示仍在答题或已取消考试，不能据此判断为落榜。
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        通过考试后仍需确认入项安排；考试操作从工作台当前待办进入。
      </p>
    </section>
  );
}

type ExamLock = 'unknown' | 'conflict' | 'access' | 'submitted' | 'cancelled' | 'resolved' | null;
interface ExamDraft {
  paper: EntranceExamCandidatePaper | null;
  answers: Record<number, ExpertExamAnswer>;
  integrity: boolean;
  lock: ExamLock;
  notice: string;
}

/** 同一来源的草稿与未知写入锁保留在内存缓存，关闭弹框不重发命令。 */
export function ExpertExamPanel({
  user,
  task,
  onChanged,
  onCancelled,
}: {
  user: AuthUser;
  task: ExpertTask;
  onChanged: () => Promise<unknown>;
  onCancelled?: () => Promise<unknown>;
}) {
  const cache = useQueryClient();
  const key = [
    'expert-exam-draft',
    user.id,
    'EXPERT',
    task.basicInfo.projectId,
    task.sourceBizType,
    task.sourceBizId,
  ];
  const retained = useQuery<ExamDraft>({
    queryKey: key,
    queryFn: async () => ({ paper: null, answers: {}, integrity: false, lock: null, notice: '' }),
    initialData: () => ({ paper: null, answers: {}, integrity: false, lock: null, notice: '' }),
    enabled: false,
    gcTime: Infinity,
  });
  // 受控输入同步更新；缓存只负责弹框/页面切换后的内存保留。
  const [draft, setDraft] = useState(retained.data);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'submit' | 'cancel' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const working = useRef(false);
  const { paper, lock } = draft;
  const projectId = task.basicInfo.projectId;
  const uploading = Object.values(draft.answers).some((answer) =>
    answer.files.some((file) => file.status === 'uploading'),
  );
  const dirty =
    Object.values(draft.answers).some((answer) => answer.text.length || answer.files.length) &&
    !['submitted', 'cancelled'].includes(lock ?? '');
  const deadline = paper ? expertExamDeadline(paper.answerDeadlineAt) : null;
  const expired = deadline !== null && now >= deadline;
  const current = useQuery({
    queryKey: currentKey(user.id, projectId),
    queryFn: async () => {
      requireIdentity();
      const result = await api.getEntranceExamCandidateCurrent(projectId);
      requireIdentity();
      return result;
    },
    enabled: open,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const accessDenied =
    current.error instanceof ApiError && [401, 403, 404].includes(current.error.status);
  const resultAvailable = current.data && ['PENDING', 'PASSED'].includes(current.data.status);
  const disabled =
    busy ||
    uploading ||
    !!lock ||
    expired ||
    accessDenied ||
    !!resultAvailable ||
    current.isFetching;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || !paper) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, paper]);
  useEffect(() => {
    const leave = (event: Event) => {
      if (
        working.current ||
        uploading ||
        (dirty && !window.confirm('未提交的答案仅保存在当前页面，离开后可能丢失，确认离开？'))
      )
        event.preventDefault();
    };
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    window.addEventListener(EXPERT_EXAM_LEAVE_REQUEST, leave);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
      window.removeEventListener(EXPERT_EXAM_LEAVE_REQUEST, leave);
    };
  }, [dirty, uploading]);
  useBlocker({
    shouldBlockFn: () =>
      sessionMatches() &&
      (working.current ||
        uploading ||
        (dirty && !window.confirm('未提交的答案仅保存在当前页面，离开后可能丢失，确认离开？'))),
    enableBeforeUnload: () => working.current || uploading || dirty,
  });

  function sameIdentity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === 'EXPERT';
  }
  function sessionMatches() {
    return mounted.current && sameIdentity();
  }
  function requireIdentity() {
    if (!sameIdentity()) throw new Error('登录身份已变化，请重新打开工作台。');
  }
  function requireSession() {
    if (!sessionMatches()) throw new Error('登录身份已变化，请重新打开工作台。');
  }
  function update(change: Partial<ExamDraft> | ((state: ExamDraft) => ExamDraft)) {
    if (!sessionMatches()) return;
    const state = cache.getQueryData<ExamDraft>(key) ?? draft;
    const next = typeof change === 'function' ? change(state) : { ...state, ...change };
    cache.setQueryData(key, next);
    setDraft(next);
  }
  function failure(value: unknown, write = false) {
    if (!sessionMatches()) return;
    setError(value);
    if (value instanceof ApiError && [401, 403, 404].includes(value.status)) {
      update({ lock: 'access' });
      if (value.status === 401) void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } else if (
      write &&
      (!(value instanceof ApiError) || value.status === 0 || value.status >= 500)
    ) {
      update({ lock: 'unknown', notice: '提交结果尚未确认，请先核实考试状态。' });
    } else if (write && value instanceof ApiError && [400, 409].includes(value.status)) {
      update({ lock: 'conflict', notice: '考试状态已变化，请先核实考试状态，系统不会重复提交。' });
    }
  }
  async function enter() {
    if (working.current || uploading) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      requireSession();
      // 先核对完整待办的来源，不能借同项目另一身份恢复或开始考试。
      const tasks = await api.getMyExpertTasks();
      requireSession();
      if (
        !tasks.some(
          (item) =>
            item.sourceBizType === task.sourceBizType &&
            item.sourceBizId === task.sourceBizId &&
            item.basicInfo.projectId === projectId &&
            item.acceptanceStatus === 'ACCEPTED' &&
            item.branchNodeCode === 'ENTRANCE_EXAM',
        )
      ) {
        update({ lock: 'access' });
        throw new Error('当前来源已无可参加的考试待办，请刷新项目。');
      }
      const result = await api.enterEntranceExam(projectId);
      requireSession();
      if (
        paper &&
        (result.attemptId !== paper.attemptId ||
          result.examVersionId !== paper.examVersionId ||
          result.paperId !== paper.paperId)
      ) {
        update({ lock: 'access' });
        throw new Error('应试身份或试卷已变化，已保留原答案，请重新核对项目身份。');
      }
      update((state) => ({
        ...state,
        paper: result,
        lock: null,
        notice: '',
        answers: state.paper
          ? state.answers
          : Object.fromEntries(
              result.questions.map((question) => [question.questionId, { text: '', files: [] }]),
            ),
      }));
      setNow(Date.now());
      await cache.invalidateQueries({ queryKey: currentKey(user.id, projectId) });
    } catch (value) {
      failure(value);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function verify() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await current.refetch({ throwOnError: true });
      requireSession();
      if (result.data && ['PENDING', 'PASSED'].includes(result.data.status)) {
        // 聚合结果并未证明某次写入成功；保留草稿，只关闭重复写入入口。
        update({
          lock: 'resolved',
          notice: `当前准入状态：${statusLabels[result.data.status]}。已暂停交卷与取消操作。`,
        });
      } else
        update({
          notice: '当前状态无法确认上次操作。可恢复原试卷核实，系统不会自动重发交卷或取消。',
        });
    } catch (value) {
      failure(value);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function requestSubmit() {
    if (!paper || disabled) return;
    const checked = expertExamSubmission(paper, draft.answers, draft.integrity);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) {
      const target = paper.questions.find((question) => checked.errors[question.questionId]);
      window.requestAnimationFrame(() =>
        document
          .getElementById(target ? `expert-answer-${target.questionId}` : 'expert-exam-integrity')
          ?.focus(),
      );
      return;
    }
    setConfirming('submit');
  }
  async function write(kind: 'submit' | 'cancel') {
    if (
      !paper ||
      lock ||
      accessDenied ||
      resultAvailable ||
      current.isFetching ||
      working.current ||
      uploading ||
      (kind === 'submit' && expired)
    )
      return;
    const checked = expertExamSubmission(paper, draft.answers, draft.integrity);
    if (kind === 'submit' && Object.keys(checked.errors).length) {
      setErrors(checked.errors);
      setConfirming(null);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    let cancelled = false;
    try {
      requireSession();
      if (kind === 'submit') await api.submitEntranceExam(checked.input);
      else await api.cancelEntranceExam({ projectId, attemptId: paper.attemptId });
      requireSession();
      update({
        lock: kind === 'submit' ? 'submitted' : 'cancelled',
        ...(kind === 'cancel' ? { paper: null, answers: {}, integrity: false } : {}),
        notice: kind === 'submit' ? '答卷已提交，等待阅卷。' : '考试已取消，无法再次入场。',
      });
      cancelled = kind === 'cancel';
      await Promise.allSettled([
        cache.invalidateQueries({ queryKey: currentKey(user.id, projectId) }),
        cache.invalidateQueries({ queryKey: ['profile-workbench', user.id], refetchType: 'none' }),
      ]);
    } catch (value) {
      failure(value, true);
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        setConfirming(null);
      }
    }
    if (cancelled && sessionMatches()) {
      setOpen(false);
      try {
        await (onCancelled ?? onChanged)();
      } catch (value) {
        failure(value);
      }
    }
  }
  function close() {
    if (working.current || uploading) return;
    setOpen(false);
    if (
      ['submitted', 'cancelled'].includes(lock ?? '') ||
      (!dirty && (resultAvailable || lock === 'access'))
    )
      void onChanged();
  }
  const seconds = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const canEnter = !paper && !lock && current.isSuccess && !current.isFetching && !resultAvailable;
  return (
    <>
      <Card asChild>
        <section aria-label="准入考试待办" className="space-y-4 p-5">
          <CardTitle asChild>
            <h2>准入考试</h2>
          </CardTitle>
          <p className="text-[13px] leading-6 text-muted-foreground">
            从当前接单身份进入考试。入场后按原试卷作答，交卷后等待阅卷与入项安排。
          </p>
          <Button size="mobileTouch" onClick={() => setOpen(true)}>
            参加准入考试
          </Button>
        </section>
      </Card>
      {open && (
        <Dialog
          title="参加准入考试"
          aria-label="参加准入考试"
          closeLabel="关闭考试"
          size="xl"
          busy={busy || uploading}
          onClose={close}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy || uploading}
                onClick={close}
              >
                暂时关闭
              </Button>
              {paper && !lock && !accessDenied && !resultAvailable && (
                <>
                  <Button
                    variant="destructiveOutline"
                    size="mobileTouch"
                    disabled={busy || uploading}
                    onClick={() => setConfirming('cancel')}
                  >
                    取消考试
                  </Button>
                  <Button
                    size="mobileTouch"
                    disabled={disabled || !draft.integrity}
                    onClick={requestSubmit}
                  >
                    提交答卷
                  </Button>
                </>
              )}
            </>
          }
        >
          <p className="text-[13px] leading-6 text-muted-foreground">
            临时答案仅保留在当前页面内存中，关闭弹框可继续作答；刷新页面或离开后可能丢失。关闭弹框不会取消考试。
          </p>
          {current.isPending && <p role="status">正在读取考试状态…</p>}
          <ErrorNotice error={current.error} />
          <ErrorNotice error={error} />
          {draft.notice && <Alert role="status">{draft.notice}</Alert>}
          {current.data && <p role="status">当前准入状态：{statusLabels[current.data.status]}</p>}
          {paper && !lock && resultAvailable && (
            <Alert>
              当前准入状态已进入阅卷或通过阶段，已暂停交卷与取消，原临时答案仍保留在本页面。
            </Alert>
          )}
          {!paper && (
            <>
              <p className="text-[13px] leading-6">
                点击开始或恢复答题后，由服务端分配原试卷。首次入场即开始计时，取消或交卷后不能重考。
              </p>
              {current.data?.status === 'NOT_PASSED' && (
                <p className="text-[13px] text-muted-foreground">
                  尚未取得通过结果也可能表示已入场或已取消；恢复答题时会核对当前应试资格。
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {canEnter && (
                  <Button size="mobileTouch" loading={busy} onClick={() => void enter()}>
                    {current.data.status === 'NOT_EXAMINED' ? '开始考试' : '恢复答题'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="mobileTouch"
                  loading={busy || current.isFetching}
                  onClick={() => void current.refetch()}
                >
                  重新读取考试状态
                </Button>
              </div>
            </>
          )}
          {(lock === 'unknown' || lock === 'conflict') && (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                size="mobileTouch"
                loading={busy}
                onClick={() => void verify()}
              >
                <RefreshCw className="size-4" aria-hidden />
                核实考试状态
              </Button>
              {paper && !resultAvailable && (
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={busy}
                  onClick={() => void enter()}
                >
                  恢复答题
                </Button>
              )}
            </div>
          )}
          {paper && (
            <>
              <header className="space-y-3 border-b pb-5">
                <h3 className="text-base font-semibold">{paper.examName}</h3>
                <p className="text-xs text-muted-foreground">已绑定历史试卷</p>
                <p className="text-[13px] text-muted-foreground">
                  {paper.paperName || '准入试卷'} · 共{paper.questions.length}题 · 满分
                  {paper.fullScore}分
                </p>
                <p className="text-[13px]">首次入场：{paper.enteredAt}（上海时间）</p>
                <p className="text-[13px]">
                  {paper.answerDeadlineAt
                    ? `答题截止：${paper.answerDeadlineAt}（上海时间）`
                    : '答题不限时'}
                </p>
                {expired && !lock && <Alert>答题时间已结束，无法交卷；可以取消考试离场。</Alert>}
              </header>
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="min-w-0 space-y-5">
                  {paper.questions.map((question) => {
                    const answer = draft.answers[question.questionId] ?? { text: '', files: [] };
                    const label = `第${question.sequenceNo}题答案`;
                    return (
                      <section
                        key={question.questionId}
                        id={`expert-exam-question-${question.questionId}`}
                        aria-label={`第${question.sequenceNo}题`}
                        className="space-y-4 border-b pb-5"
                      >
                        <h4 className="text-sm font-medium">
                          第{question.sequenceNo}题 · {question.requiredFlag ? '必答' : '选答'} ·{' '}
                          {question.score}分
                        </h4>
                        <EntranceExamText value={question.questionContent} empty="请查看题干附件" />
                        <EntranceExamFiles
                          value={question.questionFiles}
                          label={`第${question.sequenceNo}题题干附件`}
                        />
                        <div className="space-y-2">
                          <label
                            htmlFor={`expert-answer-${question.questionId}`}
                            className="text-[13px] font-medium"
                          >
                            {label}
                          </label>
                          <Textarea
                            id={`expert-answer-${question.questionId}`}
                            rows={5}
                            maxLength={100000}
                            value={answer.text}
                            disabled={disabled}
                            aria-invalid={!!errors[question.questionId]}
                            aria-describedby={
                              errors[question.questionId]
                                ? `expert-answer-error-${question.questionId}`
                                : undefined
                            }
                            onChange={(event) =>
                              update((state) => ({
                                ...state,
                                answers: {
                                  ...state.answers,
                                  [question.questionId]: {
                                    ...(state.answers[question.questionId] ?? {
                                      text: '',
                                      files: [],
                                    }),
                                    text: event.target.value,
                                  },
                                },
                              }))
                            }
                          />
                          {errors[question.questionId] && (
                            <p
                              id={`expert-answer-error-${question.questionId}`}
                              role="alert"
                              className="text-xs text-destructive"
                            >
                              {errors[question.questionId]}
                            </p>
                          )}
                        </div>
                        <StrategistExamFiles
                          label={`${label}附件`}
                          files={answer.files}
                          limit={10}
                          disabled={disabled}
                          user={user}
                          role="EXPERT"
                          onChange={(change) =>
                            update((state) => ({
                              ...state,
                              answers: {
                                ...state.answers,
                                [question.questionId]: {
                                  ...(state.answers[question.questionId] ?? {
                                    text: '',
                                    files: [],
                                  }),
                                  files: change(state.answers[question.questionId]?.files ?? []),
                                },
                              },
                            }))
                          }
                        />
                      </section>
                    );
                  })}
                </div>
                <aside
                  aria-label="答题进度"
                  className="space-y-4 rounded-xl border bg-muted/30 p-4 lg:sticky lg:top-0"
                >
                  <h4 className="text-sm font-semibold">答题进度</h4>
                  {seconds !== null && !lock ? (
                    <p
                      role="timer"
                      aria-label="剩余答题时间"
                      className="font-mono text-sm text-primary"
                    >
                      剩余 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {paper.answerDeadlineAt ? '考试已结束' : '答题不限时'}
                    </p>
                  )}
                  <div className="grid grid-cols-4 gap-2">
                    {paper.questions.map((question) => {
                      const answer = draft.answers[question.questionId];
                      const answered =
                        !!answer?.text.trim() ||
                        !!answer?.files.some((file) => file.status === 'ready');
                      return (
                        <button
                          key={question.questionId}
                          type="button"
                          aria-label={`第${question.sequenceNo}题${answered ? '已作答' : '未作答'}`}
                          className={`min-h-10 rounded-md border text-sm ${answered ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'bg-background text-muted-foreground'}`}
                          onClick={() =>
                            document
                              .getElementById(`expert-exam-question-${question.questionId}`)
                              ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                          }
                        >
                          {question.sequenceNo}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    已作答{' '}
                    {
                      paper.questions.filter((question) => {
                        const answer = draft.answers[question.questionId];
                        return (
                          !!answer?.text.trim() ||
                          !!answer?.files.some((file) => file.status === 'ready')
                        );
                      }).length
                    }{' '}
                    / {paper.questions.length} 题
                  </p>
                </aside>
              </div>
              <div className="space-y-2">
                <label className="flex min-h-11 items-start gap-3 text-[13px] leading-6">
                  <input
                    id="expert-exam-integrity"
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={draft.integrity}
                    disabled={disabled}
                    aria-invalid={!!errors.integrity}
                    aria-describedby={errors.integrity ? 'expert-exam-integrity-error' : undefined}
                    onChange={(event) => update({ integrity: event.target.checked })}
                  />
                  我承诺独立完成作答，并确认提交后不可修改。
                </label>
                {errors.integrity && (
                  <p
                    id="expert-exam-integrity-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {errors.integrity}
                  </p>
                )}
                {errors.form && <Alert variant="destructive">{errors.form}</Alert>}
              </div>
            </>
          )}
        </Dialog>
      )}
      {open && confirming && (
        <Dialog
          title={confirming === 'submit' ? '确认交卷' : '确认取消考试'}
          aria-label={confirming === 'submit' ? '确认交卷' : '确认取消考试'}
          size="sm"
          busy={busy}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                继续作答
              </Button>
              <Button
                variant={confirming === 'cancel' ? 'destructive' : 'default'}
                size="mobileTouch"
                loading={busy}
                disabled={confirming === 'submit' && expired}
                onClick={() => void write(confirming)}
              >
                {confirming === 'submit' ? '确认交卷' : '确认取消考试'}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            {confirming === 'submit'
              ? '交卷后无法修改答案或重新参加本次考试，请确认已完成检查。'
              : '取消后不会保存临时答案，且无法再次进入本次考试。确认离场？'}
          </p>
        </Dialog>
      )}
    </>
  );
}
