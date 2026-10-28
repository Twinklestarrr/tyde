import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { projectNodeLabel } from './ProjectWorkflow';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ProductionPlanPanel, PRODUCTION_PLAN_LEAVE_REQUEST } from './ProductionPlanPanel';
import { StrategistExamPanel } from './StrategistExamPanel';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';

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
  initialTab?: 'PRODUCTION_PLAN' | 'ENTRANCE_EXAM';
}) {
  const client = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<string>(initialTab);
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'PM', projectId],
    queryFn: () => api.getProjectDetail(projectId),
    retry: false,
  });
  const project = detail.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="mobileTouch">
          <Link to="/strategist/projects">
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
            <p className="mb-2 text-xs text-muted-foreground">{project.projectNo}</p>
            <h1 className="break-words text-[24px] font-semibold">
              {project.projectName || '未命名项目'}
            </h1>
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">
              {project.projectDescription || '暂无项目描述'}
            </p>
          </header>
          <section aria-label="策略官项目流程" className="rounded-[16px] border bg-card p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">策略官项目流程</h2>
              <p className="text-[13px] text-muted-foreground">
                当前阶段：{projectNodeLabel(project.currentNodeCode)}
              </p>
            </div>
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
                setTab(next);
              }}
            >
              <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
                <TabsList
                  aria-label="策略官项目模块"
                  variant="business"
                  className="mb-0 flex h-auto w-full min-w-0 flex-none flex-wrap justify-start sm:w-auto sm:flex-1"
                >
                  {tabs.map((code) => (
                    <TabsTrigger
                      key={code}
                      value={code}
                      variant="business"
                      className="min-h-11 flex-1 sm:flex-none"
                      aria-current={code === project.currentNodeCode ? 'step' : undefined}
                    >
                      {projectNodeLabel(code)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <Button
                  variant="primaryOutline"
                  size="mobileTouch"
                  onClick={() => setDetailsOpen(true)}
                >
                  <FileText className="size-4" aria-hidden />
                  查看项目详情
                </Button>
              </div>
              <TabsContent value="PRODUCTION_PLAN">
                <ProductionPlanPanel
                  user={user}
                  projectId={projectId}
                  onConfirmed={async () => {
                    void client.invalidateQueries({
                      queryKey: ['strategist-projects', user.id, 'PM'],
                    });
                    await detail.refetch({ throwOnError: true });
                  }}
                />
              </TabsContent>
              <TabsContent value="ENTRANCE_EXAM">
                <StrategistExamPanel
                  user={user}
                  projectId={projectId}
                  projectName={project.projectName || '未命名项目'}
                  onChanged={async () => {
                    void client.invalidateQueries({
                      queryKey: ['strategist-projects', user.id, 'PM'],
                    });
                    await detail.refetch({ throwOnError: true });
                  }}
                />
              </TabsContent>
              {tabs.slice(2).map((code) => (
                <TabsContent
                  key={code}
                  value={code}
                  className="rounded-xl border border-dashed p-5 text-[13px] leading-6 text-muted-foreground"
                >
                  {projectNodeLabel(code)}入口暂未开放，可点击“查看项目详情”查看项目资料。
                </TabsContent>
              ))}
            </Tabs>
          </section>
          {detailsOpen && (
            <ProjectDetailsDialog project={project} onClose={() => setDetailsOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}
