import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { AuthUser, NavigatorProjectCard } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';

/** 提交后的去向只由完整待办列表决定，详情接口可读不代表仍有本人待办。 */
export function useProjectCardContinuation({
  user,
  projectId,
  role,
  reloadDetail,
  onContinue,
  origin = 'workbench',
}: {
  user: AuthUser;
  projectId: number;
  role: 'NAVIGATOR' | 'PM';
  reloadDetail: () => Promise<unknown>;
  onContinue: (card: NavigatorProjectCard) => void;
  origin?: 'workbench' | 'directory';
}) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(false);
  const request = useRef(0);
  const [transition, setTransition] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);

  async function refresh() {
    const currentRequest = ++request.current;
    const active = () => {
      const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      return (
        mounted.current &&
        currentRequest === request.current &&
        session?.id === user.id &&
        (session.selectedRole ?? session.role) === role
      );
    };
    if (!active()) return;
    if (origin === 'directory') {
      await reloadDetail();
      if (!active()) return;
      await Promise.all([
        cache.invalidateQueries(
          { queryKey: ['project-directory', user.id, role], refetchType: 'none' },
          { throwOnError: true },
        ),
        cache.invalidateQueries(
          {
            refetchType: 'none',
            predicate: (query) =>
              String(query.queryKey[0]).startsWith('project-board-') &&
              query.queryKey[1] === user.id &&
              query.queryKey[2] === role &&
              query.queryKey[3] === projectId,
          },
          { throwOnError: true },
        ),
      ]);
      if (active()) setTransition((value) => value + 1);
      return;
    }
    const queryKey = [role === 'PM' ? 'strategist-projects' : 'navigator-projects', user.id, role];
    await cache.cancelQueries({ queryKey });
    if (!active()) return;
    const cards = await (role === 'PM'
      ? api.listStrategistProjects()
      : api.listNavigatorProjects());
    if (!active()) return;
    cache.setQueryData(queryKey, cards);
    await cache.invalidateQueries({ queryKey: ['workbench-statistics', user.id, role] });
    const card = cards.find((item) => item.id === projectId);
    if (!card) {
      await navigate({ to: role === 'PM' ? '/strategist/projects' : '/projects', replace: true });
      return;
    }
    await reloadDetail();
    if (!active()) return;
    onContinue(card);
    setTransition((value) => value + 1);
  }

  return {
    refresh,
    transition,
    cancel: () => {
      request.current++;
    },
  };
}
