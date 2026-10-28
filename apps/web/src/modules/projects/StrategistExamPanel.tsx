import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type EntranceExamCard,
  type EntranceExamConfigInput,
  type EntranceExamEditInput,
  type EntranceExamConfiguration,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ErrorNotice } from '@/components/ErrorNotice';
import { EntranceExamDialog, ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { EntranceExamAdmissions, EntranceExamRoster } from './EntranceExamRosterViews';
import { EntranceExamConfigurationView } from './EntranceExamConfigurationView';
import { EntranceExamGradingWorkspace } from './EntranceExamGradingWorkspace';
import { StrategistExamEditor } from './StrategistExamEditor';

type Editor = { kind: 'create' } | { kind: 'edit'; config: EntranceExamConfiguration };
interface WriteLock {
  status: 'unknown' | 'conflict' | 'access' | 'success';
  source: 'create' | 'edit' | 'close';
  examId?: number;
  examName?: string;
}

/** PM准入考试管理；只调用现有接口，协作只读，轮次及入项真值均由后端提供。 */
export function StrategistExamPanel({
  user,
  projectId,
  projectName,
  onChanged,
}: {
  user: AuthUser;
  projectId: number;
  projectName: string;
  onChanged: () => Promise<void>;
}) {
  const cache = useQueryClient();
  const isPm = (user.selectedRole ?? user.role) === 'PM';
  const scope = ['entrance-exams', user.id, 'PM', projectId] as const;
  const lockKey = [...scope, 'write-lock'];
  const lockState = useQuery<WriteLock | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const lock = lockState.data;
  const setLock = (value: WriteLock | null) => cache.setQueryData(lockKey, value);
  const management = useQuery({
    queryKey: [...scope, 'management'],
    queryFn: () => api.getEntranceExamManagement(projectId),
    enabled: isPm,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // canCreateExam还受数量/计划影响；候选接口明确要求当前主PM，用它核验管理身份。
  const reviewers = useQuery({
    queryKey: [...scope, 'reviewers'],
    queryFn: () => api.listEntranceExamReviewers(projectId),
    enabled: isPm,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [view, setView] = useState('admission');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [configuration, setConfiguration] = useState<EntranceExamConfiguration | null>(null);
  const [workspace, setWorkspace] = useState<{ exam: EntranceExamCard; attemptId?: number } | null>(
    null,
  );
  const [closing, setClosing] = useState<{ exam: EntranceExamCard; reason: string } | null>(null);
  const [loadingConfig, setLoadingConfig] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const writing = useRef(false);
  const save = useMutation({
    mutationFn: (input: EntranceExamConfigInput | EntranceExamEditInput) =>
      'examId' in input ? api.editEntranceExam(input) : api.publishEntranceExam(input),
    retry: false,
    networkMode: 'always',
  });
  const close = useMutation({
    mutationFn: (input: { examId: number; closeReason: string }) =>
      api.closeEntranceExam({ projectId, ...input }),
    retry: false,
    networkMode: 'always',
  });
  const busy = save.isPending || close.isPending;
  const canManage =
    isPm &&
    management.isSuccess &&
    !management.isFetching &&
    !management.isError &&
    reviewers.isSuccess &&
    !reviewers.isError &&
    !reviewers.isFetching;
  const writeDisabled = !canManage || Boolean(lock) || busy || reading || loadingConfig !== null;
  const expectedReadOnly = reviewers.error instanceof ApiError && reviewers.error.status === 403;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function sameSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && current?.id === user.id && (current.selectedRole ?? current.role) === 'PM'
    );
  }
  useEffect(() => {
    const prevent = (event: Event) => {
      if (writing.current) event.preventDefault();
    };
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, prevent);
    window.addEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, prevent);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, prevent);
      window.removeEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, prevent);
    };
  }, []);
  useBlocker({ shouldBlockFn: () => writing.current, enableBeforeUnload: () => writing.current });

  function failedWrite(failure: unknown, action: Omit<WriteLock, 'status'>) {
    if (!sameSession()) return;
    setError(failure);
    const status = failure instanceof ApiError ? failure.status : 0;
    if ([401, 403, 404].includes(status)) setLock({ ...action, status: 'access' });
    else if (status === 409) setLock({ ...action, status: 'conflict' });
    else if (status === 0 || status >= 500) setLock({ ...action, status: 'unknown' });
  }

  /** 显式回读才解除不确定写结果；回读失败不恢复旧提交按钮。 */
  async function refresh(restoreEditor = false, propagateFailure = false) {
    if (reading || writing.current) return;
    setReading(true);
    setReadError(null);
    try {
      const [list, permission] = await Promise.allSettled([
        management.refetch({ throwOnError: true }),
        reviewers.refetch({ throwOnError: true }),
      ]);
      if (!sameSession()) return;
      if (list.status === 'rejected') throw list.reason;
      if (!list.value.data) throw new Error('考试状态未读取完整，请重试。');
      if (permission.status === 'rejected') {
        if (permission.reason instanceof ApiError && permission.reason.status === 403) {
          setLock({ source: lock?.source ?? 'edit', status: 'access' });
          setNotice('当前仅可查看考试信息，由生效主策略官维护。');
          if (propagateFailure) throw permission.reason;
          return;
        }
        throw permission.reason;
      }
      const exams = list.value.data.exams;
      if (restoreEditor && editor?.kind === 'edit') {
        const latest = exams.find((exam) => exam.examId === editor.config.examId);
        if (!latest || latest.status === 'CLOSED') {
          setEditor(null);
          setNotice('该考试已关闭或不可编辑，历史名单仍可查看。');
        } else {
          const config = await api.getEntranceExamConfiguration({
            projectId,
            examId: latest.examId,
          });
          if (!sameSession()) return;
          setEditor({ kind: 'edit', config });
        }
      } else if (
        restoreEditor &&
        editor?.kind === 'create' &&
        lock?.examName &&
        exams.some((exam) => exam.examName === lock.examName)
      ) {
        setEditor(null);
        setNotice('已查到同名考试，请核对列表中的最新配置，不重复发布。');
      }
      if (closing && exams.find((exam) => exam.examId === closing.exam.examId)?.status === 'CLOSED')
        setClosing(null);
      await Promise.all([
        cache.invalidateQueries({
          queryKey: ['entrance-exam-admissions', user.id, 'PM', projectId],
        }),
        cache.invalidateQueries({ queryKey: ['entrance-exam-roster', user.id, 'PM'] }),
        onChanged(),
      ]);
      if (!sameSession()) return;
      setLock(null);
      setError(null);
    } catch (failure) {
      if (sameSession()) setReadError(failure);
      if (propagateFailure) throw failure;
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  async function saveConfig(input: EntranceExamConfigInput | EntranceExamEditInput) {
    if (writing.current || writeDisabled || !sameSession())
      throw new Error('请先读取最新考试状态与管理权限。');
    const action: Omit<WriteLock, 'status'> = {
      source: 'examId' in input ? 'edit' : 'create',
      examId: 'examId' in input ? input.examId : undefined,
      examName: input.examName ?? undefined,
    };
    writing.current = true;
    setError(null);
    setReadError(null);
    setNotice('');
    try {
      await save.mutateAsync(input);
    } catch (failure) {
      failedWrite(failure, action);
      throw failure;
    } finally {
      writing.current = false;
    }
    if (!sameSession()) return;
    setLock({ ...action, status: 'success' });
    setEditor(null);
    setNotice(
      action.source === 'create'
        ? '考试已发布，已确认结果不会重复提交。'
        : '考试新版本已保存，已入场考生保留原版本。',
    );
    await refresh();
  }

  async function confirmClose() {
    if (!closing || writeDisabled || writing.current || !sameSession()) return;
    const action: Omit<WriteLock, 'status'> = {
      source: 'close',
      examId: closing.exam.examId,
      examName: closing.exam.examName,
    };
    writing.current = true;
    setError(null);
    setReadError(null);
    setNotice('');
    try {
      await close.mutateAsync({ examId: closing.exam.examId, closeReason: closing.reason });
    } catch (failure) {
      failedWrite(failure, action);
      return;
    } finally {
      writing.current = false;
    }
    if (!sameSession()) return;
    setLock({ ...action, status: 'success' });
    setClosing(null);
    setNotice('考试已关闭，已入场考生与历史成绩仍保留。');
    await refresh();
  }

  async function openConfig(exam: EntranceExamCard, edit: boolean) {
    if (loadingConfig !== null || exam.status !== 'ACTIVE' || (edit && writeDisabled)) return;
    setLoadingConfig(exam.examId);
    setError(null);
    try {
      const config = await api.getEntranceExamConfiguration({ projectId, examId: exam.examId });
      if (!sameSession()) return;
      if (edit) setEditor({ kind: 'edit', config });
      else setConfiguration(config);
    } catch (failure) {
      if (sameSession()) setError(failure);
    } finally {
      if (mounted.current) setLoadingConfig(null);
    }
  }

  function closeWorkspace() {
    if (window.dispatchEvent(new Event(ENTRANCE_EXAM_LEAVE_REQUEST, { cancelable: true })))
      setWorkspace(null);
  }
  function closeCloseDialog() {
    if (writing.current) return;
    if (!closing?.reason.trim() || window.confirm('关闭原因尚未提交，确认放弃填写？'))
      setClosing(null);
  }

  if (!isPm) return null;
  return (
    <section aria-label="准入考试" className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">准入考试</h2>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
            组织考试、查看准入情况并完成判卷。关闭考试保留历史名单与成绩。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="mobileTouch"
            loading={management.isFetching || reviewers.isFetching || reading}
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" aria-hidden />
            刷新考试
          </Button>
          <Button
            size="mobileTouch"
            disabled={writeDisabled || management.data?.canCreateExam !== true}
            onClick={() => {
              setError(null);
              setEditor({ kind: 'create' });
            }}
          >
            <Plus className="size-4" aria-hidden />
            组织考试
          </Button>
        </div>
      </header>
      <ErrorNotice error={management.error} />
      {!expectedReadOnly && <ErrorNotice error={reviewers.error} />}
      {(management.isError || (reviewers.isError && !expectedReadOnly)) && (
        <Button
          variant="outline"
          size="account"
          disabled={busy || reading}
          onClick={() => void refresh()}
        >
          重试读取考试与权限
        </Button>
      )}
      {notice && (
        <p role="status" className="text-[13px] text-primary">
          {notice}
        </p>
      )}
      <ErrorNotice error={error} />
      <ErrorNotice error={readError} />
      {lock && (
        <div role="alert" className="space-y-3 rounded-xl border bg-muted p-4 text-[13px]">
          <p>
            {lock.status === 'success'
              ? '操作已成功，最新资料尚未读取完成。请重新读取，不要重复提交。'
              : lock.status === 'access'
                ? '当前无法提交考试操作，请重新读取管理权限。'
                : lock.status === 'conflict'
                  ? '考试已发生变化，请重新读取后核对。'
                  : '提交结果暂未确认，请重新读取考试状态核实。'}
          </p>
          <Button
            variant="outline"
            size="account"
            loading={reading}
            disabled={busy}
            onClick={() => void refresh()}
          >
            重新读取考试状态
          </Button>
        </div>
      )}
      {management.isPending ? (
        <p role="status">正在读取准入考试…</p>
      ) : (
        management.data && (
          <>
            <div className="space-y-1 rounded-xl border bg-muted p-4 text-[13px] text-muted-foreground">
              <p>
                进行中 {management.data.activeExamCount} / {management.data.maxActiveExamCount} 场
              </p>
              {!management.data.needWrittenExam && (
                <p>生产计划未配置准入考试，当前不能组织新考试；历史名单仍可查看。</p>
              )}
              {management.data.createDisabledReason && (
                <p>{management.data.createDisabledReason}</p>
              )}
              {expectedReadOnly && <p>当前仅可查看，考试由生效主策略官维护。</p>}
            </div>
            <Tabs value={view} onValueChange={setView}>
              <TabsList aria-label="考试视图" variant="business">
                <TabsTrigger variant="business" value="admission">
                  准入情况
                </TabsTrigger>
                <TabsTrigger variant="business" value="grading">
                  阅卷
                </TabsTrigger>
              </TabsList>
              <TabsContent value="admission">
                <EntranceExamAdmissions user={user} projectId={projectId} />
              </TabsContent>
              <TabsContent value="grading">
                <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                  {management.data.exams.map((exam) => (
                    <article key={exam.examId} className="min-w-0 space-y-4 rounded-xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">{exam.examNo}</p>
                          <h3 className="mt-1 break-words text-base font-semibold">
                            {exam.examName}
                          </h3>
                        </div>
                        <span className="rounded-md bg-accent px-2 py-1 text-xs text-primary">
                          {exam.status === 'ACTIVE' ? '进行中' : '已关闭'}
                        </span>
                      </div>
                      <p className="text-[13px] text-muted-foreground">
                        已交卷 {exam.examineeCount} 人 · 考试通过 {exam.admittedCount} 人 · 通过率{' '}
                        {exam.admissionRate}%
                      </p>
                      <p className="text-xs text-muted-foreground">
                        创建：{exam.createdAt}（上海时间）
                        {exam.closedAt ? ` · 关闭：${exam.closedAt}` : ''}
                      </p>
                      <div className="flex flex-wrap gap-2 border-t pt-3">
                        <Button
                          variant="outline"
                          size="mobileTouch"
                          disabled={exam.status === 'CLOSED' || loadingConfig !== null}
                          loading={loadingConfig === exam.examId}
                          onClick={() => void openConfig(exam, false)}
                        >
                          查看配置
                        </Button>
                        <Button
                          variant="primaryOutline"
                          size="mobileTouch"
                          onClick={() => setWorkspace({ exam })}
                        >
                          查看名单
                        </Button>
                        {canManage && exam.status === 'ACTIVE' && (
                          <>
                            <Button
                              variant="outline"
                              size="mobileTouch"
                              disabled={writeDisabled}
                              onClick={() => void openConfig(exam, true)}
                            >
                              编辑考试
                            </Button>
                            <Button
                              variant="dangerGhost"
                              size="mobileTouch"
                              disabled={writeDisabled}
                              onClick={() => {
                                setError(null);
                                setClosing({ exam, reason: '' });
                              }}
                            >
                              关闭考试
                            </Button>
                          </>
                        )}
                      </div>
                      {exam.status === 'CLOSED' && (
                        <p className="text-xs text-muted-foreground">
                          已关闭配置不可编辑，名单保留考生绑定的原卷与判卷记录。
                        </p>
                      )}
                    </article>
                  ))}
                  {management.data.exams.length === 0 && (
                    <p className="col-span-full rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                      暂无考试
                    </p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )
      )}
      {editor && (
        <StrategistExamEditor
          key={
            editor.kind === 'edit'
              ? `${editor.config.examId}:${editor.config.currentVersionId}`
              : 'create'
          }
          user={user}
          projectId={projectId}
          projectName={projectName}
          initialConfiguration={editor.kind === 'edit' ? editor.config : undefined}
          reviewerCandidates={reviewers.data ?? []}
          reviewersLoading={reviewers.isFetching}
          reviewersError={reviewers.error}
          onRetryReviewers={() => void reviewers.refetch()}
          existingExamNames={(management.data?.exams ?? []).map((exam) => exam.examName)}
          busy={busy || reading}
          locked={Boolean(lock)}
          onSave={saveConfig}
          onVerify={() => refresh(true)}
          onClose={() => setEditor(null)}
        />
      )}
      {configuration && (
        <EntranceExamDialog
          label="考试配置"
          title={`考试配置 · ${configuration.examName}`}
          onClose={() => setConfiguration(null)}
        >
          <EntranceExamConfigurationView config={configuration} />
        </EntranceExamDialog>
      )}
      {workspace && (
        <EntranceExamDialog
          label={workspace.attemptId ? '阅卷详情' : '考试名单'}
          title={`${workspace.attemptId ? '阅卷详情' : '考试名单'} · ${workspace.exam.examName}`}
          onClose={closeWorkspace}
        >
          <EntranceExamRoster
            user={user}
            projectId={projectId}
            examId={workspace.exam.examId}
            hidden={Boolean(workspace.attemptId)}
            onSelect={(row) => setWorkspace({ ...workspace, attemptId: row.attemptId })}
          />
          {workspace.attemptId && (
            <EntranceExamGradingWorkspace
              user={user}
              projectId={projectId}
              examId={workspace.exam.examId}
              attemptId={workspace.attemptId}
              canManage={canManage && !lock && !management.isError}
              onChanged={() => refresh(false, true)}
              onBack={() => setWorkspace({ exam: workspace.exam })}
            />
          )}
        </EntranceExamDialog>
      )}
      {closing && (
        <EntranceExamDialog
          label="关闭考试"
          title={`关闭考试 · ${closing.exam.examName}`}
          onClose={closeCloseDialog}
          busy={busy || reading}
          footer={
            <>
              <Button
                variant="outline"
                size="account"
                disabled={busy || reading}
                onClick={closeCloseDialog}
              >
                取消
              </Button>
              {lock ? (
                <Button
                  variant="outline"
                  size="account"
                  loading={reading}
                  disabled={busy}
                  onClick={() => void refresh(true)}
                >
                  重新读取考试状态
                </Button>
              ) : (
                <Button
                  size="account"
                  loading={busy}
                  disabled={writeDisabled}
                  onClick={() => void confirmClose()}
                >
                  确认关闭
                </Button>
              )}
            </>
          }
        >
          <p className="text-sm leading-6">
            关闭后不再接收新的入场，已入场考生及历史成绩保留。此操作不能撤销。
          </p>
          <label htmlFor="exam-close-reason" className="block text-[13px] font-medium">
            关闭原因（选填）
          </label>
          <Textarea
            id="exam-close-reason"
            maxLength={500}
            value={closing.reason}
            disabled={busy || Boolean(lock)}
            onChange={(event) => setClosing({ ...closing, reason: event.target.value })}
          />
          <ErrorNotice error={error} />
          <ErrorNotice error={readError} />
          {lock && (
            <p role="alert" className="text-sm">
              {lock.status === 'success'
                ? '已关闭，仅读取最新状态。'
                : '结果尚未核实，请先重新读取考试状态。'}
            </p>
          )}
        </EntranceExamDialog>
      )}
    </section>
  );
}
