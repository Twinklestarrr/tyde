import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ProjectBoardTrendMetric } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/empty-state';
import { productionPlanToday } from './production-plan-form';
import { personnelDay } from './personnel-form';
import { ProjectBoardTrendsView } from './ProjectBoardTrends';

const titles = { QUANTITY: '作业数量趋势', ACCURACY: '正确率趋势', CPD: 'CPD趋势' };

/** 三项指标各自保持七日默认范围；旧版最多 31 日，修改一项不改变另外两项。 */
export function ProjectBoardTrendCard({
  user,
  projectId,
  metric,
}: {
  user: AuthUser;
  projectId: number;
  metric: ProjectBoardTrendMetric;
}) {
  const id = useId();
  const cache = useQueryClient();
  const role = user.selectedRole ?? user.role;
  const [range, setRange] = useState(() => {
    const endDate = productionPlanToday();
    return {
      startDate: new Date(Date.parse(`${endDate}T00:00:00Z`) - 6 * 86400000)
        .toISOString()
        .slice(0, 10),
      endDate,
    };
  });
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState<Error | null>(null);
  const trends = useQuery({
    queryKey: ['project-board-trends', user.id, role, projectId, { metric, ...range }],
    enabled: role === 'PM' || (role === 'EXPERT' && user.hasExpertManagementRole === true),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const requireIdentity = () => {
        const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
        if (session?.id !== user.id || (session.selectedRole ?? session.role) !== role)
          throw new Error('当前账号或角色已变化，请重新读取人员趋势。');
      };
      requireIdentity();
      const result = await api.getProjectBoardTrends({ projectId, metric, ...range });
      requireIdentity();
      return result;
    },
  });
  return (
    <Card asChild>
      <section aria-label={titles[metric]} className="min-w-0 space-y-4 p-4 sm:p-5">
        <CardTitle>{titles[metric]}</CardTitle>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const days =
              (Date.parse(`${draft.endDate}T00:00:00Z`) -
                Date.parse(`${draft.startDate}T00:00:00Z`)) /
              86400000;
            if (
              !personnelDay(draft.startDate) ||
              !personnelDay(draft.endDate) ||
              draft.startDate.startsWith('0000') ||
              draft.endDate.startsWith('0000') ||
              days < 0 ||
              days >= 31
            ) {
              setError(new Error('请选择有效的日期范围，包含首尾最多31天。'));
              return;
            }
            setError(null);
            if (range.startDate === draft.startDate && range.endDate === draft.endDate)
              void trends.refetch();
            else setRange({ ...draft });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={`${id}-start`} className="text-xs">
              趋势开始日期
            </label>
            <Input
              id={`${id}-start`}
              type="date"
              required
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={`${id}-end`} className="text-xs">
              趋势结束日期
            </label>
            <Input
              id={`${id}-end`}
              type="date"
              required
              value={draft.endDate}
              onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
            />
          </div>
          <Button type="submit" size="mobileTouch" loading={trends.isFetching}>
            查询趋势
          </Button>
        </form>
        <ErrorNotice error={error} />
        <ErrorNotice error={trends.error} />
        {trends.isPending && <LoadingState>正在读取人员趋势…</LoadingState>}
        {trends.isError && (
          <Button variant="outline" size="mobileTouch" onClick={() => void trends.refetch()}>
            重新读取人员趋势
          </Button>
        )}
        {trends.isSuccess && <ProjectBoardTrendsView data={trends.data} />}
      </section>
    </Card>
  );
}
