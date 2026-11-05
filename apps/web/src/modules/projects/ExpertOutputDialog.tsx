import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  ExpertTask,
  ProductionOutputReport,
  ReportableProductionTask,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { productionPlanToday } from './production-plan-form';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';
import {
  expertCorrectionInput,
  expertReportInput,
  isExpertProductionTask,
  newExpertReportDraft,
  sameExpertProductionSource,
  type ExpertReportDraft,
} from './expert-production-form';

export type ExpertOutputPending = (
  | { kind: 'save'; rows: ExpertReportDraft[] }
  | { kind: 'correct'; report: ProductionOutputReport; quantity: string; remark: string }
) & { source: string };
export type ExpertOutputIntent =
  { kind: 'save'; subtaskId: number | null } | { kind: 'correct'; report: ProductionOutputReport };
export const expertOutputSource = (task: ExpertTask) => `expert-output:${task.basicInfo.projectId}`;
export const expertOutputOrigin = (task: ExpertTask) =>
  JSON.stringify([task.sourceBizType, task.sourceBizId, task.basicInfo.organizationId]);

function OutputSelect({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId(),
    [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setPortal} className="min-w-0 space-y-2 text-[13px]">
      <label htmlFor={id}>{label}</label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label} size="profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent container={portal}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** 项目共用写锁，草稿仍绑定原来源，避免从另一张卡片重复执行同一笔报量。 */
export function ExpertOutputDialog({
  user,
  task,
  intent,
  initialPending,
  reportable,
  canReport,
  onChanged,
  onClose,
}: {
  user: AuthUser;
  task: ExpertTask;
  intent: ExpertOutputIntent;
  initialPending?: ExpertOutputPending;
  reportable: ReportableProductionTask[];
  canReport: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const projectId = task.basicInfo.projectId;
  const [draft, setDraft] = useState<ExpertOutputPending>(
    () =>
      initialPending ??
      (intent.kind === 'save'
        ? {
            kind: 'save',
            source: expertOutputOrigin(task),
            rows: [newExpertReportDraft(intent.subtaskId)],
          }
        : {
            kind: 'correct',
            source: expertOutputOrigin(task),
            report: intent.report,
            quantity: '',
            remark: intent.report.remark ?? '',
          }),
  );
  const dirty =
    draft.kind === 'save'
      ? draft.rows.some(
          (row) =>
            !!row.quantity ||
            !!row.remark ||
            row.memberId !== null ||
            row.date !== productionPlanToday(),
        )
      : !!draft.quantity || draft.remark !== (draft.report.remark ?? '');
  const feedback = useProductionFeedback<ExpertOutputPending>(
    user,
    expertOutputSource(task),
    dirty,
    'EXPERT',
  );
  const [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  // 原报量规则依赖服务端待报日期；接入前禁止新报量，保留表单以待恢复。
  const blocked =
    ['save'].includes(draft.kind) ||
    feedback.busy ||
    !!feedback.lock ||
    feedback.foreignLock ||
    (draft.kind === 'save' &&
      (!canReport ||
        !reportable.length ||
        draft.rows.some(
          (row) =>
            row.subtaskId === null || !reportable.some((item) => item.subtaskId === row.subtaskId),
        )));
  async function requireTask(save: boolean) {
    feedback.requireSession();
    const tasks = await api.getMyExpertTasks();
    feedback.requireSession();
    const latest = tasks.find((item) => sameExpertProductionSource(item, task));
    if (!latest || !isExpertProductionTask(latest) || (save && !latest.operations.canReportOutput))
      throw new Error('当前来源已无对应报量能力，请刷新项目并核对本人或负责人资格。');
    return latest;
  }
  async function latestReport(report: ProductionOutputReport) {
    let current = 1;
    while (true) {
      feedback.requireSession();
      const result = await api.listProductionOutputReports({
        projectId,
        subtaskId: report.subtaskId,
        keyword: report.uid,
        reportDateStart: report.reportDate,
        reportDateEnd: report.reportDate,
        current,
        size: 100,
      });
      feedback.requireSession();
      const found = result.page.records.find((row) => row.reportId === report.reportId);
      if (found) return found;
      if (current >= result.page.pages)
        throw new Error('当前无法读取原退回报量，请重新打开报量列表。');
      current++;
    }
  }
  async function complete(state: ProductionWrite<ExpertOutputPending>) {
    await feedback.finish(state, async () => {
      await onChanged();
      if (!feedback.sameIdentity()) return;
      await Promise.all(
        [
          'expert-reportable-production',
          'expert-production-tasks',
          'production-output-reports',
          'personnel-production',
        ].map((key) =>
          cache.invalidateQueries(
            { queryKey: [key, user.id, 'EXPERT', projectId] },
            { throwOnError: true },
          ),
        ),
      );
    });
    if (feedback.sameSession()) onClose();
  }
  async function reread() {
    if (!feedback.start()) return;
    setError(null);
    const state = feedback.lock;
    try {
      feedback.requireSession();
      feedback.requireOrigin();
      if (state && state.draft.source !== expertOutputOrigin(task))
        throw new Error('本项目其他来源仍有待核实报量，请返回原来源核实。');
      if (state?.status === 'success') {
        await complete(state);
        return;
      }
      const subtaskId =
        draft.kind === 'save' ? (draft.rows[0]?.subtaskId ?? null) : draft.report.subtaskId;
      await api.listProductionOutputReports({ projectId, subtaskId, current: 1, size: 20 });
      feedback.requireSession();
      if (state?.status === 'unknown') {
        setNotice(
          '已读取当前层级报量，仍无法精确确认上次提交结果。原内容继续保留，系统不会重复提交。',
        );
      } else if (state) {
        await requireTask(draft.kind === 'save');
        if (draft.kind === 'correct') {
          const latest = await latestReport(draft.report);
          if (!latest.allowedActions.includes('SAVE_REPORT'))
            throw new Error('原报量已不可修正，保留原稿供核对。');
          setDraft({ ...draft, report: latest });
        }
        feedback.clear(state);
        setNotice('已读取当前资格与报量，请核对原内容后再提交。');
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
    let state: ProductionWrite<ExpertOutputPending> | undefined;
    let written = false;
    try {
      await requireTask(draft.kind === 'save');
      if (draft.kind === 'save') {
        const currentTasks = await api.listReportableProductionTasks(projectId);
        feedback.requireSession();
        if (
          draft.rows.some((row) => !currentTasks.some((item) => item.subtaskId === row.subtaskId))
        )
          throw new Error('该子任务已不可报量，请重新选择。');
        const input = expertReportInput(projectId, draft.rows);
        state = feedback.begin(draft);
        if (!state) return;
        await api.saveProductionOutputReports(input);
      } else {
        const latest = await latestReport(draft.report);
        const input = expertCorrectionInput(projectId, latest, draft.quantity, draft.remark);
        state = feedback.begin({ ...draft, report: latest });
        if (!state) return;
        await api.correctProductionOutputReport(input);
      }
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setNotice(draft.kind === 'save' ? '生产报量已提交。' : '生产报量已修正。');
      await complete(state);
    } catch (value) {
      if (state && !written) feedback.markFailure(state, value);
      if (feedback.sameSession()) {
        setError(value);
        if (written) setNotice('报量操作已保存，后续待办读取失败，请重新读取报量结果。');
      }
    } finally {
      feedback.stop();
    }
  }
  function close() {
    if (feedback.busy) return;
    if (!feedback.lock && dirty && !window.confirm('报量草稿尚未提交，确认放弃？')) return;
    onClose();
  }
  function updateRow(key: string, patch: Partial<ExpertReportDraft>) {
    setDraft((old) =>
      old.kind === 'save'
        ? { ...old, rows: old.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) }
        : old,
    );
  }
  const tasks = new Map(reportable.map((item) => [item.subtaskId, item]));
  const scopeOptions = reportable.map((item) => ({
    value: String(item.subtaskId),
    label: item.subtaskName,
  }));
  return (
    <Dialog
      title={draft.kind === 'save' ? '填写生产报量' : '修正生产报量'}
      aria-label={draft.kind === 'save' ? '填写生产报量' : '修正生产报量'}
      size="lg"
      busy={feedback.busy}
      onClose={close}
      footer={
        <>
          <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={close}>
            关闭报量
          </Button>
          {feedback.lock ? (
            <Button size="mobileTouch" loading={feedback.busy} onClick={() => void reread()}>
              重新读取报量结果
            </Button>
          ) : (
            <Button
              size="mobileTouch"
              loading={feedback.busy}
              disabled={blocked || draft.kind === 'save'}
              onClick={() => void submit()}
            >
              {draft.kind === 'save' ? '确认提交报量' : '确认提交修正'}
            </Button>
          )}
        </>
      }
    >
      <ErrorNotice error={error} />
      {notice && <Alert>{notice}</Alert>}
      {feedback.lock && (
        <Alert>
          {feedback.lock.status === 'success'
            ? '操作已保存，后续信息尚未读取完成；只需重试读取。'
            : feedback.lock.status === 'unknown'
              ? '报量结果尚未确认，原内容已保留并暂停重发。'
              : '成员、记录或权限已变化，请重新读取后核对。'}
        </Alert>
      )}
      {draft.kind === 'save' ? (
        <>
          <p className="text-[13px] leading-6 text-muted-foreground">
            本人报量由服务端唯一识别有效成员来源；存在多来源时会拒绝并保留草稿。零量也会记录。任务池首次有效报量后才算认领；每批1至100行，全部成功或全部失败。
          </p>
          {draft.rows.map((row, index) => (
            <section
              key={row.key}
              aria-label={`报量行${index + 1}`}
              className="space-y-4 rounded-xl border p-4"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <h3 className="text-sm font-medium">
                  第 {index + 1} 行 ·{' '}
                  {row.subtaskId === null
                    ? '请选择子任务'
                    : tasks.get(row.subtaskId)?.subtaskName || `子任务 #${row.subtaskId}`}
                </h3>
                <Button
                  variant="dangerGhost"
                  size="mobileTouch"
                  disabled={blocked || draft.rows.length === 1}
                  onClick={() =>
                    setDraft((old) =>
                      old.kind === 'save'
                        ? { ...old, rows: old.rows.filter((item) => item.key !== row.key) }
                        : old,
                    )
                  }
                >
                  移除此行
                </Button>
              </div>
              <OutputSelect
                label="报量子任务"
                value={row.subtaskId === null ? '' : String(row.subtaskId)}
                disabled={blocked}
                options={scopeOptions}
                onChange={(value) => updateRow(row.key, { subtaskId: Number(value) })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-[13px]">
                  作业日期
                  <Input
                    aria-label="作业日期"
                    type="date"
                    max={productionPlanToday()}
                    value={row.date}
                    disabled={blocked}
                    onChange={(e) => updateRow(row.key, { date: e.target.value })}
                  />
                </label>
                <label className="space-y-2 text-[13px]">
                  生产数量
                  <Input
                    aria-label="生产数量"
                    inputMode="decimal"
                    maxLength={64}
                    value={row.quantity}
                    disabled={blocked}
                    onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                  />
                </label>
              </div>
              <label className="block space-y-2 text-[13px]">
                作业备注
                <Textarea
                  aria-label="作业备注"
                  maxLength={1000}
                  rows={3}
                  value={row.remark}
                  disabled={blocked}
                  onChange={(e) => updateRow(row.key, { remark: e.target.value })}
                />
              </label>
            </section>
          ))}
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={blocked || draft.rows.length >= 100}
            onClick={() =>
              setDraft((old) =>
                old.kind === 'save'
                  ? {
                      ...old,
                      rows: [
                        ...old.rows,
                        newExpertReportDraft(intent.kind === 'save' ? intent.subtaskId : null),
                      ],
                    }
                  : old,
              )
            }
          >
            新增报量行
          </Button>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-6">
            原报量 #{draft.report.reportId} · {draft.report.displayName} · {draft.report.reportDate}{' '}
            · {draft.report.subtaskId === null ? '项目级' : `子任务 #${draft.report.subtaskId}`}
          </p>
          <p className="text-[13px] text-muted-foreground">
            原数量：{draft.report.quantity} {draft.report.quantityUnit}；退回原因：
            {draft.report.returnReason || '未记录'}。修正保留原成员、日期及层级，核准后不可修改。
          </p>
          <label className="block space-y-2 text-[13px]">
            修正数量
            <Input
              aria-label="修正数量"
              inputMode="decimal"
              maxLength={64}
              value={draft.quantity}
              disabled={blocked}
              onChange={(e) =>
                setDraft((old) =>
                  old.kind === 'correct' ? { ...old, quantity: e.target.value } : old,
                )
              }
            />
          </label>
          <label className="block space-y-2 text-[13px]">
            修正备注
            <Textarea
              aria-label="修正备注"
              maxLength={1000}
              rows={4}
              value={draft.remark}
              disabled={blocked}
              onChange={(e) =>
                setDraft((old) =>
                  old.kind === 'correct' ? { ...old, remark: e.target.value } : old,
                )
              }
            />
          </label>
        </>
      )}
    </Dialog>
  );
}
