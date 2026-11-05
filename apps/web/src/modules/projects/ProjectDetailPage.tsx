import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { ApiError, type AuthUser } from '@tyde/shared';
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
import { NavigatorExamPanel } from './NavigatorExamPanel';
import { StandardTrainingPanel, STANDARD_TRAINING_LEAVE_REQUEST } from './StandardTrainingPanel';
import { ProductionTasksPanel } from './ProductionTasksPanel';
import { PRODUCTION_TASKS_LEAVE_REQUEST } from './production-task-form';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { SESSION_KEY } from '@/hooks/useSession';

export function ProjectDetailPage({
  user,
  projectId,
  origin = 'workbench',
}: {
  user: AuthUser;
  projectId: number;
  origin?: 'workbench' | 'directory';
}) {
  const cache = useQueryClient();
  const initialTab = useRef(false);
  const lastDirectoryNode = useRef<string | null>(null);
  function requireNavigator() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== user.id || (current.selectedRole ?? current.role) !== 'NAVIGATOR')
      throw new Error('当前身份已变化，请重新打开领航员项目。');
  }
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'NAVIGATOR', projectId],
    queryFn: async () => {
      requireNavigator();
      const result = await api.getProjectDetail(projectId);
      requireNavigator();
      return result;
    },
    retry: false,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState('RECRUIT_PROJECT_MANAGER');
  const cards = useQuery({
    queryKey: ['navigator-projects', user.id, 'NAVIGATOR'],
    enabled: origin === 'workbench',
    queryFn: async () => {
      requireNavigator();
      const result = await api.listNavigatorProjects();
      requireNavigator();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const card =
    origin === 'workbench' && cards.isSuccess
      ? cards.data.find((item) => item.id === projectId)
      : undefined;
  useEffect(() => {
    if (origin === 'directory') {
      if (!detail.isSuccess) return;
      const next = detail.data.currentNodeCode;
      if (initialTab.current && lastDirectoryNode.current === next) return;
      initialTab.current = true;
      lastDirectoryNode.current = next;
      if (
        next &&
        [
          'RECRUIT_PROJECT_MANAGER',
          'ENTRANCE_EXAM',
          'STANDARD_TRAINING',
          'PRODUCTION_TASK',
        ].includes(next)
      )
        setTab(next);
      else if (next === 'COMPLETED') setTab('PRODUCTION_TASK');
      else if (next === 'RECRUIT_EXECUTION_EXPERT' || next === 'PERSONNEL_MANAGEMENT')
        setTab('STANDARD_TRAINING');
      return;
    }
    if (initialTab.current || cards.isFetching || !cards.isSuccess) return;
    initialTab.current = true;
    if (card) {
      const next = projectCardNode(card);
      if (next === 'ENTRANCE_EXAM' || next === 'PRODUCTION_TASK') setTab(next);
    }
  }, [
    origin,
    detail.isSuccess,
    detail.data?.currentNodeCode,
    cards.isSuccess,
    cards.isFetching,
    card,
  ]);
  const continuation = useProjectCardContinuation({
    user,
    projectId,
    role: 'NAVIGATOR',
    origin,
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
  const accessDenied =
    detail.error instanceof ApiError && [401, 403, 404].includes(detail.error.status);
  const project = accessDenied ? undefined : detail.data;
  function mayLeaveModule() {
    return [
      ENTRANCE_EXAM_LEAVE_REQUEST,
      STANDARD_TRAINING_LEAVE_REQUEST,
      PRODUCTION_TASKS_LEAVE_REQUEST,
    ].every((name) => window.dispatchEvent(new Event(name, { cancelable: true })));
  }
  return (
    <ProjectCardTransition transitionKey={continuation.transition} className="space-y-3">
      <Card asChild>
        <section aria-label="项目主流程" className="space-y-4 p-5">
          {origin === 'workbench' && <h1 className="sr-only">领航员项目流程</h1>}
          <div role="toolbar" aria-label="项目操作" className="flex items-center gap-2">
            {origin === 'workbench' && (
              <Button asChild variant="ghost" size="mobileTouch">
                <Link to="/projects">
                  <ArrowLeft className="size-4" aria-hidden />
                  <span className="sr-only sm:not-sr-only">返回我的项目</span>
                </Link>
              </Button>
            )}
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
              onClick={() => {
                if (mayLeaveModule()) void detail.refetch();
              }}
            >
              <RefreshCw className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">刷新详情</span>
            </Button>
          </div>
          <ErrorNotice error={detail.error} />
          {detail.isPending && <LoadingState>正在读取项目详情…</LoadingState>}
          {project && (
            <NavigatorProjectWorkflow
              currentNodeCode={card ? projectCardNode(card) : project.currentNodeCode}
              mainNodeCode={project.currentNodeCode}
              tab={tab}
              onTabChange={(next) => {
                if (next === tab || !mayLeaveModule()) return;
                initialTab.current = true;
                continuation.cancel();
                setTab(next);
              }}
              exam={
                <NavigatorExamPanel
                  user={user}
                  projectId={projectId}
                  onChanged={continuation.refresh}
                />
              }
              training={
                <StandardTrainingPanel
                  user={user}
                  projectId={projectId}
                  role="NAVIGATOR"
                  onChanged={continuation.refresh}
                />
              }
              production={
                <ProductionTasksPanel
                  user={user}
                  projectId={projectId}
                  role="NAVIGATOR"
                  onChanged={continuation.refresh}
                />
              }
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
