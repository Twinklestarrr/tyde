/** 组织退出审批：服务端分页、节点历史和冻结双版本的审批确认。 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type OrganizationNodeStatus,
  type OrganizationPendingApproval,
  type OrganizationApprovalProcessInput,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { SegmentedControl } from '@/components/ui/shared/SegmentedControl';
import { api } from '@/services/api';
import {
  OrganizationDialog,
  OrganizationPagination,
  orgControlClass,
  organizationTime,
} from './common';

interface OrganizationApprovalsProps {
  orgId: string;
  user: AuthUser;
  position: 'OWNER' | 'ADMIN';
  onSessionChanged: () => Promise<void>;
}

const nodeLabels: Record<OrganizationNodeStatus, string> = {
  WAITING: '等待中',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  SKIPPED: '已跳过',
  CANCELED: '已取消',
  TRANSFERRED: '已转派',
};
const historyStatuses: OrganizationNodeStatus[] = [
  'APPROVED',
  'REJECTED',
  'SKIPPED',
  'CANCELED',
  'TRANSFERRED',
];

/** 账号或组织变化时丢弃原审批选择、表单及分页状态。 */
export function OrganizationApprovals(props: OrganizationApprovalsProps) {
  return <ApprovalPanel key={`${props.user.id}:${props.orgId}`} {...props} />;
}

/** 所有列表和变更均来自真实接口，写操作失败后只回读、不自动重放。 */
function ApprovalPanel({ orgId, user, position, onSessionChanged }: OrganizationApprovalsProps) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const [current, setCurrent] = useState(1);
  const size = 10;
  const [status, setStatus] = useState<OrganizationNodeStatus | ''>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [selection, setSelection] = useState<{
    record: OrganizationPendingApproval;
    action: 'APPROVE' | 'REJECT';
  } | null>(null);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const queryPrefix = ['organization', user.id, orgId] as const;
  const rangeError =
    view === 'history' && startDate && endDate && startDate > endDate
      ? '开始日期不能晚于结束日期'
      : '';
  const pending = useQuery({
    queryKey: [...queryPrefix, 'approvals', 'pending', current, size],
    queryFn: () =>
      api.listPendingOrganizationApprovals({
        orgId,
        businessType: 'ORG_MEMBER_EXIT',
        current,
        size,
      }),
    enabled: view === 'pending',
    retry: false,
    refetchOnWindowFocus: false,
  });
  const history = useQuery({
    queryKey: [...queryPrefix, 'approvals', 'history', current, size, status, startDate, endDate],
    queryFn: () =>
      api.listOrganizationApprovalRecords({
        orgId,
        businessType: 'ORG_MEMBER_EXIT',
        current,
        size,
        ...(status ? { status } : {}),
        ...(startDate ? { startAt: `${startDate} 00:00:00` } : {}),
        ...(endDate ? { endAt: `${endDate} 23:59:59` } : {}),
      }),
    enabled: view === 'history' && !rangeError,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const process = useMutation({
    mutationFn: (input: OrganizationApprovalProcessInput) => api.processOrganizationApproval(input),
    retry: false,
  });
  const active = view === 'pending' ? pending : history;

  /** 冻结点击时的节点和流程版本；后台列表刷新不替换确认中的版本。 */
  function openApproval(record: OrganizationPendingApproval, action: 'APPROVE' | 'REJECT') {
    if (busy || position !== 'OWNER') return;
    setSelection({ record, action });
    setComment('');
    setCommentError('');
    setError(null);
    setNotice('');
  }

  /** 409 后保留错误并刷新列表，原确认失效，用户需重新选择最新节点。 */
  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || submitted.current || position !== 'OWNER') return;
    const normalized = comment.trim();
    if (selection.action === 'REJECT' && !normalized) {
      setCommentError('驳回时请填写审批意见');
      return;
    }
    if (normalized.length > 1000) {
      setCommentError('审批意见最多 1000 字符');
      return;
    }
    submitted.current = true;
    setBusy(true);
    setError(null);
    const { record, action } = selection;
    try {
      await process.mutateAsync({
        orgId,
        flowNo: record.flowNo,
        nodeId: record.nodeId,
        nodeVersionNo: record.nodeVersionNo,
        flowVersionNo: record.flowVersionNo,
        action,
        ...(normalized ? { actionComment: normalized } : {}),
      });
      if (mounted.current) {
        setSelection(null);
        setNotice(action === 'APPROVE' ? '审批已通过' : '申请已驳回');
      }
      try {
        await queryClient.cancelQueries({ queryKey: queryPrefix });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryPrefix }, { throwOnError: true }),
          onSessionChanged(),
        ]);
      } catch {
        if (mounted.current) setNotice('审批已处理，但读取最新数据失败，请手动刷新列表');
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure);
      if (failure instanceof ApiError && failure.status === 409) {
        setSelection(null);
        setNotice('审批版本已变化，已重新读取列表。请核对最新记录后重新选择。');
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: queryPrefix }),
          onSessionChanged(),
        ]);
      }
    } finally {
      submitted.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Card asChild>
      <section aria-label="组织审批" className="text-[13px]">
        <CardHeader className="flex-row flex-wrap items-center justify-between">
          <div>
            <CardTitle>组织退出审批</CardTitle>
            <CardDescription className="mt-[4px]">
              当前展示退出组织的待办与处理记录。
            </CardDescription>
          </div>
          <Button
            size="formCompactMobileTouch"
            variant="outline"
            disabled={active.isFetching || busy || Boolean(rangeError)}
            onClick={() => void active.refetch()}
          >
            <RefreshCw className="size-[14px]" aria-hidden />
            刷新审批列表
          </Button>
        </CardHeader>
        <CardContent className="space-y-[20px]">
          <SegmentedControl
            variant="soft"
            className="w-fit"
            name="organization-approval-view"
            ariaLabel="组织审批视图"
            value={view}
            options={[
              { value: 'pending', label: '待审批' },
              { value: 'history', label: '审批记录' },
            ]}
            onValueChange={(value) => {
              setView(value);
              setCurrent(1);
            }}
            disabled={busy}
          />
          {view === 'history' && (
            <div className="grid gap-[12px] rounded-[8px] bg-[var(--color-surface-muted)] p-[12px] sm:grid-cols-3 lg:max-w-[760px]">
              <FormField controlId="organization-approval-status" label="处理状态">
                <select
                  id="organization-approval-status"
                  className={orgControlClass}
                  value={status}
                  disabled={busy}
                  onChange={(event) => {
                    const value = historyStatuses.find((item) => item === event.target.value) ?? '';
                    setStatus(value);
                    setCurrent(1);
                  }}
                >
                  <option value="">全部状态</option>
                  {historyStatuses.map((value) => (
                    <option key={value} value={value}>
                      {nodeLabels[value]}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField
                controlId="organization-approval-start"
                label="处理开始日期"
                error={rangeError}
              >
                {({ invalid, describedBy }) => (
                  <Input
                    size="profile"
                    id="organization-approval-start"
                    type="date"
                    value={startDate}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    disabled={busy}
                    onChange={(event) => {
                      setStartDate(event.target.value);
                      setCurrent(1);
                    }}
                  />
                )}
              </FormField>
              <FormField controlId="organization-approval-end" label="处理结束日期">
                <Input
                  size="profile"
                  id="organization-approval-end"
                  type="date"
                  value={endDate}
                  disabled={busy}
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    setCurrent(1);
                  }}
                />
              </FormField>
            </div>
          )}
          {notice && (
            <p role="status" className="rounded-[8px] bg-[var(--color-primary-soft)] p-[12px]">
              {notice}
            </p>
          )}
          {error != null && <ErrorNotice error={error} />}
          {active.isError && <ErrorNotice error={active.error} />}
          {rangeError ? null : active.isPending ? (
            <LoadingState>正在读取审批列表…</LoadingState>
          ) : active.isError ? null : (
            <>
              {active.data?.records.length === 0 && (
                <EmptyState
                  icon={<ClipboardCheck className="size-[22px]" aria-hidden />}
                  title={view === 'pending' ? '暂无待审批事项' : '暂无审批记录'}
                  description={
                    view === 'pending'
                      ? '新的组织退出申请会显示在这里。'
                      : '处理后的组织退出申请会显示在这里。'
                  }
                />
              )}
              <div className="space-y-[12px]">
                {view === 'pending'
                  ? pending.data?.records.map((record) => (
                      <Card asChild key={`${record.flowNo}:${record.nodeId}`}>
                        <article className="space-y-[16px] p-[20px]">
                          <div className="flex items-start justify-between gap-[12px]">
                            <h3 className="min-w-0 break-words text-[14px] font-semibold">
                              {record.title}
                            </h3>
                            <ApprovalStatus status="PENDING" />
                          </div>
                          <ApprovalDetails record={record} />
                          <div className="flex flex-wrap items-center justify-between gap-[12px] border-t pt-[12px]">
                            <p className="text-[13px] text-[var(--color-neutral-strong)]">
                              审批节点：{record.nodeName} · 待审批
                            </p>
                            {position === 'OWNER' && (
                              <div className="ml-auto flex flex-wrap gap-[8px]">
                                <Button
                                  size="formCompactMobileTouch"
                                  disabled={busy}
                                  onClick={() => openApproval(record, 'APPROVE')}
                                >
                                  同意通过
                                </Button>
                                <Button
                                  size="formCompactMobileTouch"
                                  variant="destructiveOutline"
                                  disabled={busy}
                                  onClick={() => openApproval(record, 'REJECT')}
                                >
                                  驳回请求
                                </Button>
                              </div>
                            )}
                          </div>
                        </article>
                      </Card>
                    ))
                  : history.data?.records.map((record) => (
                      <Card asChild key={`${record.flowNo}:${record.nodeId}`}>
                        <article className="space-y-[16px] p-[20px]">
                          <div className="flex items-start justify-between gap-[12px]">
                            <h3 className="min-w-0 break-words text-[14px] font-semibold">
                              {record.title}
                            </h3>
                            <ApprovalStatus status={record.nodeStatus} />
                          </div>
                          <ApprovalDetails record={record} />
                          <div className="space-y-[10px] border-t pt-[12px]">
                            <div className="flex flex-wrap gap-x-[24px] gap-y-[6px] text-[13px] text-[var(--color-neutral-strong)]">
                              <p>审批人：{record.operatorName || '—'}</p>
                              <p>审批时间：{organizationTime(record.actionAt)}</p>
                            </div>
                            {record.actionComment && (
                              <p className="whitespace-pre-wrap break-words text-[13px] leading-[22px]">
                                <span className="text-[var(--color-neutral-strong)]">
                                  审批意见：
                                </span>
                                {record.actionComment}
                              </p>
                            )}
                          </div>
                        </article>
                      </Card>
                    ))}
              </div>
              {active.data && (
                <OrganizationPagination
                  current={active.data.current}
                  size={active.data.size}
                  total={active.data.total}
                  loading={active.isFetching || busy}
                  onPageChange={setCurrent}
                />
              )}
            </>
          )}
          {selection && (
            <OrganizationDialog
              title={selection.action === 'APPROVE' ? '确认通过退出申请' : '驳回退出申请'}
              busy={busy}
              onClose={() => setSelection(null)}
            >
              <form className="space-y-[16px]" onSubmit={(event) => void submitApproval(event)}>
                <p>申请人：{selection.record.applicantName || '—'}</p>
                <p className="whitespace-pre-wrap break-words">
                  申请原因：{selection.record.applyReason || '—'}
                </p>
                <FormField
                  controlId="organization-approval-comment"
                  label="审批意见"
                  required={selection.action === 'REJECT'}
                  error={commentError}
                >
                  {({ invalid, describedBy }) => (
                    <Textarea
                      id="organization-approval-comment"
                      value={comment}
                      maxLength={1000}
                      disabled={busy}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        setComment(event.target.value);
                        setCommentError('');
                      }}
                    />
                  )}
                </FormField>
                {error != null && <ErrorNotice error={error} />}
                <div className="flex justify-end gap-[8px]">
                  <Button
                    variant="ghost"
                    size="mobileTouch"
                    disabled={busy}
                    onClick={() => setSelection(null)}
                  >
                    取消
                  </Button>
                  <Button
                    type="submit"
                    size="mobileTouch"
                    variant={selection.action === 'APPROVE' ? 'default' : 'destructive'}
                    loading={busy}
                  >
                    确认{selection.action === 'APPROVE' ? '通过' : '驳回'}
                  </Button>
                </div>
              </form>
            </OrganizationDialog>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

/** 待办和已办共用真实申请快照，不从本地成员或当前时间推造历史。 */
function ApprovalDetails({
  record,
}: {
  record: {
    applicantName: string | null;
    targetMemberName: string | null;
    appliedAt: string;
    plannedLeaveDate: string | null;
    applyReason: string | null;
    flowNo: string;
  };
}) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-[24px] gap-y-[14px] text-[13px] [overflow-wrap:anywhere] sm:grid-cols-2">
      <div>
        <dt className="text-[var(--color-neutral-strong)]">申请人：</dt>
        <dd className="mt-[3px]">{record.applicantName || '—'}</dd>
      </div>
      <div>
        <dt className="text-[var(--color-neutral-strong)]">目标成员：</dt>
        <dd className="mt-[3px]">{record.targetMemberName || '—'}</dd>
      </div>
      <div>
        <dt className="text-[var(--color-neutral-strong)]">申请时间：</dt>
        <dd className="mt-[3px] tabular-nums">{organizationTime(record.appliedAt)}</dd>
      </div>
      <div>
        <dt className="text-[var(--color-neutral-strong)]">拟离职日期：</dt>
        <dd className="mt-[3px] tabular-nums">{record.plannedLeaveDate || '—'}</dd>
      </div>
      <div className="col-span-full rounded-[8px] bg-[var(--color-surface-muted)] px-[12px] py-[10px]">
        <dt className="text-[var(--color-neutral-strong)]">申请原因：</dt>
        <dd className="mt-[4px] whitespace-pre-wrap leading-[22px]">{record.applyReason || '—'}</dd>
      </div>
      <div className="col-span-full text-[12px] text-[var(--color-neutral-strong)]">
        <dt className="inline">流程编号：</dt>
        <dd className="inline">{record.flowNo}</dd>
      </div>
    </dl>
  );
}

/** 用真实节点状态显示文字与语义底色，不依赖颜色传达处理结果。 */
function ApprovalStatus({ status }: { status: OrganizationNodeStatus }) {
  const tone =
    status === 'APPROVED'
      ? 'border-[var(--color-success-border)] bg-[var(--color-success-soft)]'
      : status === 'REJECTED'
        ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-soft)]'
        : status === 'PENDING' || status === 'WAITING'
          ? 'border-[var(--color-warning-border)] bg-[var(--color-warning-soft)]'
          : 'border-border bg-[var(--color-surface-muted)]';
  return (
    <span
      className={`shrink-0 rounded-full border px-[8px] py-[3px] text-[12px] font-medium text-[var(--color-neutral-strong)] ${tone}`}
    >
      {nodeLabels[status]}
    </span>
  );
}
