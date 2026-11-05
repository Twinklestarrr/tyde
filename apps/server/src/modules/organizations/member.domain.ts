import { AppError } from '../../common/errors.js';

// 旧接口不含时区的日期/时间按业务时区上海解释；禁止 Date 自动进位非法日期。
export function businessDate(value: string, dateOnly = false): Date {
  const pattern = dateOnly
    ? /^(\d{4})-(\d{2})-(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
  const parts = pattern.exec(value);
  if (!parts) throw invalid('日期格式不正确');
  const [, y, m, d, h = '00', min = '00', sec = '00'] = parts;
  const utc = new Date(`${y}-${m}-${d}T${h}:${min}:${sec}.000Z`);
  if (
    !Number.isFinite(utc.getTime()) ||
    utc.toISOString().slice(0, 19) !== `${y}-${m}-${d}T${h}:${min}:${sec}`
  )
    throw invalid('日期值不合法');
  return new Date(utc.getTime() - 8 * 3_600_000);
}
const invalid = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
