import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { NavigatorProjectWorkflow } from './ProjectWorkflow';
import { ProjectManagerPanel } from './ProjectManagerPanel';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';

export function ProjectDetailPage({ user, projectId }: { user: AuthUser; projectId: number }) {
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'NAVIGATOR', projectId],
    queryFn: () => api.getProjectDetail(projectId),
    retry: false,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const project = detail.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="mobileTouch">
          <Link to="/projects">
            <ArrowLeft className="size-4" aria-hidden />
            返回我的项目
          </Link>
        </Button>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={detail.isFetching}
          onClick={() => void detail.refetch()}
        >
          <RefreshCw className="size-4" aria-hidden />
          刷新详情
        </Button>
      </div>
      <ErrorNotice error={detail.error} />
      {detail.isPending && (
        <p role="status" className="p-8 text-center text-sm text-muted-foreground">
          正在读取项目详情…
        </p>
      )}
      {project && (
        <>
          <header className="rounded-[16px] border bg-card p-5 sm:p-6">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{project.projectNo}</span>
              <span className="rounded-md bg-accent px-2 py-1 text-primary">已发布</span>
            </div>
            <h1 className="break-words text-[24px] font-semibold">
              {project.projectName || '未命名项目'}
            </h1>
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">
              {project.projectDescription || '暂无项目描述'}
            </p>
          </header>
          <NavigatorProjectWorkflow
            currentNodeCode={project.currentNodeCode}
            onViewDetails={() => setDetailsOpen(true)}
            recruitment={
              <ProjectManagerPanel
                user={user}
                projectId={projectId}
                refreshProject={async () => {
                  await detail.refetch({ throwOnError: true });
                }}
              />
            }
          />
          {detailsOpen && (
            <ProjectDetailsDialog project={project} onClose={() => setDetailsOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}
