import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AuthUser,
  ProductionOutputReport,
  ProductionOutputReviewInput,
  ProductionReviewStatus,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { personnelDay } from './personnel-form';
import { productionReviewInput } from './production-task-form';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';

type Intent = { mode: 'ALL' | 'SELECTED' | 'RETURN'; ids: number[] };
const names: Record<ProductionReviewStatus, string> = {
  PENDING: '待核查',
  VERIFIED: '已核准',
  RETURNED: '已退回',
};
export function ProductionOutputReports({
  user,
  projectId,
  subtaskId,
  canWrite,
  writable,
  onChanged,
  role = 'PM',
  onCorrect,
}: {
  user: AuthUser;
  projectId: number;
  subtaskId: number | null;
  canWrite: boolean;
  writable: boolean;
  onChanged: () => Promise<void>;
  role?: 'PM' | 'EXPERT';
  onCorrect?: (report: ProductionOutputReport) => void;
}) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [reason, setReason] = useState('');
  const feedback = useProductionFeedback<ProductionOutputReviewInput>(
    user,
    `review:${projectId}:${subtaskId}`,
    !!intent,
    role,
  );
  const [keyword, setKeyword] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [statuses, setStatuses] = useState<ProductionReviewStatus[]>([]);
  const [filter, setFilter] = useState({ keyword: '', start: '', end: '', statuses, current: 1 });
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['production-output-reports', user.id, role, projectId, subtaskId, filter],
    queryFn: async () => {
      feedback.requireIdentity();
      const result = await api.listProductionOutputReports({
        projectId,
        subtaskId,
        keyword: filter.keyword,
        reviewStatuses: filter.statuses,
        ...(filter.start ? { reportDateStart: filter.start } : {}),
        ...(filter.end ? { reportDateEnd: filter.end } : {}),
        current: filter.current,
        size: 20,
      });
      feedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const blocked =
    feedback.busy ||
    !!feedback.lock ||
    !canWrite ||
    !writable ||
    !query.isSuccess ||
    query.isFetching;
  async function reread() {
    if (!feedback.start()) return;
    setError(null);
    const previous = feedback.lock;
    try {
      feedback.requireSession();
      if (feedback.foreignLock) {
        await query.refetch({ throwOnError: true });
        feedback.requireSession();
        feedback.requireOrigin();
        return;
      }
      if (previous?.status === 'success') {
        await feedback.finish(previous, onChanged, () => query.refetch({ throwOnError: true }));
        if (feedback.sameSession()) {
          setIntent(null);
          setSelected([]);
          setNotice('报量核查已成功，已读取最新信息。');
        }
      } else {
        await query.refetch({ throwOnError: true });
        feedback.requireSession();
        feedback.requireOrigin();
        if (previous && previous.status !== 'unknown') {
          feedback.clear(previous);
          setSelected([]);
          setIntent(null);
          setNotice('已读取最新报量，请重新核对当前可核查记录。');
        } else if (previous)
          setNotice('已读取当前报量，仍无法精确确认上次核查范围，继续暂停重发。');
      }
    } catch (value) {
      if (feedback.sameSession()) setError(value);
    } finally {
      feedback.stop();
    }
  }
  function prepare(mode: Intent['mode'], ids: number[]) {
    if (blocked || (role === 'EXPERT' && mode === 'ALL')) return;
    setReason('');
    setError(null);
    setIntent({ mode, ids });
  }
  async function submit() {
    if (blocked || !intent || (role === 'EXPERT' && intent.mode === 'ALL') || !feedback.start())
      return;
    let state: ProductionWrite<ProductionOutputReviewInput> | undefined;
    let written = false;
    setError(null);
    try {
      feedback.requireSession();
      const input = productionReviewInput(projectId, subtaskId, intent.mode, intent.ids, reason);
      state = feedback.begin(input);
      if (!state) return;
      await api.reviewProductionOutputReports(input);
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setNotice('报量核查已保存。');
      await feedback.finish(state, onChanged, () => query.refetch({ throwOnError: true }));
      if (feedback.sameSession()) {
        setIntent(null);
        setSelected([]);
      }
    } catch (value) {
      if (state && !written) feedback.markFailure(state, value);
      if (feedback.sameSession()) {
        setError(value);
        if (written) setNotice('核查已保存，后续信息读取失败，请重新读取报量。');
      }
    } finally {
      feedback.stop();
    }
  }
  const lockText = feedback.lock
    ? feedback.lock.status === 'success'
      ? '核查已成功，后续读取尚未完成；只需重新读取报量。'
      : feedback.lock.status === 'unknown'
        ? '报量核查结果尚未确认，已暂停重复提交。'
        : '报量状态或权限已变化，请重新读取报量后核对。'
    : '';
  const lockNotice = feedback.lock && (
    <Alert>
      <div className="min-w-0 space-y-2">
        <p>
          {feedback.foreignLock
            ? '此来源存在其他角色的待核实核查，请切回原角色核实，不可换角色重复操作。'
            : lockText}
        </p>
        {!feedback.foreignLock && (
          <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[13px]">
            待核实操作：{feedback.lock.draft.action === 'RETURN' ? '退回' : '核准'}；报量范围：
            {feedback.lock.draft.reportIds?.length
              ? feedback.lock.draft.reportIds.join('、')
              : '本层级全部待核查'}
            {feedback.lock.draft.reason ? `；退回原因：${feedback.lock.draft.reason}` : ''}
          </p>
        )}
      </div>
    </Alert>
  );
  return (
    <section aria-label="报量核查" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h3>{subtaskId === null ? '项目级报量' : '子任务报量'}</h3>
        </CardTitle>
        {!intent && (
          <Button
            variant="outline"
            size="mobileTouch"
            loading={feedback.busy || query.isFetching}
            onClick={() => void reread()}
          >
            重新读取报量
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">
        {role === 'EXPERT' &&
          (canWrite
            ? '当前账号有权管理的项目报量，可能包含多个职责组织；核查仅处理明确选择的报量。'
            : '当前账号有权查看的项目报量；普通成员仅可修正允许操作的本人退回记录。')}
        {subtaskId === null
          ? '这里只包含项目级报量；子任务报量请从对应任务进入。'
          : '这里只核查本子任务报量。'}
        核准后锁定，退回后由原成员或有资格的负责人修正。
      </p>
      {!intent && (
        <>
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lockNotice}
        </>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            (start && !personnelDay(start)) ||
            (end && !personnelDay(end)) ||
            (start && end && start > end)
          ) {
            setError(new Error('请选择有效且先后顺序正确的报量日期。'));
            return;
          }
          setError(null);
          setSelected([]);
          setFilter({ keyword: keyword.trim(), start, end, statuses, current: 1 });
        }}
      >
        <SearchInput
          id={`production-report-search-${subtaskId ?? 'project'}`}
          label="筛选报量"
          value={keyword}
          maxLength={100}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="姓名、昵称或用户 ID"
          containerClassName="flex-1 basis-[180px]"
        />
        <label className="space-y-2 text-[13px]">
          报量开始日期
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="space-y-2 text-[13px]">
          报量结束日期
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button type="submit" size="mobileTouch" loading={query.isFetching}>
          查询报量
        </Button>
      </form>
      <fieldset className="flex flex-wrap gap-4 rounded-xl border p-3">
        <legend className="px-1 text-xs">核查状态</legend>
        {(Object.entries(names) as [ProductionReviewStatus, string][]).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={statuses.includes(value)}
              onChange={(e) =>
                setStatuses((old) =>
                  e.target.checked ? [...old, value] : old.filter((row) => row !== value),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={query.error} />
      {query.isPending && <LoadingState>正在读取报量…</LoadingState>}
      {query.isSuccess && (
        <>
          <dl className="grid grid-cols-2 gap-4 rounded-xl border bg-muted/30 p-4 text-[13px] sm:grid-cols-4">
            {[
              ['匹配报量数', query.data.totalReportCount],
              ['匹配总量', query.data.totalQuantity],
              ['待核查', query.data.pendingCount],
              ['已退回', query.data.returnedCount],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {canWrite && writable && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px]">已选 {selected.length} / 1000 条</span>
              <Button
                size="mobileTouch"
                disabled={blocked || !selected.length}
                onClick={() => prepare('SELECTED', selected)}
              >
                核准所选报量
              </Button>
              {role === 'PM' && (
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={blocked}
                  onClick={() => prepare('ALL', [])}
                >
                  核准本层级全部待核查
                </Button>
              )}
              <Button
                variant="ghost"
                size="mobileTouch"
                disabled={!selected.length || feedback.busy}
                onClick={() => setSelected([])}
              >
                清空报量选择
              </Button>
            </div>
          )}
          <div
            role="group"
            aria-label="报量列表"
            tabIndex={0}
            className="max-h-[36rem] space-y-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {query.data.page.records.map((row) => (
              <Card asChild key={row.reportId}>
                <article aria-label={`报量 ${row.reportId}`} className="space-y-3 p-4">
                  <div className="flex items-start gap-3">
                    {canWrite && row.allowedActions.includes('VERIFY') && (
                      <label className="flex size-11 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          aria-label={`选择报量${row.reportId}`}
                          className="size-4 accent-primary"
                          disabled={blocked}
                          checked={selected.includes(row.reportId)}
                          onChange={(e) => {
                            if (e.target.checked && selected.length >= 1000) {
                              setError(new Error('每次最多选择1000条报量。'));
                              return;
                            }
                            setSelected((old) =>
                              e.target.checked
                                ? [...old, row.reportId]
                                : old.filter((id) => id !== row.reportId),
                            );
                          }}
                        />
                      </label>
                    )}
                    <div className="min-w-0 flex-1">
                      <h4 className="break-words text-sm font-semibold">
                        {row.displayName} · {row.reportDate}
                      </h4>
                      <p className="mt-1 text-[13px]">
                        {row.quantity} {row.quantityUnit} · {names[row.reviewStatus]}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.userId} · 报量 #{row.reportId}
                      </p>
                    </div>
                  </div>
                  {row.remark && (
                    <p className="whitespace-pre-wrap break-words text-[13px]">
                      备注：{row.remark}
                    </p>
                  )}
                  {row.returnReason && (
                    <p className="whitespace-pre-wrap break-words text-[13px]">
                      退回原因：{row.returnReason}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    更新于 {row.updatedAt || '未记录'}（上海时间）
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {role === 'EXPERT' &&
                      onCorrect &&
                      row.allowedActions.includes('SAVE_REPORT') && (
                        <Button
                          variant="outline"
                          size="mobileTouch"
                          disabled={feedback.busy || !!feedback.lock || query.isFetching}
                          onClick={() => {
                            if (feedback.sameSession() && !feedback.lock) onCorrect(row);
                          }}
                        >
                          修正报量
                        </Button>
                      )}
                    {canWrite && row.allowedActions.includes('VERIFY') && (
                      <Button
                        variant="outline"
                        size="mobileTouch"
                        disabled={blocked}
                        onClick={() => prepare('SELECTED', [row.reportId])}
                      >
                        核准报量
                      </Button>
                    )}
                    {canWrite && row.allowedActions.includes('RETURN') && (
                      <Button
                        variant="destructiveOutline"
                        size="mobileTouch"
                        disabled={blocked}
                        onClick={() => prepare('RETURN', [row.reportId])}
                      >
                        退回报量
                      </Button>
                    )}
                  </div>
                </article>
              </Card>
            ))}
          </div>
          {!query.data.page.records.length && <EmptyState title="暂无符合条件的报量" />}
          <Pagination
            aria-label="生产报量分页"
            {...query.data.page}
            loading={query.isFetching}
            onPageChange={(current) => setFilter({ ...filter, current })}
          />
        </>
      )}
      {intent && (
        <Dialog
          title={intent.mode === 'RETURN' ? '确认退回报量' : '确认核准报量'}
          aria-label={intent.mode === 'RETURN' ? '确认退回报量' : '确认核准报量'}
          size="md"
          busy={feedback.busy}
          onClose={() => setIntent(null)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={feedback.busy}
                onClick={() => setIntent(null)}
              >
                取消
              </Button>
              {feedback.lock ? (
                <Button size="mobileTouch" loading={feedback.busy} onClick={() => void reread()}>
                  重新读取报量
                </Button>
              ) : (
                <Button
                  size="mobileTouch"
                  loading={feedback.busy}
                  disabled={blocked}
                  onClick={() => void submit()}
                >
                  {intent.mode === 'RETURN' ? '确认退回' : '确认核准'}
                </Button>
              )}
            </>
          }
        >
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lockNotice}
          <p className="text-[13px] leading-6">
            {intent.mode === 'ALL'
              ? '将核准本层级全部待核查报量，不受当前搜索、日期或分页筛选限制。核准后不可编辑。'
              : intent.mode === 'RETURN'
                ? `将退回报量 #${intent.ids[0]}，请填写原因。`
                : `将核准所选 ${intent.ids.length} 条报量，核准后不可编辑。`}
          </p>
          {intent.mode === 'RETURN' && (
            <label className="block space-y-2 text-[13px]">
              退回原因
              <Textarea
                aria-label="退回原因"
                value={reason}
                maxLength={500}
                rows={4}
                disabled={blocked}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
        </Dialog>
      )}
    </section>
  );
}
