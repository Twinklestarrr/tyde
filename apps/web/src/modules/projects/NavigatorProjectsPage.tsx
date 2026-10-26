import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FilePenLine, FolderOpen, Plus, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectNodeLabel } from './ProjectWorkflow';

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
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-medium text-primary">领航员工作台</p>
          <h1 className="text-[24px] font-semibold tracking-tight">我创建的项目</h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            从创建与发布开始，在项目内跟进各阶段协作。
          </p>
        </div>
        <Button asChild size="mobileTouch">
          <Link to="/projects/create">
            <Plus className="size-4" aria-hidden />
            创建项目
          </Link>
        </Button>
      </header>

      {created && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm"
        >
          <span>项目已发布，可进入详情查看。</span>
          <Button asChild variant="primaryGhost" size="mobileTouch">
            <Link to="/projects/$projectId" params={{ projectId: String(created) }}>
              查看已发布项目
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      )}

      <section aria-label="项目草稿" className="rounded-[16px] border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <FilePenLine className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold">
                {draft.data?.hasDraft ? draft.data.draft?.projectName || '未命名草稿' : '项目草稿'}
              </h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {draft.isPending
                  ? '正在读取草稿…'
                  : draft.data?.hasDraft
                    ? `已保存 · ${draft.data.draft?.updatedAt}，继续完善后即可发布。`
                    : draft.isError
                      ? '暂时无法确认草稿状态，请重试读取。'
                      : '你可以先保存一份草稿，准备好后再发布。'}
              </p>
            </div>
          </div>
          {draft.data?.hasDraft && (
            <Button asChild variant="outline" size="mobileTouch">
              <Link to="/projects/create">继续完善</Link>
            </Button>
          )}
          {draft.isError && (
            <Button
              variant="outline"
              loading={draft.isFetching}
              onClick={() => void draft.refetch()}
            >
              重试读取草稿
            </Button>
          )}
        </div>
        <div className="mt-3 empty:hidden">
          <ErrorNotice error={draft.error} />
        </div>
      </section>

      <section
        aria-labelledby="navigator-projects-title"
        className="space-y-5 rounded-[16px] border bg-card p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="navigator-projects-title" className="text-base font-semibold">
              当前待办项目
            </h2>
            <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
              这里展示当前需要你处理的已发布项目。项目推进后可能不再出现在待办中。
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
          <label htmlFor="navigator-project-search" className="text-[13px] font-medium">
            筛选当前待办
          </label>
          <Input
            id="navigator-project-search"
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
            <p className="text-sm font-medium">{query ? '没有匹配的待办项目' : '暂无待办项目'}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {query
                ? '换一个关键词，或清空筛选查看全部当前待办。'
                : '新发布的项目会从招募策略官阶段开始。'}
            </p>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {visible.map((project) => (
            <article key={project.id} className="flex min-w-0 flex-col rounded-xl border p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="break-all text-xs text-muted-foreground">{project.projectNo}</span>
                <span className="rounded-md bg-accent px-2 py-1 text-xs text-primary">
                  {project.workbenchStatusDescription}
                </span>
              </div>
              <h3 className="break-words text-base font-semibold">
                {project.projectName || '未命名项目'}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">{project.categoryDisplayName}</p>
              {project.projectDescription && (
                <p className="mt-3 line-clamp-2 text-[13px] leading-6 text-muted-foreground">
                  {project.projectDescription}
                </p>
              )}
              <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-muted-foreground">需求方</dt>
                <dd className="break-words">{project.requesterName}</dd>
                <dt className="text-muted-foreground">当前阶段</dt>
                <dd>{projectNodeLabel(project.currentNodeCode)}</dd>
                <dt className="text-muted-foreground">策略官</dt>
                <dd>{project.projectManagerName || project.projectManagerStatusDescription}</dd>
                <dt className="text-muted-foreground">项目人数</dt>
                <dd>
                  {project.activeExpertCount} 人在项
                  {project.requiredHeadcount != null && ` / 需求 ${project.requiredHeadcount} 人`}
                </dd>
                <dt className="text-muted-foreground">截止时间</dt>
                <dd>{project.deadline || '未设置'}（上海时间）</dd>
              </dl>
              <div className="mt-auto flex flex-wrap justify-end gap-3 border-t pt-4">
                {project.currentAction === 'RECRUIT_PROJECT_MANAGER' && (
                  <Button asChild size="mobileTouch">
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: String(project.id) }}
                      hash="project-manager"
                    >
                      招募策略官
                    </Link>
                  </Button>
                )}
                <Button asChild variant="primaryOutline" size="mobileTouch">
                  <Link to="/projects/$projectId" params={{ projectId: String(project.id) }}>
                    查看项目
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
