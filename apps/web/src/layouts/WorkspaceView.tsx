import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type Context,
  type PropsWithChildren,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, type AuthUser } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { broadcastWorkspaceRoleChange, subscribeWorkspaceRoleChanges } from './workspace-role-sync';

/** 可展示的业务角色，当前选择由服务端会话提供。 */
export const workspaceViewOptions = [
  { value: 'EXPERT', label: '执行专家' },
  { value: 'NAVIGATOR', label: '领航员' },
  { value: 'PM', label: '策略官' },
] as const;
export type WorkspaceView = (typeof workspaceViewOptions)[number]['value'];
/** 编辑页可在真实角色变更前保护未保存内容；取消时不发起会话写入。 */
export const WORKSPACE_ROLE_SWITCH_REQUEST = 'tyde:before-role-switch';

type WorkspaceViewState = {
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  isPending: boolean;
  error: unknown;
};

// 热更新只复用 Context 身份，避免新 hook 读取旧 Provider 时短暂失联。
// 角色值仍由真实会话提供；生产环境和缺失 Provider 的校验不变。
const WorkspaceViewContext: Context<WorkspaceViewState | null> =
  import.meta.hot?.data.workspaceViewContext ?? createContext<WorkspaceViewState | null>(null);
if (import.meta.hot) import.meta.hot.data.workspaceViewContext = WorkspaceViewContext;

/** 真实切换当前会话角色；服务端确认前保留当前界面，失败不重放写请求。 */
export function WorkspaceViewProvider({ user, children }: PropsWithChildren<{ user: AuthUser }>) {
  const cache = useQueryClient();
  const switching = useRef(false);
  const view = user.selectedRole ?? user.role;
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeWorkspaceRoleChanges(user.id, () => {
      void (async () => {
        if (!active || cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
        await cache.cancelQueries();
        if (!active || cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
        cache.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
        // 频道消息只使缓存失效，角色和组织身份始终取 users/me 的真实返回。
        await cache.invalidateQueries({ queryKey: SESSION_KEY });
      })();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cache, user.id]);
  const switchRole = useMutation({
    mutationFn: (role: WorkspaceView) => api.switchRole(role),
    onSuccess: async (result) => {
      if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
      await cache.cancelQueries();
      if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
      cache.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
      cache.setQueryData<AuthUser>(
        SESSION_KEY,
        (current) =>
          current && {
            ...current,
            role: result.selectedRole,
            selectedRole: result.selectedRole,
            roles: result.roles,
          },
      );
      broadcastWorkspaceRoleChange(user.id);
      // 读取完整资料同步角色相关摘要；读取失败不重复已成功的角色切换。
      void cache.invalidateQueries({ queryKey: SESSION_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401)
        void cache.invalidateQueries({ queryKey: SESSION_KEY });
    },
    onSettled: () => {
      switching.current = false;
    },
  });

  function setView(role: WorkspaceView) {
    if (switching.current || role === view || !user.roles.includes(role)) return;
    if (!window.dispatchEvent(new Event(WORKSPACE_ROLE_SWITCH_REQUEST, { cancelable: true })))
      return;
    switching.current = true;
    switchRole.mutate(role);
  }

  return (
    <WorkspaceViewContext.Provider
      value={{ view, setView, isPending: switchRole.isPending, error: switchRole.error }}
    >
      {children}
    </WorkspaceViewContext.Provider>
  );
}

export function useWorkspaceView() {
  const context = useContext(WorkspaceViewContext);
  if (!context) throw new Error('当前角色必须在登录后的工作台中使用');
  return context;
}
