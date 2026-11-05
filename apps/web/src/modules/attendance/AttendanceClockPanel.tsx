import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  ApiError,
  type AuthUser,
  type AttendanceClockInput,
  type AttendanceClockResult,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY, sessionQuery } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/empty-state';
import { OrganizationDialog } from '@/modules/organizations/common';
import {
  CLOCK_TIMEZONE,
  attendanceClockScope,
  attendanceClockInput,
  clockFailureIsUnknown,
  clockReceiptMatches,
  type ClockScope,
} from './attendance-clock';

type ClockWrite = {
  input: AttendanceClockInput;
  status: 'unknown' | 'success' | 'rejected';
  busy: boolean;
  result?: AttendanceClockResult;
};
// ponytail: 每账号/作用域只保留一笔当前运行期操作；整页重载恢复需要另加受控持久化。
const pendingClocks = new Map<string, ClockWrite>();
const clockName = (type: string) => (type === 'CLOCK_IN' ? '上班打卡' : '下班打卡');

export function AttendanceClockPanel({
  user,
  compact = false,
}: {
  user: AuthUser;
  compact?: boolean;
}) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [reloadError, setReloadError] = useState<unknown>(null);
  if ((user.selectedRole ?? user.role) !== 'EXPERT') return null;
  let scope: ClockScope;
  try {
    scope = attendanceClockScope(user);
  } catch (error) {
    return (
      <Card asChild>
        <section aria-label="今日上下班打卡" className="space-y-4 p-5">
          <CardTitle>今日打卡</CardTitle>
          <ErrorNotice error={error} />
          <ErrorNotice error={reloadError} />
          <Button
            variant="outline"
            size="mobileTouch"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setReloadError(null);
              void cache
                .fetchQuery({ ...sessionQuery, staleTime: 0 })
                .catch(setReloadError)
                .finally(() => setBusy(false));
            }}
          >
            重新读取身份
          </Button>
        </section>
      </Card>
    );
  }
  return (
    <ClockContent
      key={JSON.stringify([user.id, scope.orgId])}
      user={user}
      scope={scope}
      compact={compact}
    />
  );
}

function ClockContent({
  user,
  scope,
  compact,
}: {
  user: AuthUser;
  scope: ClockScope;
  compact: boolean;
}) {
  const cache = useQueryClient();
  const key = JSON.stringify([user.id, scope.orgId]);
  const writeKey = ['attendance-clock-write', user.id, 'EXPERT', scope.orgId];
  const retained = useQuery<ClockWrite | null>({
    queryKey: writeKey,
    queryFn: async () => null,
    enabled: false,
    gcTime: Infinity,
    initialData: () => pendingClocks.get(key) ?? null,
  });
  const pending = retained.data;
  const mounted = useRef(true),
    working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirmOut, setConfirmOut] = useState(false);
  const [lastResult, setLastResult] = useState<AttendanceClockResult | null>(
    () => pending?.result ?? null,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function identity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (!current || current.id !== user.id || (current.selectedRole ?? current.role) !== 'EXPERT')
      return false;
    try {
      return attendanceClockScope(current).orgId === scope.orgId;
    } catch {
      return false;
    }
  }
  function requireIdentity() {
    if (!identity())
      throw new ApiError(401, {
        code: 'SESSION_CHANGED',
        message: '登录身份或打卡范围已变化，请重新进入打卡页面。',
      });
  }
  function sameSession() {
    return mounted.current && identity();
  }
  const context = useQuery({
    queryKey: ['attendance-clock-context', user.id, 'EXPERT', scope.orgId, CLOCK_TIMEZONE],
    queryFn: async () => {
      requireIdentity();
      const value = await api.getAttendanceClockContext({
        ...(scope.orgId ? { orgId: scope.orgId } : {}),
        timezone: CLOCK_TIMEZONE,
      });
      requireIdentity();
      return value;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  function setPending(next: ClockWrite | null, expected?: string) {
    if (expected && pendingClocks.get(key)?.input.idempotencyKey !== expected) return;
    if (next) pendingClocks.set(key, next);
    else pendingClocks.delete(key);
    cache.setQueryData(writeKey, next);
  }
  const isWorking = () => working.current || !!pendingClocks.get(key)?.busy;
  useEffect(() => {
    const leave = (event: Event) => {
      if (identity() && isWorking()) event.preventDefault();
    };
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
  }, [user.id, scope.orgId]);
  useBlocker({
    shouldBlockFn: () => identity() && isWorking(),
    enableBeforeUnload: () => identity() && isWorking(),
  });
  async function finishRead(state: ClockWrite) {
    requireIdentity();
    await context.refetch({ throwOnError: true });
    requireIdentity();
    await cache.invalidateQueries(
      { queryKey: ['profile-workbench', user.id] },
      { throwOnError: true },
    );
    await Promise.all([
      cache.invalidateQueries(
        { queryKey: ['workbench-statistics', user.id, 'EXPERT'] },
        { throwOnError: true },
      ),
      cache.invalidateQueries({ queryKey: ['expert-projects', user.id] }, { throwOnError: true }),
      cache.invalidateQueries(
        { queryKey: ['expert-production-tasks', user.id] },
        { throwOnError: true },
      ),
      cache.invalidateQueries(
        { queryKey: ['expert-reportable-production', user.id] },
        { throwOnError: true },
      ),
    ]);
    requireIdentity();
    setPending(null, state.input.idempotencyKey);
  }
  async function execute(state: ClockWrite) {
    if (isWorking()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    setPending({ ...state, busy: true }, state.input.idempotencyKey);
    let written = false;
    try {
      requireIdentity();
      const result = await api.clockAttendance(state.input);
      if (!clockReceiptMatches(result, user.id, scope))
        throw new ApiError(502, {
          code: 'INVALID_RESPONSE',
          message: '打卡回执身份或组织不匹配，结果仍待核实。',
        });
      written = true;
      const saved: ClockWrite = { ...state, status: 'success', result, busy: true };
      setPending(saved, state.input.idempotencyKey);
      if (!sameSession()) return;
      setLastResult(result);
      setConfirmOut(false);
      setNotice(`${clockName(result.clockType)}已记录。`);
      await finishRead(saved);
    } catch (value) {
      if (!written)
        setPending(
          { ...state, status: clockFailureIsUnknown(value) ? 'unknown' : 'rejected', busy: false },
          state.input.idempotencyKey,
        );
      if (sameSession()) {
        setError(value);
        if (written) setNotice('打卡已记录，当前状态尚未读取完成，请刷新打卡状态。');
      }
      if (value instanceof ApiError && value.status === 401 && identity())
        void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } finally {
      working.current = false;
      const latest = pendingClocks.get(key);
      if (latest?.input.idempotencyKey === state.input.idempotencyKey)
        setPending({ ...latest, busy: false }, state.input.idempotencyKey);
      if (mounted.current) setBusy(false);
    }
  }
  function submit(confirmedOut = false) {
    if (
      isWorking() ||
      pendingClocks.has(key) ||
      !context.isSuccess ||
      context.isFetching ||
      !context.data.canClock
    )
      return;
    const type = context.data.nextClockType;
    if (type !== 'CLOCK_IN' && type !== 'CLOCK_OUT') return;
    if (confirmedOut && type !== 'CLOCK_OUT') {
      setConfirmOut(false);
      setError(new Error('打卡状态已变化，请重新确认当前打卡操作。'));
      return;
    }
    if (type === 'CLOCK_OUT' && !confirmedOut) {
      setConfirmOut(true);
      return;
    }
    try {
      requireIdentity();
    } catch (value) {
      setError(value);
      return;
    }
    const state: ClockWrite = {
      input: { ...attendanceClockInput(scope), clockType: type },
      status: 'unknown',
      busy: false,
    };
    setPending(state);
    void execute(state);
  }
  function retry() {
    const state = pendingClocks.get(key);
    if (!state || state.status !== 'unknown' || isWorking()) return;
    void execute(state);
  }
  async function refresh() {
    if (isWorking()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const state = pendingClocks.get(key);
    try {
      requireIdentity();
      if (state?.status === 'success') {
        await finishRead(state);
        if (sameSession()) {
          setLastResult(state.result ?? null);
          setNotice('打卡已记录，最新考勤状态已更新。');
        }
      } else {
        if (state?.status === 'rejected') {
          await cache.fetchQuery({ ...sessionQuery, staleTime: 0 });
          requireIdentity();
        }
        await context.refetch({ throwOnError: true });
        requireIdentity();
        if (state?.status === 'rejected') setPending(null, state.input.idempotencyKey);
        if (sameSession())
          setNotice(
            state?.status === 'unknown'
              ? '已读取当前状态，上次打卡结果仍待确认，请重试上次打卡。'
              : '已读取最新打卡状态。',
          );
      }
    } catch (value) {
      if (sameSession()) setError(value);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const current = context.isSuccess ? context.data : null;
  const result = pending?.status === 'success' ? pending.result : lastResult;
  const disabled =
    busy || !!pending || !current?.canClock || !current.nextClockType || context.isFetching;
  return (
    <Card asChild>
      <section aria-label="今日上下班打卡" className={`space-y-4 ${compact ? 'p-4' : 'p-5'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle>今日打卡</CardTitle>
            <p className="break-words text-[13px] text-muted-foreground">{scope.name} · 上海时间</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="mobileTouch"
              loading={busy || !!pending?.busy || context.isFetching}
              onClick={() => void refresh()}
            >
              刷新打卡状态
            </Button>
            {pending?.status === 'unknown' ? (
              <Button size="mobileTouch" loading={busy || pending.busy} onClick={retry}>
                重试上次打卡
              </Button>
            ) : (
              <Button
                size="mobileTouch"
                disabled={disabled}
                loading={busy || !!pending?.busy}
                onClick={() => submit()}
              >
                {current?.buttonText || '暂不可打卡'}
              </Button>
            )}
          </div>
        </div>
        <ErrorNotice error={context.error} />
        <ErrorNotice error={error === context.error ? null : error} />
        {notice && (
          <p role="status" className="text-[13px] leading-6">
            {notice}
          </p>
        )}
        {context.isPending && <LoadingState>正在读取今日打卡状态…</LoadingState>}
        {pending && (
          <Alert>
            {pending.status === 'unknown'
              ? '上次打卡结果待确认。重试会沿用原操作：如已保存，显示原记录；如未保存，将按服务器当前时间打卡，不会补打历史日期。'
              : pending.status === 'success'
                ? '打卡已记录，后续状态未读取完成；刷新状态不会再次打卡。'
                : '上次打卡未成功，请先刷新打卡状态并核对当前身份后操作。'}
          </Alert>
        )}
        {current && (
          <>
            <p className="text-xs text-muted-foreground">
              {current.attendanceDate} · 状态时间 {current.serverTime}
            </p>
            <dl className="grid min-w-0 grid-cols-2 gap-4 text-[13px] sm:grid-cols-4">
              {[
                ['预计上班', current.shiftStartAt],
                ['预计下班', current.shiftEndAt],
                ['首次上班打卡', current.firstClockInAt],
                ['末次下班打卡', current.lastClockOutAt],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="break-words">{value ?? '无记录'}</dd>
                </div>
              ))}
            </dl>
            {current.warning && <Alert>{current.warning}</Alert>}
          </>
        )}
        {result && (
          <div className="rounded-lg border bg-accent p-3 text-[13px] leading-6">
            <p className="font-medium">{clockName(result.clockType)}已记录</p>
            <dl className="mt-1">
              <dt className="text-xs text-muted-foreground">本次打卡时间</dt>
              <dd className="break-words">
                {result.clockAt}（{result.timezone}）
              </dd>
            </dl>
          </div>
        )}
        {error instanceof ApiError && [401, 403, 404].includes(error.status) && (
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={busy}
            onClick={() => {
              void cache.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(setError);
            }}
          >
            重新读取身份
          </Button>
        )}
        {confirmOut && (
          <OrganizationDialog
            title="确认下班打卡"
            busy={busy || !!pending?.busy}
            onClose={() => setConfirmOut(false)}
          >
            <p className="text-[13px] leading-6">确认结束本次工作并下班打卡？</p>
            <ErrorNotice error={error} />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy || !!pending?.busy}
                onClick={() => setConfirmOut(false)}
              >
                取消
              </Button>
              <Button
                size="mobileTouch"
                loading={busy || !!pending?.busy}
                disabled={pending?.status === 'rejected'}
                onClick={() => (pending?.status === 'unknown' ? retry() : submit(true))}
              >
                {pending?.status === 'unknown' ? '重试下班打卡' : '确认打卡'}
              </Button>
            </div>
          </OrganizationDialog>
        )}
      </section>
    </Card>
  );
}
