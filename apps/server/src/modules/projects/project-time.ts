import { AppError } from '../../common/errors.js';

// 项目旧契约使用上海本地时间，不依赖部署进程的时区。
export function projectTime(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}
export function parseProjectTime(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
    throw new AppError(400, 'VALIDATION_ERROR', '截止时间格式必须为yyyy-MM-dd HH:mm:ss');
  const date = new Date(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(date.getTime()) || projectTime(date) !== value)
    throw new AppError(400, 'VALIDATION_ERROR', '截止时间不合法');
  return date;
}
