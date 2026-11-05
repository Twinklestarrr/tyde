import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** 任务数来自 TASK 统计，不能使用待办项目列表长度替代任务轮次。 */
export function WorkbenchStatistics({ user }: { user: AuthUser }) {
  const cache = useQueryClient();
  const role = user.selectedRole ?? user.role;
  const stats = useQuery({
    queryKey: ['workbench-statistics', user.id, role, 'TASK'],
    queryFn: async () => {
      const current = () => {
        const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
        return session?.id === user.id && (session.selectedRole ?? session.role) === role;
      };
      if (!current()) throw new Error('当前账号或角色已变化，请重新读取工作台统计。');
      const result = await api.getProjectWorkbenchStatistics('TASK');
      if (!current()) throw new Error('当前账号或角色已变化，请重新读取工作台统计。');
      return result;
    },
    retry: false,
  });
  const data = stats.isSuccess && stats.data.mode === 'TASK' ? stats.data : undefined;
  return (
    <section aria-label="任务统计" className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          ['今日任务', data?.pendingTaskCount, '当前待处理任务'],
          ['已完成任务', data?.completedTaskCount, '累计完成任务轮次'],
          ['涉及项目', data?.involvedProjectCount, '当前角色参与项目'],
        ].map(([label, value, hint]) => (
          <Card key={label} className="space-y-2 p-4">
            <dt className="text-sm">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{value ?? '—'}</dd>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </Card>
        ))}
      </dl>
      <ErrorNotice error={stats.error} />
      {stats.isError && (
        <Button variant="outline" size="mobileTouch" onClick={() => void stats.refetch()}>
          重试读取任务统计
        </Button>
      )}
    </section>
  );
}
