import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { ApiError, type AuthUser, type ProjectExpertRecruitmentCandidate } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { RecruitmentCandidates, type RecruitmentCandidateView } from './RecruitmentCandidates';
import { RecruitmentWorkspace } from './RecruitmentWorkspace';
import {
  newRecruitmentDraft,
  recruitmentCandidateKey,
  recruitmentCandidateName,
  recruitmentInput,
  type RecruitmentDraft,
} from './expert-recruitment-form';

export const EXPERT_RECRUITMENT_LEAVE_REQUEST = 'tyde:before-expert-recruitment-leave';
type Status = 'unknown' | 'conflict' | 'access' | 'success';
type WriteState = { status: Status } & (
  { kind: 'handler'; handlerId: string } | { kind: 'submit'; drafts: RecruitmentDraft[] }
);
// 角色切换会清空读取缓存；未确认的写入在本次页面运行中仍需按账号、项目保留。
const pendingWrites = new Map<string, WriteState>();

/** 五个既有接口承接招募。下发没有可查询的批次ID，未知写入只能保守持锁。 */
export function ExpertRecruitmentPanel({
  user,
  projectId,
  onChanged,
}: {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
}) {
  const cache = useQueryClient();
  const scope = ['project-expert-recruitment', user.id, 'PM', projectId];
  const candidatesKey = ['project-recruitment-candidates', user.id, 'PM', projectId];
  const lockKey = [...scope, 'write-state'];
  const writeKey = JSON.stringify([user.id, projectId]);
  const retained = useQuery<WriteState | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: () => pendingWrites.get(writeKey) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  const lock = retained.data;
  function setLock(value: WriteState | null) {
    if (value) pendingWrites.set(writeKey, value);
    else pendingWrites.delete(writeKey);
    cache.setQueryData(lockKey, value);
  }
  const [drafts, setDrafts] = useState<RecruitmentDraft[]>(() =>
    lock?.kind === 'submit' && lock.status !== 'success' ? lock.drafts : [],
  );
  const [handlerOpen, setHandlerOpen] = useState(false);
  const [handlerId, setHandlerId] = useState('');
  const [handlerSearch, setHandlerSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [candidateView, setCandidateView] = useState<RecruitmentCandidateView>('ALL');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const working = useRef(false);
  const allowLeave = useRef(false);
  const detail = useQuery({
    queryKey: scope,
    queryFn: async () => {
      requireIdentity();
      const result = await api.getExpertRecruitmentDetail(projectId);
      requireIdentity();
      return result;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const handlers = useQuery({
    queryKey: [...scope, 'handlers'],
    queryFn: async () => {
      requireIdentity();
      const result = await api.listExpertRecruitmentHandlerCandidates(projectId);
      requireIdentity();
      return result;
    },
    enabled: handlerOpen && detail.isSuccess && detail.data.canChangeHandler,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const blocked = busy || !!lock || !detail.isSuccess || detail.isFetching;
  const dirty = drafts.length > 0;
  const hasPreviousRecruitment =
    !!detail.data &&
    (detail.data.summary.activeAssignmentCount > 0 || detail.data.summary.rejectedCount > 0);
  const selectionReadOnly = hasPreviousRecruitment && !editing && !dirty;
  const draftQuantity = drafts.reduce((total, draft) => {
    const quantity = Number(draft.quantity);
    return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
  }, 0);
  const assignedQuantity =
    (detail.data?.summary.assignedProductionRequirement ?? 0) + draftQuantity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function mayLeave() {
    return (
      allowLeave.current ||
      (!working.current && (!dirty || window.confirm('尚有未完成的招募清单，确认离开当前页面？')))
    );
  }
  useEffect(() => {
    const leave = (event: Event) => {
      if (!mayLeave()) event.preventDefault();
    };
    window.addEventListener(EXPERT_RECRUITMENT_LEAVE_REQUEST, leave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => {
      window.removeEventListener(EXPERT_RECRUITMENT_LEAVE_REQUEST, leave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    };
  }, [dirty]);
  useBlocker({
    shouldBlockFn: () => sameSession() && !mayLeave(),
    enableBeforeUnload: () => !allowLeave.current && (working.current || dirty),
  });
  function sameIdentity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === 'PM';
  }
  function sameSession() {
    return mounted.current && sameIdentity();
  }
  function requireIdentity() {
    if (!sameIdentity()) throw new Error('登录身份已变化，请重新打开项目。');
  }
  function requireSession() {
    if (!sameSession()) throw new Error('登录身份已变化，请重新打开项目。');
  }
  async function readDetail() {
    requireSession();
    const result = await api.getExpertRecruitmentDetail(projectId);
    requireSession();
    return result;
  }
  function failed(value: unknown, write?: WriteState) {
    if (!sameSession()) return;
    setError(value);
    if (write) {
      const status =
        value instanceof ApiError && [401, 403, 404].includes(value.status)
          ? 'access'
          : value instanceof ApiError && [400, 409, 413].includes(value.status)
            ? 'conflict'
            : 'unknown';
      setLock({ ...write, status });
    }
    if (value instanceof ApiError && value.status === 401)
      void cache.invalidateQueries({ queryKey: SESSION_KEY });
  }
  async function updateViews() {
    const latest = await readDetail();
    cache.setQueryData(scope, latest);
    await cache.invalidateQueries({ queryKey: candidatesKey }, { throwOnError: true });
    requireSession();
    if (handlerOpen && latest.canChangeHandler) {
      const latestHandlers = await api.listExpertRecruitmentHandlerCandidates(projectId);
      requireSession();
      cache.setQueryData([...scope, 'handlers'], latestHandlers);
    }
    return latest;
  }
  async function followUp() {
    allowLeave.current = true;
    await onChanged();
    if (!sameIdentity()) return;
    if (mounted.current) {
      try {
        await updateViews();
      } catch (value) {
        // 待办续接可能在读取期间卸载本面板，此时只需收尾已确认成功的写入。
        if (mounted.current || !sameIdentity()) throw value;
      }
    }
    if (!sameIdentity()) return;
    setLock(null);
    if (!mounted.current) return;
    setHandlerOpen(false);
    setHandlerId('');
    setDrafts([]);
    setEditing(false);
  }
  async function reread(verify = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const previous = cache.getQueryData<WriteState | null>(lockKey);
    try {
      if (previous?.status === 'success') {
        await followUp();
        if (sameSession()) setNotice('操作已成功，已读取最新招募信息。');
        return;
      }
      const latest = await updateViews();
      if (verify && previous) {
        if (previous.kind === 'handler') {
          if (latest.handler?.userId === previous.handlerId) {
            setLock({ ...previous, status: 'success' });
            setNotice('当前招募负责人已为本次选择，正在更新待办。');
            await followUp();
          } else if (latest.canChangeHandler) {
            setLock(null);
            setHandlerId('');
            setNotice('已读取当前负责人，请核对后重新选择，不会自动重发更换请求。');
          }
        } else if (previous.status === 'unknown') {
          setNotice(
            '已读取当前候选与招募汇总，仍无法确认上次整批下发结果。清单继续保留，系统不会重复下发。',
          );
        } else {
          setLock(null);
          setNotice('已读取最新招募信息，请核对对象和补招来源后再下发。');
        }
      } else setNotice('已读取最新招募信息。');
    } catch (value) {
      failed(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function add(candidate: ProjectExpertRecruitmentCandidate) {
    if (blocked || selectionReadOnly || candidate.availableAction === 'NONE') return;
    if (
      drafts.some(
        (draft) => recruitmentCandidateKey(draft.candidate) === recruitmentCandidateKey(candidate),
      )
    )
      return;
    if (drafts.length >= 100) {
      setError(new Error('每次下发最多100个对象。'));
      return;
    }
    setDrafts((current) => [...current, newRecruitmentDraft(candidate)]);
    setNotice('已加入下发清单，请填写量级与人数，确认前不会发出招募。');
    setError(null);
  }
  function prepareSubmit() {
    if (blocked) return;
    try {
      recruitmentInput(projectId, drafts);
      setError(null);
      setConfirming(true);
    } catch (value) {
      setError(value);
      setCandidateView('SELECTED');
      for (const draft of drafts) {
        try {
          recruitmentInput(projectId, [draft]);
        } catch (invalid) {
          const message = invalid instanceof Error ? invalid.message : '';
          const field = message.includes('作业人数')
            ? 'operators'
            : message.includes('质检人数')
              ? 'inspectors'
              : 'quantity';
          requestAnimationFrame(() => document.getElementById(`${draft.key}-${field}`)?.focus());
          break;
        }
      }
    }
  }
  async function submit() {
    if (working.current || cache.getQueryData(lockKey) || !detail.isSuccess || detail.isFetching)
      return;
    let input;
    try {
      input = recruitmentInput(projectId, drafts);
    } catch (value) {
      setError(value);
      setConfirming(false);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    const state: WriteState = { kind: 'submit', status: 'unknown', drafts };
    let written = false;
    try {
      requireSession();
      setLock(state);
      await api.submitExpertRecruitment(input);
      written = true;
      setLock({ ...state, status: 'success' });
      requireSession();
      setDrafts([]);
      setConfirming(false);
      setNotice('招募已下发，等待执行专家接单。');
      await followUp();
    } catch (value) {
      if (written) {
        if (sameSession()) {
          setError(value);
          setNotice('招募已下发，后续信息读取失败，请重新读取招募信息。');
        }
      } else failed(value, state);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) {
        setBusy(false);
        setConfirming(false);
      }
    }
  }
  async function changeHandler() {
    if (
      working.current ||
      cache.getQueryData(lockKey) ||
      !detail.data?.canChangeHandler ||
      detail.isError ||
      detail.isFetching ||
      !handlerId ||
      handlers.isError ||
      handlers.isFetching
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    const state: WriteState = { kind: 'handler', status: 'unknown', handlerId };
    let written = false;
    try {
      requireSession();
      setLock(state);
      await api.changeExpertRecruitmentHandler({ projectId, handlerUserId: handlerId });
      written = true;
      setLock({ ...state, status: 'success' });
      requireSession();
      setHandlerOpen(false);
      setNotice('招募负责人已更新。');
      await followUp();
    } catch (value) {
      if (written) {
        if (sameSession()) {
          setError(value);
          setNotice('负责人已更新，后续信息读取失败，请重新读取招募信息。');
        }
      } else failed(value, state);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const data = detail.data;
  const lockMessage = lock
    ? lock.status === 'success'
      ? '操作已成功，后续信息尚未读取完成，请重新读取招募信息，不要重复提交。'
      : lock.status === 'unknown'
        ? lock.kind === 'submit'
          ? '下发结果尚未确认，已保留清单并暂停重发。请核对对象的最新接单状态。'
          : '负责人调整结果尚未确认，请先核实负责人。'
        : '招募状态、权限或补招来源已变化，请先核实当前信息。'
    : '';
  return (
    <section aria-label="招募执行专家" className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h2>招募执行专家</h2>
        </CardTitle>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={busy || detail.isFetching}
          onClick={() => void reread()}
        >
          <RefreshCw className="size-4" aria-hidden />
          重新读取招募信息
        </Button>
      </header>
      <ErrorNotice error={detail.error} />
      {!handlerOpen && <ErrorNotice error={error} />}
      {!handlerOpen && notice && <Alert>{notice}</Alert>}
      {!handlerOpen && lockMessage && <Alert>{lockMessage}</Alert>}
      {!handlerOpen && lock && lock.status !== 'success' && (
        <Button
          variant="outline"
          size="mobileTouch"
          loading={busy}
          onClick={() => void reread(true)}
        >
          {lock.kind === 'handler' ? '核实负责人' : '核实下发结果'}
        </Button>
      )}
      {detail.isPending && <LoadingState>正在读取招募信息…</LoadingState>}
      {data && !detail.isError && (
        <>
          <Card asChild>
            <section aria-label="招募概览" className="space-y-4 bg-muted/30 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 text-[13px] leading-6">
                  <p>主策略官：{data.primaryManager?.name || '未指定'}</p>
                  <p>
                    招募负责人：
                    {data.handler?.name ||
                      `未单独指定，由主策略官${data.primaryManager?.name ? ` ${data.primaryManager.name}` : ''}处理`}
                  </p>
                </div>
                {data.canChangeHandler && (
                  <Button
                    variant="primaryOutline"
                    size="mobileTouch"
                    disabled={blocked || dirty}
                    title={dirty ? '请先处理或移除当前下发清单，再更换负责人。' : undefined}
                    onClick={() => {
                      setHandlerId('');
                      setHandlerSearch('');
                      setHandlerOpen(true);
                    }}
                  >
                    更换招募负责人
                  </Button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-4">
                {[
                  [
                    '项目量级',
                    data.projectQuantity === null
                      ? '未配置'
                      : `${data.projectQuantity} ${data.quantityUnit || ''}`,
                  ],
                  ['已分配量级', data.summary.assignedProductionRequirement],
                  ['剩余量级', data.summary.remainingProductionRequirement],
                  [
                    '待接单 / 已接单 / 已拒绝',
                    `${data.summary.pendingAcceptanceCount} / ${data.summary.acceptedCount} / ${data.summary.rejectedCount}`,
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </Card>
          <RecruitmentWorkspace>
            {hasPreviousRecruitment && (
              <div className="flex flex-wrap gap-2">
                {selectionReadOnly ? (
                  <Button size="mobileTouch" disabled={blocked} onClick={() => setEditing(true)}>
                    更换执行专家
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="mobileTouch"
                    disabled={blocked}
                    onClick={() => {
                      setDrafts([]);
                      setEditing(false);
                      setError(null);
                    }}
                  >
                    取消更换执行专家
                  </Button>
                )}
              </div>
            )}
            <RecruitmentCandidates
              user={user}
              projectId={projectId}
              disabled={blocked || selectionReadOnly}
              view={candidateView}
              onViewChange={setCandidateView}
              excludedKeys={drafts.map((draft) => recruitmentCandidateKey(draft.candidate))}
              onRecruit={(candidate) => add(candidate)}
            />
            <section aria-label="下发清单" className="space-y-4 rounded-xl border p-4">
              <CardTitle asChild>
                <h3>下发清单（{drafts.length} / 100）</h3>
              </CardTitle>
              <p className="text-[13px] leading-6 text-muted-foreground">
                仅下发本次新增选择；已待接单或已接单的分配保持不变。再次招募已拒绝对象会关联该对象的原拒单记录。
              </p>
              {!drafts.length && (
                <EmptyState
                  title="暂无下发对象"
                  description="从候选列表加入下发对象，或对已拒绝的分配发起补招。"
                />
              )}
              {drafts.map((draft) => {
                const name = recruitmentCandidateName(draft.candidate);
                return (
                  <section
                    key={draft.key}
                    aria-label={`下发给${name}`}
                    className="space-y-3 rounded-xl border p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="min-w-0 break-words text-sm font-medium">
                        {name} · {draft.candidate.subjectType === 'ORGANIZATION' ? '组织' : '个人'}
                      </h4>
                      <Button
                        variant="dangerGhost"
                        size="mobileTouch"
                        disabled={blocked}
                        onClick={() =>
                          setDrafts((current) => current.filter((row) => row.key !== draft.key))
                        }
                      >
                        移除下发项
                      </Button>
                    </div>
                    {draft.sourceRejectedAssignmentId !== null && (
                      <div className="flex flex-wrap items-center gap-3 text-[13px]">
                        <p>
                          补招来源：{draft.sourceName}（拒单 #{draft.sourceRejectedAssignmentId}）
                        </p>
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-3">
                      {(['quantity', 'operators', 'inspectors'] as const).map((field) => {
                        const label = `${name}${field === 'quantity' ? '招募量级' : field === 'operators' ? '作业人数' : '质检人数'}`;
                        return (
                          <label
                            key={field}
                            className="space-y-2 text-[13px]"
                            htmlFor={`${draft.key}-${field}`}
                          >
                            <span>
                              {field === 'quantity'
                                ? `招募量级${data.quantityUnit ? `（${data.quantityUnit}）` : ''}`
                                : field === 'operators'
                                  ? '作业人数'
                                  : '质检人数（选填）'}
                            </span>
                            <Input
                              id={`${draft.key}-${field}`}
                              aria-label={label}
                              inputMode={field === 'quantity' ? 'decimal' : 'numeric'}
                              maxLength={32}
                              value={draft[field]}
                              disabled={blocked}
                              onChange={(event) =>
                                setDrafts((current) =>
                                  current.map((row) =>
                                    row.key === draft.key
                                      ? { ...row, [field]: event.target.value }
                                      : row,
                                  ),
                                )
                              }
                            />
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              {data.projectQuantity !== null && assignedQuantity > data.projectQuantity && (
                <Alert>
                  累计分配量级 {assignedQuantity} {data.quantityUnit} 超出项目总量级{' '}
                  {data.projectQuantity} {data.quantityUnit}，请核对分配；此提示不阻止下发。
                </Alert>
              )}
              <div className="flex justify-end">
                <Button
                  size="mobileTouch"
                  disabled={blocked || !drafts.length}
                  onClick={prepareSubmit}
                >
                  下发招募
                </Button>
              </div>
            </section>
          </RecruitmentWorkspace>
        </>
      )}
      {handlerOpen && (
        <Dialog
          title="更换招募负责人"
          aria-label="更换招募负责人"
          size="md"
          busy={busy}
          onClose={() => setHandlerOpen(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy}
                onClick={() => setHandlerOpen(false)}
              >
                取消
              </Button>
              <Button
                size="mobileTouch"
                loading={busy}
                disabled={blocked || !handlerId || !handlers.isSuccess || handlers.isFetching}
                onClick={() => void changeHandler()}
              >
                确认更换负责人
              </Button>
            </>
          }
        >
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lockMessage && <Alert>{lockMessage}</Alert>}
          {lock?.kind === 'handler' && (
            <Button
              variant="outline"
              size="mobileTouch"
              loading={busy}
              onClick={() => void reread(true)}
            >
              核实负责人
            </Button>
          )}
          <p className="text-[13px] leading-6 text-muted-foreground">
            选择本项目招募协作负责人；主策略官仍可招募，不支持清空负责人。
          </p>
          <label className="block space-y-2 text-[13px]">
            搜索招募负责人
            <Input
              type="search"
              value={handlerSearch}
              maxLength={100}
              onChange={(event) => setHandlerSearch(event.target.value)}
            />
          </label>
          <ErrorNotice error={handlers.error} />
          {handlers.isPending && <LoadingState>正在读取负责人候选…</LoadingState>}
          {handlers.isSuccess && (
            <fieldset className="space-y-3" disabled={blocked || handlers.isFetching}>
              {handlers.data
                .filter((candidate) =>
                  `${candidate.name} ${candidate.userId}`
                    .toLocaleLowerCase()
                    .includes(handlerSearch.trim().toLocaleLowerCase()),
                )
                .map((candidate) => (
                  <label
                    key={candidate.userId}
                    className="flex min-h-11 items-center gap-3 rounded-xl border p-4 text-[13px]"
                  >
                    <input
                      type="radio"
                      className="size-4 shrink-0 accent-primary"
                      name="recruitment-handler"
                      aria-label={candidate.name}
                      checked={handlerId === candidate.userId}
                      onChange={() => setHandlerId(candidate.userId)}
                    />
                    <span className="min-w-0 break-words">
                      {candidate.name} · {candidate.userId}
                      <span className="block text-xs text-muted-foreground">
                        主负责 {candidate.currentProjectCount} 个项目
                        {candidate.currentHandler ? ' · 当前负责人' : ''}
                      </span>
                    </span>
                  </label>
                ))}
            </fieldset>
          )}
        </Dialog>
      )}
      {confirming && (
        <Dialog
          title="确认下发招募"
          aria-label="确认下发招募"
          size="sm"
          busy={busy}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                继续编辑
              </Button>
              <Button
                size="mobileTouch"
                loading={busy}
                disabled={blocked}
                onClick={() => void submit()}
              >
                确认下发
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            将一次性下发给 {drafts.length}{' '}
            个个人或组织，全部成功或全部失败。请核对量级、人数与补招来源，执行专家接单后才进入后续流程。
          </p>
        </Dialog>
      )}
    </section>
  );
}
