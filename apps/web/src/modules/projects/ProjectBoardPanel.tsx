import { type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ProjectBoardDetail, ProjectBoardRiskCard } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { EntranceExamText } from './EntranceExamText';
import { projectNodeLabel } from './ProjectWorkflow';
import { boardNumber } from './ProjectBoardTrends';
import { ProjectBoardTrendCard } from './ProjectBoardTrendCard';

const difficulty = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
const education = {
  PHD: '博士',
  MASTER: '硕士',
  BACHELOR: '本科',
  COLLEGE: '大专',
  BELOW_COLLEGE: '大专以下',
};
const employment = { FULL_TIME: '全职', PART_TIME: '兼职', UNLIMITED: '不限' };
const statuses = {
  IN_PROGRESS: '进行中',
  PENDING_ACCEPTANCE: '待验收',
  REWORK_REQUIRED: '驳回返修',
  ACCEPTED: '已验收',
};
function Value({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-[13px] leading-6">
        {children ?? '未填写'}
      </dd>
    </div>
  );
}
function ProjectBasics({ project }: { project: ProjectBoardDetail }) {
  let standardUrl: string | null = null;
  try {
    const url = new URL(project.standardLink || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') standardUrl = url.href;
  } catch {
    // 历史值不是完整HTTP(S)链接时仅展示文字。
  }
  return (
    <div className="space-y-4">
      <div>
        <h3 className="break-words text-lg font-semibold">{project.projectName || '未命名项目'}</h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">{project.projectNo}</p>
      </div>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Value label="当前阶段">{projectNodeLabel(project.currentNodeCode)}</Value>
        <Value label="发布状态">{project.status === 'PUBLISHED' ? '已发布' : '草稿'}</Value>
        <Value label="需求方">{project.requesterName}</Value>
        <Value label="项目量级">
          {project.projectQuantity == null
            ? null
            : `${boardNumber(project.projectQuantity)} ${project.quantityUnit || ''}`}
        </Value>
        <Value label="截止时间（上海）">{project.deadline}</Value>
        <Value label="发布时间（上海）">{project.publishedAt}</Value>
        <Value label="关闭时间（上海）">{project.closedAt}</Value>
      </dl>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">项目描述</p>
        <EntranceExamText value={project.projectDescription} />
      </div>
      <details className="rounded-lg border">
        <summary className="min-h-11 cursor-pointer px-4 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
          查看项目档案
        </summary>
        <div className="space-y-4 border-t p-4">
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Value label="需求方类型">
              {project.requesterType === 'ORGANIZATION' ? '组织' : '个人'}
            </Value>
            <Value label="一级分类">{project.categoryLevel1Name}</Value>
            <Value label="二级分类">{project.categoryLevel2Name}</Value>
            <Value label="三级分类">{project.categoryLevel3Names.join('、') || null}</Value>
            <Value label="项目难度">
              {project.difficultyLevel ? difficulty[project.difficultyLevel] : null}
            </Value>
            <Value label="需求人数">
              {project.requiredHeadcount == null ? null : `${project.requiredHeadcount} 人`}
            </Value>
            <Value label="学历要求">
              {project.educationRequirement ? education[project.educationRequirement] : null}
            </Value>
            <Value label="人员属性">
              {project.employmentType ? employment[project.employmentType] : null}
            </Value>
            <Value label="经验要求">{project.experienceRequirement}</Value>
          </dl>
          {(
            [
              ['工作摘要', project.workSummary],
              ['特殊要求', project.specialRequirement],
              ['必备要求', project.mandatoryRequirement],
              ['标准说明 / 作业规范', project.standardContent],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <p className="mb-1 text-xs text-muted-foreground">{label}</p>
              <EntranceExamText value={value} />
            </div>
          ))}
          <dl>
            <Value label="标准参考链接">
              {standardUrl ? (
                <a
                  href={standardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-primary underline underline-offset-4"
                >
                  {project.standardLink}
                </a>
              ) : (
                project.standardLink
              )}
            </Value>
          </dl>
        </div>
      </details>
    </div>
  );
}
/** 风险直接使用服务端卡片，不从日期或累计进度推算。 */
function RiskCard({ title, card }: { title: string; card: ProjectBoardRiskCard }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">
        {card.pendingCount} 条风险 · {card.urgentCount} 条紧急
      </p>
      {!card.items.length ? (
        <EmptyState title="当前未发现风险。" />
      ) : (
        <ul className="space-y-3">
          {card.items.map((item) => (
            <li
              key={`${item.code}:${item.targetId}`}
              className="space-y-1 rounded-lg bg-muted/50 p-3 text-[13px]"
            >
              <p
                className={
                  item.severity === 'URGENT' ? 'font-semibold text-destructive' : 'font-semibold'
                }
              >
                {item.targetName || `对象 #${item.targetId}`}
              </p>
              <p className="break-words leading-6">{item.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 角色范围与旧看板一致；独立项目入口沿用用户要求，三项人员趋势仅供 PM 和管理专家。 */
export function ProjectBoardPanel({ user, projectId }: { user: AuthUser; projectId: number }) {
  const cache = useQueryClient();
  const role = user.selectedRole ?? user.role;
  const supported =
    role === 'NAVIGATOR' ||
    role === 'PM' ||
    (role === 'EXPERT' && user.hasExpertManagementRole === true);
  const personnel = role === 'PM' || (role === 'EXPERT' && user.hasExpertManagementRole === true);
  function sameIdentity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  async function read<T>(request: () => Promise<T>) {
    if (!sameIdentity()) throw new Error('登录身份或角色已变化，请重新打开项目看板。');
    const result = await request();
    if (!sameIdentity()) throw new Error('登录身份或角色已变化，请重新打开项目看板。');
    return result;
  }
  const options = {
    enabled: supported && sameIdentity() && Number.isInteger(projectId) && projectId > 0,
    retry: false,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const basic = useQuery({
    ...options,
    queryKey: ['project-board-detail', user.id, role, projectId],
    queryFn: () => read(() => api.getProjectBoardDetail(projectId)),
  });
  const subtasks = useQuery({
    ...options,
    queryKey: ['project-board-subtasks', user.id, role, projectId],
    queryFn: () => read(() => api.getProjectBoardSubtasks(projectId)),
  });
  const risks = useQuery({
    ...options,
    queryKey: ['project-board-risks', user.id, role, projectId],
    queryFn: () => read(() => api.getProjectBoardRisks(projectId)),
  });
  // 整体进度来自看板项目列表原值；直链也按精确项目 ID 查找，不平均或累计子任务百分比。
  const overview = useQuery({
    ...options,
    enabled: options.enabled && basic.isSuccess,
    queryKey: ['project-board-overview', user.id, role, projectId, basic.data?.projectName],
    queryFn: () =>
      read(async () => {
        let current = 1;
        while (true) {
          const page = await api.listProjectBoardProjects({
            keyword: basic.data?.projectName?.slice(0, 128),
            current,
            size: 100,
          });
          if (!sameIdentity()) throw new Error('登录身份或角色已变化，请重新打开项目看板。');
          const project = page.records.find((item) => item.projectId === projectId);
          if (project) return project;
          if (!page.records.length || current >= page.pages) return null;
          current += 1;
        }
      }),
  });
  if (!supported) return <Alert>当前角色不提供项目看板。</Alert>;
  if (!sameIdentity()) return <Alert>登录身份或角色已变化，请重新打开项目看板。</Alert>;
  return (
    <section aria-label="项目看板" className="min-w-0 space-y-5">
      <Card asChild>
        <section aria-label="项目基础信息" className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>项目基础信息</CardTitle>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={basic.isFetching}
              onClick={() => void basic.refetch()}
            >
              重新读取项目基础信息
            </Button>
          </div>
          <ErrorNotice error={basic.error} />
          {basic.isPending && <LoadingState>正在读取项目基础信息…</LoadingState>}
          {basic.isSuccess && <ProjectBasics project={basic.data} />}
        </section>
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card asChild>
          <section aria-label="项目整体进度" className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>项目整体进度</CardTitle>
              <Button
                variant="outline"
                size="mobileTouch"
                loading={overview.isFetching}
                disabled={!basic.isSuccess}
                onClick={() => void overview.refetch()}
              >
                重新读取项目进度
              </Button>
            </div>
            <ErrorNotice error={overview.error} />
            {overview.isFetching && <LoadingState>正在读取项目进度…</LoadingState>}
            {overview.isSuccess &&
              (overview.data ? (
                <>
                  <p className="text-center text-sm">
                    累计报量 {boardNumber(overview.data.progressQuantity)} /{' '}
                    {boardNumber(overview.data.targetQuantity)} {overview.data.quantityUnit}
                  </p>
                  <div
                    className="mx-auto grid size-36 place-items-center rounded-full"
                    style={{
                      background: `conic-gradient(var(--primary) ${Math.max(0, Math.min(100, overview.data.progressPercent))}%, var(--muted) 0)`,
                    }}
                  >
                    <div className="grid size-28 place-items-center rounded-full bg-card">
                      <span className="text-2xl font-semibold">
                        {overview.data.progressPercent.toLocaleString('zh-CN', {
                          maximumFractionDigits: 2,
                        })}
                        %
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState title="当前列表中暂无项目进度。" />
              ))}
          </section>
        </Card>
        <Card className="space-y-3 p-4 sm:p-5">
          <ErrorNotice error={risks.error} />
          {risks.isPending && <LoadingState>正在读取风险预警…</LoadingState>}
          {risks.isSuccess && <RiskCard title="项目风险预警" card={risks.data.project} />}
          <Button
            variant="outline"
            size="mobileTouch"
            loading={risks.isFetching}
            onClick={() => void risks.refetch()}
          >
            重新读取风险预警
          </Button>
        </Card>
        <Card asChild>
          <section aria-label="子任务交付进度" className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>子任务交付进度</CardTitle>
              <Button
                variant="outline"
                size="mobileTouch"
                loading={subtasks.isFetching}
                onClick={() => void subtasks.refetch()}
              >
                重新读取子任务进度
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              进度按累计报量与目标量计算，允许超过100%；待验收和已验收任务不触发逾期或低进度风险。
              {role === 'EXPERT' && '当前显示实际可管理组织的合并范围。'}
            </p>
            <ErrorNotice error={subtasks.error} />
            {subtasks.isPending && <LoadingState>正在读取子任务进度…</LoadingState>}
            {subtasks.isSuccess &&
              (!subtasks.data.length ? (
                <EmptyState title="暂无可展示的子任务。" />
              ) : (
                <div className="grid gap-3 xl:grid-cols-2">
                  {subtasks.data.map((task) => (
                    <Card asChild key={task.subtaskId}>
                      <article aria-label={task.subtaskName} className="space-y-3 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="break-words text-sm font-semibold">
                              {task.subtaskName}
                            </h3>
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {task.subtaskNo}
                            </p>
                          </div>
                          <span className="rounded-md bg-muted px-2 py-1 text-xs">
                            {task.statusName || statuses[task.status]}
                          </span>
                        </div>
                        <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                          <span>
                            累计报量 {boardNumber(task.reportedQuantity)} /{' '}
                            {boardNumber(task.targetQuantity)} {task.quantityUnit}
                          </span>
                          <span className="font-semibold text-primary">
                            {boardNumber(task.progressPercent)}%
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{
                              width: `${Math.max(0, Math.min(100, task.progressPercent))}%`,
                            }}
                          />
                        </div>
                        <dl className="grid grid-cols-2 gap-3">
                          <Value label="分发方式">
                            {task.distributionMode === 'POOL' ? '任务池' : '指定成员'}
                          </Value>
                          <Value label="截至今日应完成量">
                            {task.expectedQuantityToDate == null
                              ? '不可计算'
                              : `${boardNumber(task.expectedQuantityToDate)} ${task.quantityUnit}`}
                          </Value>
                          <Value label="计划开始（上海）">{task.plannedStartDate}</Value>
                          <Value label="预期交付（上海）">{task.expectedDeliveryDate}</Value>
                        </dl>
                        {(task.overdueRisk || task.progressLowRisk) && (
                          <p className="text-xs font-medium text-destructive">
                            {[
                              task.overdueRisk && '已到期未完成',
                              task.progressLowRisk && '低于计划进度',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                      </article>
                    </Card>
                  ))}
                </div>
              ))}
          </section>
        </Card>

        <Card className="space-y-3 p-4 sm:p-5">
          <ErrorNotice error={risks.error} />
          {risks.isSuccess && <RiskCard title="子任务风险预警" card={risks.data.subtasks} />}
        </Card>
      </div>
      {personnel && (
        <section
          aria-label="人员趋势"
          className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
        >
          <div className="min-w-0 space-y-4">
            {(['QUANTITY', 'ACCURACY', 'CPD'] as const).map((metric) => (
              <ProjectBoardTrendCard
                key={metric}
                user={user}
                projectId={projectId}
                metric={metric}
              />
            ))}
          </div>
          <Card className="space-y-3 p-4 sm:p-5">
            <ErrorNotice error={risks.error} />
            {risks.isSuccess && <RiskCard title="人员风险预警" card={risks.data.members} />}
          </Card>
        </section>
      )}
    </section>
  );
}
