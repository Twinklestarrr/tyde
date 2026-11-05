import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthUser,
  type ProductionAcceptanceReviewInput,
  type ProductionTask,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { LoadingState } from '@/components/ui/empty-state';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';
import { productionFailureIsUnknown } from './production-task-form';
import { acceptanceReviewInput, acceptanceReviewSnapshotMatches } from './quality-acceptance-form';

interface ReviewPending {
  input: ProductionAcceptanceReviewInput;
  baseline: ProductionTask;
  reason: string;
}
const statusNames = {
  IN_PROGRESS: '进行中',
  PENDING_ACCEPTANCE: '待验收',
  REWORK_REQUIRED: '返修',
  ACCEPTED: '已验收',
};

/** NAV从真实子任务列表读取提交事实，不借用仅PM可访问的提交上下文。 */
export function NavigatorAcceptanceReview({
  user,
  projectId,
  subtask,
  onChanged,
  onClose,
}: {
  user: AuthUser;
  projectId: number;
  subtask: ProductionTask;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'ACCEPT' | 'REJECT' | null>(null);
  const [confirming, setConfirming] = useState<{
    decision: 'ACCEPT' | 'REJECT';
    baseline: ProductionTask;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const feedback = useProductionFeedback<ReviewPending>(
    user,
    `acceptance:${projectId}:${subtask.subtaskId}`,
    !!reason || decision !== null,
    'NAVIGATOR',
  );
  const pending = feedback.lock;
  useEffect(() => {
    if (pending && !feedback.foreignLock) {
      setReason(pending.draft.reason);
      setDecision(pending.draft.input.decision);
    }
  }, [pending, feedback.foreignLock]);
  const queryKey = [
    'navigator-production-acceptance',
    user.id,
    'NAVIGATOR',
    projectId,
    subtask.subtaskId,
  ];
  async function readTask() {
    let pages = 1;
    for (let current = 1; current <= pages; current++) {
      feedback.requireIdentity();
      const page = await api.listProductionTasks({ projectId, current, size: 100 });
      feedback.requireIdentity();
      const found = page.records.find((item) => item.subtaskId === subtask.subtaskId);
      if (found) return found;
      pages = page.pages;
    }
    throw new ApiError(404, {
      code: 'NOT_FOUND',
      message: '当前项目列表中已无该子任务，请刷新任务列表。',
    });
  }
  const query = useQuery({
    queryKey,
    queryFn: readTask,
    initialData: subtask,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const task = query.data;
  const blocked = !!pending || feedback.busy || !query.isSuccess || query.isFetching || !!readError;
  function canReview(action: 'ACCEPT' | 'REJECT', row = task) {
    return row.status === 'PENDING_ACCEPTANCE' && row.allowedActions.includes(action);
  }
  function close() {
    if (feedback.busy) return;
    if (!pending && (!!reason || decision) && !window.confirm('验收审核内容尚未提交，确认关闭？'))
      return;
    onClose();
  }
  async function reread() {
    if (!feedback.start()) return;
    setReadError(null);
    try {
      feedback.requireSession();
      if (feedback.foreignLock) {
        await query.refetch({ throwOnError: true });
        feedback.requireSession();
        feedback.requireOrigin();
        return;
      }
      if (pending?.status === 'success') {
        await feedback.finish(pending, onChanged, () => query.refetch({ throwOnError: true }));
        if (feedback.sameSession()) {
          setDecision(null);
          setReason('');
        }
      } else {
        await query.refetch({ throwOnError: true });
        feedback.requireSession();
        feedback.requireOrigin();
        if (pending?.status === 'unknown') {
          setNotice('已读取当前子任务，上次审核结果尚未确认；原决定和原因保留，继续暂停重发。');
          return;
        }
        if (pending) feedback.clear(pending);
      }
      if (feedback.sameSession()) {
        setError(null);
        setConfirming(null);
        setNotice('已读取最新验收状态，请重新核对本次提交。');
      }
    } catch (failure) {
      if (feedback.sameSession()) setReadError(failure);
    } finally {
      feedback.stop();
    }
  }
  function prepare(next: 'ACCEPT' | 'REJECT') {
    if (blocked || !canReview(next) || !feedback.sameSession()) return;
    setError(null);
    try {
      acceptanceReviewInput(projectId, task.subtaskId, next, reason);
      setDecision(next);
      setConfirming({ decision: next, baseline: task });
    } catch (failure) {
      setError(failure);
    }
  }
  async function submit() {
    if (!confirming || blocked || !feedback.start()) return;
    let state: ProductionWrite<ReviewPending> | undefined;
    let written = false;
    setError(null);
    setReadError(null);
    try {
      feedback.requireSession();
      feedback.requireOrigin();
      const latest = await readTask();
      feedback.requireSession();
      cache.setQueryData(queryKey, latest);
      if (!acceptanceReviewSnapshotMatches(confirming.baseline, latest))
        throw new Error('验收提交信息已变化，请核对最新详情后重新选择审核操作。');
      if (!canReview(confirming.decision, latest))
        throw new Error('当前子任务已不可执行该审核操作，请重新读取验收状态。');
      const input = acceptanceReviewInput(projectId, latest.subtaskId, confirming.decision, reason);
      state = feedback.begin({ input, baseline: latest, reason });
      if (!state) return;
      await api.reviewProductionAcceptance(input);
      written = true;
      feedback.markSuccess(state);
      if (!feedback.sameIdentity()) return;
      if (feedback.sameSession()) {
        setConfirming(null);
        setNotice('验收审核已提交，正在读取最新任务。');
      }
      await feedback.finish(state, onChanged, () => query.refetch({ throwOnError: true }));
      if (feedback.sameSession()) {
        setDecision(null);
        setReason('');
      }
    } catch (failure) {
      if (state && !written) {
        if (
          !productionFailureIsUnknown(failure) &&
          failure instanceof ApiError &&
          [400, 413, 422, 429].includes(failure.status)
        )
          feedback.clear(state);
        else feedback.markFailure(state, failure);
      }
      if (feedback.sameSession()) {
        if (written) {
          setReadError(failure);
          setNotice('验收审核已提交，最新状态读取失败；只需重新读取，不会重复提交。');
        } else {
          setError(failure);
          if (!state && failure instanceof ApiError) setReadError(failure);
        }
      }
    } finally {
      if (feedback.sameSession()) setConfirming(null);
      feedback.stop();
    }
  }
  return (
    <Dialog
      title="验收详情"
      aria-label="验收详情"
      closeLabel="关闭验收详情"
      size="lg"
      busy={feedback.busy}
      onClose={close}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 break-words text-base font-semibold">{task.subtaskName}</h3>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={feedback.busy || query.isFetching}
          onClick={() => void reread()}
        >
          重新读取验收状态
        </Button>
      </div>
      <ErrorNotice error={query.error} />
      <ErrorNotice error={readError} />
      {query.isFetching && <LoadingState>正在读取验收信息…</LoadingState>}
      <p className="text-[13px]">
        {task.subtaskNo} · {statusNames[task.status]}
      </p>
      <dl className="grid min-w-0 grid-cols-2 gap-4 text-[13px]">
        {[
          ['预期交付量', `${task.expectedQuantity} ${task.quantityUnit}`],
          ['预期交付日期', task.expectedDeliveryDate],
          [
            '已核准报量',
            task.reportedQuantity === null
              ? '未提交'
              : `${task.reportedQuantity} ${task.quantityUnit}`,
          ],
          [
            '实际交付量',
            task.actualQuantity === null ? '未提交' : `${task.actualQuantity} ${task.quantityUnit}`,
          ],
          ['实际交付日期', task.actualDeliveryDate || '未提交'],
          ['验收提交人', task.submittedByName || '未记录'],
          ['提交时间', task.submittedAt || '未提交'],
          ['审核时间', task.reviewedAt || '未审核'],
          ['审核人', task.reviewedByName || '未记录'],
        ].map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {task.quantityAdjustmentRemark && (
        <p className="whitespace-pre-wrap break-words text-[13px]">
          数量调整说明：{task.quantityAdjustmentRemark}
        </p>
      )}
      {task.rejectReason && <Alert variant="destructive">返修原因：{task.rejectReason}</Alert>}
      {pending && (
        <Alert>
          {feedback.foreignLock
            ? '此子任务存在其他角色的待核实验收操作，请切回原角色处理；当前仅可查看，不能恢复原稿或重复提交。'
            : pending.status === 'success'
              ? '验收审核已提交，后续读取尚未完成；只需重新读取验收状态。'
              : pending.status === 'unknown'
                ? '上次审核结果尚未确认，原决定和原因已保留；读取当前状态不能证明本次命令结果，不会重复提交。'
                : '验收状态或权限已变化，请重新读取后核对，原决定和原因已保留。'}
        </Alert>
      )}
      {!feedback.foreignLock && (canReview('ACCEPT') || canReview('REJECT') || pending) && (
        <div className="space-y-2">
          {decision && pending && (
            <p className="text-[13px]">
              原审核决定：{decision === 'ACCEPT' ? '通过验收' : '驳回验收'}
            </p>
          )}
          <label
            htmlFor={`acceptance-review-reason-${task.subtaskId}`}
            className="text-[13px] font-medium"
          >
            驳回原因
          </label>
          <Textarea
            id={`acceptance-review-reason-${task.subtaskId}`}
            value={reason}
            maxLength={500}
            rows={4}
            disabled={blocked}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            驳回时必填，最多500字；通过验收时不提交原因。
          </p>
        </div>
      )}
      <ErrorNotice error={error} />
      {notice && (
        <p role="status" className="text-[13px] text-primary">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3 border-t pt-4">
        <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={close}>
          关闭
        </Button>
        {canReview('REJECT') && (
          <Button
            variant="destructiveOutline"
            size="mobileTouch"
            disabled={blocked}
            onClick={() => prepare('REJECT')}
          >
            驳回验收
          </Button>
        )}
        {canReview('ACCEPT') && (
          <Button size="mobileTouch" disabled={blocked} onClick={() => prepare('ACCEPT')}>
            通过验收
          </Button>
        )}
      </div>
      {confirming && (
        <Dialog
          title={confirming.decision === 'ACCEPT' ? '确认通过验收' : '确认驳回验收'}
          aria-label={confirming.decision === 'ACCEPT' ? '确认通过验收' : '确认驳回验收'}
          size="sm"
          busy={feedback.busy}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={feedback.busy}
                onClick={() => setConfirming(null)}
              >
                返回核对
              </Button>
              <Button size="mobileTouch" loading={feedback.busy} onClick={() => void submit()}>
                {confirming.decision === 'ACCEPT' ? '确认通过' : '确认驳回'}
              </Button>
            </>
          }
        >
          <p className="break-words text-[13px]">{task.subtaskName}</p>
          <p className="whitespace-pre-wrap break-words text-[13px]">
            {confirming.decision === 'ACCEPT'
              ? '确认通过本次提交的子任务验收？'
              : `驳回原因：${reason.trim()}`}
          </p>
        </Dialog>
      )}
    </Dialog>
  );
}
