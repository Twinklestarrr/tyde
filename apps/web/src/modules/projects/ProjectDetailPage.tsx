import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/empty-state';
import { NavigatorProjectWorkflow, projectCardNode, projectNodeLabel } from './ProjectWorkflow';
import { ProjectManagerPanel } from './ProjectManagerPanel';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ProjectCardTransition } from './ProjectCardTransition';
import { useProjectCardContinuation } from './useProjectCardContinuation';

export function ProjectDetailPage({ user, projectId }: { user: AuthUser; projectId: number }) {
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'NAVIGATOR', projectId],
    queryFn: () => api.getProjectDetail(projectId),
    retry: false,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState('RECRUIT_PROJECT_MANAGER');
  const continuation = useProjectCardContinuation({
    user,
    projectId,
    role: 'NAVIGATOR',
    reloadDetail: () => detail.refetch({ throwOnError: true }),
    onContinue: (card) => {
      const next = projectCardNode(card);
      if (
        [
          'RECRUIT_PROJECT_MANAGER',
          'ENTRANCE_EXAM',
          'STANDARD_TRAINING',
          'PRODUCTION_TASK',
        ].includes(next)
      )
        setTab(next);
    },
  });
  const project = detail.data;
  return (
    <ProjectCardTransition transitionKey={continuation.transition} className="space-y-3">
      <Card asChild>
        <section aria-label="项目主流程" className="space-y-4 p-5">
          <h1 className="sr-only">领航员项目流程</h1>
          <div role="toolbar" aria-label="项目操作" className="flex items-center gap-2">
            <Button asChild variant="ghost" size="mobileTouch">
              <Link to="/projects">
                <ArrowLeft className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">返回我的项目</span>
              </Link>
            </Button>
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {project && `当前阶段：${projectNodeLabel(project.currentNodeCode)}`}
            </p>
            <Button
              variant="primaryOutline"
              size="mobileTouch"
              title="查看项目详情"
              disabled={!project}
              onClick={() => setDetailsOpen(true)}
            >
              <FileText className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">查看项目详情</span>
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={detail.isFetching}
              onClick={() => void detail.refetch()}
            >
              <RefreshCw className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">刷新详情</span>
            </Button>
          </div>
          <ErrorNotice error={detail.error} />
          {detail.isPending && <LoadingState>正在读取项目详情…</LoadingState>}
          {project && (
            <NavigatorProjectWorkflow
              currentNodeCode={project.currentNodeCode}
              tab={tab}
              onTabChange={(next) => {
                continuation.cancel();
                setTab(next);
              }}
              recruitment={
                <ProjectManagerPanel
                  user={user}
                  projectId={projectId}
                  refreshProject={continuation.refresh}
                />
              }
            />
          )}
        </section>
      </Card>
      {project && detailsOpen && (
        <ProjectDetailsDialog project={project} onClose={() => setDetailsOpen(false)} />
      )}
    </ProjectCardTransition>
  );
}
