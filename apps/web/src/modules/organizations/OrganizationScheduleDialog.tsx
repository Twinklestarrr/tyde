import { useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type OrganizationScheduleBatchInput,
  type OrganizationScheduleDay,
  type OrganizationScheduleDetailsInput,
  type OrganizationScheduleMember,
  type OrganizationScheduleResult,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/shared/FormField';
import { api } from '@/services/api';
import { OrganizationDialog, orgControlClass } from './common';

export function OrganizationScheduleDialog({
  orgId,
  month,
  members,
  day,
  keys,
  onClose,
  onSaved,
  onReload,
}: {
  orgId: string;
  month: string;
  members: OrganizationScheduleMember[];
  day?: OrganizationScheduleDay;
  keys: Map<string, string>;
  onClose: () => void;
  onSaved: (result: OrganizationScheduleResult) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [startDate, setStartDate] = useState(day?.scheduleDate ?? `${month}-01`);
  const [endDate, setEndDate] = useState(() => {
    const end = new Date(`${month}-01T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    return end.toISOString().slice(0, 10);
  });
  const [dayType, setDayType] = useState<'WORK' | 'REST'>(day?.dayType ?? 'WORK');
  const [startTime, setStartTime] = useState(day?.shiftStartAt?.slice(11, 19) || '09:00');
  const [endTime, setEndTime] = useState(day?.shiftEndAt?.slice(11, 19) || '18:00');
  const [timezone, setTimezone] = useState(day?.timezone || 'Asia/Shanghai');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>();
  const [reloadError, setReloadError] = useState<unknown>();
  const submitting = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError(undefined);
    if (
      dayType === 'WORK' &&
      (!startTime || !endTime || `${startTime}:00`.slice(0, 8) >= `${endTime}:00`.slice(0, 8))
    ) {
      setError(new Error('工作班次结束时间必须晚于开始时间，暂不支持跨日班次'));
      return;
    }
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone.trim() });
      if (!timezone.trim()) throw new Error();
    } catch {
      setError(new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai'));
      return;
    }
    if (!day) {
      const from = new Date(`${startDate}T00:00:00Z`),
        to = new Date(`${endDate}T00:00:00Z`);
      if (
        !Number.isFinite(from.getTime()) ||
        !Number.isFinite(to.getTime()) ||
        from > to ||
        Number(startDate.slice(0, 4)) < 1900 ||
        to.getTime() - from.getTime() > 365 * 86400000
      ) {
        setError(new Error('日期范围须从 1900 年起，结束不早于开始，最多 366 天'));
        return;
      }
      if (!weekdays.length) {
        setError(new Error('请至少选择一个星期'));
        return;
      }
    }
    const shift = {
      dayType,
      ...(dayType === 'WORK' ? { startTime, endTime } : {}),
      timezone: timezone.trim(),
    };
    const input: OrganizationScheduleBatchInput | OrganizationScheduleDetailsInput = day
      ? {
          orgId,
          schedules: [{ memberId: members[0]!.memberId, scheduleDate: day.scheduleDate, ...shift }],
          overwrite,
        }
      : {
          orgId,
          memberIds: members.map((member) => member.memberId).sort(),
          startDate,
          endDate,
          weekdays: [...weekdays].sort(),
          ...shift,
          overwrite,
        };
    const fingerprint = JSON.stringify([day ? 'DETAIL' : 'BATCH', input]);
    let key = keys.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.set(fingerprint, key);
    }
    submitting.current = true;
    setBusy(true);
    let result: OrganizationScheduleResult;
    try {
      result = day
        ? await api.batchOrganizationScheduleDetails(input as OrganizationScheduleDetailsInput, key)
        : await api.batchOrganizationSchedules(input as OrganizationScheduleBatchInput, key);
    } catch (failure) {
      setError(failure);
      setConflict(failure instanceof ApiError && failure.status === 409);
      return;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
    keys.delete(fingerprint);
    // 已完成写入后的回读由父页面单独呈现，不把读取失败当成保存失败。
    await onSaved(result);
  }
  async function reload() {
    setReloading(true);
    setReloadError(undefined);
    try {
      await onReload();
      setConflict(false);
    } catch (failure) {
      setReloadError(failure);
    } finally {
      setReloading(false);
    }
  }
  return (
    <OrganizationDialog
      title={day ? '编辑每日排班' : '组织批量排班'}
      busy={busy || reloading}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-[20px]">
        <p className="text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
          已选 {members.length} 人：
          {members.map((member) => member.realName || member.nickname || member.userId).join('、')}
          {day && ` · ${day.scheduleDate}`}
        </p>
        {day?.scheduleId !== null && day?.scheduleId !== undefined && (
          <Alert>
            已有排班：
            {day.dayType === 'REST'
              ? '休息'
              : `${day.shiftStartAt?.slice(11, 16)}–${day.shiftEndAt?.slice(11, 16)}`}
            ，时区 {day.timezone}。默认保留已有排班，勾选覆盖后才会更新。
          </Alert>
        )}
        <fieldset
          disabled={busy || reloading}
          className="grid grid-cols-1 gap-[16px] sm:grid-cols-2"
        >
          {!day && (
            <>
              <FormField controlId="org-schedule-start-date" label="开始日期" required>
                <Input
                  id="org-schedule-start-date"
                  size="profile"
                  type="date"
                  min="1900-01-01"
                  max="9999-12-31"
                  required
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </FormField>
              <FormField controlId="org-schedule-end-date" label="结束日期" required>
                <Input
                  id="org-schedule-end-date"
                  size="profile"
                  type="date"
                  min={startDate || '1900-01-01'}
                  max="9999-12-31"
                  required
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </FormField>
            </>
          )}
          <FormField controlId="org-schedule-day-type" label="日类型" required>
            <select
              id="org-schedule-day-type"
              className={orgControlClass}
              value={dayType}
              onChange={(event) => setDayType(event.target.value as 'WORK' | 'REST')}
            >
              <option value="WORK">工作</option>
              <option value="REST">休息</option>
            </select>
          </FormField>
          <FormField controlId="org-schedule-timezone" label="班次时区" required>
            <Input
              id="org-schedule-timezone"
              size="profile"
              required
              maxLength={64}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </FormField>
          {dayType === 'WORK' && (
            <>
              <FormField controlId="org-schedule-start-time" label="上班时间" required>
                <Input
                  id="org-schedule-start-time"
                  size="profile"
                  type="time"
                  step="1"
                  required
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
              </FormField>
              <FormField controlId="org-schedule-end-time" label="下班时间" required>
                <Input
                  id="org-schedule-end-time"
                  size="profile"
                  type="time"
                  step="1"
                  required
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </FormField>
            </>
          )}
          {!day && (
            <fieldset className="sm:col-span-2">
              <legend className="mb-[8px] text-[13px] font-medium">排班星期</legend>
              <div className="flex flex-wrap gap-[12px]">
                {['一', '二', '三', '四', '五', '六', '日'].map((label, index) => (
                  <label
                    key={label}
                    className="flex min-h-[44px] items-center gap-[6px] text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={weekdays.includes(index + 1)}
                      onChange={(event) =>
                        setWeekdays(
                          event.target.checked
                            ? [...weekdays, index + 1]
                            : weekdays.filter((value) => value !== index + 1),
                        )
                      }
                    />
                    周{label}
                  </label>
                ))}
              </div>
              <p className="mt-[6px] text-[12px] leading-[20px] text-muted-foreground">
                范围排班由服务端按所选星期展开，并排除法定放假日；调休工作日也按所选星期。若需指定节假日，请从月历点击某日编辑。
              </p>
            </fieldset>
          )}
          <label className="flex min-h-[44px] items-center gap-[8px] text-[13px] sm:col-span-2">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            覆盖已有排班（未勾选时跳过已有排班）
          </label>
        </fieldset>
        <ErrorNotice error={error} />
        {conflict && (
          <Alert>
            排班状态或请求内容存在冲突，请先读取最新月历并核对草稿。相同草稿重试保留原请求键，修改内容后使用新键。
            <Button
              variant="outline"
              size="settings"
              loading={reloading}
              onClick={() => void reload()}
            >
              读取最新排班
            </Button>
          </Alert>
        )}
        <ErrorNotice error={reloadError} />
        <div className="flex justify-end gap-[10px]">
          <Button variant="outline" size="settings" disabled={busy || reloading} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="settings" loading={busy} disabled={reloading || conflict}>
            保存排班
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}
