import { ProjectCardPeople } from './ProjectCardPeople';
import { WorkbenchStatistics } from './WorkbenchStatistics';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, FolderOpen, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { projectCardNode, projectNodeLabel } from './ProjectWorkflow';
import { ProjectCardTransition } from './ProjectCardTransition';

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
    <ProjectCardTransition direction="back" className="space-y-5">
      <WorkbenchStatistics user={user} />
      <h1 className="sr-only">我负责的项目</h1>
      <div className="flex items-center gap-3">
        <SearchInput
          id="strategist-project-search"
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
      </div>
      <section aria-label="策略官待办项目" className="space-y-4">
        <h2 className="sr-only">当前待办项目</h2>
        <ErrorNotice error={projects.error} />
        {projects.isPending && <LoadingState>正在读取项目…</LoadingState>}
        {!projects.isPending && !projects.isError && !visible.length && (
          <Card>
            <EmptyState
              className="min-h-[240px] justify-center"
              icon={<FolderOpen className="size-8" aria-hidden />}
              title={search ? '没有匹配的待办项目' : '暂无待办项目'}
              description={
                search
                  ? '试试其他关键词，或清除搜索查看全部待办。'
                  : '当前没有需要处理的项目，后续待办会显示在这里。'
              }
              action={
                <>
                  {search && (
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
                    title={`${project.requesterName} · ${project.primaryProjectManager ? '主策略官' : '招募协作负责人'}`}
                  >
                    {project.requesterName} ·{' '}
                    {project.primaryProjectManager ? '主策略官' : '招募协作负责人'}
                  </p>
                  <ProjectCardPeople project={project} />
                  <div className="mt-5 flex items-center justify-between gap-2">
                    <p
                      className="text-xs text-muted-foreground"
                      title={
                        project.deadline ? `截止时间：${project.deadline}（上海时间）` : undefined
                      }
                    >
                      {project.deadline
                        ? `截止 ${project.deadline.slice(0, 10)}`
                        : '未设置截止日期'}
                    </p>
                    <Button
                      asChild
                      variant="ghost"
                      size="iconTouch"
                      className="project-card-link shrink-0"
                    >
                      <Link
                        to="/strategist/projects/$projectId"
                        params={{ projectId: String(project.id) }}
                        search={
                          node === 'ENTRANCE_EXAM'
                            ? { tab: 'ENTRANCE_EXAM' }
                            : node === 'STANDARD_TRAINING'
                              ? { tab: 'STANDARD_TRAINING' }
                              : node === 'RECRUIT_EXECUTION_EXPERT'
                                ? { tab: 'RECRUIT_EXECUTION_EXPERT' }
                                : node === 'PERSONNEL_MANAGEMENT'
                                  ? {
                                      tab: 'PERSONNEL_MANAGEMENT',
                                      ...(project.branchNodeCode === 'MEMBER_MOVEMENT_APPROVAL'
                                        ? { personnelView: 'movements' as const }
                                        : {}),
                                    }
                                  : node === 'PRODUCTION_TASK'
                                    ? { tab: 'PRODUCTION_TASK' }
                                    : {}
                        }
                      >
                        <span className="sr-only">
                          {node === 'ENTRANCE_EXAM'
                            ? '准入考试'
                            : node === 'STANDARD_TRAINING'
                              ? '标准与培训'
                              : node === 'RECRUIT_EXECUTION_EXPERT'
                                ? '招募执行专家'
                                : node === 'PERSONNEL_MANAGEMENT'
                                  ? '人员管理'
                                  : node === 'PRODUCTION_TASK'
                                    ? '生产任务'
                                    : '生产计划'}
                        </span>
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
