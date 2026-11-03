import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, BookOpen, CircleDot, Radar, ShieldCheck } from 'lucide-react';
import { ApiError, type AuthUser } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ProfileActivity } from './ProfileActivity';

const quiet = 'text-[12px] leading-[20px] text-[var(--color-neutral-strong)]';
const nodeLabels: Record<string, string> = {
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
  OUTPUT_DATA_REVIEW: '检查数据',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
};
const flowLabels = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
  CANCELED: '已取消',
};

/** 主页只呈现服务端已有事实，完整业务操作由各模块承接。 */
export function ProfileOverview({
  user,
  showProjects,
  onProjects,
  onAttendance,
  onApplications,
}: {
  user: AuthUser;
  showProjects: boolean;
  onProjects: (projectId?: number) => void;
  onAttendance: (month: string) => void;
  onApplications: () => void;
}) {
  const cache = useQueryClient();
  const scope = [
    'profile-workbench',
    user.id,
    user.organization?.id,
    user.organization?.position,
    user.organization?.joinStatus,
  ];
  async function read<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        await cache.invalidateQueries({ queryKey: SESSION_KEY });
      throw error;
    }
  }
  const projects = useQuery({
    queryKey: [...scope, 'projects', ''],
    queryFn: () => read(api.getMyExpertProjects()),
    enabled: showProjects,
  });
  const applications = useQuery({
    queryKey: [...scope, 'applications', 1],
    queryFn: () => read(api.listMyApplications({ businessType: null, current: 1, size: 10 })),
  });

  return (
    <div aria-label="个人主页概览" className="min-w-0 space-y-[28px]">
      {showProjects && (
        <section aria-label="所在项目" className="min-w-0">
          <div className="mb-[10px] flex flex-wrap items-center justify-between gap-x-[12px]">
            <CardTitle>所在项目</CardTitle>
            <Button variant="link" size="account" className="px-0" onClick={() => onProjects()}>
              查看全部项目 <ArrowUpRight className="size-[14px]" aria-hidden />
            </Button>
          </div>
          {projects.isPending && <LoadingState>正在读取我的项目…</LoadingState>}
          {projects.isError && (
            <Card className="space-y-2 p-5">
              <ErrorNotice error={projects.error} />
              <Button variant="outline" size="settings" onClick={() => void projects.refetch()}>
                重新读取项目
              </Button>
            </Card>
          )}
          {projects.isSuccess &&
            (projects.data.length ? (
              <ul aria-label="所在项目列表" className="grid min-w-0 gap-[16px] sm:grid-cols-2">
                {projects.data.slice(0, 4).map((project) => (
                  <li key={project.projectId} className="min-w-0">
                    <Card asChild>
                      <button
                        type="button"
                        onClick={() => onProjects(project.projectId)}
                        className="flex min-h-[126px] w-full flex-col gap-3 p-5 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="flex w-full min-w-0 items-start gap-[8px]">
                          <BookOpen
                            className="mt-[2px] size-[16px] shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="break-words text-[16px] leading-6 font-semibold text-[var(--color-primary-strong)] [overflow-wrap:anywhere]">
                            {project.projectName || `项目 ${project.projectId}`}
                          </span>
                        </span>
                        <span
                          className={`${quiet} line-clamp-2 break-words [overflow-wrap:anywhere]`}
                        >
                          需求方：{project.requesterName || '未提供'}
                        </span>
                        <span className="mt-auto flex items-center gap-[6px] text-[12px] leading-[20px]">
                          <span
                            className="size-[8px] shrink-0 rounded-full bg-primary"
                            aria-hidden
                          />
                          {nodeLabels[project.currentNodeCode] || project.currentNodeCode}
                        </span>
                      </button>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <Card>
                <EmptyState
                  title="暂无参与项目"
                  description="已接单的项目会显示在这里。"
                  icon={<BookOpen />}
                />
              </Card>
            ))}
        </section>
      )}

      <ProfileActivity user={user} onManage={onAttendance} />

      <Card asChild>
        <section aria-label="履约与能力" className="grid gap-6 p-5 sm:grid-cols-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-[16px] text-muted-foreground" aria-hidden /> 履约概览
            </CardTitle>
            <dl className="mt-[24px] grid grid-cols-2 gap-[16px]">
              <div>
                <dt className={quiet}>信用分</dt>
                <dd className="mt-[6px] text-[28px] leading-[36px] font-semibold tabular-nums">
                  {user.creditScore ?? '—'}
                </dd>
              </div>
              <div>
                <dt className={quiet}>本人申请</dt>
                <dd className="mt-[6px] text-[28px] leading-[36px] font-semibold tabular-nums">
                  {applications.isSuccess ? applications.data.total : '—'}
                </dd>
              </div>
            </dl>
            <p className={`mt-[20px] ${quiet}`}>报量记录暂未接入。</p>
          </div>
          <div className="border-t pt-[20px] sm:border-t-0 sm:border-l sm:pt-0 sm:pl-[24px]">
            <CardTitle>能力画像</CardTitle>
            <EmptyState
              title="暂无能力评估数据"
              icon={<Radar />}
              className="min-h-[142px] px-0 py-6"
            />
          </div>
        </section>
      </Card>

      <section aria-label="申请动态" className="min-w-0">
        <div className="mb-[12px] flex flex-wrap items-center justify-between gap-x-[12px]">
          <CardTitle>申请动态</CardTitle>
          <Button variant="link" size="account" className="px-0" onClick={onApplications}>
            查看全部申请 <ArrowUpRight className="size-[14px]" aria-hidden />
          </Button>
        </div>
        {applications.isPending && <LoadingState>正在读取我的申请…</LoadingState>}
        {applications.isError && (
          <div className="space-y-[8px]">
            <ErrorNotice error={applications.error} />
            <Button variant="outline" size="settings" onClick={() => void applications.refetch()}>
              重新读取申请
            </Button>
          </div>
        )}
        {applications.isSuccess &&
          (applications.data.records.length ? (
            <ol className="ml-[9px] border-l">
              {applications.data.records.slice(0, 4).map((application) => (
                <li key={application.applicationId} className="relative py-[16px] pl-[26px]">
                  <span className="absolute top-[16px] left-[-10px] grid size-[20px] place-items-center bg-card text-muted-foreground">
                    <CircleDot className="size-[16px]" aria-hidden />
                  </span>
                  <div className="flex flex-wrap items-start justify-between gap-[8px]">
                    <h3 className="min-w-0 break-words text-[14px] leading-[22px] font-medium [overflow-wrap:anywhere]">
                      {application.title}
                    </h3>
                    <time className={quiet}>{application.appliedAt.slice(0, 10)}</time>
                  </div>
                  <p className={`mt-[6px] ${quiet}`}>{flowLabels[application.status]}</p>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="暂无申请动态" icon={<Activity />} className="border-t" />
          ))}
      </section>
    </div>
  );
}
