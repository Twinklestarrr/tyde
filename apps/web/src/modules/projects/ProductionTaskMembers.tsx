import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SearchInput } from '@/components/ui/search-input';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';

export function ProductionTaskMembers({
  user,
  projectId,
  subtaskId,
  selectedIds = [],
  onSelect,
  disabled = false,
  role = 'PM',
}: {
  user: AuthUser;
  projectId: number;
  subtaskId?: number;
  selectedIds?: number[];
  onSelect?: (id: number, checked: boolean) => void;
  disabled?: boolean;
  role?: 'PM' | 'EXPERT' | 'NAVIGATOR';
}) {
  const cache = useQueryClient(),
    id = useId();
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState({ keyword: '', current: 1 });
  const validSubtask =
    typeof subtaskId === 'number' &&
    Number.isInteger(subtaskId) &&
    subtaskId > 0 &&
    subtaskId <= 2147483647;
  const readOnlyRole = role === 'NAVIGATOR' ? '领航员' : '执行专家';
  function current() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  const query = useQuery({
    queryKey: [
      'production-task-members',
      user.id,
      role,
      projectId,
      subtaskId ?? 'candidates',
      filter,
    ],
    enabled: role === 'PM' || validSubtask,
    queryFn: async () => {
      if (!current()) throw new Error('当前身份已变化，请重新进入生产任务。');
      if (role !== 'PM' && !validSubtask)
        throw new Error(`${readOnlyRole}仅可查看子任务已指定或认领人员。`);
      const input = { projectId, ...filter, size: 20 };
      const result = subtaskId
        ? await api.listProductionTaskAssignees({ ...input, subtaskId })
        : await api.listProductionTaskMembers(input);
      if (!current()) throw new Error('当前身份已变化，请重新进入生产任务。');
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <section aria-label={subtaskId ? '子任务人员列表' : '可指定成员'} className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter({ keyword: keyword.trim(), current: 1 });
        }}
      >
        <SearchInput
          id={id}
          label={subtaskId ? '筛选任务成员' : '筛选可指定成员'}
          value={keyword}
          maxLength={100}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="姓名、昵称或用户 ID"
          containerClassName="flex-1 basis-[200px]"
        />
        <Button type="submit" size="mobileTouch" loading={query.isFetching}>
          {subtaskId ? '查询任务成员' : '查询可指定成员'}
        </Button>
      </form>
      <ErrorNotice error={query.error} />
      {role !== 'PM' && !validSubtask && (
        <EmptyState title={`${readOnlyRole}仅可查看子任务已指定或认领人员。`} />
      )}
      {query.isPending && (role === 'PM' || validSubtask) && (
        <LoadingState>正在读取成员…</LoadingState>
      )}
      {query.isSuccess && current() && (
        <>
          <div
            role="group"
            aria-label="生产成员列表"
            tabIndex={0}
            className="max-h-[28rem] space-y-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {query.data.records.map((member) => (
              <Card asChild key={member.memberId}>
                <article
                  aria-label={member.displayName}
                  className="flex items-start gap-3 p-4 text-[13px]"
                >
                  {role === 'PM' && onSelect && (
                    <label className="flex size-11 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        aria-label={`指定${member.displayName}`}
                        className="size-4 accent-primary"
                        disabled={
                          disabled ||
                          query.isFetching ||
                          (!selectedIds.includes(member.memberId) && selectedIds.length >= 1000)
                        }
                        checked={selectedIds.includes(member.memberId)}
                        onChange={(e) => onSelect(member.memberId, e.target.checked)}
                      />
                    </label>
                  )}
                  <div className="min-w-0 flex-1">
                    <h4 className="break-words font-medium">{member.displayName}</h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {member.organizationName || '个人'} · {member.userId} · 成员 #
                      {member.memberId}
                    </p>
                    {member.assignmentType && (
                      <p className="mt-2">
                        {member.assignmentType === 'DESIGNATED' ? '指定' : '认领'}于{' '}
                        {member.assignedAt || '未记录'}
                      </p>
                    )}
                  </div>
                </article>
              </Card>
            ))}
          </div>
          {!query.data.records.length && (
            <EmptyState title={subtaskId ? '暂无已指定或认领人员' : '暂无符合实际入项条件的成员'} />
          )}
          <Pagination
            aria-label={subtaskId ? '子任务成员分页' : '可指定成员分页'}
            {...query.data}
            loading={query.isFetching}
            onPageChange={(current) => setFilter({ ...filter, current })}
          />
        </>
      )}
    </section>
  );
}
