import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, RotateCw } from 'lucide-react';
import type {
  AuthUser,
  OrganizationScheduleDay,
  OrganizationScheduleMember,
  OrganizationScheduleResult,
  OrganizationSchedulesInput,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/shared/FormField';
import { api } from '@/services/api';
import {
  employmentLabels,
  joinStatusLabels,
  OrganizationPagination,
  orgControlClass,
  positionLabels,
  shanghaiToday,
} from './common';
import { OrganizationScheduleDialog } from './OrganizationScheduleDialog';

const emptyFilters = {
  keyword: '',
  joinStatus: '',
  employmentType: '',
  position: '',
  projectId: '',
};
const statusLabels = {
  PRESENT: '正常',
  LATE: '迟到',
  EARLY_LEAVE: '早退',
  LATE_EARLY: '迟到早退',
  LEAVE: '请假',
  ABSENT: '缺勤',
  REST: '休息',
  UNSCHEDULED: '未排班',
  REVIEW_REQUIRED: '待复核',
  PENDING_ATTENDANCE: '待出勤',
};
const memberName = (member: OrganizationScheduleMember) =>
  member.realName || member.nickname || member.userId;
type ScheduleAction = { members: OrganizationScheduleMember[]; day?: OrganizationScheduleDay };

export function OrganizationSchedules(props: { user: AuthUser; orgId: string }) {
  return <OrganizationSchedulesPanel key={`${props.user.id}:${props.orgId}`} {...props} />;
}

function OrganizationSchedulesPanel({ user, orgId }: { user: AuthUser; orgId: string }) {
  const cache = useQueryClient();
  const keys = useRef(new Map<string, string>());
  const [query, setQuery] = useState<OrganizationSchedulesInput>({
    orgId,
    month: shanghaiToday().slice(0, 7),
    current: 1,
    size: 20,
  });
  const [filters, setFilters] = useState(emptyFilters);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<ScheduleAction>();
  const [error, setError] = useState<Error>();
  const [savedResult, setSavedResult] = useState<OrganizationScheduleResult>();
  const [notice, setNotice] = useState('');
  const schedules = useQuery({
    queryKey: ['organization', user.id, orgId, 'schedules', query],
    queryFn: () => api.listOrganizationSchedules(query),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const members = schedules.data?.members ?? [];
  // 选择始终以当前响应的真实权限为准，不跨页累积成员。
  const selectable = members.filter((member) => member.canSchedule);
  const chosen = selectable.filter((member) => selected.includes(member.memberId));
  const dayCount = new Date(`${query.month}-01T00:00:00Z`);
  dayCount.setUTCMonth(dayCount.getUTCMonth() + 1, 0);
  const dates = Array.from(
    { length: dayCount.getUTCDate() },
    (_, i) => `${query.month}-${String(i + 1).padStart(2, '0')}`,
  );

  function changeQuery(next: OrganizationSchedulesInput) {
    setSelected([]);
    setError(undefined);
    setQuery(next);
  }
  function search(event: FormEvent) {
    event.preventDefault();
    const projectId = filters.projectId.trim() ? Number(filters.projectId) : undefined;
    if (
      projectId !== undefined &&
      (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
    ) {
      setError(new Error('项目 ID 必须是 1 至 2147483647 的整数'));
      return;
    }
    changeQuery({
      orgId,
      month: query.month,
      current: 1,
      size: query.size,
      ...(filters.keyword.trim() ? { keyword: filters.keyword.trim() } : {}),
      ...(filters.joinStatus
        ? { joinStatus: filters.joinStatus as OrganizationSchedulesInput['joinStatus'] }
        : {}),
      ...(filters.employmentType
        ? { employmentType: filters.employmentType as OrganizationSchedulesInput['employmentType'] }
        : {}),
      ...(filters.position
        ? { position: filters.position as OrganizationSchedulesInput['position'] }
        : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    });
  }
  async function reload() {
    const response = await schedules.refetch();
    if (response.isError) throw response.error;
  }
  async function saved(result: OrganizationScheduleResult) {
    setAction(undefined);
    setSelected([]);
    setSavedResult(result);
    setNotice('');
    const results = await Promise.allSettled([
      cache.invalidateQueries(
        { queryKey: ['organization', user.id, orgId, 'schedules'] },
        { throwOnError: true },
      ),
      cache.invalidateQueries({ queryKey: ['profile-workbench', user.id] }, { throwOnError: true }),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      setNotice('排班已保存，但读取最新数据失败，请点击刷新排班重新读取。');
  }

  return (
    <section
      className="min-w-0 overflow-hidden rounded-[10px] border bg-card text-[13px]"
      aria-labelledby="organization-schedules-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-[12px] px-[20px] pt-[20px] pb-[16px] max-[640px]:px-[16px]">
        <div>
          <h2 id="organization-schedules-title" className="m-0 text-[15px] font-semibold">
            组织排班
          </h2>
          <p className="mt-[6px] text-[12px] text-[var(--color-neutral-strong)]">
            按成员查看月排班，选择成员批量排班，或点击某日编辑。
          </p>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Button
            variant="ghost"
            size="formCompactMobileTouch"
            loading={schedules.isFetching}
            onClick={() => void schedules.refetch()}
          >
            {!schedules.isFetching && <RotateCw className="size-[14px]" aria-hidden />}刷新排班
          </Button>
          <Button
            size="settings"
            disabled={!chosen.length || schedules.isFetching || schedules.isError}
            onClick={() => setAction({ members: chosen })}
          >
            <CalendarDays className="size-[15px]" aria-hidden />
            批量排班{chosen.length ? `（${chosen.length} 人）` : ''}
          </Button>
        </div>
      </div>
      <form
        onSubmit={search}
        className="grid grid-cols-2 items-end gap-[12px] px-[20px] pb-[16px] max-[640px]:px-[16px] min-[900px]:grid-cols-4"
      >
        <FormField controlId="org-schedule-month" label="排班月份">
          <Input
            id="org-schedule-month"
            type="month"
            min="1900-01"
            max="9999-12"
            size="profile"
            value={query.month}
            onChange={(event) => {
              const month = event.target.value;
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1900)
                changeQuery({ ...query, month, current: 1 });
            }}
          />
        </FormField>
        <FormField controlId="org-schedule-keyword" label="姓名 / UID / 完整手机号">
          <Input
            id="org-schedule-keyword"
            size="profile"
            value={filters.keyword}
            maxLength={100}
            onChange={(event) => setFilters({ ...filters, keyword: event.target.value })}
          />
        </FormField>
        {(
          [
            ['joinStatus', '排班成员状态', '尚未离组成员', joinStatusLabels],
            ['position', '排班组织角色', '全部角色', positionLabels],
            ['employmentType', '排班人员属性', '全部属性', employmentLabels],
          ] as const
        ).map(([field, label, placeholder, options]) => (
          <FormField key={field} controlId={`org-schedule-${field}`} label={label}>
            <select
              id={`org-schedule-${field}`}
              className={orgControlClass}
              value={filters[field]}
              onChange={(event) => setFilters({ ...filters, [field]: event.target.value })}
            >
              <option value="">{placeholder}</option>
              {Object.entries(options).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        ))}
        <FormField controlId="org-schedule-project" label="排班项目 ID">
          <Input
            id="org-schedule-project"
            size="profile"
            inputMode="numeric"
            value={filters.projectId}
            onChange={(event) => setFilters({ ...filters, projectId: event.target.value })}
          />
        </FormField>
        <div className="flex gap-[8px]">
          <Button type="submit" size="settings">
            查询排班
          </Button>
          <Button
            variant="outline"
            size="settings"
            onClick={() => {
              setFilters(emptyFilters);
              changeQuery({ orgId, month: query.month, current: 1, size: query.size });
            }}
          >
            重置
          </Button>
        </div>
      </form>
      <div className="space-y-[12px] px-[20px] pb-[16px] max-[640px]:px-[16px]">
        <ErrorNotice error={error} />
        {savedResult && (
          <Alert>
            排班已保存：新增 {savedResult.createdCount} 条，覆盖 {savedResult.updatedCount}{' '}
            条，跳过已有排班 {savedResult.skippedCount} 条。批次：{savedResult.batchNo}
            {savedResult.conflicts.length > 0 && (
              <span className="block">
                已跳过：
                {savedResult.conflicts
                  .map(
                    (item) =>
                      `${members.find((member) => member.memberId === item.memberId) ? memberName(members.find((member) => member.memberId === item.memberId)!) : item.memberId} ${item.scheduleDate}`,
                  )
                  .join('、')}
              </span>
            )}
          </Alert>
        )}
        {notice && <Alert>{notice}</Alert>}
        <ErrorNotice error={schedules.error} />
        {schedules.isPending && <p role="status">正在读取组织排班…</p>}
        {schedules.data && (
          <p className="text-[12px] text-[var(--color-neutral-strong)]">
            已选当前页 {chosen.length} 人 ·
            班次按各自时区显示；待激活、已离组等不可排班成员仅供查看。
          </p>
        )}
      </div>
      {schedules.data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <caption className="sr-only">{query.month} 组织成员月排班</caption>
              <thead className="bg-muted/50 text-[var(--color-neutral-strong)]">
                <tr>
                  <th className="sticky left-0 z-[1] min-w-[180px] bg-card px-[16px] py-[12px] font-medium">
                    <label className="flex min-h-[44px] items-center gap-[8px]">
                      <input
                        type="checkbox"
                        aria-label="选择本页可排班成员"
                        disabled={!selectable.length || schedules.isFetching || schedules.isError}
                        checked={selectable.length > 0 && chosen.length === selectable.length}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked ? selectable.map((member) => member.memberId) : [],
                          )
                        }
                      />
                      成员
                    </label>
                  </th>
                  {dates.map((date) => (
                    <th
                      key={date}
                      className="min-w-[74px] px-[4px] py-[12px] text-center font-medium"
                    >
                      <time dateTime={date}>{Number(date.slice(-2))} 日</time>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.memberId} className="border-t">
                    <th className="sticky left-0 z-[1] bg-card px-[16px] py-[12px] font-normal">
                      <label className="flex min-h-[44px] items-center gap-[8px]">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${memberName(member)}`}
                          disabled={
                            !member.canSchedule || schedules.isFetching || schedules.isError
                          }
                          checked={member.canSchedule && selected.includes(member.memberId)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, member.memberId]
                                : selected.filter((id) => id !== member.memberId),
                            )
                          }
                        />
                        <span className="min-w-0">
                          <span className="block font-medium break-all">{memberName(member)}</span>
                          <span className="mt-[4px] block text-[11px] text-muted-foreground">
                            {joinStatusLabels[member.joinStatus]} · 正常{' '}
                            {member.summary.presentCount} 天
                          </span>
                        </span>
                      </label>
                    </th>
                    {dates.map((date) => {
                      const day = member.days.find((item) => item.scheduleDate === date);
                      return (
                        <td key={date} className="px-[3px] py-[8px] text-center">
                          {day ? (
                            <button
                              type="button"
                              className="min-h-[52px] w-full rounded-[6px] px-[4px] py-[6px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
                              disabled={
                                !member.canSchedule || schedules.isFetching || schedules.isError
                              }
                              aria-label={`编辑 ${memberName(member)} ${date} 排班`}
                              title={`${day.dayType === 'WORK' ? `${day.shiftStartAt?.slice(11, 16)}–${day.shiftEndAt?.slice(11, 16)} ${day.timezone}` : day.dayType === 'REST' ? '休息' : '未排班'} · ${statusLabels[day.calendarStatus]}`}
                              onClick={() => setAction({ members: [member], day })}
                            >
                              <span className="block font-medium">
                                {day.dayType === 'WORK'
                                  ? `${day.shiftStartAt?.slice(11, 16) || '工作'}`
                                  : day.dayType === 'REST'
                                    ? '休息'
                                    : '—'}
                              </span>
                              <span className="mt-[3px] block text-[11px] text-muted-foreground">
                                {statusLabels[day.calendarStatus]}
                              </span>
                            </button>
                          ) : (
                            <span className="text-muted-foreground">未加载</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!members.length && (
                  <tr>
                    <td
                      colSpan={dates.length + 1}
                      className="px-[20px] py-[40px] text-muted-foreground"
                    >
                      当前筛选下没有成员。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-[20px] py-[16px] max-[640px]:px-[16px]">
            <OrganizationPagination
              current={schedules.data.current}
              size={schedules.data.size}
              total={schedules.data.total}
              loading={schedules.isFetching}
              onPageChange={(current) => changeQuery({ ...query, current })}
            />
          </div>
        </>
      )}
      {action && (
        <OrganizationScheduleDialog
          orgId={orgId}
          month={query.month}
          members={action.members}
          day={action.day}
          keys={keys.current}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          onReload={reload}
        />
      )}
    </section>
  );
}
