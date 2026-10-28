import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError, type AuthUser, type WorkbenchAttendanceCalendarStatus } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SESSION_KEY } from '@/hooks/useSession';
import { shanghaiToday } from '@/modules/organizations/common';
import { api } from '@/services/api';
import { AttendanceDayDialog, PersonalScheduleDialog } from './ProfileAttendanceDialogs';

const panelClass = 'min-w-0 space-y-[20px] rounded-[8px] border bg-card p-[16px] sm:p-[24px]';
const quietClass = 'text-[13px] leading-[22px] text-[var(--color-neutral-strong)]';
const flowLabels = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
  CANCELED: '已取消',
};
const profileScope = (user: AuthUser) => [
  'profile-workbench',
  user.id,
  user.organization?.id,
  user.organization?.position,
  user.organization?.joinStatus,
];
const attendanceMeta: Record<
  WorkbenchAttendanceCalendarStatus,
  { label: string; short: string; color: string }
> = {
  PRESENT: {
    label: '正常出勤',
    short: '勤',
    color: 'bg-accent text-[var(--color-primary-strong)]',
  },
  LATE: {
    label: '迟到',
    short: '迟',
    color: 'bg-[var(--color-warning-soft)] text-[var(--color-warning-hover)]',
  },
  EARLY_LEAVE: {
    label: '早退',
    short: '早',
    color: 'bg-[var(--color-warning-soft)] text-[var(--color-warning-hover)]',
  },
  LATE_EARLY: {
    label: '迟到且早退',
    short: '迟早',
    color: 'bg-[var(--color-warning-soft)] text-[var(--color-warning-hover)]',
  },
  LEAVE: { label: '请假', short: '假', color: 'bg-accent text-[var(--color-primary-strong)]' },
  ABSENT: {
    label: '缺勤',
    short: '缺',
    color: 'bg-[var(--color-danger-soft)] text-[var(--color-danger-strong)]',
  },
  REST: { label: '休息', short: '休', color: 'bg-muted text-muted-foreground' },
  UNSCHEDULED: { label: '未排班', short: '—', color: 'bg-card text-muted-foreground' },
  REVIEW_REQUIRED: {
    label: '需人工复核',
    short: '复',
    color: 'bg-[var(--color-danger-soft)] text-[var(--color-danger-strong)]',
  },
  PENDING_ATTENDANCE: {
    label: '待出勤',
    short: '待',
    color: 'bg-accent text-[var(--color-primary-strong)]',
  },
};

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

export function ProfileAttendance({
  user,
  initialMonth,
}: {
  user: AuthUser;
  initialMonth?: string;
}) {
  const cache = useQueryClient();
  const [month, setMonth] = useState(() => initialMonth ?? shanghaiToday().slice(0, 7));
  const [queryMonth, setQueryMonth] = useState(month);
  const [monthError, setMonthError] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const organization = user.organization;
  const orgId = typeof organization?.id === 'string' ? organization.id : undefined;
  const canManageOrganization =
    !!orgId &&
    ['OWNER', 'ADMIN'].includes(String(organization?.position)) &&
    ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(organization?.joinStatus));
  const canRead =
    !organization ||
    (!!orgId &&
      ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(organization.joinStatus)));
  const input = { month: queryMonth, ...(orgId ? { orgId } : {}) };
  const attendance = useQuery({
    queryKey: [...profileScope(user), 'attendance', input],
    queryFn: () => readProfile(api.getMyAttendance(input), cache),
    enabled: canRead,
  });
  const holidays = useQuery({
    queryKey: [...profileScope(user), 'holidays', queryMonth],
    queryFn: () => readProfile(api.getAttendanceHolidays({ month: queryMonth }), cache),
  });
  const selectedDay = attendance.data?.days.find((day) => day.scheduleDate === selectedDate);
  async function written(message: string) {
    setNotice(message);
    await cache.invalidateQueries({ queryKey: ['profile-workbench', user.id] });
  }
  const firstWeekday = (new Date(`${queryMonth}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) {
      setMonthError('请选择 1900 年起的有效月份');
      return;
    }
    setMonthError('');
    setSelectedDate(null);
    if (queryMonth === month) {
      if (canRead) void attendance.refetch();
      void holidays.refetch();
    } else setQueryMonth(month);
  }
  return (
    <section aria-label="我的排班考勤" className={panelClass}>
      <div>
        <h3 className="text-[17px] leading-[26px] font-semibold">我的排班考勤</h3>
        <p className={`mt-[6px] ${quietClass}`}>
          查看本人排班、打卡与考勤汇总，点击日期查看详情和可用操作。
        </p>
      </div>
      <form onSubmit={submit} className="flex min-w-0 flex-wrap items-end gap-[8px]">
        <label className="min-w-0 flex-1 basis-[160px] text-[12px] leading-[20px]">
          考勤月份
          <Input
            size="profile"
            type="month"
            min="1900-01"
            max="9999-12"
            value={month}
            className="mt-[6px]"
            aria-invalid={!!monthError}
            aria-describedby={monthError ? 'profile-month-error' : undefined}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          size="settings"
          loading={attendance.isFetching || holidays.isFetching}
        >
          查询考勤
        </Button>
      </form>
      {attendance.isSuccess && (
        <div className="flex flex-wrap items-center justify-between gap-[12px] rounded-[8px] bg-muted p-[14px]">
          <div className="min-w-0 space-y-[4px]">
            <p className="text-[14px] font-medium">
              {attendance.data.independentSchedule ? '个人排班' : '组织排班'}
            </p>
            <p className={quietClass}>
              {attendance.data.permissions.canBatchSchedule
                ? '可为自己设置工作日、休息日和班次。'
                : attendance.data.independentSchedule
                  ? '当前账号暂不可编辑排班。'
                  : canManageOrganization
                    ? '可前往组织管理的排班管理，为自己和组织成员安排班次。'
                    : '组织班次由主管或管理员统一安排；你可以在这里查看本人排班与考勤。'}
            </p>
          </div>
          {attendance.data.permissions.canBatchSchedule && (
            <Button variant="outline" size="settings" onClick={() => setScheduleOpen(true)}>
              为自己排班
            </Button>
          )}
          {!attendance.data.independentSchedule && canManageOrganization && (
            <Button asChild variant="outline" size="settings">
              <Link to="/organization" search={{ tab: 'schedules' }}>
                管理组织排班
              </Link>
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className={quietClass}>
          {notice}
        </p>
      )}
      {monthError && (
        <p id="profile-month-error" role="alert" className="text-[13px] text-[var(--color-danger)]">
          {monthError}
        </p>
      )}
      {!canRead && (
        <p className={quietClass}>当前组织关系暂不能读取考勤，请在我的组织中核对入组状态。</p>
      )}
      {canRead && attendance.isPending && (
        <p role="status" className={quietClass}>
          正在读取本人考勤…
        </p>
      )}
      {attendance.isError && (
        <div className="space-y-[8px]">
          <ErrorNotice error={attendance.error} />
          <Button variant="outline" size="settings" onClick={() => void attendance.refetch()}>
            重新读取考勤
          </Button>
        </div>
      )}
      {attendance.isSuccess && (
        <>
          <dl
            aria-label="月度考勤汇总"
            className="grid grid-cols-2 gap-[12px] text-[13px] sm:grid-cols-5"
          >
            {[
              ['正常出勤', attendance.data.summary.presentCount],
              ['迟到', attendance.data.summary.lateCount],
              ['早退', attendance.data.summary.earlyLeaveCount],
              ['请假', attendance.data.summary.leaveCount],
              ['缺勤', attendance.data.summary.absentCount],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[8px] bg-muted p-[12px]">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-[4px] text-[18px] font-semibold">
                  {value}
                  <span className="ml-[4px] text-[12px] font-normal">天</span>
                </dd>
              </div>
            ))}
          </dl>
          {attendance.data.days.every((day) => day.calendarStatus === 'UNSCHEDULED') && (
            <p className={quietClass}>本月暂无排班记录</p>
          )}
          <div aria-label={`${queryMonth} 本人考勤月历`}>
            <div
              className="mb-[6px] grid grid-cols-7 gap-[4px] text-center text-[12px] text-muted-foreground"
              aria-hidden
            >
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <ul className="grid grid-cols-7 gap-[4px]">
              {Array.from({ length: firstWeekday }, (_, index) => (
                <li key={`empty-${index}`} aria-hidden />
              ))}
              {attendance.data.days.map((day) => {
                const meta = attendanceMeta[day.calendarStatus];
                return (
                  <li key={day.scheduleDate} aria-label={`${day.scheduleDate} ${meta.label}`}>
                    <button
                      type="button"
                      aria-label={`${day.scheduleDate} ${meta.label}`}
                      onClick={() => setSelectedDate(day.scheduleDate)}
                      className={`flex min-h-[64px] w-full min-w-0 flex-col items-center justify-center gap-[5px] rounded-[6px] border px-[2px] py-[8px] text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${meta.color}`}
                    >
                      <time dateTime={day.scheduleDate}>{Number(day.scheduleDate.slice(-2))}</time>
                      <span aria-hidden>{meta.short}</span>
                      <span className="sr-only">{meta.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <ul
            aria-label="考勤状态图例"
            className="flex flex-wrap gap-x-[14px] gap-y-[8px] text-[12px] leading-[20px] text-muted-foreground"
          >
            {[...new Set(attendance.data.days.map((day) => day.calendarStatus))].map((status) => (
              <li key={status}>
                {attendanceMeta[status].short} · {attendanceMeta[status].label}
              </li>
            ))}
          </ul>
          <details className="rounded-[8px] border p-[12px]">
            <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-medium">
              查看每日班次与打卡明细
            </summary>
            <ul className="mt-[8px] divide-y text-[12px] leading-[20px]">
              {attendance.data.days.map((day) => (
                <li
                  key={day.scheduleDate}
                  className="space-y-[4px] py-[12px] [overflow-wrap:anywhere]"
                >
                  <p className="font-medium">
                    {day.scheduleDate} · {attendanceMeta[day.calendarStatus].label}
                  </p>
                  <p className="text-muted-foreground">
                    班次：
                    {day.shiftStartAt && day.shiftEndAt
                      ? `${day.shiftStartAt.slice(11)} — ${day.shiftEndAt.slice(11)}（${day.timezone}）`
                      : '无有效工作班次'}
                  </p>
                  <p className="text-muted-foreground">
                    上班打卡：{day.firstClockInAt || '无记录'}；下班打卡：
                    {day.lastClockOutAt || '无记录'}
                  </p>
                  {day.reviewReason && <p>复核说明：{day.reviewReason}</p>}
                  {day.application && (
                    <p>
                      考勤申请：{day.application.applicationType === 'LEAVE' ? '请假' : '考勤修正'}{' '}
                      · {flowLabels[day.application.status]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <section aria-label="节假日安排" className="space-y-[10px] border-t pt-[16px]">
        <h4 className="text-[14px] font-semibold">节假日安排</h4>
        {holidays.isPending && (
          <p role="status" className={quietClass}>
            正在读取节假日日历…
          </p>
        )}
        {holidays.isError && (
          <div className="space-y-[8px]">
            <ErrorNotice error={holidays.error} />
            <Button variant="outline" size="settings" onClick={() => void holidays.refetch()}>
              重新读取节假日
            </Button>
          </div>
        )}
        {holidays.isSuccess &&
          (holidays.data.days.length ? (
            <ul className="space-y-[8px] text-[12px] leading-[20px]">
              {holidays.data.days.map((day) => (
                <li key={day.date} className="break-words">
                  {day.date} · {day.holidayName} ·{' '}
                  {day.calendarDayType === 'PUBLIC_HOLIDAY' ? '法定放假日' : '调休工作日'}
                </li>
              ))}
            </ul>
          ) : (
            <p className={quietClass}>本月没有已公布的特殊放假或调休安排。</p>
          ))}
        <p className={quietClass}>
          节假日安排与实际排班分别展示，不据此推算出勤。迟到且早退会同时计入两项汇总。
        </p>
      </section>
      {scheduleOpen && attendance.data?.permissions.canBatchSchedule && (
        <PersonalScheduleDialog
          month={queryMonth}
          onClose={() => setScheduleOpen(false)}
          onWritten={written}
        />
      )}
      {selectedDay && (
        <AttendanceDayDialog
          key={selectedDay.scheduleDate}
          day={selectedDay}
          orgId={attendance.data?.organizationId ?? null}
          memberId={attendance.data?.memberId ?? null}
          statusLabel={attendanceMeta[selectedDay.calendarStatus].label}
          onClose={() => setSelectedDate(null)}
          onReload={async () => {
            const result = await attendance.refetch();
            if (result.isError) throw result.error;
          }}
          onWritten={written}
        />
      )}
    </section>
  );
}
