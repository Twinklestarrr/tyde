import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type ProjectProductionPlan,
  type ProjectProductionPlanInput,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { ProductionPlanFields } from './ProductionPlanFields';
import {
  productionPlanInput,
  productionPlanNumber,
  productionPlanToday,
  productionPlanValues,
  productionStageEstimate,
  type ProductionPlanValues,
} from './production-plan-form';

/** 父级在卸载生产计划 Tab 前询问未确认内容，不影响打开项目资料弹框。 */
export const PRODUCTION_PLAN_LEAVE_REQUEST = 'tyde:before-production-plan-leave';

interface ProductionPlanPanelProps {
  user: AuthUser;
  projectId: number;
  onConfirmed?: () => Promise<void>;
}

/** 当前真实 PM 任职范围由服务端判定，读取成功前不开放空白计划写入。 */
export function ProductionPlanPanel({ user, projectId, onConfirmed }: ProductionPlanPanelProps) {
  const query = useQuery({
    queryKey: ['project-production-plan', user.id, 'PM', projectId],
    queryFn: () => api.getProjectProductionPlan(projectId),
    enabled: (user.selectedRole ?? user.role) === 'PM',
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if ((user.selectedRole ?? user.role) !== 'PM') return null;
  if (query.isError && !query.data)
    return (
      <section aria-label="生产计划" className="space-y-[16px] p-[20px]">
        <h2 className="text-[18px] font-semibold">生产计划</h2>
        <ErrorNotice error={query.error} />
        <Button
          variant="outline"
          size="account"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重新读取生产计划
        </Button>
      </section>
    );
  if (!query.data || query.isFetching)
    return (
      <p role="status" className="p-[24px] text-[14px] text-muted-foreground">
        正在读取生产计划…
      </p>
    );
  return (
    <ProductionPlanEditor
      key={`${user.id}:${projectId}`}
      user={user}
      projectId={projectId}
      plan={query.data}
      onConfirmed={onConfirmed}
    />
  );
}

/** 未确认表单仅保留在内存，确认成功后立即使用服务端结果锁定为只读。 */
function ProductionPlanEditor({
  user,
  projectId,
  plan,
  onConfirmed,
}: ProductionPlanPanelProps & { plan: ProjectProductionPlan }) {
  const cache = useQueryClient();
  const form = useForm<ProductionPlanValues>({
    defaultValues: productionPlanValues(plan),
    mode: 'onSubmit',
  });
  const [confirming, setConfirming] = useState(false);
  const [lock, setLock] = useState<'unknown' | 'conflict' | 'success' | 'access' | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [today, setToday] = useState(productionPlanToday);
  const mounted = useRef(false);
  const writing = useRef(false);
  const readOnly = !plan.editable || plan.hasPlan || plan.confirmedAt !== null;
  const dirty = form.formState.isDirty && !readOnly;
  const confirm = useMutation({
    mutationFn: (input: ProjectProductionPlanInput) =>
      api.confirmProjectProductionPlan(projectId, input),
    retry: false,
    networkMode: 'always',
  });
  const busy = confirm.isPending || reading;
  const disabled = readOnly || !!lock || busy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 异步写入或读取完成后只更新仍属于本人 PM 会话的页面和缓存。 */
  function sessionMatches() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && current?.id === user.id && (current.selectedRole ?? current.role) === 'PM'
    );
  }

  useEffect(() => {
    /** 角色/模块只确认一次；取消时不卸载、不清空编辑内容。 */
    function beforeLeave(event: Event) {
      if (writing.current) {
        event.preventDefault();
        return;
      }
      if (!dirty) return;
      const target = event.type === WORKSPACE_ROLE_SWITCH_REQUEST ? '角色' : '模块';
      if (!window.confirm(`未确认的生产计划内容将会丢失，确认切换${target}？`))
        event.preventDefault();
    }
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    window.addEventListener(PRODUCTION_PLAN_LEAVE_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
      window.removeEventListener(PRODUCTION_PLAN_LEAVE_REQUEST, beforeLeave);
    };
  }, [dirty]);

  useBlocker({
    shouldBlockFn: () => {
      const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      if (current && (current.id !== user.id || (current.selectedRole ?? current.role) !== 'PM'))
        return false;
      return (
        writing.current || (dirty && !window.confirm('未确认的生产计划内容将会丢失，确认离开？'))
      );
    },
    enableBeforeUnload: () => writing.current || dirty,
  });

  /** 确认弹框打开及最终提交均重新校验，午夜跨日后不沿用旧日期。 */
  function input() {
    const currentDay = productionPlanToday();
    setToday(currentDay);
    form.clearErrors();
    const result = productionPlanInput(form.getValues(), currentDay);
    for (const [name, message] of Object.entries(result.errors)) {
      const path = name as keyof typeof result.errors;
      form.setError(path, { type: 'validate', message });
    }
    if (!result.input) return null;
    return { ...result.input, extJson: plan.extJson };
  }

  /** 恢复动作只有 GET，不自动再次确认；服务端只读结果取代本地待确认输入。 */
  async function reread(discard = true) {
    if (reading || writing.current) return;
    if (discard && dirty && !window.confirm('重新读取将替换未确认的生产计划内容，确认继续？'))
      return;
    setReading(true);
    setReadError(null);
    try {
      const result = await api.getProjectProductionPlan(projectId);
      if (!sessionMatches()) return;
      cache.setQueryData(['project-production-plan', user.id, 'PM', projectId], result);
      form.reset(productionPlanValues(result));
      if (result.hasPlan && onConfirmed) await onConfirmed();
      if (!sessionMatches()) return;
      setLock(null);
      setError(null);
      if (result.hasPlan) setNotice('生产计划已确认，当前展示最新只读结果。');
      else
        setNotice(
          result.editable
            ? '已读取最新生产计划，请核对后再确认。'
            : '当前生产计划仅可查看，由主策略官确认。',
        );
    } catch (failure) {
      if (sessionMatches()) {
        setReadError(failure);
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setLock('access');
      }
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** 单次不可逆确认；网络未知和冲突先锁定并显式读取，不自动重放。 */
  async function submit() {
    if (writing.current || disabled || !sessionMatches()) return;
    const values = input();
    if (!values) {
      setConfirming(false);
      return;
    }
    writing.current = true;
    setError(null);
    setReadError(null);
    setNotice('');
    let result: ProjectProductionPlan;
    try {
      result = await confirm.mutateAsync(values);
    } catch (failure) {
      if (sessionMatches()) {
        setError(failure);
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setLock('access');
        else if (failure instanceof ApiError && failure.status === 409) setLock('conflict');
        else if (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500)
          setLock('unknown');
      }
      return;
    } finally {
      writing.current = false;
      if (mounted.current) setConfirming(false);
    }
    if (!sessionMatches()) return;
    cache.setQueryData(['project-production-plan', user.id, 'PM', projectId], result);
    form.reset(productionPlanValues(result));
    setNotice('生产计划已确认，不能再次修改。');
    setLock('success');
    await reread(false);
  }

  const stages = form.watch('stages');
  const operatorCpd = form.watch('operatorCpd');
  const estimates = stages.map(
    (stage) => productionStageEstimate(stage, operatorCpd).expectedOutput,
  );
  const totalEstimate = estimates.every((value) => value !== null)
    ? estimates.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  return (
    <section aria-label="生产计划" className="space-y-[20px] p-[16px] sm:p-[24px]">
      <header className="flex flex-wrap items-start justify-between gap-[16px]">
        <div>
          <h2 id="production-plan-title" className="text-[20px] font-semibold">
            生产计划
          </h2>
          <p className="mt-[6px] text-[13px] leading-6 text-muted-foreground">
            {plan.hasPlan
              ? `已确认${plan.confirmedAt ? ` · ${plan.confirmedAt}（上海时间）` : ''}，计划内容仅可查看。`
              : readOnly
                ? '当前生产计划仅可查看，由主策略官确认。'
                : '设置人数产能、人群与阶段。确认后计划将锁定，不能修改。'}
          </p>
        </div>
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={confirm.isPending}
          loading={reading}
          onClick={() => void reread()}
        >
          <RefreshCw className="size-4" aria-hidden />
          重新读取生产计划
        </Button>
      </header>
      {notice && (
        <p role="status" className="text-[13px] text-primary">
          {notice}
        </p>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && input()) setConfirming(true);
        }}
      >
        <fieldset disabled={disabled} aria-label={readOnly ? '只读生产计划' : '生产计划配置'}>
          <ProductionPlanFields form={form} plan={plan} readOnly={readOnly} />
        </fieldset>
        <div className="mt-[24px] rounded-[12px] border bg-muted p-[16px] text-[13px] leading-6">
          <p>
            {plan.hasPlan ? '服务端已确认预计产出' : '合计预计产出（估算）'}：
            <strong>
              {productionPlanNumber(plan.hasPlan ? plan.totalExpectedOutput : totalEstimate)}{' '}
              {plan.projectReference.quantityUnit}
            </strong>
          </p>
          {!plan.hasPlan && (
            <p className="mt-[4px] text-muted-foreground">
              页面估算供核对，最终产出以确认后服务端结果为准。
            </p>
          )}
          {!plan.hasPlan &&
            totalEstimate !== null &&
            plan.projectReference.projectQuantity !== null &&
            totalEstimate < plan.projectReference.projectQuantity && (
              <p className="mt-[4px] text-[var(--color-warning)]">
                估算产出低于项目量级，请核对阶段安排。
              </p>
            )}
        </div>
        <div className="mt-[20px] space-y-[12px]">
          <ErrorNotice error={error} />
          {lock && (lock !== 'success' || (!reading && Boolean(readError))) && (
            <Alert>
              <div className="space-y-[12px]">
                <p>
                  {lock === 'success'
                    ? '生产计划已确认，但最新资料读取失败。请重新读取。'
                    : lock === 'access'
                      ? '当前无法确认此生产计划，请重新读取权限或返回项目列表。'
                      : lock === 'conflict'
                        ? '生产计划已发生变化，请重新读取后核对。'
                        : '提交结果暂未确认，请先重新读取生产计划核对。'}
                </p>
              </div>
            </Alert>
          )}
          <ErrorNotice error={readError} />
        </div>
        <footer className="mt-[24px] flex flex-wrap items-center justify-between gap-[16px] border-t pt-[20px]">
          <p className="text-[13px] leading-6 text-muted-foreground">
            {plan.hasPlan
              ? '当前结果已锁定为只读。'
              : readOnly
                ? '仅主策略官可以确认生产计划。'
                : `确认后${form.watch('needWrittenExam') ? '安排准入考试' : '进入标准与培训'}，其他环节按项目实际进度继续。`}
          </p>
          {!readOnly && (
            <Button type="submit" size="account" loading={confirm.isPending} disabled={disabled}>
              确认生产计划
            </Button>
          )}
        </footer>
      </form>
      {confirming && (
        <ProductionPlanConfirmation
          busy={confirm.isPending}
          today={today}
          written={form.getValues('needWrittenExam')}
          onClose={() => setConfirming(false)}
          onConfirm={() => void submit()}
        />
      )}
    </section>
  );
}

/** 原生弹框限制焦点，首次确认才发送写请求。 */
function ProductionPlanConfirmation({
  busy,
  today,
  written,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  today: string;
  written: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="确认生产计划"
      aria-describedby="production-plan-confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-32px)] max-w-[520px] rounded-[12px] border bg-card p-[24px] text-foreground shadow-xl backdrop:bg-black/40"
    >
      <h2 id="production-plan-confirm-title" className="text-[18px] font-semibold">
        确认生产计划
      </h2>
      <p
        id="production-plan-confirm-description"
        className="mt-[12px] text-[14px] leading-6 text-muted-foreground"
      >
        确认后本计划不能再次编辑。计划目标为{written ? '准入考试' : '标准与培训'}
        ，实际项目进度不会回退。各阶段开始日期须不早于确认当日，当前上海日期为 {today}。
      </p>
      <div className="mt-[24px] flex flex-wrap justify-end gap-[10px]">
        <Button variant="outline" size="account" disabled={busy} onClick={onClose}>
          继续填写
        </Button>
        <Button size="account" loading={busy} onClick={onConfirm}>
          确认提交
        </Button>
      </div>
    </dialog>
  );
}
