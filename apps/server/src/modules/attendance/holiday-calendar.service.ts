import type { fetch as nodeFetch } from 'undici-types';
import { AppError } from '../../common/errors.js';
import { monthDates } from './attendance.domain.js';
import { bundledHolidayCalendars, type Holiday } from './holiday-calendar.data.js';
export class HolidayCalendarService {
  private readonly cache = new Map<number, { days: Holiday[]; loadedAt: number }>();
  private readonly loading = new Map<number, Promise<Holiday[]>>();
  constructor(
    private readonly source = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/%d.json',
    // 部署构建可能注入不完整的 Web 全局类型；固定使用 Node 原生 fetch 的完整类型。
    private readonly fetcher: typeof nodeFetch = fetch as typeof nodeFetch,
    private readonly bundled: Readonly<
      Record<number, readonly Holiday[]>
    > = bundledHolidayCalendars,
  ) {}
  async month(month: string) {
    monthDates(month);
    const days = await this.year(Number(month.slice(0, 4)));
    const weekNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    return {
      month,
      days: days
        .filter((day) => day.date.startsWith(`${month}-`))
        .map((day) => {
          const dayOfWeek = new Date(`${day.date}T00:00:00Z`).getUTCDay() || 7;
          return {
            date: day.date,
            dayOfWeek,
            weekName: weekNames[dayOfWeek]!,
            calendarDayType: day.isOffDay ? 'PUBLIC_HOLIDAY' : 'MAKEUP_WORKDAY',
            holidayName: day.name,
            defaultScheduleDayType: day.isOffDay ? 'REST' : 'WORK',
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
  private async year(year: number): Promise<Holiday[]> {
    const cached = this.cache.get(year);
    if (cached && Date.now() - cached.loadedAt < 86400000) return cached.days;
    const loading = this.loading.get(year);
    if (loading) return loading;
    const promise = (async () => {
      try {
        const response = await this.fetcher(this.source.replace('%d', String(year)), {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('unavailable');
        const raw = await response.text();
        if (raw.length > 1024 * 1024) throw new Error('too large');
        const data = JSON.parse(raw) as { year?: unknown; days?: unknown };
        if (
          Number(data.year) !== year ||
          !Array.isArray(data.days) ||
          !data.days.length ||
          data.days.length > 366
        )
          throw new Error('invalid calendar');
        const seen = new Set<string>();
        const days = data.days.map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') throw new Error('invalid day');
          const day = entry as Holiday;
          if (
            typeof day.date !== 'string' ||
            !day.date.startsWith(`${year}-`) ||
            typeof day.name !== 'string' ||
            !day.name.trim() ||
            typeof day.isOffDay !== 'boolean' ||
            seen.has(day.date)
          )
            throw new Error('invalid day');
          const valid = monthDates(day.date.slice(0, 7)).dates.includes(day.date);
          if (!valid) throw new Error('invalid date');
          seen.add(day.date);
          return { date: day.date, name: day.name, isOffDay: day.isOffDay };
        });
        // 年份缓存有界；过期仍可用的已校验数据只在远程失败时回退。
        if (this.cache.size >= 16 && !this.cache.has(year))
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(year, { days, loadedAt: Date.now() });
        return days;
      } catch {
        if (cached) return cached.days;
        const baseline = this.bundled[year];
        if (baseline) {
          const days = baseline.map((day) => ({ ...day }));
          if (this.cache.size >= 16 && !this.cache.has(year))
            this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(year, { days, loadedAt: Date.now() });
          return days;
        }
        throw new AppError(503, 'HOLIDAY_UNAVAILABLE', '节假日数据源暂不可用，请稍后重试');
      } finally {
        this.loading.delete(year);
      }
    })();
    this.loading.set(year, promise);
    return promise;
  }
}
