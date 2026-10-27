import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, FolderOpen, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectNodeLabel } from './ProjectWorkflow';

export function StrategistProjectsPage({ user }: { user: AuthUser }) {
  const [keyword, setKeyword] = useState('');
  const projects = useQuery({
    queryKey: ['strategist-projects', user.id, 'PM'],
    queryFn: () => api.listStrategistProjects(),
    retry: false,
  });
  const search = keyword.trim().toLocaleLowerCase();
  const visible = (projects.data ?? []).filter((project) =>
    [
      project.projectNo,
      project.projectName,
      project.requesterName,
      project.categoryDisplayName,
    ].some((value) => value?.toLocaleLowerCase().includes(search)),
  );
  return (
    <div className="space-y-6">
      <header>
        <p className="mb-2 text-xs font-medium text-primary">策略官工作台</p>
        <h1 className="text-[24px] font-semibold tracking-tight">我负责的项目</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          查看当前项目待办，配置与核对生产计划。
        </p>
      </header>
      <section
        aria-label="策略官待办项目"
        className="space-y-5 rounded-[16px] border bg-card p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">当前待办项目</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              仅展示当前角色的待办，项目推进后可能移出列表。
            </p>
          </div>
          <Button
            variant="outline"
            size="mobileTouch"
            loading={projects.isFetching}
            onClick={() => void projects.refetch()}
          >
            <RefreshCw className="size-4" aria-hidden />
            刷新项目
          </Button>
        </div>
        <div className="max-w-md space-y-2">
          <label htmlFor="strategist-project-search" className="text-[13px] font-medium">
            筛选当前待办
          </label>
          <Input
            id="strategist-project-search"
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="项目名称、编号、需求方或分类"
          />
        </div>
        <ErrorNotice error={projects.error} />
        {projects.isPending && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            正在读取项目…
          </p>
        )}
        {!projects.isPending && !projects.isError && !visible.length && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <FolderOpen className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm">{search ? '没有匹配的待办项目' : '暂无待办项目'}</p>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {visible.map((project) => (
            <article key={project.id} className="flex min-w-0 flex-col rounded-xl border p-5">
              <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{project.projectNo}</span>
                <span className="rounded-md bg-accent px-2 py-1 text-primary">
                  {project.workbenchStatusDescription}
                </span>
              </div>
              <h3 className="break-words text-base font-semibold">
                {project.projectName || '未命名项目'}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">{project.categoryDisplayName}</p>
              <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-muted-foreground">需求方</dt>
                <dd className="break-words">{project.requesterName}</dd>
                <dt className="text-muted-foreground">当前阶段</dt>
                <dd>{projectNodeLabel(project.currentNodeCode)}</dd>
                <dt className="text-muted-foreground">项目身份</dt>
                <dd>{project.primaryProjectManager ? '主策略官' : '招募协作负责人'}</dd>
                <dt className="text-muted-foreground">截止时间</dt>
                <dd>{project.deadline || '未设置'}（上海时间）</dd>
              </dl>
              <div className="mt-auto flex justify-end border-t pt-4">
                <Button asChild variant="primaryOutline" size="mobileTouch">
                  <Link
                    to="/strategist/projects/$projectId"
                    params={{ projectId: String(project.id) }}
                  >
                    生产计划
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
