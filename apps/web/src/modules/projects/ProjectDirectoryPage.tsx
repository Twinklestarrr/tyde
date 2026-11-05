import { useEffect, useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page';
import { SearchInput } from '@/components/ui/search-input';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { projectNodeLabel } from './ProjectWorkflow';
import { boardNumber } from './ProjectBoardTrends';

export interface ProjectDirectorySearch {
  view?: 'managed' | 'participating';
  keyword?: string;
  page?: number;
}
export interface ProjectDirectoryDetailSearch extends ProjectDirectorySearch {
  scope?: 'managed' | 'participating';
  assignmentId?: number;
  movementId?: number;
  invalidSource?: boolean;
}
const personalNodeNames: Record<string, string> = {
  OUTPUT_DATA_REVIEW: '检查数据',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
};
const admissionNames = {
  PASSED: '已通过准入',
  PENDING: '等待阅卷',
  NOT_PASSED: '尚未取得通过结果',
  NOT_EXAMINED: '未参加考试',
};

/** 完整目录按独立权限范围读取，不以当前待办决定项目是否可见。 */
export function ProjectDirectoryPage({
  user,
  search,
  onSearch,
}: {
  user: AuthUser;
  search: ProjectDirectorySearch;
  onSearch: (next: ProjectDirectorySearch) => void;
}) {
  const cache = useQueryClient();
  const id = useId();
  const role = user.selectedRole ?? user.role;
  const managed =
    role !== 'EXPERT' || (user.hasExpertManagementRole === true && search.view !== 'participating');
  const keyword = search.keyword ?? '';
  const page = search.page ?? 1;
  const [input, setInput] = useState(keyword);
  useEffect(() => setInput(keyword), [keyword]);
  function requireIdentity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== user.id || (current.selectedRole ?? current.role) !== role)
      throw new Error('当前账号或角色已变化，请重新读取项目。');
  }
  const projects = useQuery({
    queryKey: ['project-directory', user.id, role, 'managed', keyword, page],
    enabled: managed,
    queryFn: async () => {
      requireIdentity();
      const result = await api.listProjectBoardProjects({ keyword, current: page, size: 20 });
      requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const statistics = useQuery({
    queryKey: ['project-directory', user.id, role, 'statistics'],
    enabled: managed,
    queryFn: async () => {
      requireIdentity();
      const result = await api.getProjectWorkbenchStatistics('BOARD');
      requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const participating = useQuery({
    queryKey: ['project-directory', user.id, role, 'participating', keyword],
    enabled: !managed && role === 'EXPERT',
    queryFn: async () => {
      requireIdentity();
      const result = await api.getMyExpertProjects(keyword || undefined);
      requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const loading = managed ? projects.isFetching || statistics.isFetching : participating.isFetching;
  function refresh() {
    if (managed) {
      void projects.refetch();
      void statistics.refetch();
    } else void participating.refetch();
  }
  const backSearch = {
    ...search,
    view: managed ? ('managed' as const) : ('participating' as const),
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="项目"
        icon={<FolderKanban />}
        description={
          managed
            ? '查看所有有权管理的项目，包括没有当前待办及已经结项的项目。'
            : '查看本人参与的项目及项目资料。'
        }
        actions={
          <Button variant="outline" size="mobileTouch" loading={loading} onClick={refresh}>
            <RefreshCw className="size-4" aria-hidden />
            刷新项目
          </Button>
        }
      />
      {role === 'EXPERT' && user.hasExpertManagementRole === true && (
        <Tabs
          value={managed ? 'managed' : 'participating'}
          onValueChange={(view) => onSearch({ view: view as 'managed' | 'participating' })}
        >
          <TabsList aria-label="项目范围" variant="business">
            <TabsTrigger value="managed" variant="business">
              管理项目
            </TabsTrigger>
            <TabsTrigger value="participating" variant="business">
              参与项目
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {managed && (
        <section aria-label="项目概览" className="space-y-3">
          <ErrorNotice error={statistics.error} />
          {statistics.isSuccess && statistics.data.mode === 'BOARD' && (
            <>
              <p className="text-sm font-medium">全部项目 {statistics.data.totalProjectCount}</p>
              <dl className="grid gap-3 sm:grid-cols-3">
                {[
                  ['启动中', statistics.data.startupProjectCount],
                  ['组建中', statistics.data.assemblyProjectCount],
                  ['生产中', statistics.data.productionProjectCount],
                ].map(([label, value]) => (
                  <Card key={label} className="min-w-0 p-5">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-2 break-all text-2xl font-semibold tabular-nums">{value}</dd>
                  </Card>
                ))}
              </dl>
            </>
          )}
          {statistics.isSuccess && (
            <p className="text-xs text-muted-foreground">
              全部项目包含已结项项目；生产中仅统计已有子任务报量的项目，各阶段数量之和可能小于总数。
            </p>
          )}
        </section>
      )}
      <Card className="space-y-5 p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim() === keyword && page === 1) refresh();
            else onSearch({ ...backSearch, keyword: input.trim() || undefined, page: 1 });
          }}
        >
          <SearchInput
            id={id}
            label="筛选项目"
            value={input}
            maxLength={managed ? 128 : 100}
            onChange={(event) => setInput(event.target.value)}
            placeholder="项目名称或需求方"
            containerClassName="flex-1 basis-[220px]"
          />
          <Button type="submit" size="mobileTouch" loading={loading}>
            查询项目
          </Button>
          <Button
            variant="outline"
            size="mobileTouch"
            onClick={() => {
              setInput('');
              onSearch({ view: backSearch.view });
            }}
          >
            重置项目筛选
          </Button>
        </form>
        <ErrorNotice error={managed ? projects.error : participating.error} />
        {(managed ? projects.isPending : participating.isPending) && (
          <LoadingState>正在读取项目列表…</LoadingState>
        )}
        {managed && projects.isSuccess && (
          <>
            <div role="group" aria-label="完整项目列表" className="grid gap-4 lg:grid-cols-2">
              {projects.data.records.map((project) => (
                <Card asChild key={project.projectId}>
                  <article aria-label={project.projectName} className="min-w-0 space-y-3 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <CardTitle asChild>
                        <h2 className="break-words">{project.projectName || '未命名项目'}</h2>
                      </CardTitle>
                      <span className="rounded-md bg-muted px-2 py-1 text-xs">
                        {project.currentNodeName || projectNodeLabel(project.currentNodeCode)}
                      </span>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">{project.projectNo}</p>
                    <p className="break-words text-[13px]">需求方：{project.requesterName}</p>
                    <p className="text-[13px]">
                      交付量 {boardNumber(project.progressQuantity)} /{' '}
                      {boardNumber(project.targetQuantity)} {project.quantityUnit || ''}
                    </p>
                    <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                      <span>交付进度</span>
                      <span className="font-semibold text-primary">
                        {boardNumber(project.progressPercent)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(0, Math.min(100, project.progressPercent))}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      截止时间：{project.deadline || '未设置'}（上海时间）
                    </p>
                    <Button asChild variant="primaryOutline" size="mobileTouch">
                      <Link
                        to="/project-directory/$projectId"
                        params={{ projectId: String(project.projectId) }}
                        search={{ ...backSearch, scope: 'managed' }}
                      >
                        查看项目
                      </Link>
                    </Button>
                  </article>
                </Card>
              ))}
            </div>
            {!projects.data.records.length && <EmptyState title="暂无符合条件的项目" />}
            <Pagination
              aria-label="项目列表分页"
              {...projects.data}
              loading={projects.isFetching}
              onPageChange={(page) => onSearch({ ...backSearch, page })}
            />
          </>
        )}
        {!managed && participating.isSuccess && (
          <>
            <div role="group" aria-label="参与项目列表" className="grid gap-4 lg:grid-cols-2">
              {participating.data.map((project) => (
                <Card
                  asChild
                  key={`${project.projectId}:${project.assignmentId}:${project.movementId}`}
                >
                  <article
                    aria-label={project.projectName || `项目 ${project.projectId}`}
                    className="space-y-3 p-5"
                  >
                    <CardTitle asChild>
                      <h2 className="break-words">
                        {project.projectName || `项目 ${project.projectId}`}
                      </h2>
                    </CardTitle>
                    <p className="break-words text-[13px]">需求方：{project.requesterName}</p>
                    <p className="text-[13px]">
                      本人阶段：
                      {personalNodeNames[project.currentNodeCode] ||
                        projectNodeLabel(project.currentNodeCode)}
                    </p>
                    {project.needWrittenExam && (
                      <p className="text-xs text-muted-foreground">
                        {admissionNames[project.admissionStatus]}
                      </p>
                    )}
                    <Button asChild variant="primaryOutline" size="mobileTouch">
                      <Link
                        to="/project-directory/$projectId"
                        params={{ projectId: String(project.projectId) }}
                        search={{
                          ...backSearch,
                          scope: 'participating',
                          ...(project.assignmentId === null
                            ? { movementId: project.movementId! }
                            : { assignmentId: project.assignmentId }),
                        }}
                      >
                        查看项目
                      </Link>
                    </Button>
                  </article>
                </Card>
              ))}
            </div>
            {!participating.data.length && <EmptyState title="暂无参与项目" />}
            <p className="text-xs text-muted-foreground">
              共 {participating.data.length} 个匹配项目
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
