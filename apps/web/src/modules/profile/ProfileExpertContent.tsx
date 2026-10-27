import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ApiError,
  type AuthUser,
  type OrganizationDetail,
  type OrganizationUpdateResult,
  type WorkbenchApplication,
  type WorkbenchAttendanceApplicationResult,
  type WorkbenchPage,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TabsContent } from '@/components/ui/tabs';
import { SESSION_KEY } from '@/hooks/useSession';
import { joinStatusLabels, positionLabels } from '@/modules/organizations/common';
import { OrganizationEdit, SelfDeparture } from '@/modules/organizations/OrganizationPage';
import { ProfileAttendance } from './ProfileAttendance';
import { ProfileOverview } from './ProfileOverview';
import { ProfileApplicationWithdrawal } from './ProfileApplicationWithdrawal';
import { api } from '@/services/api';

const panelClass = 'min-w-0 space-y-[20px] rounded-[8px] border bg-card p-[16px] sm:p-[24px]';
const quietClass = 'text-[13px] leading-[22px] text-[var(--color-neutral-strong)]';
const flowLabels = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
  CANCELED: '已取消',
};
const nodeLabels: Record<string, string> = {
  ENTRANCE_EXAM: '准入考试',
  STANDARD_TRAINING: '标准与培训',
  PRODUCTION_TASK: '生产任务',
  OUTPUT_DATA_REVIEW: '检查数据',
  MEMBER_MOVEMENT_APPROVAL: '人员变动审批',
  MEMBER_ENTRY_CONFIRM: '确认入项时间',
};
const admissionLabels = {
  PASSED: '已通过准入',
  PENDING: '待阅卷',
  NOT_PASSED: '未通过准入',
  NOT_EXAMINED: '未参加考试',
};
const profileScope = (user: AuthUser) => [
  'profile-workbench',
  user.id,
  user.organization?.id,
  user.organization?.position,
  user.organization?.joinStatus,
];
/** 业务读取失去会话时让公共会话边界重新确认身份，不将业务错误当作登录成功。 */
async function readProfile<T>(request: Promise<T>, cache: QueryClient): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      await cache.invalidateQueries({ queryKey: SESSION_KEY });
    throw error;
  }
}

/** 概览与完整业务共用个人中心页签，卡片入口同步选中对应页签。 */
export function ProfileExpertContent({
  user,
  showProjects,
  onSectionChange,
}: {
  user: AuthUser;
  showProjects: boolean;
  onSectionChange: (section: 'overview' | 'projects' | 'attendance' | 'organization') => void;
}) {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [attendanceMonth, setAttendanceMonth] = useState<string>();
  const scope = profileScope(user);
  return (
    <>
      <TabsContent value="overview" className="m-0">
        <ProfileOverview
          user={user}
          showProjects={showProjects}
          onProjects={(id) => {
            setProjectId(id ?? null);
            onSectionChange('projects');
          }}
          onAttendance={(month) => {
            setAttendanceMonth(month);
            onSectionChange('attendance');
          }}
          onApplications={() => onSectionChange('organization')}
        />
      </TabsContent>
      {showProjects && (
        <TabsContent value="projects" className="m-0 min-w-0">
          <ExpertProjects key={scope.join(':')} user={user} initialProjectId={projectId} />
        </TabsContent>
      )}
      <TabsContent value="attendance" className="m-0 min-w-0">
        <ProfileAttendance key={scope.join(':')} user={user} initialMonth={attendanceMonth} />
      </TabsContent>
      <TabsContent value="organization" className="m-0 min-w-0">
        <ExpertApplications key={scope.join(':')} user={user} />
      </TabsContent>
    </>
  );
}

function ExpertProjects({
  user,
  initialProjectId = null,
}: {
  user: AuthUser;
  initialProjectId?: number | null;
}) {
  const cache = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(initialProjectId);
  const projects = useQuery({
    queryKey: [...profileScope(user), 'projects', search],
    queryFn: () => readProfile(api.getMyExpertProjects(search || undefined), cache),
  });
  const selectedProject = projects.isSuccess
    ? projects.data.find((project) => project.projectId === selectedId)
    : undefined;
  const detail = useQuery({
    queryKey: [
      ...profileScope(user),
      'project-detail',
      selectedProject?.assignmentId,
      selectedProject?.movementId,
    ],
    queryFn: () => readProfile(api.getExpertAssignmentDetail(selectedProject!), cache),
    enabled: !!selectedProject,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setSelectedId(null);
    if (search === keyword.trim()) void projects.refetch();
    else setSearch(keyword.trim());
  }
  return (
    <section aria-label="我的项目" className={panelClass}>
      <div>
        <h3 className="text-[17px] leading-[26px] font-semibold">我的项目</h3>
        <p className={`mt-[6px] ${quietClass}`}>
          查看本人已接单项目与当前履约节点，参与范围以服务端实际分配为准。
        </p>
      </div>
      <form onSubmit={submit} className="flex min-w-0 flex-wrap items-end gap-[8px]">
        <label className="min-w-0 flex-1 basis-[180px] text-[12px] leading-[20px]">
          搜索我的项目
          <Input
            size="profile"
            className="mt-[6px]"
            maxLength={100}
            value={keyword}
            placeholder="项目名称、需求方或节点"
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" size="settings" loading={projects.isFetching}>
          查询项目
        </Button>
      </form>
      {projects.isPending && (
        <p role="status" className={quietClass}>
          正在读取我的项目…
        </p>
      )}
      {projects.isError && (
        <div className="space-y-[8px]">
          <ErrorNotice error={projects.error} />
          <Button variant="outline" size="settings" onClick={() => void projects.refetch()}>
            重新读取项目
          </Button>
        </div>
      )}
      {projects.isSuccess && projects.data.length === 0 && (
        <p className={`${quietClass} py-[24px] text-center`}>暂无符合执行专家参与范围的项目</p>
      )}
      {projects.isSuccess && projects.data.length > 0 && (
        <ul aria-label="我的项目列表" className="grid min-w-0 gap-[10px] sm:grid-cols-2">
          {projects.data.map((project) => (
            <li key={project.projectId} className="min-w-0">
              <button
                type="button"
                aria-pressed={selectedId === project.projectId}
                onClick={() => setSelectedId(project.projectId)}
                className="flex min-h-[100px] w-full min-w-0 flex-col items-start gap-[6px] rounded-[8px] border p-[14px] text-left text-[13px] leading-[20px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-accent"
              >
                <span className="max-w-full break-words font-semibold [overflow-wrap:anywhere]">
                  {project.projectName || `项目 ${project.projectId}`}
                </span>
                <span className="max-w-full break-words text-muted-foreground [overflow-wrap:anywhere]">
                  需求方：{project.requesterName || '未提供'}
                </span>
                <span className="flex max-w-full flex-wrap gap-x-[12px] gap-y-[4px] text-[12px]">
                  <span>{nodeLabels[project.currentNodeCode] || project.currentNodeCode}</span>
                  {project.needWrittenExam && (
                    <span>{admissionLabels[project.admissionStatus]}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedProject && (
        <section aria-label="项目详情" className="space-y-[16px] border-t pt-[20px]">
          <h3 className="text-[16px] font-semibold">项目详情</h3>
          {detail.isPending && (
            <p role="status" className={quietClass}>
              正在读取项目详情…
            </p>
          )}
          {detail.isError && (
            <div className="space-y-[8px]">
              <ErrorNotice error={detail.error} />
              <Button variant="outline" size="settings" onClick={() => void detail.refetch()}>
                重新读取项目详情
              </Button>
            </div>
          )}
          {detail.isSuccess && (
            <>
              <h4 className="break-words text-[15px] font-semibold [overflow-wrap:anywhere]">
                {detail.data.projectDetail.projectName || `项目 ${selectedProject.projectId}`}
              </h4>
              <dl className="grid min-w-0 gap-[16px] text-[13px] leading-[22px] sm:grid-cols-2 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere] [&_dt]:mb-[4px] [&_dt]:text-muted-foreground">
                <div>
                  <dt>需求方</dt>
                  <dd>{detail.data.projectDetail.requesterName || '未提供'}</dd>
                </div>
                <div>
                  <dt>截止时间（上海时间）</dt>
                  <dd>{detail.data.projectDetail.deadline || '未设置'}</dd>
                </div>
                <div>
                  <dt>本人当前节点</dt>
                  <dd>
                    {nodeLabels[selectedProject.currentNodeCode] || selectedProject.currentNodeCode}
                  </dd>
                </div>
                <div>
                  <dt>生产量级</dt>
                  <dd>
                    {detail.data.productionPlan.totalExpectedOutput ?? '未配置'}{' '}
                    {detail.data.productionPlan.totalExpectedOutput != null &&
                      detail.data.projectDetail.quantityUnit}
                  </dd>
                </div>
                <div>
                  <dt>作业人数要求</dt>
                  <dd>{detail.data.productionPlan.operatorHeadcount ?? '未配置'}</dd>
                </div>
                <div>
                  <dt>质检人数要求</dt>
                  <dd>{detail.data.productionPlan.inspectorHeadcount ?? '未配置'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt>项目说明</dt>
                  <dd className="whitespace-pre-wrap">
                    {detail.data.projectDetail.projectDescription || '未提供'}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt>作业标准</dt>
                  <dd className="whitespace-pre-wrap">
                    {detail.data.projectDetail.standardContent || '未提供'}
                  </dd>
                </div>
              </dl>
              <p className={quietClass}>当前提供只读详情，接单、考试和生产操作尚未接入。</p>
            </>
          )}
        </section>
      )}
    </section>
  );
}

function ExpertApplications({ user }: { user: AuthUser }) {
  const cache = useQueryClient();
  const [current, setCurrent] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [exitSubmitted, setExitSubmitted] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const departureKeys = useRef(new Map<string, string>());
  const queryKey = [...profileScope(user), 'applications', current];
  const applications = useQuery({
    queryKey,
    queryFn: () =>
      readProfile(api.listMyApplications({ businessType: null, current, size: 10 }), cache),
  });
  const org = user.organization;
  const position =
    typeof org?.position === 'string'
      ? positionLabels[org.position as keyof typeof positionLabels]
      : '';
  const joinStatus =
    typeof org?.joinStatus === 'string'
      ? joinStatusLabels[org.joinStatus as keyof typeof joinStatusLabels]
      : '';
  const orgId = typeof org?.id === 'string' ? org.id : '';
  const validOrgId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId);
  const canReadOrganization =
    (user.selectedRole ?? user.role) === 'EXPERT' &&
    validOrgId &&
    ['OWNER', 'ADMIN'].includes(String(org?.position)) &&
    ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(org?.joinStatus));
  const organizationKey = ['profile-organization', user.id, orgId, org?.position, org?.joinStatus];
  const organizationDetail = useQuery({
    queryKey: organizationKey,
    queryFn: () => readProfile(api.getOrganization(orgId), cache),
    enabled: canReadOrganization,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const organizationSummary = organizationDetail.data ?? org;
  const activeOrganizationOwner =
    canReadOrganization && org?.position === 'OWNER' && org.joinStatus === 'ACTIVE';
  const canEditOrganization =
    activeOrganizationOwner &&
    organizationDetail.data?.position === 'OWNER' &&
    !organizationDetail.isError;
  const pendingExit =
    exitSubmitted ||
    org?.joinStatus === 'EXIT_APPROVING' ||
    applications.data?.records.some(
      (record) =>
        record.businessType === 'ORG_MEMBER_EXIT' &&
        record.status === 'PENDING' &&
        record.applicantOrgId === orgId,
    );
  const canExit =
    validOrgId &&
    ['ADMIN', 'MEMBER'].includes(String(org?.position)) &&
    org?.joinStatus === 'ACTIVE' &&
    !['FROZEN', 'DISSOLVED'].includes(String(org.status)) &&
    !pendingExit;

  async function refreshAfterWrite(message: string) {
    setRefreshing(true);
    const results = await Promise.allSettled([
      cache.invalidateQueries({ queryKey: ['profile-workbench', user.id] }, { throwOnError: true }),
      cache.invalidateQueries(
        { queryKey: ['profile-organization', user.id] },
        { throwOnError: true },
      ),
      cache.invalidateQueries({ queryKey: ['organization', user.id] }, { throwOnError: true }),
      cache.invalidateQueries({ queryKey: SESSION_KEY }, { throwOnError: true }),
    ]);
    const failed = results.some((result) => result.status === 'rejected');
    setRefreshFailed(failed);
    setNotice(failed ? `${message}；最新资料读取失败，请手动重试读取。` : message);
    setRefreshing(false);
  }

  async function organizationSaved(result: OrganizationUpdateResult) {
    if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
    await Promise.all([
      cache.cancelQueries({ queryKey: organizationKey }),
      cache.cancelQueries({ queryKey: ['organization', user.id, orgId, 'detail'] }),
      cache.cancelQueries({ queryKey: SESSION_KEY }),
    ]);
    if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
    const fields = { description: result.description, logoUrl: result.logoUrl };
    cache.setQueryData<OrganizationDetail>(organizationKey, (previous) =>
      previous ? { ...previous, ...fields } : previous,
    );
    cache.setQueriesData<OrganizationDetail>(
      { queryKey: ['organization', user.id, orgId, 'detail'] },
      (previous) => (previous ? { ...previous, ...fields } : previous),
    );
    cache.setQueryData<AuthUser | null>(SESSION_KEY, (current) =>
      current?.organization?.id === orgId
        ? { ...current, organization: { ...current.organization, ...fields } }
        : current,
    );
    await refreshAfterWrite('组织资料已保存');
  }

  async function withdrawn(result: WorkbenchAttendanceApplicationResult) {
    cache.setQueryData<WorkbenchPage<WorkbenchApplication>>(
      queryKey,
      (previous) =>
        previous && {
          ...previous,
          records: previous.records.map((record) =>
            record.applicationId === result.applicationId
              ? {
                  ...record,
                  status: result.status,
                  flowVersionNo: result.flowVersionNo,
                  canWithdraw: false,
                }
              : record,
          ),
        },
    );
    await refreshAfterWrite('考勤申请已撤回');
  }
  return (
    <section aria-label="组织与申请" className={panelClass}>
      <div>
        <h3 className="text-[17px] leading-[26px] font-semibold">组织与申请</h3>
        <p className={`mt-[6px] ${quietClass}`}>
          组织身份来自真实成员关系，申请记录只查询本人发起的流程。
        </p>
      </div>
      {notice && <Alert>{notice}</Alert>}
      {refreshFailed && (
        <Button
          variant="outline"
          size="settings"
          loading={refreshing}
          onClick={() => void refreshAfterWrite('组织与申请已更新')}
        >
          重新读取组织与申请
        </Button>
      )}
      <div className="space-y-[12px] rounded-[8px] border p-[16px]">
        <h4 className="text-[14px] font-semibold">我的组织</h4>
        {org ? (
          <>
            <p className="break-words text-[14px] leading-[22px] font-medium">
              {typeof organizationSummary?.name === 'string'
                ? organizationSummary.name
                : '所属组织'}
            </p>
            <p className={quietClass}>
              {[position, joinStatus].filter(Boolean).join(' · ') || '查看成员关系详情'}
            </p>
            {typeof organizationSummary?.description === 'string' &&
              organizationSummary.description.trim() && (
                <p className={`${quietClass} whitespace-pre-wrap`}>
                  {organizationSummary.description}
                </p>
              )}
            {typeof organizationSummary?.unifiedCreditCode === 'string' &&
              organizationSummary.unifiedCreditCode && (
                <p className={quietClass}>
                  统一社会信用代码：{organizationSummary.unifiedCreditCode}
                </p>
              )}
            <div className="flex flex-wrap items-center gap-[8px]">
              <Button asChild variant="outline" size="settings">
                <Link to="/organization">查看组织信息与可用操作</Link>
              </Button>
              {canEditOrganization && (
                <Button
                  variant="outline"
                  size="settings"
                  disabled={organizationDetail.isFetching}
                  onClick={() => setEditingOrganization(true)}
                >
                  编辑组织资料
                </Button>
              )}
              {canExit && (
                <Button
                  variant="destructiveOutline"
                  size="settings"
                  onClick={() => setExiting(true)}
                >
                  申请退出组织
                </Button>
              )}
              {pendingExit && <p className={quietClass}>退出审批中</p>}
            </div>
            {org.position === 'OWNER' && org.joinStatus === 'ACTIVE' && (
              <p className={quietClass}>主管退出前请先在组织管理中转让主管角色。</p>
            )}
            {(!activeOrganizationOwner ||
              (organizationDetail.data && organizationDetail.data.position !== 'OWNER')) && (
              <p className={quietClass}>仅正常在组的主管可修改组织资料。</p>
            )}
            {canReadOrganization && organizationDetail.isPending && (
              <p role="status" className={quietClass}>
                正在读取组织资料…
              </p>
            )}
            {canReadOrganization && organizationDetail.isError && (
              <div className="space-y-[8px]">
                <p className={quietClass}>组织详情未更新，请重新读取后编辑组织资料。</p>
                <ErrorNotice error={organizationDetail.error} />
                <Button
                  variant="outline"
                  size="settings"
                  loading={organizationDetail.isFetching}
                  onClick={() => void organizationDetail.refetch()}
                >
                  重新读取组织资料
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className={quietClass}>当前未加入组织</p>
        )}
      </div>
      <section aria-label="我的申请" className="space-y-[16px]">
        <h4 className="text-[15px] font-semibold">我的申请</h4>
        {applications.isPending && (
          <p role="status" className={quietClass}>
            正在读取我的申请…
          </p>
        )}
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
            <ul className="space-y-[12px]">
              {applications.data.records.map((application) => (
                <li
                  key={application.applicationId}
                  className="min-w-0 space-y-[8px] rounded-[8px] border p-[14px] text-[13px] leading-[22px] [overflow-wrap:anywhere]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-[8px]">
                    <h5 className="min-w-0 flex-1 font-medium">{application.title}</h5>
                    <span className="rounded-[5px] bg-muted px-[8px] py-[2px] text-[12px]">
                      {flowLabels[application.status]}
                    </span>
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    申请时间：{application.appliedAt}（上海时间）
                  </p>
                  {application.applicantOrgName && <p>所属组织：{application.applicantOrgName}</p>}
                  {application.applyReason && (
                    <p className="whitespace-pre-wrap">申请原因：{application.applyReason}</p>
                  )}
                  {attendanceApplicationDetails(application).map(([label, value]) => (
                    <p key={label}>
                      {label}：{value}
                    </p>
                  ))}
                  {application.targetMemberName && <p>目标成员：{application.targetMemberName}</p>}
                  {application.plannedLeaveDate && <p>计划离组：{application.plannedLeaveDate}</p>}
                  {application.finishedAt && <p>结束时间：{application.finishedAt}（上海时间）</p>}
                  <p className="text-[12px] text-muted-foreground">流水号：{application.flowNo}</p>
                  <ProfileApplicationWithdrawal
                    application={application}
                    userId={user.id}
                    onSuccess={withdrawn}
                    onRefresh={() => applications.refetch()}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${quietClass} py-[20px] text-center`}>暂无申请记录</p>
          ))}
        {applications.isSuccess && (
          <nav
            aria-label="申请分页"
            className="flex flex-wrap items-center justify-between gap-[12px] border-t pt-[16px] text-[12px] text-muted-foreground"
          >
            <span>
              共 {applications.data.total} 条 · 第 {current} /{' '}
              {Math.max(1, applications.data.pages)} 页
            </span>
            <div className="flex gap-[8px]">
              <Button
                variant="outline"
                size="settings"
                disabled={current <= 1 || applications.isFetching}
                onClick={() => setCurrent((page) => page - 1)}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="settings"
                disabled={current >= applications.data.pages || applications.isFetching}
                onClick={() => setCurrent((page) => page + 1)}
              >
                下一页
              </Button>
            </div>
          </nav>
        )}
      </section>
      {editingOrganization && canEditOrganization && organizationDetail.data && (
        <OrganizationEdit
          orgId={orgId}
          detail={organizationDetail.data}
          onClose={() => setEditingOrganization(false)}
          onSuccess={organizationSaved}
        />
      )}
      {exiting && canExit && (
        <SelfDeparture
          orgId={orgId}
          requestKeys={departureKeys.current}
          onClose={() => setExiting(false)}
          onSuccess={async () => {
            if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
            setExiting(false);
            setExitSubmitted(true);
            await refreshAfterWrite('退出申请已提交，等待主管审批');
          }}
        />
      )}
    </section>
  );
}

function attendanceApplicationDetails(application: WorkbenchApplication): [string, string][] {
  if (!['ATTENDANCE_LEAVE', 'ATTENDANCE_CORRECTION'].includes(application.businessType)) return [];
  const form = application.formData;
  if (!form) return [];
  const result: [string, string][] = [];
  if (typeof form.attendanceDate === 'string') result.push(['考勤日期', form.attendanceDate]);
  const statuses: Record<string, string> = {
    PRESENT: '正常出勤',
    LATE: '迟到',
    EARLY_LEAVE: '早退',
    LATE_EARLY: '迟到且早退',
    LEAVE: '请假',
    ABSENT: '缺勤',
    REST: '休息',
  };
  const status = typeof form.finalStatus === 'string' ? statuses[form.finalStatus] : undefined;
  if (status) result.push(['申请目标状态', status]);
  if (typeof form.leaveStartAt === 'string' && typeof form.leaveEndAt === 'string')
    result.push([
      '请假时段',
      `${form.leaveStartAt} — ${form.leaveEndAt}${typeof form.timezone === 'string' ? `（${form.timezone}）` : ''}`,
    ]);
  return result;
}
