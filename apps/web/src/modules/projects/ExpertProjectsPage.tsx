import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderOpen, RefreshCw } from 'lucide-react';
import {
  ApiError,
  requiresExpertProjectOwners,
  type AuthUser,
  type ExpertTask,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectNodeLabel } from './ProjectWorkflow';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import { ExpertTaskResponseDialog } from './ExpertTaskResponseDialog';
import { SESSION_KEY } from '@/hooks/useSession';

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
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
};

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
  const sessionMatches = () => {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current &&
      session?.id === user.id &&
      (session.selectedRole ?? session.role) === 'EXPERT'
    );
  };
  function requireSession() {
    if (!sessionMatches())
      throw new ApiError(401, {
        code: 'SESSION_CHANGED',
        message: '登录身份已变化，请重新打开工作台。',
      });
  }
  async function suppressTaskActions(task: ExpertTask, remove = false) {
    if (!sessionMatches()) return;
    await cache.cancelQueries({ queryKey: ['expert-projects', user.id] });
    if (!sessionMatches()) return;
    // 缓存本身锁住来源；关闭弹窗或切换页面不能用旧待办重放未知/已成功操作。
    cache.setQueriesData<ExpertTask[]>({ queryKey: ['expert-projects', user.id] }, (tasks) =>
      tasks?.flatMap((item) => {
        if (item.sourceBizType !== task.sourceBizType || item.sourceBizId !== task.sourceBizId)
          return [item];
        return remove
          ? []
          : [{ ...item, operations: { ...item.operations, canAccept: false, canReject: false } }];
      }),
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
  const projects = useQuery({
    queryKey: ['expert-projects', user.id, 'EXPERT', search],
    queryFn: async () => {
      requireSession();
      const tasks = await api.getMyExpertTasks(search ? { keyword: search } : undefined);
      requireSession();
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
      requireSession();
      const project = await api.getExpertAssignmentDetail(selected!);
      requireSession();
      return project;
    },
    enabled: !!selected,
    retry: false,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setSelected(null);
    if (search === keyword.trim()) void projects.refetch();
    else setSearch(keyword.trim());
  }
  return (
    <div className="space-y-6">
      <header>
        <p className="mb-2 text-xs font-medium text-primary">执行专家工作台</p>
        <h1 className="text-[24px] font-semibold tracking-tight">我负责的项目</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          查看本人当前待办，以及个人、组织和转入项目资料。
        </p>
      </header>
      <section
        aria-label="执行专家待办项目"
        className="space-y-5 rounded-[16px] border bg-card p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">当前待办项目</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              按当前参与身份展示，项目推进后可能移出列表。
            </p>
          </div>
          <Button
            variant="outline"
            size="mobileTouch"
            loading={projects.isFetching}
            onClick={() => {
              setSelected(null);
              void projects.refetch();
            }}
          >
            <RefreshCw className="size-4" aria-hidden />
            {projects.isError ? '重试读取项目' : '刷新项目'}
          </Button>
        </div>
        <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-48 space-y-2">
            <label htmlFor="expert-project-search" className="text-[13px] font-medium">
              筛选当前待办
            </label>
            <Input
              id="expert-project-search"
              type="search"
              maxLength={100}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="项目名称或需求方"
            />
          </div>
          <Button type="submit" variant="outline" size="mobileTouch" loading={projects.isFetching}>
            查询项目
          </Button>
        </form>
        <ErrorNotice error={projects.error} />
        {notice && (
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            {notice}
          </p>
        )}
        {projects.isPending && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            正在读取项目…
          </p>
        )}
        {projects.isSuccess && !projects.data.length && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <FolderOpen className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm">{search ? '没有匹配的待办项目' : '暂无待办项目'}</p>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {(projects.data ?? []).map((project) => (
            <article
              key={`${project.sourceBizType}:${project.sourceBizId}`}
              className="flex min-w-0 flex-col rounded-xl border p-5"
            >
              <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>项目 {project.basicInfo.projectId}</span>
                <span className="rounded-md bg-accent px-2 py-1 text-primary">
                  {acceptanceLabels[project.acceptanceStatus]}
                </span>
              </div>
              <h3 className="break-words text-base font-semibold">
                {project.basicInfo.projectName || '未命名项目'}
              </h3>
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
              <div className="mt-auto flex flex-wrap justify-end gap-3 border-t pt-4">
                {project.operations.canReject && (
                  <Button
                    variant="destructiveOutline"
                    size="mobileTouch"
                    onClick={() => {
                      setSelected(null);
                      setResponse({ task: project, decision: 'REJECT' });
                    }}
                  >
                    拒绝
                  </Button>
                )}
                {project.operations.canAccept && (
                  <Button
                    variant="success"
                    size="mobileTouch"
                    onClick={() => {
                      setSelected(null);
                      setResponse({ task: project, decision: 'ACCEPT' });
                    }}
                  >
                    接单
                  </Button>
                )}
                <Button
                  variant="primaryOutline"
                  size="mobileTouch"
                  onClick={() => setSelected(project)}
                >
                  查看项目
                  <ArrowRight className="size-4" aria-hidden />
                </Button>
              </div>
            </article>
          ))}
        </div>
        {selected && detail.isFetching && (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取项目详情…
          </p>
        )}
        {selected && detail.isError && (
          <div className="space-y-3">
            <ErrorNotice error={detail.error} />
            <Button variant="outline" size="mobileTouch" onClick={() => void detail.refetch()}>
              重试读取项目详情
            </Button>
          </div>
        )}
      </section>
      {selected && detail.isSuccess && !detail.isFetching && (
        <ProjectDetailsDialog
          project={detail.data.projectDetail}
          onClose={() => setSelected(null)}
        />
      )}
      {response && (
        <ExpertTaskResponseDialog
          task={response.task}
          decision={response.decision}
          user={user}
          onClose={() => setResponse(null)}
          onUncertain={() => suppressTaskActions(response.task)}
          onReload={async () => {
            requireSession();
            const result = await projects.refetch({ throwOnError: true });
            requireSession();
            return (
              result.data?.find(
                (task) =>
                  task.sourceBizType === response.task.sourceBizType &&
                  task.sourceBizId === response.task.sourceBizId,
              ) ?? null
            );
          }}
          onWritten={async (result) => {
            if (!sessionMatches()) return;
            await suppressTaskActions(response.task, true);
            if (!sessionMatches()) return;
            setResponse(null);
            setSelected(null);
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
            const refreshed = await Promise.allSettled([
              cache.invalidateQueries(
                { queryKey: ['expert-projects', user.id] },
                { throwOnError: true },
              ),
              cache.invalidateQueries({ queryKey: ['expert-project-detail', user.id] }),
              cache.invalidateQueries({ queryKey: ['profile-workbench', user.id] }),
            ]);
            if (sessionMatches() && refreshed.some((item) => item.status === 'rejected'))
              setNotice(`${message}最新项目读取失败，请刷新项目确认当前状态。`);
          }}
        />
      )}
    </div>
  );
}
