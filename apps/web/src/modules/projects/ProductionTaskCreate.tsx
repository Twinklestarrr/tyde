import { useState } from 'react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ProductionTaskMembers } from './ProductionTaskMembers';
import { productionTaskInput, type ProductionTaskDraft } from './production-task-form';
import { productionPlanToday } from './production-plan-form';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';

export function ProductionTaskCreate({
  user,
  projectId,
  canWrite,
  initialDraft,
  quantityUnit,
  onChanged,
  onClose,
}: {
  user: AuthUser;
  projectId: number;
  canWrite: boolean;
  initialDraft?: ProductionTaskDraft;
  quantityUnit?: string | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ProductionTaskDraft>(
    () =>
      initialDraft ?? {
        name: '',
        quantity: '',
        date: productionPlanToday(),
        mode: 'POOL',
        memberIds: [],
      },
  );
  const feedback = useProductionFeedback<ProductionTaskDraft>(
    user,
    `create:${projectId}`,
    !!draft.name ||
      !!draft.quantity ||
      draft.memberIds.length > 0 ||
      draft.date !== productionPlanToday(),
  );
  const [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const blocked = feedback.busy || !!feedback.lock || !canWrite;
  function close() {
    if (feedback.busy) return;
    if (
      !feedback.lock &&
      (draft.name ||
        draft.quantity ||
        draft.memberIds.length ||
        draft.date !== productionPlanToday()) &&
      !window.confirm('创建草稿尚未提交，确认放弃？')
    )
      return;
    onClose();
  }
  async function complete(state: ProductionWrite<ProductionTaskDraft>) {
    await feedback.finish(state, onChanged);
    if (feedback.sameSession()) onClose();
  }
  async function reread() {
    if (!feedback.start()) return;
    setError(null);
    const state = feedback.lock;
    try {
      feedback.requireSession();
      if (state?.status === 'success') await complete(state);
      else {
        await api.listProductionTasks({
          projectId,
          current: 1,
          size: 20,
          keyword: state?.draft.name ?? draft.name,
        });
        feedback.requireSession();
        if (state && state.status !== 'unknown') {
          feedback.clear(state);
          setNotice('已读取当前生产任务，请核对名称、人员及权限后重新创建。');
        } else if (state)
          setNotice('已读取当前任务，仍无法精确确认上次创建结果，草稿继续保留并暂停重发。');
      }
    } catch (value) {
      if (feedback.sameSession()) setError(value);
    } finally {
      feedback.stop();
    }
  }
  async function submit() {
    if (blocked || !feedback.start()) return;
    setError(null);
    let state: ProductionWrite<ProductionTaskDraft> | undefined;
    let written = false;
    try {
      feedback.requireSession();
      const input = productionTaskInput(projectId, draft);
      state = feedback.begin(draft);
      if (!state) return;
      await api.createProductionTask(input);
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setNotice('子任务已创建。');
      await complete(state);
    } catch (value) {
      if (state && !written) feedback.markFailure(state, value);
      if (feedback.sameSession()) {
        setError(value);
        if (written) setNotice('子任务已创建，后续信息读取失败，请重新读取创建结果。');
      }
    } finally {
      feedback.stop();
    }
  }
  return (
    <Dialog
      title="创建生产子任务"
      aria-label="创建生产子任务"
      size="lg"
      busy={feedback.busy}
      onClose={close}
      footer={
        <>
          <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={close}>
            取消创建
          </Button>
          {feedback.lock ? (
            <Button size="mobileTouch" loading={feedback.busy} onClick={() => void reread()}>
              重新读取创建结果
            </Button>
          ) : (
            <Button
              size="mobileTouch"
              loading={feedback.busy}
              disabled={blocked}
              onClick={() => void submit()}
            >
              确认创建子任务
            </Button>
          )}
        </>
      }
    >
      <ErrorNotice error={error} />
      {notice && <Alert>{notice}</Alert>}
      {feedback.lock && (
        <Alert>
          {feedback.lock.status === 'unknown'
            ? '创建结果尚未确认，草稿已保留并暂停重发。'
            : feedback.lock.status === 'success'
              ? '子任务已创建，后续信息尚未读取完成，请重新读取创建结果。'
              : '成员、名称或权限已变化，请重新读取后核对。'}
        </Alert>
      )}
      <label className="block space-y-2 text-[13px]">
        子任务名称
        <Input
          aria-label="子任务名称"
          maxLength={128}
          value={draft.name}
          disabled={blocked}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-[13px]">
          预期交付量{quantityUnit ? `（${quantityUnit}）` : ''}
          <Input
            aria-label="预期交付量"
            inputMode="decimal"
            maxLength={64}
            value={draft.quantity}
            disabled={blocked}
            onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">
            最多26位整数、4位小数，按输入精确提交。
          </span>
        </label>
        <label className="space-y-2 text-[13px]">
          预期交付日期
          <Input
            aria-label="预期交付日期"
            type="date"
            min={productionPlanToday()}
            value={draft.date}
            disabled={blocked}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
        </label>
      </div>
      <fieldset disabled={blocked} className="flex flex-wrap gap-4">
        {(
          [
            ['POOL', '任务池'],
            ['DESIGNATED', '指定人员'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="production-distribution"
              className="size-4 accent-primary"
              checked={draft.mode === value}
              onChange={() => setDraft({ ...draft, mode: value })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {draft.mode === 'POOL' ? (
        <p className="text-[13px] text-muted-foreground">
          创建到任务池，成员首次有效报量后才记为认领；本次不指定人员。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span>已指定 {draft.memberIds.length} / 1000 名（跨页保留）</span>
            <Button
              variant="outline"
              size="mobileTouch"
              disabled={blocked || !draft.memberIds.length}
              onClick={() => setDraft({ ...draft, memberIds: [] })}
            >
              清空指定成员
            </Button>
          </div>
          <ProductionTaskMembers
            user={user}
            projectId={projectId}
            selectedIds={draft.memberIds}
            disabled={blocked}
            onSelect={(id, checked) => {
              if (blocked) return;
              setDraft((old) => ({
                ...old,
                memberIds: checked
                  ? [...old.memberIds, id]
                  : old.memberIds.filter((memberId) => memberId !== id),
              }));
            }}
          />
        </>
      )}
    </Dialog>
  );
}
