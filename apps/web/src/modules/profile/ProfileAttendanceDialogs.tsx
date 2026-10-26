import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type WorkbenchAttendanceDay,
  type WorkbenchAttendanceManualStatus,
  type WorkbenchScheduleRequest,
  type WorkbenchScheduleResult,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { SESSION_KEY } from '@/hooks/useSession';
import { OrganizationDialog, orgControlClass } from '@/modules/organizations/common';
import { api } from '@/services/api';

const quietClass = 'text-[13px] leading-[22px] text-[var(--color-neutral-strong)]';
const statusOptions: { value: WorkbenchAttendanceManualStatus; label: string }[] = [
  { value: 'PRESENT', label: '正常出勤' },
  { value: 'LATE', label: '迟到' },
  { value: 'EARLY_LEAVE', label: '早退' },
  { value: 'LATE_EARLY', label: '迟到且早退' },
  { value: 'LEAVE', label: '请假' },
  { value: 'ABSENT', label: '缺勤' },
  { value: 'REST', label: '休息' },
];
const flowLabels = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
  CANCELED: '已取消',
};
const timePart = (value: string | null) => value?.slice(11, 19) || '';
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
const localTime = (date: string, value: string) =>
  `${date} ${value.length === 5 ? `${value}:00` : value}`;

export function AttendanceDayDialog({
  day,
  orgId,
  memberId,
  statusLabel,
  onClose,
  onReload,
  onWritten,
}: {
  day: WorkbenchAttendanceDay;
  orgId: string | null;
  memberId: string | null;
  statusLabel: string;
  onClose: () => void;
  onReload: () => Promise<void>;
  onWritten: (message: string) => Promise<void>;
}) {
  const cache = useQueryClient();
  const [mode, setMode] = useState<'LEAVE' | 'CORRECTION' | 'DIRECT' | 'WITHDRAW' | null>(null);
  const [finalStatus, setFinalStatus] = useState<WorkbenchAttendanceManualStatus | ''>(
    statusOptions.find(({ value }) => value === day.finalStatus)?.value ?? '',
  );
  const [startTime, setStartTime] = useState(timePart(day.shiftStartAt));
  const [endTime, setEndTime] = useState(timePart(day.shiftEndAt));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const direct =
    !!orgId &&
    !!memberId &&
    day.permissions.canDirectUpdate &&
    Number.isInteger(day.dailyId) &&
    day.dailyId != null &&
    Number.isInteger(day.dailyVersionNo) &&
    day.dailyVersionNo != null;
  const canLeave = !!orgId && day.permissions.canApplyLeave;
  const canCorrect = !!orgId && day.permissions.canApplyCorrection;
  const canWithdraw =
    day.application?.status === 'PENDING' &&
    day.application.canWithdraw &&
    day.permissions.canWithdraw;
  const allowed =
    mode === 'LEAVE'
      ? canLeave
      : mode === 'CORRECTION'
        ? canCorrect
        : mode === 'DIRECT'
          ? direct
          : mode === 'WITHDRAW'
            ? canWithdraw
            : true;

  async function failed(failure: unknown) {
    setError(failure);
    if (failure instanceof ApiError) {
      if (failure.status === 409) setConflict(true);
      if (failure.status === 401) await cache.invalidateQueries({ queryKey: SESSION_KEY });
    }
  }
  async function reload() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReload();
      setConflict(false);
      setNotice('已重新读取考勤，请核对当前状态后再提交。');
    } catch (failure) {
      await failed(failure);
    } finally {
      setBusy(false);
    }
  }
  function edit(next: typeof mode) {
    setMode(next);
    setError(null);
    setNotice('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict || !mode) return;
    setError(null);
    if (!allowed) {
      setError(new Error('当前日期已不可执行此操作，请重新读取考勤。'));
      return;
    }
    if (mode !== 'WITHDRAW') {
      if (!reason.trim() || reason.trim().length > 1000) {
        setError(new Error('请填写 1 至 1000 字的事由'));
        return;
      }
      if (
        mode !== 'LEAVE' &&
        (!finalStatus || (mode === 'CORRECTION' && finalStatus === 'LEAVE'))
      ) {
        setError(new Error('请选择可用的修正后考勤状态'));
        return;
      }
      if (mode === 'LEAVE') {
        const start = localTime(day.scheduleDate, startTime);
        const end = localTime(day.scheduleDate, endTime);
        if (!validTime(startTime) || !validTime(endTime) || start >= end) {
          setError(new Error('请填写有效时段，结束时间必须晚于开始时间'));
          return;
        }
        if (
          !day.shiftStartAt ||
          !day.shiftEndAt ||
          start < day.shiftStartAt ||
          end > day.shiftEndAt
        ) {
          setError(new Error('请假时段必须在当天班次内，不支持跨日'));
          return;
        }
      }
      if (
        day.dailyId != null &&
        (!Number.isInteger(day.dailyVersionNo) || day.dailyVersionNo == null)
      ) {
        setError(new Error('日考勤版本缺失，请重新读取考勤'));
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'WITHDRAW') {
        await api.withdrawMyAttendance({
          applicationId: day.application!.applicationId,
          flowVersionNo: day.application!.flowVersionNo,
        });
      } else if (mode === 'DIRECT') {
        await api.updateMyAttendance({
          orgId: orgId!,
          dailyId: day.dailyId!,
          finalStatus: finalStatus as WorkbenchAttendanceManualStatus,
          manualRemark: reason.trim(),
          versionNo: day.dailyVersionNo!,
        });
      } else {
        await api.applyMyAttendance({
          orgId: orgId!,
          attendanceDate: day.scheduleDate,
          applicationType: mode,
          finalStatus:
            mode === 'LEAVE' ? 'LEAVE' : (finalStatus as WorkbenchAttendanceManualStatus),
          reason: reason.trim(),
          versionNo: day.dailyVersionNo,
          ...(day.dailyId == null ? {} : { dailyId: day.dailyId }),
          ...(mode === 'LEAVE'
            ? {
                leaveStartAt: localTime(day.scheduleDate, startTime),
                leaveEndAt: localTime(day.scheduleDate, endTime),
              }
            : {}),
        });
      }
    } catch (failure) {
      await failed(failure);
      setBusy(false);
      return;
    }
    onClose();
    void onWritten(
      mode === 'DIRECT'
        ? '考勤已更新。'
        : mode === 'WITHDRAW'
          ? '考勤申请已撤回。'
          : '申请已提交，等待主管审批。',
    );
  }

  return (
    <OrganizationDialog title="排班考勤详情" onClose={onClose} busy={busy}>
      <div className="space-y-[20px]">
        <h3 className="text-[15px] font-semibold">{day.scheduleDate}</h3>
        <dl className="grid gap-[10px] text-[13px] leading-[22px] sm:grid-cols-2 [&_dt]:text-muted-foreground [&_dd]:break-words">
          {[
            ['考勤状态', statusLabel],
            [
              '班次时间',
              day.shiftStartAt && day.shiftEndAt
                ? `${timePart(day.shiftStartAt)} — ${timePart(day.shiftEndAt)}（${day.timezone}）`
                : '无有效工作班次',
            ],
            ['上班打卡', day.firstClockInAt || '无记录'],
            ['下班打卡', day.lastClockOutAt || '无记录'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {day.reviewReason && <p className={quietClass}>复核说明：{day.reviewReason}</p>}
        {day.application && (
          <p className={quietClass}>
            考勤申请：{day.application.applicationType === 'LEAVE' ? '请假' : '考勤修正'} ·{' '}
            {flowLabels[day.application.status]}
          </p>
        )}
        {!mode ? (
          <div className="flex flex-wrap gap-[8px] border-t pt-[16px]">
            {canLeave && (
              <Button size="settings" onClick={() => edit('LEAVE')}>
                申请请假
              </Button>
            )}
            {canCorrect && (
              <Button size="settings" variant="outline" onClick={() => edit('CORRECTION')}>
                申请考勤修正
              </Button>
            )}
            {direct && (
              <Button size="settings" variant="outline" onClick={() => edit('DIRECT')}>
                直接修正考勤
              </Button>
            )}
            {canWithdraw && (
              <Button size="settings" variant="outline" onClick={() => edit('WITHDRAW')}>
                撤回考勤申请
              </Button>
            )}
            {!canLeave && !canCorrect && !direct && !canWithdraw && (
              <p className={quietClass}>
                {orgId ? '当前日期暂无可用的考勤操作。' : '加入组织后可发起请假和考勤修正申请。'}
              </p>
            )}
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-[16px] border-t pt-[16px]"
            noValidate
          >
            <h4 className="text-[15px] font-semibold">
              {mode === 'LEAVE'
                ? '请假申请'
                : mode === 'CORRECTION'
                  ? '考勤修正申请'
                  : mode === 'DIRECT'
                    ? '直接修正考勤'
                    : '撤回考勤申请'}
            </h4>
            {mode === 'WITHDRAW' ? (
              <p className={quietClass}>确认撤回此待审批申请？撤回不会修改当天考勤。</p>
            ) : (
              <fieldset disabled={busy} className="space-y-[16px]">
                {mode !== 'LEAVE' && (
                  <FormField controlId="attendance-target-status" label="修正后的考勤状态" required>
                    <select
                      id="attendance-target-status"
                      className={orgControlClass}
                      value={finalStatus}
                      onChange={(event) =>
                        setFinalStatus(event.target.value as WorkbenchAttendanceManualStatus)
                      }
                    >
                      <option value="">请选择</option>
                      {statusOptions
                        .filter(({ value }) => mode === 'DIRECT' || value !== 'LEAVE')
                        .map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                    </select>
                  </FormField>
                )}
                {mode === 'LEAVE' && (
                  <div className="grid gap-[12px] sm:grid-cols-2">
                    <FormField
                      controlId="attendance-leave-start"
                      label="请假开始时间"
                      required
                      description={`班次时区：${day.timezone || 'Asia/Shanghai'}`}
                    >
                      <Input
                        id="attendance-leave-start"
                        type="time"
                        step="1"
                        size="profile"
                        value={startTime}
                        onChange={(event) => setStartTime(event.target.value)}
                      />
                    </FormField>
                    <FormField controlId="attendance-leave-end" label="请假结束时间" required>
                      <Input
                        id="attendance-leave-end"
                        type="time"
                        step="1"
                        size="profile"
                        value={endTime}
                        onChange={(event) => setEndTime(event.target.value)}
                      />
                    </FormField>
                  </div>
                )}
                <FormField
                  controlId="attendance-reason"
                  label={mode === 'LEAVE' ? '请假事由' : '修正事由'}
                  required
                >
                  <Textarea
                    id="attendance-reason"
                    maxLength={1000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </FormField>
                <p className={quietClass}>
                  {mode === 'DIRECT'
                    ? '当前管理身份可直接修正已有日考勤，无需审批。'
                    : '审批通过后才变更考勤，可在组织与申请中查看进度。'}
                </p>
              </fieldset>
            )}
            {!allowed && (
              <p role="alert" className={quietClass}>
                当前日期已不可执行此操作，请返回查看最新状态。
              </p>
            )}
            <ErrorNotice error={error} />
            {conflict && (
              <p className={quietClass}>考勤或申请版本已变化，请先重读并核对，再手动提交。</p>
            )}
            {notice && (
              <p role="status" className={quietClass}>
                {notice}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-[8px]">
              <Button variant="outline" size="settings" disabled={busy} onClick={() => edit(null)}>
                返回详情
              </Button>
              {conflict && (
                <Button
                  variant="outline"
                  size="settings"
                  loading={busy}
                  onClick={() => void reload()}
                >
                  重读考勤
                </Button>
              )}
              <Button type="submit" size="settings" loading={busy} disabled={conflict || !allowed}>
                {mode === 'WITHDRAW' ? '确认撤回' : '提交'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </OrganizationDialog>
  );
}

type ScheduleRow = WorkbenchScheduleRequest['schedules'][number];

export function PersonalScheduleDialog({
  month,
  onClose,
  onWritten,
}: {
  month: string;
  onClose: () => void;
  onWritten: (message: string) => Promise<void>;
}) {
  const cache = useQueryClient();
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
      .toISOString()
      .slice(0, 10),
  );
  const [dayType, setDayType] = useState<'WORK' | 'REST'>('WORK');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [weekdaysOnly, setWeekdaysOnly] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WorkbenchScheduleResult | null>(null);
  const receipt = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

  function generate() {
    setError(null);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      Number(from.slice(0, 4)) < 1900 ||
      from > to
    ) {
      setError(new Error('请选择有效的起止日期'));
      return;
    }
    const first = new Date(`${from}T00:00:00Z`);
    const last = new Date(`${to}T00:00:00Z`);
    const count = (last.getTime() - first.getTime()) / 86_400_000 + 1;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 366 ||
      first.toISOString().slice(0, 10) !== from ||
      last.toISOString().slice(0, 10) !== to
    ) {
      setError(new Error('每次排班请选择 1 至 366 个有效日期'));
      return;
    }
    const next: ScheduleRow[] = [];
    for (let offset = 0; offset < count; offset++) {
      const date = new Date(first.getTime() + offset * 86_400_000);
      if (weekdaysOnly && [0, 6].includes(date.getUTCDay())) continue;
      next.push({
        scheduleDate: date.toISOString().slice(0, 10),
        dayType,
        ...(dayType === 'WORK' ? { startTime, endTime } : {}),
      });
    }
    setRows(next);
    setResult(null);
  }
  function change(index: number, patch: Partial<ScheduleRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
    setResult(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || result) return;
    setError(null);
    if (!rows.length || rows.length > 366) {
      setError(new Error('请先生成 1 至 366 条排班日期'));
      return;
    }
    const work = rows.find(
      (row) =>
        row.dayType === 'WORK' &&
        (!validTime(row.startTime || '') ||
          !validTime(row.endTime || '') ||
          `${row.startTime}:00`.slice(0, 8) >= `${row.endTime}:00`.slice(0, 8)),
    );
    if (work) {
      setError(new Error(`${work.scheduleDate} 的班次时间无效，结束时间必须晚于开始时间`));
      return;
    }
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone.trim() });
    } catch {
      setError(new Error('请填写有效的 IANA 时区，例如 Asia/Shanghai'));
      return;
    }
    const input = {
      schedules: rows.map((row) => ({
        scheduleDate: row.scheduleDate,
        dayType: row.dayType,
        ...(row.dayType === 'WORK' ? { startTime: row.startTime, endTime: row.endTime } : {}),
      })),
      overwrite,
      timezone: timezone.trim(),
    };
    const fingerprint = JSON.stringify(input);
    if (receipt.current?.fingerprint !== fingerprint)
      receipt.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
    setBusy(true);
    let saved: WorkbenchScheduleResult;
    try {
      saved = await api.batchMySchedules({
        ...input,
        idempotencyKey: receipt.current!.idempotencyKey,
      });
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError && failure.status === 401)
        await cache.invalidateQueries({ queryKey: SESSION_KEY });
      setBusy(false);
      return;
    }
    setResult(saved);
    setBusy(false);
    void onWritten(
      `排班已保存：新增 ${saved.createdCount} 条，覆盖 ${saved.updatedCount} 条，跳过 ${saved.skippedCount} 条。`,
    );
  }

  return (
    <OrganizationDialog title="为自己排班" onClose={onClose} busy={busy}>
      <form className="space-y-[16px]" onSubmit={(event) => void submit(event)} noValidate>
        <p className={quietClass}>
          排班仅保存到本人。班次使用所填时区的本地时间，不支持跨日；生成日期后可逐日调整。
        </p>
        <fieldset disabled={busy} className="space-y-[16px]">
          <div className="grid gap-[12px] sm:grid-cols-2">
            <FormField controlId="schedule-from" label="排班开始日期">
              <Input
                id="schedule-from"
                type="date"
                size="profile"
                min="1900-01-01"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </FormField>
            <FormField controlId="schedule-to" label="排班结束日期">
              <Input
                id="schedule-to"
                type="date"
                size="profile"
                min="1900-01-01"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </FormField>
            <FormField controlId="schedule-day-type" label="默认日类型">
              <select
                id="schedule-day-type"
                className={orgControlClass}
                value={dayType}
                onChange={(event) => setDayType(event.target.value as 'WORK' | 'REST')}
              >
                <option value="WORK">工作</option>
                <option value="REST">休息</option>
              </select>
            </FormField>
            <FormField controlId="schedule-timezone" label="班次时区">
              <Input
                id="schedule-timezone"
                size="profile"
                maxLength={64}
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                  setResult(null);
                }}
              />
            </FormField>
            {dayType === 'WORK' && (
              <>
                <FormField controlId="schedule-start" label="默认上班时间">
                  <Input
                    id="schedule-start"
                    type="time"
                    step="1"
                    size="profile"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </FormField>
                <FormField controlId="schedule-end" label="默认下班时间">
                  <Input
                    id="schedule-end"
                    type="time"
                    step="1"
                    size="profile"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </FormField>
              </>
            )}
          </div>
          <label className="flex min-h-[44px] items-center gap-[8px] text-[13px]">
            <input
              type="checkbox"
              checked={weekdaysOnly}
              onChange={(event) => setWeekdaysOnly(event.target.checked)}
            />
            仅生成周一至周五（节假日请按实际安排调整）
          </label>
          <Button variant="outline" size="settings" onClick={generate}>
            生成排班日期
          </Button>
          {rows.length > 0 && (
            <fieldset className="space-y-[8px]">
              <legend className="mb-[8px] text-[13px] font-medium">
                逐日排班（{rows.length} 天）
              </legend>
              <ul className="max-h-[320px] space-y-[10px] overflow-y-auto p-[2px]">
                {rows.map((row, index) => (
                  <li
                    key={row.scheduleDate}
                    className="space-y-[8px] rounded-[8px] border p-[12px]"
                  >
                    <div className="flex items-center justify-between gap-[8px]">
                      <time dateTime={row.scheduleDate} className="text-[13px] font-medium">
                        {row.scheduleDate}
                      </time>
                      <Button
                        variant="ghost"
                        size="mobileTouch"
                        aria-label={`移除 ${row.scheduleDate}`}
                        onClick={() => {
                          setRows((current) => current.filter((_, i) => i !== index));
                          setResult(null);
                        }}
                      >
                        移除
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-[8px] sm:grid-cols-3">
                      <select
                        className={orgControlClass}
                        aria-label={`${row.scheduleDate} 日类型`}
                        value={row.dayType}
                        onChange={(event) =>
                          change(index, {
                            dayType: event.target.value as 'WORK' | 'REST',
                            ...(event.target.value === 'WORK'
                              ? {
                                  startTime: row.startTime || startTime,
                                  endTime: row.endTime || endTime,
                                }
                              : {}),
                          })
                        }
                      >
                        <option value="WORK">工作</option>
                        <option value="REST">休息</option>
                      </select>
                      {row.dayType === 'WORK' && (
                        <>
                          <Input
                            type="time"
                            step="1"
                            size="profile"
                            aria-label={`${row.scheduleDate} 上班时间`}
                            value={row.startTime || ''}
                            onChange={(event) => change(index, { startTime: event.target.value })}
                          />
                          <Input
                            type="time"
                            step="1"
                            size="profile"
                            aria-label={`${row.scheduleDate} 下班时间`}
                            value={row.endTime || ''}
                            onChange={(event) => change(index, { endTime: event.target.value })}
                          />
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <label className="flex min-h-[44px] items-center gap-[8px] text-[13px]">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(event) => {
                setOverwrite(event.target.checked);
                setResult(null);
              }}
            />
            覆盖已有排班（未勾选时跳过已有日期）
          </label>
        </fieldset>
        <ErrorNotice error={error} />
        {result && (
          <div
            role="status"
            className={`space-y-[6px] rounded-[8px] border p-[12px] ${quietClass}`}
          >
            <p>
              新增 {result.createdCount} 条，覆盖 {result.updatedCount} 条，跳过{' '}
              {result.skippedCount} 条。
            </p>
            {result.conflicts.length > 0 && (
              <p>
                已有排班未覆盖：
                {result.conflicts.map(({ scheduleDate }) => scheduleDate).join('、')}
                。核对后可勾选覆盖并再次提交。
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-[8px]">
          <Button variant="outline" size="settings" disabled={busy} onClick={onClose}>
            {result ? '完成' : '取消'}
          </Button>
          <Button type="submit" size="settings" loading={busy} disabled={!!result || !rows.length}>
            保存排班
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}
