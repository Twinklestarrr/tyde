import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ApiError, type AuthUser, type WorkbenchAttendanceCalendarStatus } from '@tyde/shared';
import { Button } from '@/components/ui/button';
import { SESSION_KEY } from '@/hooks/useSession';
import { shanghaiToday } from '@/modules/organizations/common';
import { api } from '@/services/api';

const states: Record<WorkbenchAttendanceCalendarStatus, { label: string; color: string }> = {
  PRESENT: { label: '正常出勤', color: 'bg-[var(--color-success)]' },
  LATE: { label: '迟到', color: 'bg-[var(--color-warning)]' },
  EARLY_LEAVE: { label: '早退', color: 'bg-[var(--color-warning)]' },
  LATE_EARLY: { label: '迟到且早退', color: 'bg-[var(--color-warning)]' },
  LEAVE: { label: '请假', color: 'bg-[var(--color-warning)]' },
  ABSENT: { label: '缺勤', color: 'bg-[var(--color-danger)]' },
  REVIEW_REQUIRED: { label: '需人工复核', color: 'bg-[var(--color-danger)]' },
  REST: { label: '休息', color: 'bg-muted' },
  UNSCHEDULED: { label: '未排班', color: 'bg-muted' },
  PENDING_ATTENDANCE: { label: '待出勤', color: 'bg-muted' },
};
const dayMs = 86_400_000;

export function ProfileActivity({
  user,
  onManage,
}: {
  user: AuthUser;
  onManage: (month: string) => void;
}) {
  const today = shanghaiToday();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const cache = useQueryClient();
  const organization = user.organization;
  const orgId = typeof organization?.id === 'string' ? organization.id : undefined;
  const canRead =
    !organization ||
    (!!orgId &&
      ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(organization.joinStatus)));
  const monthCount = year === currentYear ? Number(today.slice(5, 7)) : 12;
  const months = Array.from(
    { length: monthCount },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
  );
  const queries = useQueries({
    queries: months.map((month) => {
      const input = { month, ...(orgId ? { orgId } : {}) };
      return {
        queryKey: [
          'profile-workbench',
          user.id,
          organization?.id,
          organization?.position,
          organization?.joinStatus,
          'attendance',
          input,
        ],
        enabled: canRead,
        queryFn: async () => {
          try {
            return await api.getMyAttendance(input);
          } catch (error) {
            if (error instanceof ApiError && error.status === 401)
              await cache.invalidateQueries({ queryKey: SESSION_KEY });
            throw error;
          }
        },
      };
    }),
  });
  const loaded = queries.filter((query) => query.isSuccess);
  const failed = queries.filter((query) => query.isError);
  const present = loaded.reduce((total, query) => total + query.data!.summary.presentCount, 0);
  const days = new Map(
    loaded.flatMap((query) => query.data!.days.map((day) => [day.scheduleDate, day] as const)),
  );
  const firstDay = Date.UTC(year, 0, 1);
  const offset = (new Date(firstDay).getUTCDay() + 6) % 7;
  const start = firstDay - offset * dayMs;
  const weeks = Math.ceil((Date.UTC(year + 1, 0, 1) - start) / dayMs / 7);
  const gridStyle = { gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` };

  return (
    <section aria-label="年度考勤" className="min-w-0 rounded-[8px] border bg-card p-[16px]">
      <div className="mb-[16px] flex flex-wrap items-center justify-between gap-[12px]">
        <div>
          <h3 className="text-[14px] leading-[22px] font-semibold">考勤记录</h3>
          <p className="mt-[4px] text-[12px] leading-[20px] text-muted-foreground">
            {loaded.length ? `${present} 天正常出勤` : '暂无已加载考勤'}
            {canRead && ` · 已加载 ${loaded.length}/${monthCount} 个月`}
          </p>
        </div>
        <label className="flex items-center gap-[8px] text-[12px]">
          年份
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="h-[36px] rounded-[6px] border bg-card px-[10px] text-[12px] focus-visible:outline-2 focus-visible:outline-ring"
          >
            {[currentYear, currentYear - 1, currentYear - 2].map((value) => (
              <option key={value} value={value}>
                {value} 年
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-w-0 overflow-x-auto pb-[6px]">
        <div className="min-w-[600px]">
          <div
            className="mb-[6px] ml-[34px] grid gap-[3px] text-[12px] text-muted-foreground"
            style={gridStyle}
            aria-hidden
          >
            {Array.from({ length: 12 }, (_, month) => (
              <span
                key={month}
                className="whitespace-nowrap"
                style={{
                  gridColumn: Math.floor((Date.UTC(year, month, 1) - start) / dayMs / 7) + 1,
                }}
              >
                {month + 1} 月
              </span>
            ))}
          </div>
          <div className="flex gap-[8px]">
            <div
              className="grid w-[26px] shrink-0 grid-rows-7 gap-[3px] text-[12px] leading-none text-muted-foreground"
              aria-hidden
            >
              {['一', '', '三', '', '五', '', ''].map((day, index) => (
                <span key={index} className="flex items-center">
                  {day && `周${day}`}
                </span>
              ))}
            </div>
            <div
              className="grid min-w-0 flex-1 grid-flow-col grid-rows-7 gap-[3px]"
              style={gridStyle}
            >
              {Array.from({ length: weeks * 7 }, (_, index) => {
                const date = new Date(start + index * dayMs).toISOString().slice(0, 10);
                if (!date.startsWith(String(year))) return <span key={date} />;
                const monthIndex = Number(date.slice(5, 7)) - 1;
                const query = queries[monthIndex];
                const day = days.get(date);
                const future = date > today && (!day || day.calendarStatus === 'UNSCHEDULED');
                const state = day ? states[day.calendarStatus] : undefined;
                const label = future
                  ? '未来日期'
                  : !canRead
                    ? '暂不能读取'
                    : query?.isError
                      ? '未加载'
                      : query?.isPending
                        ? '读取中'
                        : (state?.label ?? '暂无考勤记录');
                return (
                  <button
                    key={date}
                    type="button"
                    title={`${date} · ${label}`}
                    aria-label={`${date} · ${label}，管理本月考勤`}
                    onClick={() => onManage(date.slice(0, 7))}
                    className={`aspect-square min-w-0 rounded-[2px] border border-border/30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${future || !canRead || !query?.isSuccess ? 'bg-muted/50' : (state?.color ?? 'bg-muted/50')}`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-[12px] flex flex-wrap items-center justify-between gap-[12px] text-[12px] leading-[20px] text-muted-foreground">
        <ul aria-label="考勤图例" className="flex flex-wrap gap-x-[12px] gap-y-[4px]">
          {[
            ['正常出勤', 'bg-[var(--color-success)]'],
            ['迟到 / 早退 / 请假', 'bg-[var(--color-warning)]'],
            ['缺勤 / 待复核', 'bg-[var(--color-danger)]'],
            ['无出勤结果', 'bg-muted'],
          ].map(([label, color]) => (
            <li key={label} className="inline-flex items-center gap-[5px]">
              <span
                aria-hidden
                className={`size-[10px] rounded-[2px] border border-border/30 ${color}`}
              />
              {label}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="settings" onClick={() => onManage(months.at(-1)!)}>
          管理排班与考勤
        </Button>
      </div>
      {!canRead && (
        <p className="mt-[8px] text-[12px] text-muted-foreground">当前组织关系暂不能读取考勤。</p>
      )}
      {canRead && queries.some((query) => query.isFetching) && (
        <p role="status" className="mt-[8px] text-[12px] text-muted-foreground">
          正在读取真实考勤记录…
        </p>
      )}
      {failed.length > 0 && (
        <div className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[12px] text-muted-foreground">
          <p role="alert">{failed.length} 个月未加载，空白色块不代表正常出勤。</p>
          <Button
            variant="outline"
            size="settings"
            onClick={() => void Promise.allSettled(failed.map((query) => query.refetch()))}
          >
            重试未加载月份
          </Button>
        </div>
      )}
    </section>
  );
}
