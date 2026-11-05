import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthUser,
  type PersonnelProductionRow,
  type PersonnelQualitySaveInput,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { productionQuantityUnits } from './production-task-form';
import { productionPlanToday } from './production-plan-form';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';
import { productionDateRange, qualityInput, type QualityDraft } from './quality-acceptance-form';

type PerformanceMember = Pick<
  PersonnelProductionRow,
  'memberId' | 'displayName' | 'organizationName' | 'reportDate'
>;
type QualityPending = { input: PersonnelQualitySaveInput; drafts: QualityDraft[] };
const sourceNames = { MANUAL: '人工填报', WORK_SYSTEM: '作业系统' };
const denied = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

function qualityDifference(draft: QualityDraft) {
  const inspected = productionQuantityUnits(draft.inspected);
  const qualified = productionQuantityUnits(draft.qualified);
  if (inspected === null || qualified === null || inspected <= qualified) return null;
  const value = inspected - qualified;
  const fraction = String(value % 10000n)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return `${value / 10000n}${fraction ? `.${fraction}` : ''}`;
}

function ProductionSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Record<string, string>;
}) {
  const id = useId();
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setPortal} className="space-y-2">
      <label htmlFor={id} className="text-[13px]">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} size="profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent container={portal}>
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function PersonnelProduction({
  user,
  projectId,
  canWrite,
  active = true,
  onPerformance,
  role = 'PM',
  organizationIds: organizationScope,
}: {
  user: AuthUser;
  projectId: number;
  canWrite: boolean;
  active?: boolean;
  onPerformance?: (member: PerformanceMember) => void;
  role?: 'PM' | 'EXPERT';
  organizationIds?: string[];
}) {
  const session = useProductionFeedback<never>(user, `daily-read:${projectId}`, false, role);
  const id = useId();
  const [start, setStart] = useState(productionPlanToday);
  const [end, setEnd] = useState(productionPlanToday);
  const [keyword, setKeyword] = useState('');
  const [account, setAccount] = useState('ALL');
  const [source, setSource] = useState('ALL');
  const [organizationIds, setOrganizationIds] = useState<string[]>([]);
  const [organizations, setOrganizations] = useState<[string, string][]>([]);
  const [filter, setFilter] = useState(() => ({
    start: productionPlanToday(),
    end: productionPlanToday(),
    keyword: '',
    account: 'ALL',
    source: 'ALL',
    organizationIds: [] as string[],
    current: 1,
  }));
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<PersonnelProductionRow | null>(null);
  const [qualitySaved, setQualitySaved] = useState(false);
  const query = useQuery({
    queryKey: ['personnel-production', user.id, role, projectId, organizationScope ?? null, filter],
    enabled: active,
    queryFn: async () => {
      session.requireIdentity();
      if (role === 'EXPERT' && organizationScope?.length !== 1)
        throw new Error('请从明确的组织管理来源进入日生产。');
      const result = await api.listPersonnelProduction({
        projectId,
        ...productionDateRange(filter.start, filter.end),
        keyword: filter.keyword || undefined,
        organizationIds: role === 'EXPERT' ? organizationScope : filter.organizationIds,
        ...(role === 'EXPERT' || filter.account === 'ALL'
          ? {}
          : { accountTypes: [filter.account as 'INDIVIDUAL' | 'ORGANIZATION'] }),
        ...(filter.source === 'ALL'
          ? {}
          : { dataSources: [filter.source as 'MANUAL' | 'WORK_SYSTEM'] }),
        current: filter.current,
        size: 20,
      });
      session.requireIdentity();
      if (
        role === 'EXPERT' &&
        result.records.some(
          (row) => !row.organizationId || !organizationScope?.includes(row.organizationId),
        )
      )
        throw new Error('日生产返回了当前组织范围以外的记录，请重新读取。');
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  });
  const data = !query.isError && session.sameIdentity() ? query.data : undefined;
  useEffect(() => {
    if (!data) return;
    setOrganizations((previous) => [
      ...new Map([
        ...previous,
        ...data.records
          .filter((row) => row.organizationId)
          .map(
            (row) =>
              [row.organizationId!, row.organizationName || '未命名组织'] as [string, string],
          ),
      ]).entries(),
    ]);
  }, [data]);
  async function refreshProduction() {
    session.requireSession();
    await query.refetch({ throwOnError: true });
    session.requireSession();
  }
  return (
    <section aria-label="人员日生产" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h3>人员日生产</h3>
        </CardTitle>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新日生产
        </Button>
      </div>
      <p className="text-[13px] leading-6 text-muted-foreground">
        按成员和生产日期汇总全部核查状态的报量，质量合计只计各报量最新一次质量记录。近7日CPD、备注和质量历史条数不随来源筛选缩减。
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            productionDateRange(start, end);
            setFilter({
              start,
              end,
              keyword: keyword.trim(),
              account,
              source,
              organizationIds,
              current: 1,
            });
            setError(null);
          } catch (value) {
            setError(value);
          }
        }}
      >
        <SearchInput
          id={`${id}-keyword`}
          label="搜索日生产人员"
          value={keyword}
          maxLength={100}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="姓名、昵称或用户 ID"
          containerClassName="self-end sm:max-w-none"
        />
        <label className="space-y-2 text-[13px]">
          生产日期
          <Input
            type="date"
            aria-label="生产日期"
            value={start}
            size="profile"
            onChange={(event) => {
              setStart(event.target.value);
              setEnd(event.target.value);
            }}
          />
        </label>
        {role === 'PM' && (
          <ProductionSelect
            label="接单身份"
            value={account}
            onChange={setAccount}
            options={{ ALL: '全部身份', INDIVIDUAL: '个人', ORGANIZATION: '组织' }}
          />
        )}
        <ProductionSelect
          label="生产数据来源"
          value={source}
          onChange={setSource}
          options={{ ALL: '全部来源', ...sourceNames }}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button type="submit" size="settings" loading={query.isFetching}>
            查询日生产
          </Button>
          <Button
            variant="outline"
            size="settings"
            onClick={() => {
              const today = productionPlanToday();
              setStart(today);
              setEnd(today);
              setKeyword('');
              setAccount('ALL');
              setSource('ALL');
              setOrganizationIds([]);
              setFilter({
                start: today,
                end: today,
                keyword: '',
                account: 'ALL',
                source: 'ALL',
                organizationIds: [],
                current: 1,
              });
              setError(null);
            }}
          >
            重置生产筛选
          </Button>
        </div>
      </form>
      {role === 'PM' && (
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer py-2 text-[13px]">组织筛选</summary>
          <fieldset className="mt-2 flex flex-wrap gap-4">
            <legend className="text-xs text-muted-foreground">
              选项来自已加载的日生产记录，可先搜索或翻页查找。
            </legend>
            {organizations.map(([id, name]) => (
              <label key={id} className="flex min-h-11 items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={organizationIds.includes(id)}
                  disabled={!organizationIds.includes(id) && organizationIds.length >= 100}
                  onChange={(e) =>
                    setOrganizationIds((old) =>
                      e.target.checked ? [...old, id] : old.filter((value) => value !== id),
                    )
                  }
                />
                {name}
              </label>
            ))}
            {!organizations.length && (
              <p className="text-xs text-muted-foreground">暂无已加载组织</p>
            )}
          </fieldset>
        </details>
      )}
      <ErrorNotice error={error} />
      <ErrorNotice error={query.error} />
      {qualitySaved && <Alert>质量记录已保存。</Alert>}
      {query.isPending && active && <LoadingState>正在读取人员日生产…</LoadingState>}
      {data && (
        <>
          {data.records.length ? (
            <div
              role="group"
              aria-label="日生产记录列表"
              tabIndex={0}
              className="max-h-[42rem] space-y-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {data.records.map((row) => (
                <Card key={`${row.memberId}:${row.reportDate}`} asChild>
                  <article
                    aria-label={`${row.displayName} ${row.reportDate}`}
                    className="space-y-3 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="break-words text-sm font-semibold">
                        {row.displayName} · {row.reportDate}
                      </h4>
                      <span className="text-xs text-muted-foreground">
                        {row.organizationName || '—'} · {row.userId}
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
                      {[
                        ['报量', `${row.quantity} ${row.quantityUnit}`],
                        ['近7日CPD', row.recent7DayCpd],
                        [
                          '抽检 / 合格 / 不合格',
                          `${row.inspectedQuantity} / ${row.qualifiedQuantity} / ${row.unqualifiedQuantity}`,
                        ],
                        ['合格率', row.accuracyRate === null ? '暂无抽检' : `${row.accuracyRate}%`],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="mt-1 break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="text-xs text-muted-foreground">
                      来源：{row.dataSources.map((value) => sourceNames[value]).join('、')} ·
                      质量历史 {row.qualityRecordCount} 条
                      {row.hasManualQualityEntry ? ' · 含人工质量' : ''}
                    </p>
                    {row.remarks && (
                      <p className="whitespace-pre-wrap break-words text-[13px] leading-6">
                        {row.remarks}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!row.dataSources.includes('WORK_SYSTEM') && (
                        <Button
                          variant="outline"
                          size="mobileTouch"
                          disabled={query.isFetching}
                          onClick={() => {
                            setQualitySaved(false);
                            setSelected(row);
                          }}
                        >
                          质量记录{row.qualityRecordCount > 0 ? `(${row.qualityRecordCount})` : ''}
                        </Button>
                      )}
                      {canWrite &&
                        row.allowedActions.includes('CREATE_PERFORMANCE') &&
                        onPerformance && (
                          <Button
                            variant="outline"
                            size="mobileTouch"
                            disabled={query.isFetching}
                            onClick={() => {
                              if (session.sameSession())
                                onPerformance({
                                  memberId: row.memberId,
                                  displayName: row.displayName,
                                  organizationName: row.organizationName,
                                  reportDate: row.reportDate,
                                });
                            }}
                          >
                            记录成员表现
                          </Button>
                        )}
                    </div>
                  </article>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState title="暂无匹配的人员日生产" />
            </Card>
          )}
          <Pagination
            aria-label="人员日生产分页"
            current={data.current}
            total={data.total}
            pages={data.pages}
            loading={query.isFetching}
            onPageChange={(current) => setFilter((value) => ({ ...value, current }))}
          />
        </>
      )}
      {selected && (
        <QualityDialog
          key={`${selected.memberId}:${selected.reportDate}`}
          user={user}
          projectId={projectId}
          row={selected}
          role={role}
          canWrite={canWrite}
          onRefreshProduction={refreshProduction}
          onSaved={() => {
            setSelected(null);
            setQualitySaved(true);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function QualityDialog({
  user,
  projectId,
  row,
  canWrite,
  onRefreshProduction,
  onSaved,
  onClose,
  role,
}: {
  user: AuthUser;
  projectId: number;
  row: PersonnelProductionRow;
  canWrite: boolean;
  onRefreshProduction: () => Promise<void>;
  onSaved: () => void;
  onClose: () => void;
  role: 'PM' | 'EXPERT';
}) {
  const cache = useQueryClient();
  const [drafts, setDrafts] = useState<QualityDraft[]>([]);
  const feedback = useProductionFeedback<QualityPending>(
    user,
    `quality:${projectId}:${row.memberId}:${row.reportDate}`,
    drafts.length > 0,
    role,
  );
  useEffect(() => {
    if (feedback.lock && !feedback.foreignLock && !drafts.length)
      setDrafts(feedback.lock.draft.drafts);
  }, [feedback.lock]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const key = { projectId, memberId: row.memberId, reportDate: row.reportDate };
  const queryKey = ['personnel-quality', user.id, role, projectId, row.memberId, row.reportDate];
  const context = useQuery({
    queryKey,
    queryFn: async () => {
      feedback.requireIdentity();
      const value = await api.getPersonnelQualityContext(key);
      feedback.requireIdentity();
      return value;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data =
    !context.isError && !denied(error) && feedback.sameIdentity() ? context.data : undefined;
  const canRecord =
    canWrite &&
    row.allowedActions.includes('SAVE_QUALITY') &&
    !row.dataSources.includes('WORK_SYSTEM');
  const blocked = feedback.busy || !!feedback.lock || !canRecord || !data || context.isFetching;
  async function complete(state: ProductionWrite<QualityPending>) {
    await feedback.finish(state, onRefreshProduction, () =>
      context.refetch({ throwOnError: true }),
    );
    if (feedback.sameSession()) onSaved();
  }
  async function reread() {
    if (!feedback.start()) return;
    setError(null);
    const state = feedback.lock;
    try {
      feedback.requireSession();
      if (feedback.foreignLock) {
        await context.refetch({ throwOnError: true });
        feedback.requireSession();
        feedback.requireOrigin();
        return;
      }
      if (state?.status === 'success') {
        await complete(state);
        return;
      }
      await context.refetch({ throwOnError: true });
      feedback.requireSession();
      feedback.requireOrigin();
      if (state?.status === 'unknown')
        setNotice(
          '已读取最新质量历史，但没有幂等键或请求编号，仍不能确认上次追加结果；记录相同也不会解锁重发。',
        );
      else if (state) {
        feedback.clear(state);
        setNotice('已读取当前质量权限，请核对明细后再操作。');
      }
    } catch (value) {
      if (feedback.sameSession()) setError(value);
    } finally {
      feedback.stop();
    }
  }
  async function submit() {
    if (blocked || !data || !feedback.start()) return;
    let state: ProductionWrite<QualityPending> | undefined;
    let written = false;
    setError(null);
    try {
      feedback.requireSession();
      const latest = await api.getPersonnelQualityContext(key);
      feedback.requireSession();
      cache.setQueryData(queryKey, latest);
      const input = qualityInput(key, drafts, latest, row.quantity);
      state = feedback.begin({ input, drafts });
      if (!state) return;
      await api.savePersonnelQuality(input);
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setConfirming(false);
      await complete(state);
    } catch (value) {
      if (state && !written) feedback.markFailure(state, value);
      if (feedback.sameSession()) {
        setError(value);
        setConfirming(false);
      }
    } finally {
      feedback.stop();
    }
  }
  const reports = [...new Set(data?.items.map((item) => item.outputReportId) ?? [])];
  return (
    <>
      <Dialog
        title="生产质量明细"
        aria-label="生产质量明细"
        size="lg"
        busy={feedback.busy}
        onClose={onClose}
        footer={
          <>
            <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={onClose}>
              关闭质量明细
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={feedback.busy || context.isFetching}
              onClick={() => void reread()}
            >
              {feedback.lock ? '核实质量结果' : '重新读取质量明细'}
            </Button>
            {!feedback.lock && canRecord && (
              <Button
                size="mobileTouch"
                disabled={blocked || !drafts.length}
                onClick={() => {
                  try {
                    qualityInput(key, drafts, data!, row.quantity);
                    setError(null);
                    setConfirming(true);
                  } catch (value) {
                    setError(value);
                  }
                }}
              >
                提交新增质量
              </Button>
            )}
          </>
        }
      >
        <p className="text-[13px] leading-6">
          {row.displayName} · {row.reportDate}
          。每次填报追加质量历史，不覆盖已有记录；抽检数量不能超过该条报量与当日总作业量。
        </p>
        <ErrorNotice error={error} />
        <ErrorNotice error={context.error} />
        {notice && <Alert>{notice}</Alert>}
        {feedback.lock && (
          <Alert>
            {feedback.foreignLock
              ? '此来源存在其他角色的待核实质量追加，请切回原角色核实，不可换角色重复追加。'
              : feedback.lock.status === 'success'
                ? '质量追加已成功，后续读取失败时仅重新读取，不再次追加。'
                : feedback.lock.status === 'unknown'
                  ? '质量追加结果尚未确认，已保留原填报并停止重发。'
                  : '质量来源、权限或任务状态已变化，请重新读取核对。'}
          </Alert>
        )}
        {context.isPending && <LoadingState>正在读取全部质量历史…</LoadingState>}
        {data && (
          <>
            {!reports.length && <Alert>当日暂无可录入质量的报量记录，暂不能保存质量记录。</Alert>}
            {!!reports.length && !data.items.some((item) => item.editable) && (
              <Alert>当日没有可编辑的质量记录，暂不能保存；已有质量记录仅供查看。</Alert>
            )}
            {reports.map((reportId) => {
              const history = data.items.filter((item) => item.outputReportId === reportId);
              const first = history[0]!;
              const editable = history.every((item) => item.editable);
              return (
                <Card asChild key={reportId}>
                  <article aria-label={`报量 ${reportId}`} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-base font-semibold">
                        报量 #{reportId} · {first.subtaskName || '项目级报量'}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {first.quantity} {first.quantityUnit} ·{' '}
                        {sourceNames[first.reportDataSource]}
                      </span>
                    </div>
                    {history.map((item) => (
                      <div
                        key={`${reportId}:${item.qualityId ?? 'none'}`}
                        className="space-y-1 rounded-lg bg-muted/30 p-3 text-[13px] leading-5"
                      >
                        {item.qualityId === null ? (
                          <p>暂无质量记录</p>
                        ) : (
                          <>
                            <p>
                              抽检 {item.inspectedQuantity} / 合格 {item.qualifiedQuantity} ·{' '}
                              {item.qualityDataSource
                                ? sourceNames[item.qualityDataSource]
                                : '未记录来源'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.operatorName || '未记录操作人'} ·{' '}
                              {item.operationTime || '未记录时间'}
                            </p>
                            {item.unqualifiedReason && (
                              <p className="whitespace-pre-wrap break-words">
                                {item.unqualifiedReason}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {canRecord && editable ? (
                      <Button
                        variant="outline"
                        size="mobileTouch"
                        disabled={
                          blocked ||
                          drafts.length >= 100 ||
                          drafts.some((draft) => draft.outputReportId === reportId)
                        }
                        onClick={() => {
                          if (feedback.sameSession() && !blocked)
                            setDrafts((value) => [
                              ...value,
                              {
                                id: crypto.randomUUID(),
                                outputReportId: reportId,
                                inspected: '',
                                qualified: '',
                                reason: '',
                              },
                            ]);
                        }}
                      >
                        新增质量记录
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        当前身份或此报量只读，不可追加人工质量。
                      </p>
                    )}
                  </article>
                </Card>
              );
            })}
            {!feedback.foreignLock &&
              drafts.map((draft, index) => (
                <section
                  key={draft.id}
                  aria-label={`新增质量记录 ${index + 1}`}
                  className="space-y-3 rounded-xl border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-base font-semibold">
                      新增质量记录 {index + 1} · 报量 #{draft.outputReportId}
                    </h3>
                    <Button
                      variant="dangerGhost"
                      size="mobileTouch"
                      disabled={blocked}
                      onClick={() =>
                        setDrafts((value) => value.filter((item) => item.id !== draft.id))
                      }
                    >
                      移除新增质量
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(['inspected', 'qualified'] as const).map((field) => (
                      <label key={field} className="space-y-2 text-[13px]">
                        {field === 'inspected' ? '抽检数量' : '合格数量'}
                        <Input
                          aria-label={field === 'inspected' ? '抽检数量' : '合格数量'}
                          inputMode="decimal"
                          value={draft[field]}
                          maxLength={64}
                          disabled={blocked}
                          onChange={(event) =>
                            setDrafts((value) =>
                              value.map((item) =>
                                item.id === draft.id
                                  ? { ...item, [field]: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  {qualityDifference(draft) !== null && (
                    <label className="block space-y-2 text-[13px]">
                      不合格原因（不合格数量：{qualityDifference(draft)}）
                      <Textarea
                        aria-label="不合格原因"
                        value={draft.reason}
                        rows={2}
                        maxLength={1000}
                        disabled={blocked}
                        onChange={(event) =>
                          setDrafts((value) =>
                            value.map((item) =>
                              item.id === draft.id ? { ...item, reason: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </label>
                  )}
                </section>
              ))}
          </>
        )}
      </Dialog>
      {confirming && (
        <Dialog
          title="确认追加质量"
          aria-label="确认追加质量"
          size="sm"
          busy={feedback.busy}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={feedback.busy}
                onClick={() => setConfirming(false)}
              >
                继续填写
              </Button>
              <Button
                size="mobileTouch"
                loading={feedback.busy}
                disabled={blocked}
                onClick={() => void submit()}
              >
                确认追加质量
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            将为 {row.displayName} 的 {row.reportDate} 报量追加 {drafts.length}{' '}
            条质量历史，全部成功或全部失败。已存在的历史记录会保留。
          </p>
        </Dialog>
      )}
    </>
  );
}
