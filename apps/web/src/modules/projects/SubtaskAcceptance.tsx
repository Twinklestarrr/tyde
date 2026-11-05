import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthUser,
  type ProductionAcceptanceSubmitInput,
  type ProductionTask,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';
import {
  acceptanceInput,
  acceptanceDefaultQuantity,
  validateAcceptanceContext,
  acceptanceSnapshotConfirmed,
  type AcceptanceDraft,
} from './quality-acceptance-form';

type AcceptancePending = {
  input: ProductionAcceptanceSubmitInput;
  baseline: ProductionTask;
  form: AcceptanceDraft;
};

/** PM提交与NAV审核分开；上下文canSubmit只控制当前可提交性，不能证明旧提交成功。 */
export function SubtaskAcceptance({
  user,
  projectId,
  subtask,
  canWrite,
  onChanged,
  onClose = () => {},
}: {
  user: AuthUser;
  projectId: number;
  subtask: ProductionTask;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onClose?: () => void;
}) {
  const cache = useQueryClient();
  const [form, setForm] = useState<AcceptanceDraft>({ quantity: '', date: '', remark: '' });
  const [dateTouched, setDateTouched] = useState(false);
  const [quantityTouched, setQuantityTouched] = useState(false);
  const dirty = quantityTouched || !!form.remark || dateTouched;
  const feedback = useProductionFeedback<AcceptancePending>(
    user,
    `acceptance:${projectId}:${subtask.subtaskId}`,
    dirty,
  );
  useEffect(() => {
    if (feedback.lock && !feedback.foreignLock && !form.quantity) setForm(feedback.lock.draft.form);
  }, [feedback.lock, feedback.foreignLock]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  function close() {
    if (feedback.busy) return;
    if (!feedback.lock && dirty && !window.confirm('验收草稿尚未提交，确认放弃？')) return;
    onClose();
  }
  const key = { projectId, subtaskId: subtask.subtaskId };
  const queryKey = ['production-acceptance', user.id, 'PM', projectId, subtask.subtaskId];
  const context = useQuery({
    queryKey,
    queryFn: async () => {
      feedback.requireIdentity();
      const result = await api.getProductionAcceptanceContext(key);
      feedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (!context.data) return;
    const day = context.data.defaultActualDeliveryDate;
    const quantity = acceptanceDefaultQuantity(context.data.defaultActualQuantity);
    setForm((value) => ({
      ...value,
      date: value.date || day,
      quantity: quantityTouched || feedback.lock ? value.quantity : quantity,
    }));
  }, [context.data, quantityTouched, feedback.lock]);
  const denied = error instanceof ApiError && [401, 403, 404].includes(error.status);
  const data = !context.isError && !denied && feedback.sameIdentity() ? context.data : undefined;
  const blocked =
    feedback.busy || !!feedback.lock || !canWrite || !data?.canSubmit || context.isFetching;
  async function readTask() {
    let current = 1;
    while (true) {
      feedback.requireSession();
      const page = await api.listProductionTasks({
        projectId,
        keyword: subtask.subtaskName,
        current,
        size: 100,
      });
      feedback.requireSession();
      const found = page.records.find((item) => item.subtaskId === subtask.subtaskId);
      if (found) return found;
      if (current >= page.pages) throw new Error('当前无法读取此子任务，不能确认验收提交状态。');
      current++;
    }
  }
  async function complete(state: ProductionWrite<AcceptancePending>) {
    feedback.requireOrigin();
    await feedback.finish(state, onChanged, () => context.refetch({ throwOnError: true }));
    if (feedback.sameSession()) onClose();
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
      feedback.requireOrigin();
      if (state?.status === 'success') {
        await complete(state);
        return;
      }
      if (state) {
        const task = await readTask();
        if (
          state.status === 'unknown' &&
          acceptanceSnapshotConfirmed(state.draft.input, state.draft.baseline, task)
        ) {
          feedback.markSuccess(state);
          await complete(state);
          return;
        }
      }
      await context.refetch({ throwOnError: true });
      feedback.requireSession();
      if (state?.status === 'unknown')
        setNotice(
          '已读取同一子任务的验收快照，但仍无法核实原提交的精确交付信息，继续保留草稿并暂停重发。',
        );
      else if (state) {
        feedback.clear(state);
        setNotice('已重新读取验收条件，请核对当前数据后再提交。');
      }
    } catch (value) {
      if (feedback.sameSession()) setError(value);
    } finally {
      feedback.stop();
    }
  }
  async function submit() {
    if (blocked || !feedback.start()) return;
    let state: ProductionWrite<AcceptancePending> | undefined;
    let written = false;
    setError(null);
    try {
      feedback.requireSession();
      feedback.requireOrigin();
      const latest = await api.getProductionAcceptanceContext(key);
      feedback.requireSession();
      cache.setQueryData(queryKey, latest);
      if (!latest.canSubmit)
        throw new Error('当前验收条件已变化，请重新读取并核对待核查、退回报量。');
      const baseline = await readTask();
      if (
        !['IN_PROGRESS', 'REWORK_REQUIRED'].includes(baseline.status) ||
        !baseline.allowedActions.includes('SUBMIT_ACCEPTANCE')
      )
        throw new Error('子任务当前不可提交验收，请重新读取。');
      validateAcceptanceContext(form, latest);
      const input = acceptanceInput(projectId, subtask.subtaskId, form);
      state = feedback.begin({ input, baseline, form });
      if (!state) return;
      await api.submitProductionAcceptance(input);
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setConfirming(false);
      setNotice('验收已提交，正在读取后续信息。');
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
  return (
    <>
      <Dialog
        title="子任务验收"
        aria-label="子任务验收"
        size="md"
        busy={feedback.busy}
        onClose={close}
        footer={
          <>
            <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={close}>
              关闭验收
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={feedback.busy || context.isFetching}
              onClick={() => void reread()}
            >
              {feedback.lock ? '核实验收结果' : '重新读取验收信息'}
            </Button>
            {canWrite && !feedback.lock && (
              <Button
                size="mobileTouch"
                disabled={blocked}
                onClick={() => {
                  try {
                    validateAcceptanceContext(form, data!);
                    acceptanceInput(projectId, subtask.subtaskId, form);
                    setError(null);
                    setConfirming(true);
                  } catch (value) {
                    setError(value);
                  }
                }}
              >
                提交验收
              </Button>
            )}
          </>
        }
      >
        <p className="break-words text-[13px] leading-6">
          {subtask.subtaskName} · {subtask.subtaskNo}
          。当前仅由主策略官提交验收，验收通过或驳回由领航员另行处理。
        </p>
        <ErrorNotice error={error} />
        <ErrorNotice error={context.error} />
        {notice && <Alert>{notice}</Alert>}
        {feedback.lock && (
          <Alert>
            {feedback.foreignLock
              ? '此子任务存在其他角色的待核实验收操作，请切回原角色核实；当前只读，不展示或恢复原草稿。'
              : feedback.lock.status === 'success'
                ? '验收提交已成功，当前仅重新读取后续信息，不会重复提交。'
                : feedback.lock.status === 'unknown'
                  ? '验收提交结果尚未确认，已保留原草稿并暂停重发；当前不可提交不等于原请求已成功。'
                  : '任务状态、报量或权限已变化，请先重新读取验收信息。'}
          </Alert>
        )}
        {context.isPending && <LoadingState>正在读取验收汇总…</LoadingState>}
        {data && (
          <>
            <dl className="grid grid-cols-2 gap-4 text-[13px]">
              {[
                ['预期交付量', `${data.expectedQuantity} ${data.quantityUnit}`],
                ['预期交付日期', data.expectedDeliveryDate],
                ['已核准报量', `${data.reportedQuantity} ${data.quantityUnit}`],
                ['待核查 / 退回', `${data.pendingCount} / ${data.returnedCount}`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {!data.canSubmit && (
              <Alert>
                当前不可提交：须至少有一条核准报量，且没有待核查或退回数据；已提交、已验收或当前身份只读时也不可提交。
              </Alert>
            )}
            <label className="block space-y-2 text-[13px]">
              实际交付量
              <Input
                aria-label="实际交付量"
                inputMode="decimal"
                maxLength={64}
                placeholder="请核对后填写实际交付量"
                value={form.quantity}
                disabled={blocked}
                onChange={(event) => {
                  setQuantityTouched(true);
                  setForm((value) => ({ ...value, quantity: event.target.value }));
                }}
              />
            </label>
            <label className="block space-y-2 text-[13px]">
              实际交付日期
              <Input
                type="date"
                aria-label="实际交付日期"
                value={form.date}
                disabled={blocked}
                onChange={(event) => {
                  setDateTouched(true);
                  setForm((value) => ({ ...value, date: event.target.value }));
                }}
              />
            </label>
            <label className="block space-y-2 text-[13px]">
              数量调整说明
              <Textarea
                aria-label="数量调整说明"
                value={form.remark}
                maxLength={1000}
                rows={3}
                disabled={blocked}
                onChange={(event) => setForm((value) => ({ ...value, remark: event.target.value }))}
              />
            </label>
            <p className="text-[13px] leading-6 text-muted-foreground">
              实际交付量与核准合计不一致时必须填写调整说明。请手动核对实际量；提交时会由服务端重新计算核准合计。
            </p>
          </>
        )}
      </Dialog>
      {confirming && (
        <Dialog
          title="确认提交验收"
          aria-label="确认提交验收"
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
                确认提交验收
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            确认以实际交付量 {form.quantity}、实际交付日期 {form.date} 提交“{subtask.subtaskName}
            ”验收？核准报量不会因此解锁。
          </p>
        </Dialog>
      )}
    </>
  );
}
