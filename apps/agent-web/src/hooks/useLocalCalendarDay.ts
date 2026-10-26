import { useEffect, useState } from 'react';

function localDay(timestamp = Date.now()): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 单个工作区共享一个午夜计时器；休眠恢复时按当前本地日期重新校准。 */
export function watchLocalCalendarDay(
  onDay: (day: number) => void,
  visibility: EventTarget = document,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentDay: number | undefined;
  let closed = false;
  const update = () => {
    if (closed) return;
    clearTimeout(timer);
    const now = Date.now();
    const day = localDay(now);
    if (day !== currentDay) {
      currentDay = day;
      onDay(day);
    }
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    timer = setTimeout(update, Math.max(1, nextMidnight.getTime() - now));
  };
  visibility.addEventListener('visibilitychange', update);
  update();
  return () => {
    closed = true;
    clearTimeout(timer);
    visibility.removeEventListener('visibilitychange', update);
  };
}

export function useLocalCalendarDay(): number {
  const [day, setDay] = useState(localDay);
  useEffect(() => watchLocalCalendarDay(setDay), []);
  return day;
}
