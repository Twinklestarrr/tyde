import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { projectCardNode, projectNodeLabel } from './ProjectWorkflow';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ProductionPlanPanel, PRODUCTION_PLAN_LEAVE_REQUEST } from './ProductionPlanPanel';
import { StrategistExamPanel } from './StrategistExamPanel';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { StandardTrainingPanel, STANDARD_TRAINING_LEAVE_REQUEST } from './StandardTrainingPanel';
import { ProjectCardTransition } from './ProjectCardTransition';
import { useProjectCardContinuation } from './useProjectCardContinuation';

const tabs = [
  'PRODUCTION_PLAN',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
  'RECRUIT_EXECUTION_EXPERT',
  'PERSONNEL_MANAGEMENT',
  'PRODUCTION_TASK',
] as const;

export function StrategistProjectPage({
  user,
  projectId,
  initialTab = 'PRODUCTION_PLAN',
}: {
  user: AuthUser;
  projectId: number;
  initialTab?: 'PRODUCTION_PLAN' | 'ENTRANCE_EXAM' | 'STANDARD_TRAINING';
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<string>(initialTab);
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'PM', projectId],
    queryFn: () => api.getProjectDetail(projectId),
    retry: false,
  });
  const project = detail.data;
  const continuation = useProjectCardContinuation({
    user,
    projectId,
    role: 'PM',
    reloadDetail: () => detail.refetch({ throwOnError: true }),
    onContinue: (card) => {
      const next = projectCardNode(card);
      if (tabs.some((code) => code === next)) setTab(next);
    },
  });
  return (
    <ProjectCardTransition transitionKey={continuation.transition} className="space-y-3">
      <Card asChild>
        <section aria-label="策略官项目流程" className="space-y-4 p-5">
          <h1 className="sr-only">策略官项目流程</h1>
          <div role="toolbar" aria-label="项目操作" className="flex items-center gap-2">
            <Button asChild variant="ghost" size="mobileTouch">
              <Link to="/strategist/projects">
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
            <Tabs
              value={tab}
              onValueChange={(next) => {
                if (
                  tab === 'PRODUCTION_PLAN' &&
                  next !== tab &&
                  !window.dispatchEvent(
                    new Event(PRODUCTION_PLAN_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                if (
                  tab === 'ENTRANCE_EXAM' &&
                  next !== tab &&
                  !window.dispatchEvent(
                    new Event(ENTRANCE_EXAM_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                if (
                  tab === 'STANDARD_TRAINING' &&
                  next !== tab &&
                  !window.dispatchEvent(
                    new Event(STANDARD_TRAINING_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                continuation.cancel();
                setTab(next);
              }}
            >
              <TabsList
                aria-label="策略官项目模块"
                variant="business"
                className="mb-3 grid h-auto w-full min-w-0 grid-cols-2 min-[360px]:grid-cols-3 sm:flex sm:flex-wrap sm:justify-start"
              >
                {tabs.map((code) => (
                  <TabsTrigger
                    key={code}
                    value={code}
                    variant="business"
                    className="min-h-11 min-w-0 px-2 sm:flex-none sm:px-3"
                    aria-current={code === project.currentNodeCode ? 'step' : undefined}
                  >
                    {projectNodeLabel(code)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="PRODUCTION_PLAN">
                <ProductionPlanPanel
                  user={user}
                  projectId={projectId}
                  onConfirmed={continuation.refresh}
                />
              </TabsContent>
              <TabsContent value="ENTRANCE_EXAM">
                <StrategistExamPanel
                  user={user}
                  projectId={projectId}
                  projectName={project.projectName || '未命名项目'}
                  onChanged={continuation.refresh}
                />
              </TabsContent>
              <TabsContent value="STANDARD_TRAINING">
                <StandardTrainingPanel
                  user={user}
                  projectId={projectId}
                  onChanged={continuation.refresh}
                />
              </TabsContent>
              {tabs.slice(3).map((code) => (
                <TabsContent key={code} value={code}>
                  <EmptyState
                    title={`${projectNodeLabel(code)}入口暂未开放`}
                    description="可点击“查看项目详情”查看项目资料。"
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </section>
      </Card>
      {project && detailsOpen && (
        <ProjectDetailsDialog project={project} onClose={() => setDetailsOpen(false)} />
      )}
    </ProjectCardTransition>
  );
}
