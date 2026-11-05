import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  ProjectPersonnelAttendanceMember,
  ProjectPersonnelAttendanceStatus,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { ErrorNotice } from '@/components/ErrorNotice';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { productionPlanToday } from './production-plan-form';

const statusNames: Record<ProjectPersonnelAttendanceStatus, string> = {
  PRESENT: '正常',
  LATE: '迟到',
  EARLY_LEAVE: '早退',
  LATE_EARLY: '迟到且早退',
  LEAVE: '请假',
  ABSENT: '缺勤',
  REST: '休息',
  UNSCHEDULED: '未排班',
  REVIEW_REQUIRED: '待复核',
};
export function PersonnelAttendance({
  user,
  projectId,
  organizations = [],
  role = 'PM',
  organizationId,
}: {
  user: AuthUser;
  projectId: number;
  organizations?: [string, string][];
  role?: 'PM' | 'EXPERT';
  organizationId?: string;
}) {
  const cache = useQueryClient();
  const [month, setMonth] = useState(() => productionPlanToday().slice(0, 7));
  const [keyword, setKeyword] = useState('');
  const [statuses, setStatuses] = useState<ProjectPersonnelAttendanceStatus[]>([]);
  const [organizationIds, setOrganizationIds] = useState<string[]>([]);
  const [filter, setFilter] = useState({
    month,
    keyword: '',
    attendanceStatuses: statuses,
    organizationIds,
    current: 1,
  });
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<ProjectPersonnelAttendanceMember | null>(null);
  function current() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  const query = useQuery({
    queryKey: ['project-personnel-attendance', user.id, role, projectId, organizationId, filter],
    enabled: role === 'PM' || !!organizationId,
    queryFn: async () => {
      if (!current()) throw new Error('当前身份已变化，请重新进入人员管理。');
      if (role === 'EXPERT' && !organizationId) throw new Error('当前卡片没有可读取的组织范围。');
      const result = await api.listProjectPersonnelAttendance({
        projectId,
        ...filter,
        size: 20,
        ...(role === 'EXPERT' ? { organizationIds: [organizationId!] } : {}),
      });
      if (!current()) throw new Error('当前身份已变化，请重新进入人员管理。');
      if (role === 'EXPERT' && result.records.some((row) => row.organizationId !== organizationId))
        throw new Error('考勤返回范围与当前组织不一致，请重新读取。');
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const holidayOrganizationId = query.data?.records.find(
    (member) => member.organizationId,
  )?.organizationId;
  const holidays = useQuery({
    queryKey: ['project-personnel-holidays', user.id, role, holidayOrganizationId, filter.month],
    enabled: query.isSuccess && !!holidayOrganizationId,
    queryFn: () =>
      api.getAttendanceHolidays({ orgId: holidayOrganizationId!, month: filter.month }),
    retry: false,
  });
  const [year, monthNumber] = filter.month.split('-').map(Number);
  const dates = Array.from(
    { length: new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate() },
    (_, index) => `${filter.month}-${String(index + 1).padStart(2, '0')}`,
  );
  return (
    <section aria-label="项目考勤" className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$/.test(month)) {
            setError(new Error('请选择1900年起的有效月份。'));
            return;
          }
          setError(null);
          setFilter({
            month,
            keyword: keyword.trim(),
            attendanceStatuses: statuses,
            organizationIds,
            current: 1,
          });
        }}
      >
        <label className="space-y-2 text-[13px]">
          考勤月份
          <Input
            type="month"
            min="1900-01"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <SearchInput
          id="project-personnel-attendance-keyword"
          label="筛选考勤成员"
          value={keyword}
          maxLength={100}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="姓名、昵称或用户 ID"
          containerClassName="flex-1 basis-[200px]"
        />
        <Button type="submit" size="mobileTouch" loading={query.isFetching}>
          查询考勤
        </Button>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新考勤
        </Button>
      </form>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl border p-3">
        <legend className="px-1 text-xs text-muted-foreground">
          考勤状态（仅筛选明细和汇总，成员总数不变）
        </legend>
        {Object.entries(statusNames).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={statuses.includes(value as ProjectPersonnelAttendanceStatus)}
              onChange={(e) =>
                setStatuses((rows) =>
                  e.target.checked
                    ? [...rows, value as ProjectPersonnelAttendanceStatus]
                    : rows.filter((row) => row !== value),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {role === 'PM' && organizations.length > 0 && (
        <fieldset className="flex flex-wrap gap-4 rounded-xl border p-3">
          <legend className="px-1 text-xs">所属组织（选项来自已加载成员）</legend>
          {organizations.map(([id, name]) => (
            <label key={id} className="flex min-h-11 items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={organizationIds.includes(id)}
                onChange={(e) =>
                  setOrganizationIds((rows) =>
                    e.target.checked ? [...rows, id] : rows.filter((value) => value !== id),
                  )
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
      )}
      <ErrorNotice error={error ?? query.error} />
      {query.isPending && <LoadingState>正在读取项目考勤…</LoadingState>}
      {query.isSuccess && (
        <>
          <ErrorNotice error={holidays.error} />
          <div
            className="overflow-x-auto rounded-xl border"
            role="region"
            aria-label="项目月度考勤矩阵"
            tabIndex={0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-card">人员</TableHead>
                  {dates.map((date) => {
                    const holiday = holidays.data?.days.find(
                      (day) => day.date === date && day.calendarDayType === 'PUBLIC_HOLIDAY',
                    );
                    return (
                      <TableHead
                        key={date}
                        className={holiday ? 'text-destructive' : ''}
                        title={holiday?.holidayName}
                      >
                        {date.slice(-2)}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.records.map((member) => (
                  <TableRow key={member.memberId}>
                    <TableHead className="sticky left-0 bg-card">
                      <span className="whitespace-nowrap">{member.displayName}</span>
                      <span className="block text-xs text-muted-foreground">{member.userId}</span>
                    </TableHead>
                    {dates.map((date) => {
                      const day = member.days.find((day) => day.date === date);
                      return (
                        <TableCell
                          key={date}
                          className="whitespace-nowrap text-center"
                          title={
                            day
                              ? [
                                  day.shiftStartAt,
                                  day.shiftEndAt,
                                  day.firstClockInAt,
                                  day.lastClockOutAt,
                                ]
                                  .filter(Boolean)
                                  .join(' / ')
                              : '无排班记录'
                          }
                        >
                          {day?.finalAttendanceStatus
                            ? statusNames[day.finalAttendanceStatus]
                            : '—'}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div
            role="group"
            aria-label="考勤成员列表"
            tabIndex={0}
            className="grid max-h-[42rem] gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
          >
            {query.data.records.map((member) => (
              <Card asChild key={member.memberId}>
                <article aria-label={`${member.displayName}考勤`} className="space-y-3 p-5">
                  <CardTitle asChild>
                    <h3>{member.displayName}</h3>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {member.organizationName || '个人'} · {member.userId}
                  </p>
                  <dl className="grid grid-cols-3 gap-3 text-[13px]">
                    {(
                      [
                        ['排班行数', member.summary.scheduledCount],
                        ['正常', member.summary.presentCount],
                        ['迟到', member.summary.lateCount],
                        ['早退', member.summary.earlyLeaveCount],
                        ['请假', member.summary.leaveCount],
                        ['缺勤', member.summary.absentCount],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Button variant="outline" size="mobileTouch" onClick={() => setSelected(member)}>
                    查看考勤明细
                  </Button>
                </article>
              </Card>
            ))}
          </div>
          {!query.data.records.length && <EmptyState title="暂无项目考勤成员" />}
          <Pagination
            aria-label="项目考勤分页"
            {...query.data}
            loading={query.isFetching}
            onPageChange={(current) => setFilter({ ...filter, current })}
          />
        </>
      )}
      {selected && query.isSuccess && (
        <Dialog
          title={`${selected.displayName} · 考勤明细`}
          aria-label="考勤明细"
          size="lg"
          onClose={() => setSelected(null)}
        >
          <p className="text-[13px] text-muted-foreground">
            {filter.month} · 仅展示真实排班；缺少考勤结果不视为缺勤。时间沿用排班所在地。
          </p>
          {selected.days.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {['日期', '排班', '班次', '考勤结果', '首次上班打卡', '末次下班打卡'].map(
                      (label) => (
                        <TableHead key={label} className="whitespace-nowrap">
                          {label}
                        </TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.days.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell className="whitespace-nowrap">{day.date}</TableCell>
                      <TableCell>{day.scheduleStatus === 'ACTIVE' ? '有效' : '已取消'}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {day.shiftStartAt || '—'}
                        <br />
                        {day.shiftEndAt || '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {day.finalAttendanceStatus
                          ? statusNames[day.finalAttendanceStatus]
                          : '暂无结果'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {day.firstClockInAt || '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {day.lastClockOutAt || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="本月暂无符合条件的排班明细" />
          )}
        </Dialog>
      )}
    </section>
  );
}
