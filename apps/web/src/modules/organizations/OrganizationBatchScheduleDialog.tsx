import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  type OrganizationScheduleDetailsInput,
  type OrganizationScheduleMember,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/shared/FormField';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { api } from '@/services/api';
import { OrganizationDialog, orgControlClass } from './common';
import type { OrganizationScheduleDialogProps } from './OrganizationScheduleDialog';

type Detail = OrganizationScheduleDetailsInput['schedules'][number];
type Editor = Detail & { memberName: string; startTime: string; endTime: string };
const nameOf = (member: OrganizationScheduleMember) =>
  member.realName || member.nickname || member.userId;
const dayKey = (memberId: string, date: string) => `${memberId}:${date}`;
const validTimes = (start: string, end: string) =>
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(start) &&
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(end) &&
  `${start}:00`.slice(0, 8) < `${end}:00`.slice(0, 8);

/** 整月逐人草稿只在二次确认后提交明细；不把未提交改动混入正式排班。 */
export function OrganizationBatchScheduleDialog({
  orgId,
  month,
  members,
  onClose,
  onSaved,
  onReload,
}: OrganizationScheduleDialogProps) {
  const [targetMonth, setTargetMonth] = useState(month);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [overwrite, setOverwrite] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Detail>>({});
  const [editor, setEditor] = useState<Editor>();
  const [pending, setPending] = useState<OrganizationScheduleDetailsInput>();
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>();
  const keys = useRef(new Map<string, string>());
  const submitting = useRef(false);
  const holidays = useQuery({
    queryKey: ['organization-schedule-draft-holidays', orgId, targetMonth],
    queryFn: () => api.getAttendanceHolidays({ orgId, month: targetMonth }),
    enabled: /^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth),
    retry: false,
  });
  const last = new Date(`${targetMonth}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const dates = Number.isFinite(last.getTime())
    ? Array.from(
        { length: last.getUTCDate() },
        (_, index) => `${targetMonth}-${String(index + 1).padStart(2, '0')}`,
      )
    : [];
  const editorInvalid =
    !!editor && editor.dayType === 'WORK' && !validTimes(editor.startTime, editor.endTime);
  const hours =
    (Number(endTime.slice(0, 2)) * 60 +
      Number(endTime.slice(3, 5)) -
      Number(startTime.slice(0, 2)) * 60 -
      Number(startTime.slice(3, 5))) /
      60 -
    1;
  const details = Object.values(drafts);
  const workCount = details.filter((row) => row.dayType === 'WORK').length;

  function generate() {
    setError(undefined);
    if (!validTimes(startTime, endTime)) {
      setError(new Error('基础下班时间必须晚于上班时间，暂不支持跨日班次'));
      return;
    }
    if (!holidays.isSuccess || !dates.length) return;
    if (members.length * dates.length > 5000) {
      setError(new Error('一次最多提交 5000 条排班，请减少所选人数'));
      return;
    }
    const next: Record<string, Detail> = {};
    for (const member of members)
      for (const date of dates) {
        const holiday = holidays.data.days.find((item) => item.date === date);
        const dayType =
          holiday?.defaultScheduleDayType ??
          (holiday?.calendarDayType === 'PUBLIC_HOLIDAY'
            ? 'REST'
            : holiday?.calendarDayType === 'MAKEUP_WORKDAY'
              ? 'WORK'
              : [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
                ? 'REST'
                : 'WORK');
        next[dayKey(member.memberId, date)] = {
          memberId: member.memberId,
          scheduleDate: date,
          dayType,
          ...(dayType === 'WORK' ? { startTime, endTime } : {}),
        };
      }
    setDrafts(next);
    setEditor(undefined);
  }
  function edit(member: OrganizationScheduleMember, date: string) {
    const draft = drafts[dayKey(member.memberId, date)];
    const existing = member.days.find((item) => item.scheduleDate === date);
    setEditor({
      memberId: member.memberId,
      memberName: nameOf(member),
      scheduleDate: date,
      dayType: draft?.dayType ?? existing?.dayType ?? 'WORK',
      startTime: draft?.startTime || existing?.shiftStartAt?.slice(11, 19) || startTime,
      endTime: draft?.endTime || existing?.shiftEndAt?.slice(11, 19) || endTime,
    });
  }
  function changeEditor(next: Editor) {
    setEditor(next);
    if (next.dayType === 'WORK' && !validTimes(next.startTime, next.endTime)) return;
    const row: Detail = {
      memberId: next.memberId,
      scheduleDate: next.scheduleDate,
      dayType: next.dayType,
      ...(next.dayType === 'WORK' ? { startTime: next.startTime, endTime: next.endTime } : {}),
    };
    setDrafts((current) => ({ ...current, [dayKey(next.memberId, next.scheduleDate)]: row }));
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (editorInvalid || details.length < 1 || details.length > 5000) {
      setError(new Error('请先设置 1 至 5000 条有效排班明细'));
      return;
    }
    try {
      if (!timezone.trim()) throw new Error();
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone.trim() });
    } catch {
      setError(new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai'));
      return;
    }
    setPending({
      orgId,
      schedules: details
        .sort(
          (a, b) =>
            a.memberId.localeCompare(b.memberId) || a.scheduleDate.localeCompare(b.scheduleDate),
        )
        .map((row) => ({ ...row, timezone: timezone.trim() })),
      timezone: timezone.trim(),
      overwrite,
    });
  }
  async function submit() {
    if (!pending || submitting.current) return;
    const input = pending;
    const fingerprint = JSON.stringify(input);
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(fingerprint, key);
    }
    submitting.current = true;
    setBusy(true);
    setPending(undefined);
    try {
      const result = await api.batchOrganizationScheduleDetails(input, key);
      keys.current.delete(fingerprint);
      await onSaved(result);
    } catch (failure) {
      setError(failure);
      setConflict(failure instanceof ApiError && failure.status === 409);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    setReloading(true);
    try {
      await onReload();
      setConflict(false);
      setError(undefined);
    } catch (failure) {
      setError(failure);
    } finally {
      setReloading(false);
    }
  }
  return (
    <OrganizationDialog title="组织批量排班" wide busy={busy || reloading} onClose={onClose}>
      <form onSubmit={prepare} className="space-y-4">
        <p>
          已选 {members.length} 人：{members.map(nameOf).join('、')}
        </p>
        <fieldset disabled={busy || reloading} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="目标月份" controlId="org-batch-month" required>
            <Input
              id="org-batch-month"
              type="month"
              min="1900-01"
              value={targetMonth}
              required
              onChange={(event) => {
                setTargetMonth(event.target.value);
                setDrafts({});
                setEditor(undefined);
                setError(undefined);
                setConflict(false);
              }}
            />
          </FormField>
          <FormField label="默认时区" controlId="org-batch-zone" required>
            <Input
              id="org-batch-zone"
              value={timezone}
              required
              onChange={(event) => setTimezone(event.target.value)}
            />
          </FormField>
          <FormField label="基础上班时间" controlId="org-batch-start" required>
            <Input
              id="org-batch-start"
              type="time"
              value={startTime}
              required
              onChange={(event) => setStartTime(event.target.value)}
            />
          </FormField>
          <FormField label="基础下班时间" controlId="org-batch-end" required>
            <Input
              id="org-batch-end"
              type="time"
              value={endTime}
              required
              onChange={(event) => setEndTime(event.target.value)}
            />
          </FormField>
          <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            覆盖已有排班（未勾选时跳过已有排班）
          </label>
        </fieldset>
        {validTimes(startTime, endTime) && hours > 8 && (
          <Alert>
            基础班次扣除 1 小时休息后有效工时为 {Number(hours.toFixed(2))} 小时，超过 8 小时。
          </Alert>
        )}
        {holidays.isError && (
          <>
            <ErrorNotice error={holidays.error} />
            <Button variant="outline" onClick={() => void holidays.refetch()}>
              重试节假日
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={!holidays.isSuccess || busy || reloading}
          onClick={generate}
        >
          一键排班
        </Button>
        {!holidays.isSuccess && (
          <p className="text-sm text-muted-foreground">节假日日历尚不可用，一键排班暂不可用。</p>
        )}
        <p className="text-xs text-muted-foreground">
          浅色为已有设置，强调色为本次草稿；红色日期为法定节假日。点击某个成员日期调整，提交前不会保存。
        </p>
        <div
          className="max-h-72 overflow-auto rounded-lg border"
          tabIndex={0}
          aria-label="批量排班编辑矩阵"
        >
          <Table className="w-max min-w-full">
            <caption className="sr-only">{targetMonth} 批量排班编辑矩阵</caption>
            <TableHeader className="sticky top-0 z-20">
              <TableRow>
                <TableHead className="sticky left-0 z-30 min-w-28">已选人员</TableHead>
                {dates.map((date) => (
                  <TableHead
                    key={date}
                    className={`min-w-12 px-2 text-center ${holidays.data?.days.some((item) => item.date === date && item.calendarDayType === 'PUBLIC_HOLIDAY') ? 'text-destructive' : ''}`}
                  >
                    {date.slice(8)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.memberId}>
                  <TableHead scope="row" className="sticky left-0 z-10 max-w-40">
                    <span className="block truncate" title={nameOf(member)}>
                      {nameOf(member)}
                    </span>
                  </TableHead>
                  {dates.map((date) => {
                    const draft = drafts[dayKey(member.memberId, date)];
                    const existing = member.days.find((item) => item.scheduleDate === date);
                    const kind = draft?.dayType ?? existing?.dayType;
                    const label = `${nameOf(member)} ${date} ${draft ? '本次' : '已有'}${kind === 'WORK' ? '出勤' : kind === 'REST' ? '休息' : '未设置'}`;
                    return (
                      <TableCell key={date} className="p-1 text-center">
                        <button
                          type="button"
                          disabled={busy || reloading}
                          className={`size-10 rounded border text-sm focus-visible:ring-2 focus-visible:ring-ring ${draft ? 'border-primary bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'}`}
                          aria-label={label}
                          title={label}
                          onClick={() => edit(member, date)}
                        >
                          {kind === 'WORK' ? '班' : kind === 'REST' ? '休' : '+'}
                        </button>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {editor && (
          <fieldset
            disabled={busy || reloading}
            className="grid gap-3 rounded-lg border bg-muted/40 p-4 sm:grid-cols-3"
          >
            <legend className="px-2 text-sm font-medium">
              单日设置 · {editor.memberName} · {editor.scheduleDate}
            </legend>
            <FormField controlId="org-batch-day-type" label="当天排班类型">
              <select
                id="org-batch-day-type"
                className={orgControlClass}
                value={editor.dayType}
                onChange={(event) =>
                  changeEditor({ ...editor, dayType: event.target.value as 'WORK' | 'REST' })
                }
              >
                <option value="WORK">出勤</option>
                <option value="REST">休息</option>
              </select>
            </FormField>
            {editor.dayType === 'WORK' && (
              <>
                <FormField label="当天上班" controlId="org-batch-day-start">
                  <Input
                    id="org-batch-day-start"
                    type="time"
                    step="1"
                    value={editor.startTime}
                    aria-invalid={editorInvalid}
                    onChange={(event) => changeEditor({ ...editor, startTime: event.target.value })}
                  />
                </FormField>
                <FormField label="当天下班" controlId="org-batch-day-end">
                  <Input
                    id="org-batch-day-end"
                    type="time"
                    step="1"
                    value={editor.endTime}
                    aria-invalid={editorInvalid}
                    onChange={(event) => changeEditor({ ...editor, endTime: event.target.value })}
                  />
                </FormField>
              </>
            )}
            {editorInvalid ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-3">
                当天的下班时间必须晚于上班时间，暂不支持跨日班次。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground sm:col-span-3">
                有效改动立即应用到本次草稿。
              </p>
            )}
          </fieldset>
        )}
        <p role="status" className="text-sm">
          本次草稿 {details.length} 条：出勤 {workCount} 条，休息 {details.length - workCount} 条。
        </p>
        <ErrorNotice error={error} />
        {conflict && (
          <Alert>
            排班版本冲突，请先读取最新排班。
            <Button variant="outline" disabled={reloading || busy} onClick={() => void reload()}>
              读取最新排班
            </Button>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy || reloading} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={
              busy ||
              reloading ||
              conflict ||
              editorInvalid ||
              !details.length ||
              details.length > 5000
            }
          >
            提交排班
          </Button>
        </div>
      </form>
      {pending && (
        <OrganizationDialog
          title="确认提交组织排班"
          busy={busy}
          onClose={() => setPending(undefined)}
        >
          <p>
            目标月份 {targetMonth}；排班{' '}
            {new Set(pending.schedules.map((row) => row.memberId)).size} 人，明细{' '}
            {pending.schedules.length} 条。
          </p>
          <p>
            出勤 {pending.schedules.filter((row) => row.dayType === 'WORK').length} 条，休息{' '}
            {pending.schedules.filter((row) => row.dayType === 'REST').length} 条。
          </p>
          <p>
            基础班次 {startTime}–{endTime}；默认时区 {pending.timezone}；
            {pending.overwrite ? '覆盖已有排班' : '保留已有排班'}。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPending(undefined)}>
              取消
            </Button>
            <Button onClick={() => void submit()}>确认提交</Button>
          </div>
        </OrganizationDialog>
      )}
    </OrganizationDialog>
  );
}
