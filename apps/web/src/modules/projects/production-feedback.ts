import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { ApiError, type AuthUser } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { PRODUCTION_TASKS_LEAVE_REQUEST, productionFailureIsUnknown } from './production-task-form';

export interface ProductionWrite<T> {
  id: string;
  originRole: 'PM' | 'EXPERT' | 'NAVIGATOR';
  status: 'unknown' | 'success' | 'conflict' | 'access';
  draft: T;
}
// 角色切换清空读取缓存时，未知写入仍按账号及业务来源保留；页面刷新不持久化。
const pendingWrites = new Map<string, ProductionWrite<unknown>>();

/** start/stop覆盖一次操作；begin须在POST前调用，finish只收尾已确认成功的写入。 */
export function useProductionFeedback<T>(
  user: AuthUser,
  source: string,
  dirty = false,
  role: 'PM' | 'EXPERT' | 'NAVIGATOR' = 'PM',
) {
  const cache = useQueryClient();
  const mounted = useRef(true);
  const working = useRef(false);
  const allowLeave = useRef(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([user.id, source]);
  const queryKey = ['production-write', user.id, role, source];
  const retained = useQuery<ProductionWrite<T> | null>({
    queryKey,
    queryFn: async () => null,
    initialData: () => (pendingWrites.get(key) as ProductionWrite<T> | undefined) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function sameIdentity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  function sameSession() {
    return mounted.current && sameIdentity();
  }
  // 共享查询可以跨组件挂载继续；写入和界面操作仍使用 requireSession。
  function requireIdentity() {
    if (!sameIdentity()) throw new Error('登录身份已变化，请重新打开生产任务。');
  }
  function requireSession() {
    if (!sameSession()) throw new Error('登录身份已变化，请重新打开生产任务。');
  }
  function mayLeave() {
    return (
      allowLeave.current ||
      (!working.current &&
        (!dirty || window.confirm('尚有未完成的生产任务操作，确认离开当前页面？')))
    );
  }
  useEffect(() => {
    const leave = (event: Event) => {
      if (sameIdentity() && !mayLeave()) event.preventDefault();
    };
    window.addEventListener(PRODUCTION_TASKS_LEAVE_REQUEST, leave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => {
      window.removeEventListener(PRODUCTION_TASKS_LEAVE_REQUEST, leave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    };
  }, [dirty, role, user.id]);
  useBlocker({
    shouldBlockFn: () => sameIdentity() && !mayLeave(),
    enableBeforeUnload: () => sameIdentity() && !allowLeave.current && (working.current || dirty),
  });
  function setLock(value: ProductionWrite<T> | null, expectedId?: string) {
    if (expectedId && pendingWrites.get(key)?.id !== expectedId) return;
    if ((value?.originRole ?? pendingWrites.get(key)?.originRole ?? role) !== role) return;
    if (value) pendingWrites.set(key, value);
    else pendingWrites.delete(key);
    cache.setQueryData(queryKey, value);
    cache.setQueriesData(
      {
        queryKey: ['production-write', user.id],
        predicate: (query) => query.queryKey[3] === source,
      },
      value,
    );
  }
  function begin(draft: T) {
    if (pendingWrites.has(key)) return undefined;
    const state: ProductionWrite<T> = {
      id: crypto.randomUUID(),
      originRole: role,
      status: 'unknown',
      draft,
    };
    setLock(state);
    return state;
  }
  function markSuccess(state: ProductionWrite<T>) {
    setLock({ ...state, status: 'success' }, state.id);
  }
  function markFailure(state: ProductionWrite<T>, error: unknown) {
    const unknown = productionFailureIsUnknown(error);
    const status = unknown
      ? 'unknown'
      : error instanceof ApiError && [401, 403, 404].includes(error.status)
        ? 'access'
        : 'conflict';
    setLock({ ...state, status }, state.id);
  }
  function clear(state: ProductionWrite<T>) {
    requireOrigin();
    setLock(null, state.id);
  }
  function requireOrigin() {
    const pending = pendingWrites.get(key);
    if (pending && pending.originRole !== role)
      throw new Error(
        `此来源存在${{ PM: '策略官', EXPERT: '执行专家', NAVIGATOR: '领航员' }[pending.originRole]}身份的待核实操作，请切回原角色核实，不能换角色重复提交。`,
      );
  }
  function start() {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    return true;
  }
  function stop() {
    working.current = false;
    allowLeave.current = false;
    if (mounted.current) setBusy(false);
  }
  async function finish(
    state: ProductionWrite<T>,
    onChanged: () => Promise<void>,
    refresh?: () => Promise<unknown>,
  ) {
    requireOrigin();
    allowLeave.current = true;
    try {
      await onChanged();
      if (!sameIdentity()) return;
      if (mounted.current && refresh) {
        try {
          await refresh();
        } catch (error) {
          if (mounted.current || !sameIdentity()) throw error;
        }
      }
      if (sameIdentity()) clear(state);
    } finally {
      allowLeave.current = false;
    }
  }
  return {
    lock: retained.data ?? null,
    foreignLock: !!retained.data && retained.data.originRole !== role,
    busy,
    mounted,
    working,
    allowLeave,
    sameIdentity,
    sameSession,
    requireIdentity,
    requireSession,
    requireOrigin,
    setLock,
    begin,
    markSuccess,
    markFailure,
    clear,
    start,
    stop,
    finish,
  };
}
