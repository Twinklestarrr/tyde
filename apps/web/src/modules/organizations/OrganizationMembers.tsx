import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RotateCw, Search, SlidersHorizontal } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type OrganizationMember,
  type OrganizationMemberQuery,
  type OrganizationMemberUpdateInput,
  type OrganizationPosition,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { api } from '@/services/api';
import { OrganizationMemberDossier } from './OrganizationMemberDossier';
import {
  OrganizationDialog,
  OrganizationPagination,
  orgControlClass,
  positionLabels,
  employmentLabels,
  joinStatusLabels,
  organizationTime,
  shanghaiToday,
} from './common';

const emptyFilters = {
  keyword: '',
  position: '',
  employmentType: '',
  joinStatus: '',
  joinedStartDate: '',
  joinedEndDate: '',
  leftStartDate: '',
  leftEndDate: '',
  projectId: '',
};
const shanghaiDate = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
    : '';
};
const displayName = (member: OrganizationMember) =>
  member.nickname && member.realName && member.nickname !== member.realName
    ? `${member.nickname}（${member.realName}）`
    : member.nickname || member.realName || '未命名成员';
const memberLevels = ['未定义', '普通', '进阶1', '进阶2', '高阶', '特殊专家'];
type MemberAction = { kind: 'edit' | 'role' | 'exit'; member: OrganizationMember };

interface OrganizationMembersProps {
  orgId: string;
  user: AuthUser;
  position: 'OWNER' | 'ADMIN';
  canWrite: boolean;
  onSessionChanged: () => Promise<void>;
}

/** 账号或组织变化时清除旧筛选、成员草稿和退出幂等键。 */
export function OrganizationMembers(props: OrganizationMembersProps) {
  return (
    <OrganizationMembersPanel
      key={`${props.user.id}:${props.orgId}:${props.position}`}
      {...props}
    />
  );
}

function OrganizationMembersPanel({
  orgId,
  user,
  position,
  canWrite,
  onSessionChanged,
}: OrganizationMembersProps) {
  const cache = useQueryClient();
  // 仅在提交时登记指纹；关闭失败弹框后再次提交相同内容仍可领取原幂等结果。
  const departureKeys = useRef(new Map<string, string>());
  const [filters, setFilters] = useState(emptyFilters);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [query, setQuery] = useState<OrganizationMemberQuery>({ orgId, current: 1, size: 20 });
  const [filterError, setFilterError] = useState<Error>();
  const [action, setAction] = useState<MemberAction>();
  const [notice, setNotice] = useState('');
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [dossier, setDossier] = useState<OrganizationMember | null>(null);
  const members = useQuery({
    queryKey: ['organization', user.id, orgId, 'members', query],
    queryFn: () => api.listOrganizationMembers({ ...query, orgId }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const setFilter = (key: keyof typeof emptyFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const appliedFilterCount = Object.entries(query).filter(
    ([key, value]) => key in emptyFilters && value !== undefined,
  ).length;

  function search(event: FormEvent) {
    event.preventDefault();
    setFilterError(undefined);
    if (
      (filters.joinedStartDate &&
        filters.joinedEndDate &&
        filters.joinedStartDate > filters.joinedEndDate) ||
      (filters.leftStartDate && filters.leftEndDate && filters.leftStartDate > filters.leftEndDate)
    ) {
      setFilterError(new Error('日期范围起点不能晚于终点'));
      return;
    }
    const projectId = filters.projectId.trim() ? Number(filters.projectId) : undefined;
    if (
      projectId !== undefined &&
      (!Number.isInteger(projectId) || projectId < -2147483648 || projectId > 2147483647)
    ) {
      setFilterError(new Error('项目 ID 必须是 32 位整数'));
      return;
    }
    const next: OrganizationMemberQuery = { orgId, current: 1, size: query.size };
    for (const key of [
      'keyword',
      'joinedStartDate',
      'joinedEndDate',
      'leftStartDate',
      'leftEndDate',
    ] as const) {
      if (filters[key].trim()) next[key] = filters[key].trim();
    }
    if (filters.position) next.position = filters.position as OrganizationMemberQuery['position'];
    if (filters.employmentType)
      next.employmentType = filters.employmentType as OrganizationMemberQuery['employmentType'];
    if (filters.joinStatus)
      next.joinStatus = filters.joinStatus as OrganizationMemberQuery['joinStatus'];
    if (projectId !== undefined) next.projectId = projectId;
    setQuery(next);
  }

  async function saved(message: string) {
    setAction(undefined);
    setNotice(message);
    await cache.invalidateQueries({ queryKey: ['organization', user.id, orgId] });
    try {
      await onSessionChanged();
    } catch {
      setNotice(`${message}；账户状态刷新失败，请重新读取组织信息。`);
    }
  }

  return (
    <Card asChild>
      <section className="overflow-hidden text-[13px]" aria-labelledby="organization-members-title">
        <CardHeader className="flex-row flex-wrap items-center justify-between">
          <div className="flex flex-wrap items-center gap-[10px]">
            <CardTitle id="organization-members-title">组织人员</CardTitle>
            {members.data && (
              <span className="rounded-[5px] bg-muted px-[7px] py-[2px] text-[12px] tabular-nums text-[var(--color-neutral-strong)]">
                {members.data.total} 人
              </span>
            )}
            <span className="text-[12px] text-[var(--color-neutral-strong)]">时间均为上海时间</span>
          </div>
          <Button
            variant="ghost"
            size="formCompactMobileTouch"
            loading={members.isFetching}
            onClick={() => void members.refetch()}
          >
            {!members.isFetching && <RotateCw className="size-[14px]" aria-hidden />}
            刷新人员
          </Button>
        </CardHeader>
        <form onSubmit={search} className="p-[20px]">
          <div className="grid grid-cols-2 items-center gap-[8px] min-[641px]:flex min-[641px]:flex-wrap">
            <div className="relative col-span-2 min-w-0 min-[641px]:min-w-[220px] min-[641px]:flex-1">
              <label htmlFor="org-member-keyword" className="sr-only">
                姓名 / 完整手机号
              </label>
              <Search
                className="pointer-events-none absolute top-1/2 left-[12px] size-[15px] -translate-y-1/2 text-[var(--color-neutral-strong)]"
                aria-hidden
              />
              <Input
                size="profile"
                id="org-member-keyword"
                className="rounded-[8px] bg-card pl-[36px] shadow-none"
                placeholder="搜索真实姓名 / 完整手机号"
                value={filters.keyword}
                maxLength={100}
                onChange={(event) => setFilter('keyword', event.target.value)}
              />
            </div>
            {(
              [
                ['position', '组织角色', '全部角色', positionLabels],
                ['joinStatus', '成员状态', '全部状态', joinStatusLabels],
              ] as const
            ).map(([key, label, placeholder, options]) => (
              <div key={key} className="min-w-0 min-[641px]:w-[140px]">
                <label htmlFor={`org-member-${key}`} className="sr-only">
                  {label}
                </label>
                <select
                  id={`org-member-${key}`}
                  className={orgControlClass}
                  value={filters[key]}
                  onChange={(event) => setFilter(key, event.target.value)}
                >
                  <option value="">{placeholder}</option>
                  {Object.entries(options).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <Button type="submit" size="settings">
              查询
            </Button>
            <Button
              variant={moreFiltersOpen ? 'soft' : 'outline'}
              size="settings"
              aria-expanded={moreFiltersOpen}
              aria-controls="org-member-more-filters"
              onClick={() => setMoreFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal className="size-[14px] shrink-0" aria-hidden />
              更多筛选
              <ChevronDown
                className={`size-[14px] shrink-0 transition-transform ${moreFiltersOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </Button>
          </div>
          {moreFiltersOpen && (
            <div
              id="org-member-more-filters"
              className="mt-[12px] grid min-w-0 grid-cols-1 gap-[12px] rounded-[8px] border bg-muted/30 p-[16px] min-[540px]:grid-cols-2 min-[960px]:grid-cols-3"
            >
              <FormField controlId="org-member-employmentType" label="人员属性">
                <select
                  id="org-member-employmentType"
                  className={orgControlClass}
                  value={filters.employmentType}
                  onChange={(event) => setFilter('employmentType', event.target.value)}
                >
                  <option value="">全部属性</option>
                  {Object.entries(employmentLabels).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </FormField>
              {(
                [
                  ['joinedStartDate', '入组日期起'],
                  ['joinedEndDate', '入组日期止'],
                  ['leftStartDate', '离组日期起'],
                  ['leftEndDate', '离组日期止'],
                ] as const
              ).map(([key, label]) => (
                <FormField key={key} controlId={`org-member-${key}`} label={label}>
                  <Input
                    size="profile"
                    type="date"
                    id={`org-member-${key}`}
                    className="rounded-[8px] bg-card shadow-none"
                    value={filters[key]}
                    onChange={(event) => setFilter(key, event.target.value)}
                  />
                </FormField>
              ))}
              <FormField
                controlId="org-member-project"
                label="项目 ID"
                description="仅筛选成员，不影响在项数统计。"
              >
                <Input
                  size="profile"
                  id="org-member-project"
                  className="rounded-[8px] bg-card shadow-none"
                  type="number"
                  step="1"
                  min={-2147483648}
                  max={2147483647}
                  value={filters.projectId}
                  onChange={(event) => setFilter('projectId', event.target.value)}
                />
              </FormField>
            </div>
          )}
          <div className="mt-[10px] flex min-h-[24px] flex-wrap items-center gap-[8px] text-[12px]">
            <span className="text-[var(--color-neutral-strong)]" role="status">
              {appliedFilterCount ? `已应用 ${appliedFilterCount} 项筛选` : '显示全部成员'}
            </span>
            <Button
              variant="link"
              size="formCompactMobileTouch"
              onClick={() => {
                setFilters(emptyFilters);
                setFilterError(undefined);
                setQuery({ orgId, current: 1, size: 20 });
              }}
            >
              重置筛选
            </Button>
          </div>
        </form>
        {filterError && (
          <div className="px-[20px] pb-[16px] max-[640px]:px-[16px]">
            <ErrorNotice error={filterError} />
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="mx-[20px] mb-[16px] rounded-[8px] bg-accent px-[12px] py-[10px] max-[640px]:mx-[16px]"
          >
            {notice}
          </p>
        )}
        {members.error && (
          <div className="px-[20px] pb-[16px] max-[640px]:px-[16px]">
            <ErrorNotice error={members.error} />
          </div>
        )}
        {members.isPending && <LoadingState className="border-t">正在读取组织人员…</LoadingState>}
        {members.data && (
          <>
            <div
              tabIndex={0}
              role="region"
              aria-label="组织人员表格，可左右滚动"
              className="min-w-0 overflow-x-auto border-t focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
            >
              <Table className="min-w-[1040px]">
                <caption className="sr-only">组织人员列表，时间均为上海时间</caption>
                <TableHeader>
                  <TableRow>
                    {[
                      '成员',
                      '人员属性',
                      '组织角色',
                      '人员等级',
                      '成员状态',
                      '入组 / 离组时间',
                      '在项数',
                      '操作',
                    ].map((label) => (
                      <TableHead
                        key={label}
                        scope="col"
                        className={`${label === '操作' ? 'border-l bg-[var(--color-surface-muted)] min-[960px]:sticky min-[960px]:right-0 min-[960px]:z-10' : ''}`}
                      >
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data.records.map((member) => {
                    const self = member.userId === user.id;
                    const canEdit =
                      canWrite && (position === 'OWNER' || member.position === 'MEMBER' || self);
                    const canRole =
                      canWrite &&
                      !self &&
                      member.position !== 'OWNER' &&
                      (position === 'OWNER' || member.position === 'MEMBER') &&
                      ['ACTIVE', 'PENDING_ACTIVATION'].includes(String(member.joinStatus));
                    const canExit =
                      canWrite &&
                      member.joinStatus === 'ACTIVE' &&
                      member.position !== 'OWNER' &&
                      !self &&
                      (position === 'OWNER' || member.position === 'MEMBER');
                    return (
                      <TableRow key={member.memberId} className="group bg-card">
                        <TableHead
                          scope="row"
                          className="w-[300px] min-w-[260px] max-w-[300px] bg-card py-[14px] text-[13px] font-normal text-foreground group-hover:bg-muted/30"
                        >
                          <div className="flex items-center gap-[10px]">
                            <UserAvatar
                              url={member.avatarUrl}
                              name={displayName(member)}
                              className="size-[32px] text-[14px]"
                            />
                            <div className="min-w-0">
                              <p className="truncate font-medium" title={displayName(member)}>
                                {displayName(member)}
                                {self && (
                                  <span className="ml-[6px] text-[12px] font-normal text-[var(--color-neutral-strong)]">
                                    （我）
                                  </span>
                                )}
                              </p>
                              <div className="mt-[5px] flex min-w-0 items-center gap-[8px] text-[12px] text-[var(--color-neutral-strong)]">
                                <span className="shrink-0 tabular-nums">{member.phoneMasked}</span>
                                <span aria-hidden className="h-[10px] border-l" />
                                <span className="truncate" title={`用户 ID：${member.userId}`}>
                                  用户 ID：{member.userId}
                                </span>
                              </div>
                              {member.userStatus !== 'ACTIVE' && (
                                <p className="mt-[3px] text-destructive">
                                  {member.userStatus === 'FROZEN' ? '账号冻结' : '账号封禁'}
                                </p>
                              )}
                            </div>
                          </div>
                        </TableHead>
                        <TableCell className="whitespace-nowrap">
                          {member.employmentType
                            ? employmentLabels[member.employmentType]
                            : '未设置'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {positionLabels[member.position]}
                        </TableCell>
                        <TableCell>
                          <select
                            aria-label={`${displayName(member)}人员等级`}
                            className={orgControlClass}
                            value={levels[member.memberId] ?? '未定义'}
                            onChange={(event) =>
                              setLevels((current) => ({
                                ...current,
                                [member.memberId]: event.target.value,
                              }))
                            }
                          >
                            {memberLevels.map((level) => (
                              <option key={level}>{level}</option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span
                            className={`inline-flex items-center rounded-[5px] px-[7px] py-[3px] text-[12px] leading-[18px] ${
                              member.joinStatus === 'ACTIVE'
                                ? 'bg-[var(--color-success-soft)] text-[var(--color-success-hover)]'
                                : member.joinStatus === 'LEFT' || member.joinStatus === 'REMOVED'
                                  ? 'bg-muted text-[var(--color-neutral-strong)]'
                                  : 'bg-[var(--color-warning-soft)] text-[var(--color-neutral-strong)]'
                            }`}
                          >
                            {member.joinStatus ? joinStatusLabels[member.joinStatus] : '未设置'}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-[12px] tabular-nums">
                          <p>
                            <span className="mr-[6px] text-[var(--color-neutral-strong)]">
                              入组
                            </span>
                            {organizationTime(member.joinedAt)}
                          </p>
                          {(member.leftAt || member.plannedLeaveDate) && (
                            <p className="mt-[5px]">
                              <span className="mr-[6px] text-[var(--color-neutral-strong)]">
                                {member.leftAt ? '离组' : '拟离组'}
                              </span>
                              {member.leftAt
                                ? organizationTime(member.leftAt)
                                : member.plannedLeaveDate}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{member.activeProjectCount}</TableCell>
                        <TableCell className="border-l bg-card group-hover:bg-[var(--color-surface-muted)] min-[960px]:sticky min-[960px]:right-0">
                          <div className="flex flex-nowrap items-center gap-[4px] whitespace-nowrap">
                            <Button
                              variant="link"
                              size="formCompactMobileTouch"
                              onClick={() => setDossier(member)}
                            >
                              查看档案
                            </Button>
                            {canEdit && (
                              <Button
                                variant="link"
                                size="formCompactMobileTouch"
                                onClick={() => setAction({ kind: 'edit', member })}
                              >
                                编辑成员
                              </Button>
                            )}
                            {canRole && (
                              <Button
                                variant="link"
                                size="formCompactMobileTouch"
                                onClick={() => setAction({ kind: 'role', member })}
                              >
                                变更角色
                              </Button>
                            )}
                            {canExit && (
                              <Button
                                variant="dangerGhost"
                                size="formCompactMobileTouch"
                                onClick={() => setAction({ kind: 'exit', member })}
                              >
                                {self ? '申请退出' : '移出组织'}
                              </Button>
                            )}
                            {!canEdit && !canRole && !canExit && (
                              <span className="text-[var(--color-neutral-strong)]">—</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {members.data.records.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="p-0">
                        <EmptyState title="暂无符合条件的人员" />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <CardFooter className="block border-t-0">
              <OrganizationPagination
                current={members.data.current}
                size={members.data.size}
                total={members.data.total}
                loading={members.isFetching}
                onPageChange={(current) => setQuery((value) => ({ ...value, current }))}
              />
            </CardFooter>
          </>
        )}
        {dossier && (
          <OrganizationMemberDossier
            member={dossier}
            name={displayName(dossier)}
            onClose={() => setDossier(null)}
          />
        )}
        <p className="px-5 py-3 text-xs text-muted-foreground">
          人员等级仅在当前视图暂存，刷新或离开后重置，未保存到服务器。
        </p>
        {action && canWrite && (
          <MemberDialog
            key={`${action.kind}:${action.member.memberId}`}
            action={action}
            orgId={orgId}
            position={position}
            userId={user.id}
            departureKeys={departureKeys.current}
            onClose={() => setAction(undefined)}
            onSaved={saved}
          />
        )}
      </section>
    </Card>
  );
}

function MemberDialog({
  action,
  orgId,
  position,
  userId,
  departureKeys,
  onClose,
  onSaved,
}: {
  action: MemberAction;
  orgId: string;
  position: 'OWNER' | 'ADMIN';
  userId: string;
  departureKeys: Map<string, string>;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { member, kind } = action;
  const [joinedAt, setJoinedAt] = useState(shanghaiDate(member.joinedAt));
  const [employment, setEmployment] = useState(member.employmentType || '');
  const [role, setRole] = useState<OrganizationPosition>(member.position);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const [leaveDate, setLeaveDate] = useState(shanghaiToday);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<unknown>();
  const self = member.userId === userId;
  const title =
    kind === 'edit'
      ? '编辑组织成员'
      : kind === 'role'
        ? '变更组织角色'
        : self
          ? '申请退出组织'
          : '移出组织';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    setBusy(true);
    try {
      let message: string;
      if (kind === 'edit') {
        const input: OrganizationMemberUpdateInput = {
          orgId,
          memberId: member.memberId,
          versionNo: member.versionNo,
        };
        if (joinedAt && joinedAt !== shanghaiDate(member.joinedAt))
          input.joinedAt = `${joinedAt} 00:00:00`;
        if (employment && employment !== member.employmentType)
          input.employmentType = employment as 'FULL_TIME' | 'PART_TIME';
        if (!input.joinedAt && !input.employmentType) throw new Error('请先修改入组日期或人员属性');
        await api.updateOrganizationMember(input);
        message = '成员资料已保存';
      } else if (kind === 'role') {
        if (
          self ||
          member.position === 'OWNER' ||
          (position !== 'OWNER' && member.position !== 'MEMBER') ||
          (role === 'OWNER' && (position !== 'OWNER' || member.position !== 'ADMIN'))
        )
          throw new Error('当前身份不能执行该岗位变更');
        if (role === member.position) throw new Error('请选择需要变更的组织角色');
        if (role === 'OWNER' && !confirmed) throw new Error('请确认主管转让后果');
        await api.changeOrganizationMemberRole({
          orgId,
          memberId: member.memberId,
          position: role,
        });
        message = role === 'OWNER' ? '主管已转让，正在读取最新组织身份' : '组织角色已更新';
      } else {
        if (!reason.trim()) throw new Error('请填写退出原因');
        const fingerprint = JSON.stringify([member.memberId, reason.trim(), leaveDate]);
        const idempotencyKey = departureKeys.get(fingerprint) ?? crypto.randomUUID();
        departureKeys.set(fingerprint, idempotencyKey);
        const result = await api.requestOrganizationDeparture(
          { orgId, memberId: member.memberId, reason: reason.trim(), plannedLeaveDate: leaveDate },
          idempotencyKey,
        );
        departureKeys.delete(fingerprint);
        message =
          result.flowStatus === 'PENDING'
            ? '退出申请已提交，等待主管审批'
            : `组织退出已安排：${result.joinStatus ? joinStatusLabels[result.joinStatus] : '请刷新查看'}`;
      }
      await onSaved(message);
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <OrganizationDialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={(event) => void submit(event)} className="space-y-[16px]">
        <p className="break-words text-[13px]">
          {displayName(member)}{' '}
          <span className="text-muted-foreground">· {member.phoneMasked}</span>
        </p>
        <fieldset disabled={busy} className="min-w-0 space-y-[16px]">
          {kind === 'edit' && (
            <>
              <FormField
                controlId="org-edit-joined-at"
                label="入组日期（上海）"
                description="留空或日期不变保持原值，不支持清空。不能选择未来日期。"
              >
                <Input
                  size="profile"
                  id="org-edit-joined-at"
                  type="date"
                  max={shanghaiToday()}
                  value={joinedAt}
                  onChange={(event) => setJoinedAt(event.target.value)}
                />
              </FormField>
              <FormField controlId="org-edit-employment" label="人员属性">
                <select
                  id="org-edit-employment"
                  className={orgControlClass}
                  value={employment}
                  onChange={(event) => setEmployment(event.target.value)}
                >
                  <option value="">未设置（保持原值）</option>
                  {Object.entries(employmentLabels).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </FormField>
            </>
          )}
          {kind === 'role' && (
            <>
              <FormField controlId="org-edit-role" label="组织角色" required>
                <select
                  id="org-edit-role"
                  className={orgControlClass}
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value as OrganizationPosition);
                    setConfirmed(false);
                  }}
                >
                  <option value="MEMBER">成员</option>
                  <option value="ADMIN">管理员</option>
                  {position === 'OWNER' && member.position === 'ADMIN' && !self && (
                    <option value="OWNER">主管（转让）</option>
                  )}
                </select>
              </FormField>
              {role === 'OWNER' && (
                <div className="space-y-[12px] rounded-[8px] border border-destructive/30 bg-destructive/5 p-[12px] text-[13px] leading-[22px]">
                  <p>
                    转让后，对方成为组织主管，你将成为管理员。已有待审批事项不会自动转派，转让前请先处理待办。
                  </p>
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-[8px]">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      className="mt-[5px] size-[16px]"
                      required
                    />
                    <span>我确认将主管转让给该成员</span>
                  </label>
                </div>
              )}
              {self && role === 'MEMBER' && (
                <p className="text-[13px] leading-[22px] text-destructive">
                  改为成员后，你将失去组织管理权限。
                </p>
              )}
            </>
          )}
          {kind === 'exit' && (
            <>
              <p className="rounded-[8px] bg-muted p-[12px] text-[13px] leading-[22px]">
                {self
                  ? '本人退出需主管审批；审批通过后按拟离职日期生效。'
                  : '当天移出将立即离组；未来日期先进入待离职，在离职日期 0 点生效，无需审批。'}
                此操作仅处理组织关系，项目与排班的退出尚未联动。
              </p>
              <FormField controlId="org-exit-date" label="拟离职日期（上海）" required>
                <Input
                  size="profile"
                  id="org-exit-date"
                  type="date"
                  required
                  min={shanghaiToday()}
                  value={leaveDate}
                  onChange={(event) => {
                    setLeaveDate(event.target.value);
                  }}
                />
              </FormField>
              <FormField controlId="org-exit-reason" label="退出原因" required>
                <Textarea
                  id="org-exit-reason"
                  required
                  maxLength={1000}
                  rows={4}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </FormField>
            </>
          )}
        </fieldset>
        <ErrorNotice error={error} />
        {error instanceof ApiError && error.status === 409 && (
          <p className="text-[13px] leading-[22px] text-destructive">
            成员或审批状态已变化。请关闭弹窗并刷新人员列表，确认最新状态后再操作。
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-[8px]">
          <Button variant="outline" size="settings" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            size="settings"
            loading={busy}
            variant={kind === 'exit' || role === 'OWNER' ? 'destructive' : 'default'}
          >
            {kind === 'edit'
              ? '保存成员资料'
              : kind === 'role'
                ? role === 'OWNER'
                  ? '确认转让主管'
                  : '确认变更角色'
                : self
                  ? '提交退出申请'
                  : '确认移出组织'}
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}
