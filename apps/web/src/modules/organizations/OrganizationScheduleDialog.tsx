import { useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
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
import { OrganizationBatchScheduleDialog } from './OrganizationBatchScheduleDialog';

export type OrganizationScheduleDialogProps = {
  orgId: string;
  month: string;
  members: OrganizationScheduleMember[];
  day?: OrganizationScheduleDay;
  keys: Map<string, string>;
  onClose: () => void;
  onSaved: (result: OrganizationScheduleResult) => Promise<void>;
  onReload: () => Promise<void>;
};

export function OrganizationScheduleDialog(props: OrganizationScheduleDialogProps) {
  return props.day ? (
    <DailyScheduleDialog {...props} day={props.day} />
  ) : (
    <OrganizationBatchScheduleDialog {...props} />
  );
}

function DailyScheduleDialog({
  orgId,
  members,
  day,
  keys,
  onClose,
  onSaved,
  onReload,
}: OrganizationScheduleDialogProps & { day: OrganizationScheduleDay }) {
  const [dayType, setDayType] = useState<'WORK' | 'REST'>(day?.dayType ?? 'WORK');
  const [startTime, setStartTime] = useState(day?.shiftStartAt?.slice(11, 19) || '09:00');
  const [endTime, setEndTime] = useState(day?.shiftEndAt?.slice(11, 19) || '18:00');
  const [timezone, setTimezone] = useState(day?.timezone || 'Asia/Shanghai');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>();
  const [reloadError, setReloadError] = useState<unknown>();
  const submitting = useRef(false);

  async function submit(event: FormEvent, confirmed = false) {
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
    const shift = {
      dayType,
      ...(dayType === 'WORK' ? { startTime, endTime } : {}),
      timezone: timezone.trim(),
    };
    const input: OrganizationScheduleDetailsInput = {
      orgId,
      schedules: [{ memberId: members[0]!.memberId, scheduleDate: day.scheduleDate, ...shift }],
      overwrite,
    };
    if (!confirmed) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    const fingerprint = JSON.stringify(['DETAIL', input]);
    let key = keys.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.set(fingerprint, key);
    }
    submitting.current = true;
    setBusy(true);
    let result: OrganizationScheduleResult;
    try {
      result = await api.batchOrganizationScheduleDetails(input, key);
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
    <OrganizationDialog title="编辑每日排班" busy={busy || reloading} onClose={onClose}>
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
            提交排班
          </Button>
        </div>
      </form>
      {confirming && (
        <OrganizationDialog
          title="确认提交组织排班"
          busy={busy}
          onClose={() => setConfirming(false)}
        >
          <p>
            已选 {members.length} 人，日期 {day.scheduleDate}。
          </p>
          <p>
            {dayType === 'WORK' ? `工作班次 ${startTime}–${endTime}` : '休息'}，时区 {timezone}；
            {overwrite ? '覆盖已有排班' : '保留已有排班'}。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="mobileTouch" onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button size="mobileTouch" onClick={(event) => void submit(event, true)}>
              确认提交
            </Button>
          </div>
        </OrganizationDialog>
      )}
    </OrganizationDialog>
  );
}
