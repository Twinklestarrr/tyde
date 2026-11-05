import { WorkbenchStatistics } from './WorkbenchStatistics';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import {
  ApiError,
  requiresExpertProjectOwners,
  type AuthUser,
  type ExpertTask,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { projectNodeLabel } from './ProjectWorkflow';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ExpertTaskResponseDialog } from './ExpertTaskResponseDialog';
import { EXPERT_EXAM_LEAVE_REQUEST } from './ExpertExamPanel';
import { EXPERT_TRAINING_LEAVE_REQUEST } from './ExpertTrainingPanel';
import { ExpertProjectModules } from './ExpertProjectModules';
import { EXPERT_PRODUCTION_LEAVE_REQUEST } from './expert-production-form';
import { PERSONNEL_LEAVE_REQUEST } from './personnel-form';
import { SESSION_KEY } from '@/hooks/useSession';
import { ProjectCardTransition } from './ProjectCardTransition';
import { AttendanceClockPanel } from '@/modules/attendance/AttendanceClockPanel';

const acceptanceLabels = {
  PENDING_ACCEPTANCE: '待接单',
  ACCEPTED: '已接单',
  REJECTED: '已拒绝',
  CANCELLED: '已取消',
  REPLACED: '已替换',
};
const branchLabels: Record<string, string> = {
  ENTRANCE_EXAM: '准入考试',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认成员入项时间',
  OUTPUT_DATA_REVIEW: '报量核查',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
};

function ExpertProjectSummary({
  project,
  user,
  compact = false,
}: {
  project: ExpertTask;
  user: AuthUser;
  compact?: boolean;
}) {
  const identity = `${project.basicInfo.organizationName || '个人参与'}${
    project.accessContext.projectOwner
      ? ' · 项目负责人'
      : project.accessContext.acceptedOrganizationOwner ||
          requiresExpertProjectOwners(project, user)
        ? ' · 组织主管'
        : ''
  }${project.sourceBizType === 'PROJECT_MEMBER_TRANSFER' ? ' · 转入项目' : ''}`;
  if (compact)
    return (
      <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle asChild className="min-w-0 flex-1">
            <h2>{project.basicInfo.projectName || '未命名项目'}</h2>
          </CardTitle>
          <span className="rounded-md bg-accent px-2 py-1 text-xs text-primary">
            {project.branchNodeCode
              ? branchLabels[project.branchNodeCode] || '待处理'
              : acceptanceLabels[project.acceptanceStatus]}
          </span>
        </div>
        <p className="mt-3 break-words text-[13px] text-muted-foreground">{identity}</p>
        <p
          className="mt-2 text-xs text-muted-foreground"
          title={
            project.basicInfo.deadline ? `${project.basicInfo.deadline}（上海时间）` : undefined
          }
        >
          {project.basicInfo.deadline
            ? `截止 ${project.basicInfo.deadline.slice(0, 10)}`
            : '未设置截止日期'}
        </p>
      </>
    );
  return (
    <>
      <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>项目 {project.basicInfo.projectId}</span>
        <span className="rounded-md bg-accent px-2 py-1 text-primary">
          {acceptanceLabels[project.acceptanceStatus]}
        </span>
      </div>
      <CardTitle asChild>
        <h3>{project.basicInfo.projectName || '未命名项目'}</h3>
      </CardTitle>
      <p className="mt-2 text-xs text-muted-foreground">
        {[
          project.basicInfo.categoryLevel1Name,
          project.basicInfo.categoryLevel2Name,
          ...project.basicInfo.categoryLevel3Names,
        ]
          .filter(Boolean)
          .join(' / ') || '未设置分类'}
      </p>
      {project.basicInfo.projectDescription && (
        <p className="mt-3 line-clamp-2 text-[13px] leading-6 text-muted-foreground">
          {project.basicInfo.projectDescription}
        </p>
      )}
      <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px] [&_dd]:min-w-0 [&_dd]:break-words">
        <dt className="text-muted-foreground">需求方</dt>
        <dd>{project.basicInfo.requesterName}</dd>
        <dt className="text-muted-foreground">当前阶段</dt>
        <dd>{projectNodeLabel(project.currentNodeCode)}</dd>
        {project.branchNodeCode && (
          <>
            <dt className="text-muted-foreground">本人待办</dt>
            <dd>{branchLabels[project.branchNodeCode] || '待处理'}</dd>
          </>
        )}
        <dt className="text-muted-foreground">参与身份</dt>
        <dd>
          {project.basicInfo.organizationName || '个人参与'}
          {project.accessContext.projectOwner
            ? ' · 项目负责人'
            : project.accessContext.acceptedOrganizationOwner ||
                requiresExpertProjectOwners(project, user)
              ? ' · 组织主管'
              : ''}
          {project.sourceBizType === 'PROJECT_MEMBER_TRANSFER' && ' · 转入项目'}
        </dd>
        <dt className="text-muted-foreground">策略官</dt>
        <dd>{project.basicInfo.projectManagerName || '未任职'}</dd>
        <dt className="text-muted-foreground">截止时间</dt>
        <dd>{project.basicInfo.deadline || '未设置'}（上海时间）</dd>
      </dl>
    </>
  );
}

/** 本人待办采用真实分配/转入来源；详情入口由服务端再次校验参与范围。 */
export function ExpertProjectsPage({ user }: { user: AuthUser }) {
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const identityMatches = () => {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === 'EXPERT';
  };
  const sessionMatches = () => mounted.current && identityMatches();
  function requireIdentity() {
    if (!identityMatches())
      throw new ApiError(401, {
        code: 'SESSION_CHANGED',
        message: '登录身份已变化，请重新打开工作台。',
      });
  }
  function requireSession() {
    if (!sessionMatches())
      throw new ApiError(401, {
        code: 'SESSION_CHANGED',
        message: '登录身份已变化，请重新打开工作台。',
      });
  }
  async function suppressTaskActions(task: ExpertTask) {
    if (!sessionMatches()) return;
    await cache.cancelQueries({ queryKey: ['expert-projects', user.id] });
    if (!sessionMatches()) return;
    // 缓存本身锁住来源；关闭弹窗或切换页面不能用旧待办重放未知/已成功操作。
    setSelected((current) =>
      current?.sourceBizType === task.sourceBizType && current.sourceBizId === task.sourceBizId
        ? { ...current, operations: { ...current.operations, canAccept: false, canReject: false } }
        : current,
    );
    cache.setQueriesData<ExpertTask[]>({ queryKey: ['expert-projects', user.id] }, (tasks) =>
      tasks?.map((item) =>
        item.sourceBizType === task.sourceBizType && item.sourceBizId === task.sourceBizId
          ? { ...item, operations: { ...item.operations, canAccept: false, canReject: false } }
          : item,
      ),
    );
  }
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ExpertTask | null>(null);
  const [response, setResponse] = useState<{
    task: ExpertTask;
    decision: 'ACCEPT' | 'REJECT';
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [transitionStep, setTransitionStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (transitionStep > 0) heading.current?.focus();
  }, [transitionStep]);
  const projects = useQuery({
    queryKey: ['expert-projects', user.id, 'EXPERT', search],
    queryFn: async () => {
      // 查询缓存跨页面挂载复用，不能用发起请求的旧组件是否挂载判断身份。
      requireIdentity();
      const tasks = await api.getMyExpertTasks(search ? { keyword: search } : undefined);
      requireIdentity();
      return tasks;
    },
    retry: false,
  });
  const detail = useQuery({
    queryKey: [
      'expert-project-detail',
      user.id,
      'EXPERT',
      selected?.assignmentId,
      selected?.movementId,
    ],
    queryFn: async () => {
      requireIdentity();
      const project = await api.getExpertAssignmentDetail(selected!);
      requireIdentity();
      return project;
    },
    enabled: !!selected,
    retry: false,
  });
  async function readCurrentTask(task: ExpertTask) {
    requireSession();
    await cache.cancelQueries({ queryKey: ['expert-projects', user.id] });
    requireSession();
    // 用完整待办判断来源是否仍在，不能把筛选结果的缺失当成任务完成。
    const tasks = await api.getMyExpertTasks();
    requireSession();
    await cache.invalidateQueries({
      queryKey: ['expert-projects', user.id],
      refetchType: 'none',
    });
    requireSession();
    cache.setQueryData(['expert-projects', user.id, 'EXPERT', ''], tasks);
    if (search) await projects.refetch({ throwOnError: true });
    requireSession();
    const latest =
      tasks.find(
        (item) =>
          item.sourceBizType === task.sourceBizType &&
          item.sourceBizId === task.sourceBizId &&
          item.basicInfo.projectId === task.basicInfo.projectId &&
          item.basicInfo.organizationId === task.basicInfo.organizationId,
      ) ?? null;
    setSelected(latest);
    setDetailsOpen(false);
    setRefreshRequired(false);
    setRefreshError(null);
    setDirection(latest ? 'forward' : 'back');
    setTransitionStep((step) => step + 1);
    await Promise.allSettled([
      cache.invalidateQueries({ queryKey: ['expert-project-detail', user.id] }),
      cache.invalidateQueries({ queryKey: ['profile-workbench', user.id] }),
      cache.invalidateQueries({ queryKey: ['workbench-statistics', user.id, 'EXPERT'] }),
    ]);
    requireSession();
    return latest;
  }
  async function refreshCurrentTask(task: ExpertTask) {
    if (refreshing || !sessionMatches()) return;
    if (!window.dispatchEvent(new Event(EXPERT_EXAM_LEAVE_REQUEST, { cancelable: true }))) return;
    if (!window.dispatchEvent(new Event(EXPERT_TRAINING_LEAVE_REQUEST, { cancelable: true })))
      return;
    if (!window.dispatchEvent(new Event(EXPERT_PRODUCTION_LEAVE_REQUEST, { cancelable: true })))
      return;
    if (!window.dispatchEvent(new Event(PERSONNEL_LEAVE_REQUEST, { cancelable: true }))) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latest = await readCurrentTask(task);
      if (sessionMatches() && refreshRequired)
        setNotice(
          latest ? '操作已成功，已读取最新项目待办。' : '当前项目已无待办，已返回项目卡片。',
        );
    } catch (failure) {
      if (sessionMatches()) setRefreshError(failure);
    } finally {
      if (sessionMatches()) setRefreshing(false);
    }
  }
  function openProject(task: ExpertTask) {
    setSelected(task);
    setNotice('');
    setRefreshRequired(false);
    setRefreshError(null);
    setDirection('forward');
    setTransitionStep((step) => step + 1);
  }
  async function trainingConfirmed(task: ExpertTask) {
    if (!sessionMatches()) return;
    setRefreshRequired(true);
    setRefreshing(true);
    setRefreshError(null);
    setNotice('阅读已确认，正在读取后续待办。');
    try {
      await readCurrentTask(task);
      if (sessionMatches()) setNotice('已确认阅读，后续待办已更新。');
    } catch (failure) {
      if (sessionMatches()) {
        setRefreshError(failure);
        setNotice('阅读已确认，最新待办读取失败，请重试读取项目。');
      }
      throw failure;
    } finally {
      if (sessionMatches()) setRefreshing(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setSelected(null);
    if (search === keyword.trim()) void projects.refetch();
    else setSearch(keyword.trim());
  }
  async function businessChanged(task: ExpertTask, label: string) {
    if (!sessionMatches()) return;
    setRefreshRequired(true);
    setRefreshing(true);
    setRefreshError(null);
    setNotice(`${label}已保存，正在读取后续待办。`);
    try {
      await readCurrentTask(task);
      if (sessionMatches()) setNotice(`${label}已保存，后续待办已更新。`);
    } catch (failure) {
      if (sessionMatches()) {
        setRefreshError(failure);
        setNotice(`${label}已保存，最新待办读取失败，请重试读取项目。`);
      }
      throw failure;
    } finally {
      if (sessionMatches()) setRefreshing(false);
    }
  }
  return (
    <ProjectCardTransition
      direction={direction}
      transitionKey={`${selected ? `${selected.sourceBizType}:${selected.sourceBizId}` : 'list'}:${transitionStep}`}
      className="space-y-6"
    >
      {selected ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="mobileTouch"
              disabled={refreshing}
              onClick={() => {
                if (
                  !window.dispatchEvent(new Event(EXPERT_EXAM_LEAVE_REQUEST, { cancelable: true }))
                )
                  return;
                if (
                  !window.dispatchEvent(
                    new Event(EXPERT_TRAINING_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                if (
                  !window.dispatchEvent(
                    new Event(EXPERT_PRODUCTION_LEAVE_REQUEST, { cancelable: true }),
                  )
                )
                  return;
                if (!window.dispatchEvent(new Event(PERSONNEL_LEAVE_REQUEST, { cancelable: true })))
                  return;
                setSelected(null);
                setDetailsOpen(false);
                setDirection('back');
                setTransitionStep((step) => step + 1);
              }}
            >
              <ArrowLeft className="size-4" aria-hidden />
              返回项目卡片
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={refreshing}
              onClick={() => void refreshCurrentTask(selected)}
            >
              <RefreshCw className="size-4" aria-hidden />
              {refreshError || refreshRequired ? '重试读取项目' : '刷新项目'}
            </Button>
          </div>
          <header>
            <p className="mb-2 text-xs font-medium text-primary">执行专家工作台</p>
            <h1
              ref={heading}
              tabIndex={-1}
              className="m-0 text-[24px] leading-[32px] font-semibold tracking-tight outline-none"
            >
              项目待办详情
            </h1>
          </header>
          <Card asChild>
            <article aria-label="当前项目待办" className="p-5">
              <ExpertProjectSummary project={selected} user={user} />
              {notice && (
                <p role="status" className="mb-4 text-sm leading-6 text-muted-foreground">
                  {notice}
                </p>
              )}
              <ErrorNotice error={refreshError} />
              {refreshRequired && (
                <p role="status" className="mb-4 text-sm leading-6 text-muted-foreground">
                  操作已成功，正在确认当前项目的后续待办。读取失败时可重试读取，不会重复提交。
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-3 border-t pt-4">
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={!detail.isSuccess || detail.isFetching}
                  onClick={() => setDetailsOpen(true)}
                >
                  <FileText className="size-4" aria-hidden />
                  项目资料
                </Button>
                {selected.operations.canReject && (
                  <Button
                    variant="destructiveOutline"
                    size="mobileTouch"
                    disabled={refreshing || refreshRequired}
                    onClick={() => setResponse({ task: selected, decision: 'REJECT' })}
                  >
                    拒绝
                  </Button>
                )}
                {selected.operations.canAccept && (
                  <Button
                    variant="success"
                    size="mobileTouch"
                    disabled={refreshing || refreshRequired}
                    onClick={() => setResponse({ task: selected, decision: 'ACCEPT' })}
                  >
                    接单
                  </Button>
                )}
              </div>
            </article>
          </Card>
          {detail.isFetching && <LoadingState>正在读取项目详情…</LoadingState>}
          <ExpertProjectModules
            key={`${selected.basicInfo.projectId}:${selected.basicInfo.organizationId}:${selected.sourceBizType}:${selected.sourceBizId}`}
            user={user}
            task={selected}
            onExamChanged={() => refreshCurrentTask(selected)}
            onExamCancelled={async () => {
              if (!sessionMatches()) return;
              setRefreshRequired(true);
              setRefreshing(true);
              setRefreshError(null);
              setNotice('考试已取消，正在读取最新待办。');
              try {
                await readCurrentTask(selected);
                if (sessionMatches()) {
                  setSelected(null);
                  setDirection('back');
                  setNotice('考试已取消，已返回项目卡片。');
                }
              } catch (failure) {
                if (sessionMatches()) {
                  setRefreshError(failure);
                  setNotice('考试已取消，最新待办读取失败，请重试读取项目。');
                }
                throw failure;
              } finally {
                if (sessionMatches()) setRefreshing(false);
              }
            }}
            onTrainingConfirmed={() => trainingConfirmed(selected)}
            onProductionChanged={() => businessChanged(selected, '生产操作')}
            onPersonnelChanged={() => businessChanged(selected, '人员操作')}
          />
          {detail.isError && (
            <div className="space-y-3">
              <ErrorNotice error={detail.error} />
              <Button variant="outline" size="mobileTouch" onClick={() => void detail.refetch()}>
                重试读取项目详情
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <h1 ref={heading} tabIndex={-1} className="sr-only">
            我负责的项目
          </h1>
          <WorkbenchStatistics user={user} />
          <AttendanceClockPanel user={user} compact />
          <section aria-label="执行专家待办项目" className="space-y-5">
            <form onSubmit={submit} className="flex items-center gap-3">
              <SearchInput
                id="expert-project-search"
                label="筛选当前待办"
                maxLength={100}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索项目"
                containerClassName="flex-1"
                submitLabel="查询项目"
                loading={projects.isFetching}
              />
              <Button
                variant="ghost"
                size="settings"
                className="w-[40px] shrink-0 px-0 max-[640px]:w-[44px]"
                loading={projects.isFetching}
                aria-label={projects.isError ? '重试读取项目' : '刷新项目'}
                title={projects.isError ? '重试读取项目' : '刷新项目'}
                onClick={() => void projects.refetch()}
              >
                {!projects.isFetching && <RefreshCw className="size-4" aria-hidden />}
              </Button>
            </form>
            <ErrorNotice error={projects.error} />
            {notice && (
              <p role="status" className="text-sm leading-6 text-muted-foreground">
                {notice}
              </p>
            )}
            {projects.isPending && <LoadingState>正在读取项目…</LoadingState>}
            {projects.isSuccess && !projects.data.length && (
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
                        <Button
                          variant="outline"
                          size="settings"
                          onClick={() => {
                            setKeyword('');
                            setSearch('');
                          }}
                        >
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
              {(projects.data ?? []).map((project) => (
                <Card asChild key={`${project.sourceBizType}:${project.sourceBizId}`}>
                  <article className="project-card relative flex min-w-0 flex-col p-5">
                    <ExpertProjectSummary project={project} user={user} compact />
                    <div className="mt-5 flex justify-end">
                      <Button
                        variant="ghost"
                        size="iconTouch"
                        className="project-card-link"
                        onClick={() => openProject(project)}
                      >
                        <span className="sr-only">查看项目</span>
                        <ArrowRight className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </article>
                </Card>
              ))}
            </div>
          </section>
        </>
      )}
      {selected && detailsOpen && detail.isSuccess && (
        <ProjectDetailsDialog
          project={detail.data.projectDetail}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {response && (
        <ExpertTaskResponseDialog
          task={response.task}
          decision={response.decision}
          user={user}
          onClose={() => setResponse(null)}
          onUncertain={() => suppressTaskActions(response.task)}
          onReload={() => readCurrentTask(response.task)}
          onWritten={async (result) => {
            if (!sessionMatches()) return;
            const submittedTask = response.task;
            await suppressTaskActions(submittedTask);
            if (!sessionMatches()) return;
            setResponse(null);
            setRefreshRequired(true);
            setRefreshing(true);
            setRefreshError(null);
            const next = {
              NONE: '',
              VIEW_RESULT: '',
              MANAGE_PROJECT_MEMBERS: '后续由项目负责人管理成员。',
              TAKE_ENTRANCE_EXAM: '下一步参加准入考试。',
              WAIT_ENTRY_CONFIRMATION: '等待确认入项安排。',
            }[result.nextAction];
            const message =
              (result.memberStatus ?? result.status) === 'REJECTED'
                ? '已拒绝项目。'
                : `接单成功。${next}`;
            setNotice(message);
            try {
              const latest = await readCurrentTask(submittedTask);
              if (sessionMatches())
                setNotice(
                  `${message}${latest ? '已更新当前项目待办。' : '当前项目已无待办，已返回项目卡片。'}`,
                );
            } catch (failure) {
              if (sessionMatches()) {
                setRefreshError(failure);
                setNotice(`${message}最新项目读取失败，请重试读取项目确认当前状态。`);
              }
            } finally {
              if (sessionMatches()) setRefreshing(false);
            }
          }}
        />
      )}
    </ProjectCardTransition>
  );
}
