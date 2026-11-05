import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { ApiError, type AuthUser } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { projectCardNode, projectNodeLabel, ProjectStageContent } from './ProjectWorkflow';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ProductionPlanPanel, PRODUCTION_PLAN_LEAVE_REQUEST } from './ProductionPlanPanel';
import { StrategistExamPanel } from './StrategistExamPanel';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { StandardTrainingPanel, STANDARD_TRAINING_LEAVE_REQUEST } from './StandardTrainingPanel';
import { ExpertRecruitmentPanel, EXPERT_RECRUITMENT_LEAVE_REQUEST } from './ExpertRecruitmentPanel';
import { ProjectCardTransition } from './ProjectCardTransition';
import { useProjectCardContinuation } from './useProjectCardContinuation';
import { PersonnelManagementPanel } from './PersonnelManagementPanel';
import { PERSONNEL_LEAVE_REQUEST } from './personnel-form';
import { ProductionTasksPanel } from './ProductionTasksPanel';
import { PRODUCTION_TASKS_LEAVE_REQUEST } from './production-task-form';

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
  initialPersonnelView = 'roster',
  origin = 'workbench',
}: {
  user: AuthUser;
  projectId: number;
  origin?: 'workbench' | 'directory';
  initialPersonnelView?: 'roster' | 'movements';
  initialTab?:
    | 'PRODUCTION_PLAN'
    | 'ENTRANCE_EXAM'
    | 'STANDARD_TRAINING'
    | 'RECRUIT_EXECUTION_EXPERT'
    | 'PERSONNEL_MANAGEMENT'
    | 'PRODUCTION_TASK';
}) {
  const cache = useQueryClient();
  const initialized = useRef(origin === 'workbench');
  const lastDirectoryNode = useRef<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<string>(initialTab);
  const [personnelView, setPersonnelView] = useState(initialPersonnelView);
  const detail = useQuery({
    queryKey: ['project-detail', user.id, 'PM', projectId],
    queryFn: async () => {
      const current = () => {
        const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
        return session?.id === user.id && (session.selectedRole ?? session.role) === 'PM';
      };
      if (!current()) throw new Error('当前身份已变化，请重新进入项目。');
      const result = await api.getProjectDetail(projectId);
      if (!current()) throw new Error('当前身份已变化，请重新进入项目。');
      return result;
    },
    retry: false,
  });
  const project =
    detail.error instanceof ApiError && [401, 403, 404].includes(detail.error.status)
      ? undefined
      : detail.data;
  useEffect(() => {
    if (origin !== 'directory' || !detail.isSuccess) return;
    const next = detail.data.currentNodeCode;
    if (initialized.current && lastDirectoryNode.current === next) return;
    initialized.current = true;
    lastDirectoryNode.current = next;
    if (tabs.some((code) => code === next)) setTab(next!);
    else if (next === 'COMPLETED') setTab('PRODUCTION_TASK');
  }, [origin, detail.isSuccess, detail.data?.currentNodeCode]);
  const continuation = useProjectCardContinuation({
    user,
    projectId,
    role: 'PM',
    origin,
    reloadDetail: () => detail.refetch({ throwOnError: true }),
    onContinue: (card) => {
      const next = projectCardNode(card);
      if (next === 'PERSONNEL_MANAGEMENT')
        setPersonnelView(
          card.branchNodeCode === 'MEMBER_MOVEMENT_APPROVAL' ? 'movements' : 'roster',
        );
      if (tabs.some((code) => code === next)) setTab(next);
    },
  });
  return (
    <ProjectCardTransition transitionKey={continuation.transition} className="space-y-3">
      <Card asChild>
        <section aria-label="策略官项目流程" className="space-y-4 p-5">
          {origin === 'workbench' && <h1 className="sr-only">策略官项目流程</h1>}
          <div role="toolbar" aria-label="项目操作" className="flex items-center gap-2">
            {origin === 'workbench' && (
              <Button asChild variant="ghost" size="mobileTouch">
                <Link to="/strategist/projects">
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
                if (
                  tab === 'RECRUIT_EXECUTION_EXPERT' &&
                  next !== tab &&
                  !window.dispatchEvent(
                    new Event(EXPERT_RECRUITMENT_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                if (
                  tab === 'PERSONNEL_MANAGEMENT' &&
                  next !== tab &&
                  !window.dispatchEvent(new Event(PERSONNEL_LEAVE_REQUEST, { cancelable: true }))
                )
                  return;
                if (
                  tab === 'PRODUCTION_TASK' &&
                  next !== tab &&
                  !window.dispatchEvent(
                    new Event(PRODUCTION_TASKS_LEAVE_REQUEST, { cancelable: true }),
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
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="PRODUCTION_PLAN"
                >
                  <ProductionPlanPanel
                    user={user}
                    projectId={projectId}
                    onConfirmed={continuation.refresh}
                  />
                </ProjectStageContent>
              </TabsContent>
              <TabsContent value="ENTRANCE_EXAM">
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="ENTRANCE_EXAM"
                >
                  <StrategistExamPanel
                    user={user}
                    projectId={projectId}
                    projectName={project.projectName || '未命名项目'}
                    onChanged={continuation.refresh}
                  />
                </ProjectStageContent>
              </TabsContent>
              <TabsContent value="STANDARD_TRAINING">
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="STANDARD_TRAINING"
                >
                  <StandardTrainingPanel
                    user={user}
                    projectId={projectId}
                    onChanged={continuation.refresh}
                  />
                </ProjectStageContent>
              </TabsContent>
              <TabsContent value="RECRUIT_EXECUTION_EXPERT">
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="RECRUIT_EXECUTION_EXPERT"
                >
                  <ExpertRecruitmentPanel
                    user={user}
                    projectId={projectId}
                    onChanged={continuation.refresh}
                  />
                </ProjectStageContent>
              </TabsContent>
              <TabsContent value="PERSONNEL_MANAGEMENT">
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="PERSONNEL_MANAGEMENT"
                >
                  <PersonnelManagementPanel
                    user={user}
                    projectId={projectId}
                    onChanged={continuation.refresh}
                    initialView={personnelView}
                  />
                </ProjectStageContent>
              </TabsContent>
              <TabsContent value="PRODUCTION_TASK">
                <ProjectStageContent
                  currentNodeCode={project.currentNodeCode}
                  stage="PRODUCTION_TASK"
                >
                  <ProductionTasksPanel
                    user={user}
                    projectId={projectId}
                    onChanged={continuation.refresh}
                  />
                </ProjectStageContent>
              </TabsContent>
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
