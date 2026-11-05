import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  ApiError,
  type AuthUser,
  type ProjectPersonnelMember,
  type ProjectPersonnelRosterInput,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { PersonnelProduction } from './PersonnelProduction';
import { PersonnelAttendance } from './PersonnelAttendance';
import { PersonnelPerformance } from './PersonnelPerformance';
import { PersonnelMovements } from './PersonnelMovements';
import { PERSONNEL_LEAVE_REQUEST, personnelEntryInput } from './personnel-form';
import { productionPlanToday } from './production-plan-form';

type EntryDraft = {
  members: ProjectPersonnelMember[];
  decision: 'YES' | 'NO';
  date: string;
  reason: string;
};
type Pending = {
  id: string;
  originRole: 'PM' | 'EXPERT';
  organizationId?: string;
  status: 'unknown' | 'conflict' | 'success';
  draft: EntryDraft;
};
const pendingEntries = new Map<string, Pending>();
const statusNames = {
  PENDING_CONFIRM: '待确认',
  PENDING_ENTRY: '待入项',
  ACTIVE: '已入项',
  ENTRY_DECLINED: '放弃入项',
  PENDING_EXIT: '待离项',
  PENDING_TRANSFER: '待转项',
  LEFT: '已离项',
  REMOVED: '已移除',
};
type FilterKey =
  | 'accountTypes'
  | 'statuses'
  | 'orgPositions'
  | 'employmentTypes'
  | 'organizationIds'
  | 'responsibleUserIds';
const baseFilters: [FilterKey, string, [string, string][]][] = [
  [
    'accountTypes',
    '成员身份',
    [
      ['INDIVIDUAL', '个人'],
      ['ORGANIZATION', '组织'],
    ],
  ],
  ['statuses', '成员状态', Object.entries(statusNames)],
  [
    'orgPositions',
    '组织职位',
    [
      ['OWNER', '主管'],
      ['ADMIN', '管理员'],
      ['MEMBER', '成员'],
    ],
  ],
  [
    'employmentTypes',
    '用工类型',
    [
      ['FULL_TIME', '全职'],
      ['PART_TIME', '兼职'],
    ],
  ],
];

type PersonnelManagementProps = {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
  initialView?: 'roster' | 'movements';
  role?: 'PM' | 'EXPERT';
  canManage?: boolean;
  organizationId?: string;
  initialMovementId?: number;
  approvalOnly?: boolean;
};

export function PersonnelManagementPanel(props: PersonnelManagementProps) {
  if (props.approvalOnly)
    return (
      <PersonnelMovements
        key={JSON.stringify([
          props.user.id,
          props.role ?? 'PM',
          props.projectId,
          props.organizationId,
          props.initialMovementId,
        ])}
        user={props.user}
        projectId={props.projectId}
        role={props.role}
        organizationId={props.organizationId}
        initialMovementId={props.initialMovementId}
        approvalOnly
        canWrite={false}
        selectedMembers={[]}
        onChanged={props.onChanged}
      />
    );
  return (
    <PersonnelManagementContent
      key={JSON.stringify([
        props.user.id,
        props.role ?? 'PM',
        props.projectId,
        props.organizationId,
      ])}
      {...props}
    />
  );
}

function PersonnelManagementContent({
  user,
  projectId,
  onChanged,
  initialView = 'roster',
  role = 'PM',
  canManage = false,
  organizationId,
  initialMovementId,
}: PersonnelManagementProps) {
  const cache = useQueryClient();
  const scope = ['project-personnel-roster', user.id, role, projectId, organizationId];
  const writeKey = JSON.stringify([user.id, projectId]);
  const lockKey = ['project-personnel-entry-write', user.id, role, projectId, organizationId];
  const lockQuery = useQuery<Pending | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: () => pendingEntries.get(writeKey) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  const lock = lockQuery.data;
  const foreignLock =
    !!lock &&
    (lock.originRole !== role || (role === 'EXPERT' && lock.organizationId !== organizationId));
  const [view, setView] = useState<'roster' | 'attendance' | 'production' | 'movements'>(
    initialView,
  );
  useEffect(() => setView(initialView), [initialView]);
  const [keyword, setKeyword] = useState('');
  const [filters, setFilters] = useState<ProjectPersonnelRosterInput>({ projectId });
  const [filter, setFilter] = useState<ProjectPersonnelRosterInput>({
    projectId,
    current: 1,
    size: 20,
  });
  const [known, setKnown] = useState<ProjectPersonnelMember[]>([]);
  const [selected, setSelected] = useState<ProjectPersonnelMember[]>(() =>
    !foreignLock ? (lock?.draft.members ?? []) : [],
  );
  const [entry, setEntry] = useState<EntryDraft | null>(() =>
    lock && !foreignLock && lock.status !== 'success' ? lock.draft : null,
  );
  const [detailMember, setDetailMember] = useState<ProjectPersonnelMember | null>(null);
  const [performance, setPerformance] = useState<
    | (Pick<ProjectPersonnelMember, 'memberId' | 'displayName' | 'organizationName'> & {
        reportDate: string;
      })
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    allowLeave = useRef(false);
  function identity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  function current() {
    return mounted.current && identity();
  }
  function requireIdentity() {
    if (!identity()) throw new Error('当前身份已变化，请重新进入人员管理。');
  }
  function requireSession() {
    if (!current()) throw new Error('当前身份已变化，请重新进入人员管理。');
  }
  function requireOrigin() {
    const previous = pendingEntries.get(writeKey);
    if (
      previous &&
      (previous.originRole !== role ||
        (role === 'EXPERT' && previous.organizationId !== organizationId))
    )
      throw new Error(
        '此项目存在其他角色或组织的待核实入项决定，请回到原角色和原组织核实，不能重复保存。',
      );
  }
  function setLock(value: Pending | null, expectedId?: string) {
    const previous = pendingEntries.get(writeKey);
    if (expectedId && previous?.id !== expectedId) return;
    if (
      previous &&
      (previous.originRole !== role ||
        (role === 'EXPERT' && previous.organizationId !== organizationId))
    )
      return;
    if (value) pendingEntries.set(writeKey, value);
    else pendingEntries.delete(writeKey);
    cache.setQueryData(lockKey, value);
    cache.setQueriesData(
      {
        queryKey: ['project-personnel-entry-write', user.id],
        predicate: (query) => query.queryKey[3] === projectId,
      },
      value,
    );
  }
  const permission = useQuery({
    queryKey: ['project-expert-recruitment', user.id, 'PM', projectId],
    enabled: role === 'PM',
    queryFn: async () => {
      requireIdentity();
      const result = await api.getExpertRecruitmentDetail(projectId);
      requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const roster = useQuery({
    queryKey: [...scope, filter],
    enabled: view === 'roster' && (role === 'PM' || !!organizationId),
    queryFn: async () => {
      requireIdentity();
      if (role === 'EXPERT' && !organizationId) throw new Error('当前卡片没有可管理的组织范围。');
      const result = await api.listProjectPersonnelRoster({
        ...filter,
        ...(role === 'EXPERT' ? { organizationIds: [organizationId!] } : {}),
      });
      requireIdentity();
      if (role === 'EXPERT' && result.records.some((row) => row.organizationId !== organizationId))
        throw new Error('花名册返回范围与当前组织不一致，请重新读取。');
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const canWrite =
    role === 'EXPERT'
      ? canManage && !!organizationId
      : permission.isSuccess && permission.data.canChangeHandler && !permission.isFetching;
  const blocked = busy || !!lock || !canWrite || !roster.isSuccess || roster.isFetching;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!roster.data) return;
    setKnown((old) => {
      const rows = new Map(old.map((row) => [row.memberId, row]));
      roster.data.records.forEach((row) => rows.set(row.memberId, row));
      return [...rows.values()];
    });
  }, [roster.data]);
  function mayLeave() {
    return (
      allowLeave.current ||
      (!working.current && (!entry || window.confirm('尚有未完成的入项决定，确认离开当前页面？')))
    );
  }
  useEffect(() => {
    const leave = (event: Event) => {
      if (identity() && !mayLeave()) event.preventDefault();
    };
    window.addEventListener(PERSONNEL_LEAVE_REQUEST, leave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => {
      window.removeEventListener(PERSONNEL_LEAVE_REQUEST, leave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    };
  }, [entry, role, user.id]);
  useBlocker({
    shouldBlockFn: () => identity() && !mayLeave(),
    enableBeforeUnload: () => identity() && !allowLeave.current && (working.current || !!entry),
  });
  async function readViews(includeRoster = true) {
    if (role === 'PM') await permission.refetch({ throwOnError: true });
    requireSession();
    if (!includeRoster) return;
    const latest = await roster.refetch({ throwOnError: true });
    requireSession();
    if (latest.data)
      setSelected((rows) =>
        rows.map(
          (row) => latest.data!.records.find((item) => item.memberId === row.memberId) ?? row,
        ),
      );
  }
  async function changed() {
    await readViews(view === 'roster');
    allowLeave.current = true;
    try {
      await onChanged();
    } finally {
      allowLeave.current = false;
    }
  }
  async function finish(state: Pending) {
    requireOrigin();
    await readViews();
    allowLeave.current = true;
    await onChanged();
    if (!identity()) return;
    setLock(null, state.id);
    if (current()) {
      setEntry(null);
      setSelected([]);
    }
  }
  async function reread() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const previous = cache.getQueryData<Pending | null>(lockKey);
    try {
      if (foreignLock) {
        await readViews();
        requireOrigin();
        return;
      }
      if (previous?.status === 'success') await finish(previous);
      else {
        await readViews();
        if (previous?.status === 'conflict') {
          requireOrigin();
          setLock(null, previous.id);
          setNotice('已读取最新成员与权限，请核对入项决定后重新保存。');
        } else if (previous)
          setNotice(
            '已读取当前人员信息，仍无法精确确认上次整批保存结果；决定继续保留，不会重复提交。',
          );
        else setNotice('已读取最新人员信息。');
      }
    } catch (value) {
      if (current()) setError(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function openEntry(members: ProjectPersonnelMember[]) {
    if (
      blocked ||
      !members.length ||
      members.some(
        (row) =>
          !row.allowedActions.includes('SET_ENTRY') ||
          (role === 'EXPERT' && row.organizationId !== organizationId),
      )
    )
      return;
    setError(null);
    setEntry({
      members,
      decision: 'YES',
      date:
        members.length === 1
          ? (members[0]?.plannedEntryDate ?? productionPlanToday())
          : productionPlanToday(),
      reason: '',
    });
  }
  async function saveEntry() {
    if (
      !entry ||
      blocked ||
      working.current ||
      entry.members.some(
        (row) =>
          !row.allowedActions.includes('SET_ENTRY') ||
          (role === 'EXPERT' && row.organizationId !== organizationId),
      )
    )
      return;
    let input;
    try {
      input = personnelEntryInput(
        projectId,
        entry.members.map((row) => row.memberId),
        entry.decision,
        entry.date,
        entry.reason,
      );
    } catch (value) {
      setError(value);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    const state: Pending = {
      id: crypto.randomUUID(),
      originRole: role,
      organizationId,
      status: 'unknown',
      draft: entry,
    };
    let written = false;
    try {
      requireSession();
      requireOrigin();
      if (pendingEntries.has(writeKey)) return;
      setLock(state);
      await api.saveProjectPersonnelEntry(input);
      written = true;
      setLock({ ...state, status: 'success' }, state.id);
      requireSession();
      setNotice('入项决定已保存。');
      await finish(state);
    } catch (value) {
      if (current()) {
        setError(value);
        if (written) setNotice('入项决定已保存，后续信息读取失败，请重新读取人员信息。');
        else
          setLock(
            {
              ...state,
              status:
                value instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(value.status)
                  ? 'conflict'
                  : 'unknown',
            },
            state.id,
          );
      }
      if (value instanceof ApiError && value.status === 401)
        void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const organizations = [
    ...new Map(
      known
        .filter((row) => row.organizationId)
        .map((row) => [row.organizationId!, row.organizationName || '未命名组织']),
    ).entries(),
  ];
  const owners = [
    ...new Map(
      known.flatMap((row) =>
        row.projectOwners.length
          ? row.projectOwners.map((owner) => [owner.userId, owner.name] as [string, string])
          : row.responsibleUserId
            ? [
                [row.responsibleUserId, row.responsibleUserName || '未命名负责人'] as [
                  string,
                  string,
                ],
              ]
            : [],
      ),
    ).entries(),
  ];
  const lockText = foreignLock
    ? '此项目存在其他角色或组织的待核实入项决定，请回原角色和原组织核实；当前只读，不展示或恢复原草稿。'
    : lock
      ? lock.status === 'unknown'
        ? '入项决定结果尚未确认，已保留本次成员与决定，暂停重复保存。'
        : lock.status === 'success'
          ? '入项决定已保存，后续信息尚未读取完成，请重新读取人员信息。'
          : '权限或成员状态已变化，请重新读取人员信息后核对。'
      : '';
  const allFilters: typeof baseFilters = [
    ...baseFilters,
    ...(role === 'PM'
      ? [['organizationIds', '组织', organizations] as (typeof baseFilters)[number]]
      : []),
    ['responsibleUserIds', '项目负责人', owners],
  ];
  return (
    <section aria-label="人员管理" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h2>人员管理</h2>
        </CardTitle>
        {!entry && (
          <Button
            variant="outline"
            size="mobileTouch"
            loading={busy || roster.isFetching || permission.isFetching}
            onClick={() => void reread()}
          >
            重新读取人员信息
          </Button>
        )}
      </div>
      <ErrorNotice error={role === 'PM' ? permission.error : null} />
      {!entry && (
        <>
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lockText && <Alert>{lockText}</Alert>}
          {lock && !foreignLock && lock.status !== 'success' && (
            <Button variant="outline" size="mobileTouch" onClick={() => setEntry(lock.draft)}>
              恢复入项决定
            </Button>
          )}
        </>
      )}
      {role === 'EXPERT' && (
        <Alert>当前花名册和考勤固定为此卡片组织；每项操作仍以服务端实时资格为准。</Alert>
      )}
      {role === 'PM' && permission.isSuccess && !permission.data.canChangeHandler && (
        <Alert>
          当前为招募协作负责人，可查看人员信息；入项、表现记录和人员异动由主策略官处理。
        </Alert>
      )}
      <Tabs
        value={view}
        onValueChange={(next) => {
          if (
            next !== view &&
            window.dispatchEvent(new Event(PERSONNEL_LEAVE_REQUEST, { cancelable: true }))
          )
            setView(next as typeof view);
        }}
      >
        <TabsList
          aria-label="人员管理模块"
          variant="business"
          className="mb-4 grid h-auto w-full grid-cols-2 sm:flex sm:flex-wrap sm:justify-start"
        >
          {(
            [
              ['roster', '花名册'],
              ['attendance', '排班考勤'],
              ['production', '生产情况'],
              ['movements', '变动记录'],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              variant="business"
              className="min-h-11 min-w-0 px-2 sm:px-3"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {view === 'roster' && (
          <TabsContent value="roster" className="space-y-4">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setSelected([]);
                setFilter({ ...filters, keyword: keyword.trim(), current: 1, size: 20 });
              }}
            >
              <div className="flex flex-wrap items-end gap-3">
                <SearchInput
                  id="project-personnel-keyword"
                  label="筛选项目成员"
                  value={keyword}
                  maxLength={100}
                  placeholder="姓名、昵称或用户 ID"
                  onChange={(e) => setKeyword(e.target.value)}
                  containerClassName="flex-1 basis-[220px]"
                />
                <Button type="submit" size="mobileTouch" loading={roster.isFetching}>
                  查询成员
                </Button>
                <Button
                  variant="outline"
                  size="mobileTouch"
                  onClick={() => {
                    setKeyword('');
                    setFilters({ projectId });
                    setFilter({ projectId, current: 1, size: 20 });
                    setSelected([]);
                  }}
                >
                  重置筛选
                </Button>
                <Button
                  variant="outline"
                  size="mobileTouch"
                  loading={roster.isFetching}
                  onClick={() => void roster.refetch()}
                >
                  刷新花名册
                </Button>
              </div>
              <details className="rounded-xl border p-3">
                <summary className="cursor-pointer py-2 text-[13px]">更多筛选</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {allFilters.map(([field, label, options]) => (
                    <fieldset key={String(field)} className="rounded-lg border p-3">
                      <legend className="px-1 text-xs">{label}</legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {options.map(([value, name]) => (
                          <label
                            key={value}
                            className="flex min-h-11 items-center gap-2 text-[13px]"
                          >
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={
                                !!(filters[field] as readonly string[] | undefined)?.includes(value)
                              }
                              onChange={(e) =>
                                setFilters((old) => ({
                                  ...old,
                                  [field]: e.target.checked
                                    ? [...(old[field] ?? []), value]
                                    : (old[field] ?? []).filter((item) => item !== value),
                                }))
                              }
                            />
                            {name}
                          </label>
                        ))}
                        {!options.length && (
                          <p className="text-xs text-muted-foreground">暂无已加载选项</p>
                        )}
                      </div>
                    </fieldset>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  组织、负责人选项来自已加载成员；可先搜索或翻页查找其他成员。
                </p>
              </details>
            </form>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <span>已选 {selected.length} / 100 名</span>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={!selected.length || busy}
                onClick={() => setSelected([])}
              >
                清空成员选择
              </Button>
              {canWrite && (
                <Button
                  size="mobileTouch"
                  disabled={
                    blocked ||
                    !selected.length ||
                    selected.some((row) => !row.allowedActions.includes('SET_ENTRY'))
                  }
                  onClick={() => openEntry(selected)}
                >
                  批量设置入项
                </Button>
              )}
            </div>
            <ErrorNotice error={roster.error} />
            {roster.isPending && <LoadingState>正在读取花名册…</LoadingState>}
            {roster.isSuccess && (
              <>
                <div
                  role="group"
                  aria-label="花名册成员列表"
                  tabIndex={0}
                  className="grid max-h-[42rem] gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
                >
                  {roster.data.records.map((member) => (
                    <Card asChild key={member.memberId}>
                      <article aria-label={member.displayName} className="space-y-3 p-5">
                        <div className="flex items-start gap-3">
                          {canWrite && (
                            <label className="flex size-11 shrink-0 items-center justify-center">
                              <input
                                type="checkbox"
                                aria-label={`选择${member.displayName}`}
                                className="size-4 accent-primary"
                                disabled={blocked}
                                checked={selected.some((row) => row.memberId === member.memberId)}
                                onChange={(e) => {
                                  if (e.target.checked && selected.length >= 100) {
                                    setError(new Error('每次最多选择100名成员。'));
                                    return;
                                  }
                                  setSelected((rows) =>
                                    e.target.checked
                                      ? [...rows, member]
                                      : rows.filter((row) => row.memberId !== member.memberId),
                                  );
                                }}
                              />
                            </label>
                          )}
                          <div className="min-w-0 flex-1">
                            <h3 className="break-words text-base font-semibold">
                              {member.displayName}
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {member.userId} · {member.organizationName || '个人'}
                            </p>
                          </div>
                          <span className="rounded-md bg-muted px-2 py-1 text-xs">
                            {member.statusName}
                          </span>
                        </div>
                        <div className="space-y-1 text-[13px]">
                          <p>
                            项目负责人：
                            {member.projectOwners.length
                              ? member.projectOwners.map((owner) => owner.name).join('、')
                              : member.responsibleUserName || '未指定'}
                          </p>
                          <p>预计入项：{member.plannedEntryDate || '未设置'}</p>
                          <p>实际入项：{member.joinedAt || '尚未入项'}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="mobileTouch"
                            onClick={() => setDetailMember(member)}
                          >
                            成员详情
                          </Button>
                          {canWrite && member.allowedActions.includes('SET_ENTRY') && (
                            <Button
                              size="mobileTouch"
                              disabled={blocked}
                              onClick={() => openEntry([member])}
                            >
                              设置入项
                            </Button>
                          )}
                        </div>
                      </article>
                    </Card>
                  ))}
                </div>
                {!roster.data.records.length && <EmptyState title="暂无符合条件的项目成员" />}
                <Pagination
                  aria-label="项目花名册分页"
                  {...roster.data}
                  loading={roster.isFetching}
                  onPageChange={(current) => setFilter({ ...filter, current })}
                />
              </>
            )}
          </TabsContent>
        )}
        {view === 'attendance' && (
          <TabsContent value="attendance">
            <PersonnelAttendance
              user={user}
              projectId={projectId}
              organizations={organizations}
              role={role}
              organizationId={organizationId}
            />
          </TabsContent>
        )}
        {view === 'production' && (
          <TabsContent value="production">
            <PersonnelProduction
              user={user}
              projectId={projectId}
              role={role}
              organizationIds={role === 'EXPERT' && organizationId ? [organizationId] : undefined}
              canWrite={canWrite && !busy && !lock}
              onPerformance={setPerformance}
            />
          </TabsContent>
        )}
        {view === 'movements' && (
          <TabsContent value="movements">
            <PersonnelMovements
              user={user}
              projectId={projectId}
              role={role}
              organizationId={organizationId}
              initialMovementId={initialMovementId}
              canWrite={canWrite && !busy && !lock}
              selectedMembers={selected}
              onChanged={changed}
            />
          </TabsContent>
        )}
      </Tabs>
      {detailMember && roster.isSuccess && (
        <Dialog title="成员详情" aria-label="成员详情" onClose={() => setDetailMember(null)}>
          <h3 className="text-base font-semibold">{detailMember.displayName}</h3>
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
            {[
              ['用户 ID', detailMember.userId],
              ['所属组织', detailMember.organizationName || '个人'],
              [
                '组织职位',
                detailMember.orgPosition
                  ? { OWNER: '主管', ADMIN: '管理员', MEMBER: '成员' }[detailMember.orgPosition]
                  : '—',
              ],
              [
                '用工类型',
                detailMember.employmentType === 'FULL_TIME'
                  ? '全职'
                  : detailMember.employmentType === 'PART_TIME'
                    ? '兼职'
                    : '—',
              ],
              ['成员状态', detailMember.statusName],
              ['准入时间', detailMember.admittedAt],
              [
                '入项决定',
                detailMember.entryDecision === 'YES'
                  ? '确认'
                  : detailMember.entryDecision === 'NO'
                    ? '放弃'
                    : '尚未决定',
              ],
              ['预计入项', detailMember.plannedEntryDate],
              ['实际入项', detailMember.joinedAt],
              ['预计离项', detailMember.plannedLeaveDate],
              ['实际离项', detailMember.leftAt],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Dialog>
      )}
      {performance && (
        <PersonnelPerformance
          key={performance.memberId}
          user={user}
          projectId={projectId}
          member={performance}
          role={role}
          canWrite={canWrite && !lock}
          onChanged={changed}
          onClose={() => setPerformance(null)}
        />
      )}
      {entry && (
        <Dialog
          title="设置入项"
          aria-label="设置入项"
          busy={busy}
          onClose={() => {
            if (mayLeave()) setEntry(null);
          }}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                loading={busy}
                onClick={() => void reread()}
              >
                重新读取人员信息
              </Button>
              <Button
                size="mobileTouch"
                loading={busy}
                disabled={blocked}
                onClick={() => void saveEntry()}
              >
                确认保存入项决定
              </Button>
            </>
          }
        >
          <p className="text-[13px]">
            本次共 {entry.members.length} 名：
            {entry.members.map((row) => row.displayName).join('、')}
          </p>
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lockText && <Alert>{lockText}</Alert>}
          <fieldset className="flex flex-wrap gap-4" disabled={blocked}>
            {(
              [
                ['YES', '确认入项'],
                ['NO', '放弃入项'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-[13px]">
                <input
                  type="radio"
                  name="personnel-entry-decision"
                  className="size-4 accent-primary"
                  checked={entry.decision === value}
                  onChange={() => setEntry({ ...entry, decision: value })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {entry.decision === 'YES' ? (
            <label className="block space-y-2 text-[13px]">
              预计入项日期
              <Input
                type="date"
                min={productionPlanToday()}
                value={entry.date}
                disabled={blocked}
                onChange={(e) => setEntry({ ...entry, date: e.target.value })}
              />
              <span className="block text-xs text-muted-foreground">
                上海当天入项立即生效；未来日期仅安排待入项，实际生效由服务端任务处理。
              </span>
            </label>
          ) : (
            <label className="block space-y-2 text-[13px]">
              放弃原因
              <Textarea
                rows={4}
                maxLength={500}
                value={entry.reason}
                disabled={blocked}
                onChange={(e) => setEntry({ ...entry, reason: e.target.value })}
              />
            </label>
          )}
        </Dialog>
      )}
    </section>
  );
}
