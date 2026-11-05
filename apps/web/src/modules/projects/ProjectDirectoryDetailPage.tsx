import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { AuthUser, WorkbenchProjectSource } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ErrorNotice } from '@/components/ErrorNotice';
import { ProjectBoardPanel } from './ProjectBoardPanel';
import { ProjectDetailPage } from './ProjectDetailPage';
import { StrategistProjectPage } from './StrategistProjectPage';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { projectNodeLabel } from './ProjectWorkflow';
import { PRODUCTION_PLAN_LEAVE_REQUEST } from './ProductionPlanPanel';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { STANDARD_TRAINING_LEAVE_REQUEST } from './StandardTrainingPanel';
import { EXPERT_RECRUITMENT_LEAVE_REQUEST } from './ExpertRecruitmentPanel';
import { PERSONNEL_LEAVE_REQUEST } from './personnel-form';
import { PRODUCTION_TASKS_LEAVE_REQUEST } from './production-task-form';
import type { ProjectDirectoryDetailSearch } from './ProjectDirectoryPage';

export function ProjectDirectoryDetailPage({
  user,
  projectId,
  search,
}: {
  user: AuthUser;
  projectId: number;
  search: ProjectDirectoryDetailSearch;
}) {
  const role = user.selectedRole ?? user.role;
  const [tab, setTab] = useState('board');
  const personal = search.scope === 'participating';
  const backSearch = {
    view: personal ? ('participating' as const) : search.view,
    keyword: search.keyword,
    page: search.page,
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title="项目详情"
        actions={
          <Button asChild variant="outline" size="mobileTouch">
            <Link to="/project-directory" search={backSearch}>
              <ArrowLeft className="size-4" aria-hidden />
              返回项目列表
            </Link>
          </Button>
        }
      />
      {personal ? (
        <PersonalProjectDetails
          user={user}
          projectId={projectId}
          source={
            search.assignmentId
              ? { assignmentId: search.assignmentId, movementId: null }
              : { assignmentId: null, movementId: search.movementId! }
          }
        />
      ) : role === 'EXPERT' ? (
        <ProjectBoardPanel user={user} projectId={projectId} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            if (next === tab) return;
            if (
              tab === 'operations' &&
              ![
                PRODUCTION_PLAN_LEAVE_REQUEST,
                ENTRANCE_EXAM_LEAVE_REQUEST,
                STANDARD_TRAINING_LEAVE_REQUEST,
                EXPERT_RECRUITMENT_LEAVE_REQUEST,
                PERSONNEL_LEAVE_REQUEST,
                PRODUCTION_TASKS_LEAVE_REQUEST,
              ].every((name) => window.dispatchEvent(new Event(name, { cancelable: true })))
            )
              return;
            setTab(next);
          }}
        >
          <TabsList aria-label="项目详情视图" variant="business">
            <TabsTrigger variant="business" value="board">
              项目看板
            </TabsTrigger>
            <TabsTrigger variant="business" value="operations">
              业务操作
            </TabsTrigger>
          </TabsList>
          <TabsContent value="board">
            <ProjectBoardPanel user={user} projectId={projectId} />
          </TabsContent>
          <TabsContent value="operations">
            {role === 'NAVIGATOR' ? (
              <ProjectDetailPage user={user} projectId={projectId} origin="directory" />
            ) : (
              <StrategistProjectPage user={user} projectId={projectId} origin="directory" />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function PersonalProjectDetails({
  user,
  projectId,
  source,
}: {
  user: AuthUser;
  projectId: number;
  source: WorkbenchProjectSource;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  function requireIdentity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== user.id || (current.selectedRole ?? current.role) !== 'EXPERT')
      throw new Error('当前身份已变化，请重新进入参与项目。');
  }
  const query = useQuery({
    queryKey: [
      'project-directory',
      user.id,
      'EXPERT',
      'personal-detail',
      projectId,
      source.assignmentId,
      source.movementId,
    ],
    queryFn: async () => {
      requireIdentity();
      const result = await api.getExpertAssignmentDetail(source);
      requireIdentity();
      if (result.projectDetail.id !== projectId)
        throw new Error('项目与所选参与来源不一致，请从项目列表重新进入。');
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Card className="space-y-4 p-5" role="region" aria-label="参与项目详情">
      <ErrorNotice error={query.error} />
      <Button
        variant="outline"
        size="mobileTouch"
        loading={query.isFetching}
        onClick={() => void query.refetch()}
      >
        重新读取参与项目
      </Button>
      {query.isPending && <LoadingState>正在读取参与项目…</LoadingState>}
      {query.isSuccess && (
        <>
          <CardTitle asChild>
            <h2 className="break-words">
              {query.data.projectDetail.projectName || `项目 ${projectId}`}
            </h2>
          </CardTitle>
          <dl className="grid grid-cols-2 gap-4 text-[13px]">
            {[
              ['项目编号', query.data.projectDetail.projectNo],
              ['需求方', query.data.projectDetail.requesterName],
              ['项目阶段', projectNodeLabel(query.data.currentNodeCode)],
              ['截止时间（上海）', query.data.projectDetail.deadline || '未设置'],
              ['计划作业人数', query.data.productionPlan.operatorHeadcount ?? '未配置'],
              ['计划量级', query.data.productionPlan.totalExpectedOutput ?? '未配置'],
            ].map(([label, value]) => (
              <div className="min-w-0" key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="whitespace-pre-wrap break-words text-[13px]">
            {query.data.projectDetail.projectDescription || '暂无项目说明。'}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" size="mobileTouch" onClick={() => setOpen(true)}>
              查看完整项目资料
            </Button>
            <Button asChild size="mobileTouch">
              <Link to="/">前往工作台</Link>
            </Button>
          </div>
          <EmptyState title="任务处理" description="查看及处理当前待办，请前往工作台。" />
          {open && (
            <ProjectDetailsDialog
              project={query.data.projectDetail}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      )}
    </Card>
  );
}
