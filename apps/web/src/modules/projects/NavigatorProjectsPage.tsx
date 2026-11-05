import { ProjectCardPeople } from './ProjectCardPeople';
import { WorkbenchStatistics } from './WorkbenchStatistics';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FilePenLine, FolderOpen, Plus, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { projectCardNode, projectNodeLabel } from './ProjectWorkflow';
import { ProjectCardTransition } from './ProjectCardTransition';

/** 本人待办与唯一草稿分开读取，不将待办接口当成完整项目库。 */
export function NavigatorProjectsPage({ user, created }: { user: AuthUser; created?: number }) {
  const [keyword, setKeyword] = useState('');
  const projects = useQuery({
    queryKey: ['navigator-projects', user.id, 'NAVIGATOR'],
    queryFn: () => api.listNavigatorProjects(),
    retry: false,
  });
  const draft = useQuery({
    queryKey: ['project-draft', user.id, 'NAVIGATOR'],
    queryFn: () => api.getCurrentProjectDraft(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const query = keyword.trim().toLocaleLowerCase();
  const visible = (projects.data ?? []).filter((project) =>
    [
      project.projectName,
      project.projectNo,
      project.requesterName,
      project.categoryDisplayName,
    ].some((value) => value?.toLocaleLowerCase().includes(query)),
  );

  return (
    <ProjectCardTransition direction="back" className="space-y-5">
      <WorkbenchStatistics user={user} />
      <h1 className="sr-only">我创建的项目</h1>
      <div className="flex items-center gap-2 sm:gap-3">
        <SearchInput
          id="navigator-project-search"
          label="筛选当前待办"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索项目"
          containerClassName="flex-1"
        />
        <Button
          variant="ghost"
          size="settings"
          className="w-[40px] shrink-0 px-0 max-[640px]:w-[44px]"
          aria-label="刷新项目"
          title="刷新项目"
          loading={projects.isFetching}
          onClick={() => void projects.refetch()}
        >
          {!projects.isFetching && <RefreshCw className="size-4" aria-hidden />}
        </Button>
        <Button asChild size="settings" className="ml-auto shrink-0">
          <Link to="/projects/create">
            <Plus className="size-4" aria-hidden />
            创建项目
          </Link>
        </Button>
      </div>
      {created && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
        >
          <span className="text-primary">项目已发布</span>
          <Button asChild variant="primaryGhost" size="mobileTouch">
            <Link to="/projects/$projectId" params={{ projectId: String(created) }}>
              查看已发布项目
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      )}
      {draft.data?.hasDraft && (
        <section
          aria-label="项目草稿"
          className="flex items-center gap-3 rounded-xl bg-muted px-4 py-2"
        >
          <FilePenLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-[13px]">
            草稿 · {draft.data.draft?.projectName || '未命名草稿'}
          </h2>
          <Button asChild variant="primaryGhost" size="mobileTouch" className="shrink-0">
            <Link to="/projects/create">继续完善</Link>
          </Button>
        </section>
      )}
      {draft.isError && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ErrorNotice error={draft.error} />
          <Button
            variant="ghost"
            size="mobileTouch"
            loading={draft.isFetching}
            onClick={() => void draft.refetch()}
          >
            重试读取草稿
          </Button>
        </div>
      )}
      <section aria-labelledby="navigator-projects-title" className="space-y-4">
        <h2 id="navigator-projects-title" className="sr-only">
          当前待办项目
        </h2>
        <ErrorNotice error={projects.error} />
        {projects.isPending && <LoadingState>正在读取项目…</LoadingState>}
        {!projects.isPending && !projects.isError && !visible.length && (
          <Card>
            <EmptyState
              className="min-h-[240px] justify-center"
              icon={<FolderOpen className="size-8" aria-hidden />}
              title={query ? '没有匹配的待办项目' : '暂无待办项目'}
              description={
                query
                  ? '试试其他关键词，或清除搜索查看全部待办。'
                  : '当前没有需要处理的项目，后续待办会显示在这里。'
              }
              action={
                <>
                  {query && (
                    <Button variant="outline" size="settings" onClick={() => setKeyword('')}>
                      清除搜索
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="settings"
                    loading={projects.isFetching}
                    onClick={() => void projects.refetch()}
                  >
                    重新加载
                  </Button>
                </>
              }
            />
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {visible.map((project) => {
            const node = projectCardNode(project);
            return (
              <Card asChild key={project.id}>
                <article className="project-card flex min-w-0 flex-col p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <CardTitle asChild className="min-w-0 flex-1">
                      <h3>{project.projectName || '未命名项目'}</h3>
                    </CardTitle>
                    <span className="rounded-md bg-accent px-2 py-1 text-xs text-primary">
                      {projectNodeLabel(node)}
                    </span>
                  </div>
                  <p
                    className="mt-3 truncate text-[13px] text-muted-foreground"
                    title={project.requesterName}
                  >
                    {project.requesterName}
                  </p>
                  <ProjectCardPeople project={project} />
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <p
                      className="mr-auto text-xs text-muted-foreground"
                      title={
                        project.deadline ? `截止时间：${project.deadline}（上海时间）` : undefined
                      }
                    >
                      {project.deadline
                        ? `截止 ${project.deadline.slice(0, 10)}`
                        : '未设置截止日期'}
                    </p>
                    {project.currentAction === 'RECRUIT_PROJECT_MANAGER' && (
                      <Button
                        asChild
                        variant="primaryGhost"
                        size="mobileTouch"
                        className="project-card-secondary"
                      >
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: String(project.id) }}
                          hash="project-manager"
                        >
                          招募策略官
                        </Link>
                      </Button>
                    )}
                    <Button
                      asChild
                      variant="ghost"
                      size="iconTouch"
                      className="project-card-link shrink-0"
                    >
                      <Link to="/projects/$projectId" params={{ projectId: String(project.id) }}>
                        <span className="sr-only">查看项目</span>
                        <ArrowRight className="size-4" aria-hidden />
                      </Link>
                    </Button>
                  </div>
                </article>
              </Card>
            );
          })}
        </div>
      </section>
    </ProjectCardTransition>
  );
}
