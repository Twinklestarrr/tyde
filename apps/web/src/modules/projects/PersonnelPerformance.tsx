import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { ApiError, type AuthUser, type ProjectPersonnelMember } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { saveExamBlob } from './EntranceExamFiles';
import { PERSONNEL_LEAVE_REQUEST, personnelPerformanceInput } from './personnel-form';
import { PRODUCTION_TASKS_LEAVE_REQUEST } from './production-task-form';

type Draft = { date: string; content: string };
type Pending = {
  status: 'unknown' | 'conflict' | 'success';
  draft: Draft;
  originRole: 'PM' | 'EXPERT';
};
const pendingWrites = new Map<string, Pending>();

export function PersonnelPerformance({
  user,
  projectId,
  member,
  canWrite,
  onChanged,
  onClose,
  role = 'PM',
}: {
  user: AuthUser;
  projectId: number;
  member: Pick<ProjectPersonnelMember, 'memberId' | 'displayName' | 'organizationName'> & {
    reportDate: string;
  };
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
  role?: 'PM' | 'EXPERT';
}) {
  const cache = useQueryClient();
  const writeKey = JSON.stringify([user.id, projectId, member.memberId]);
  const lockKey = [
    'project-personnel-performance-write',
    user.id,
    role,
    projectId,
    member.memberId,
  ];
  const lockQuery = useQuery<Pending | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: () => pendingWrites.get(writeKey) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  const lock = lockQuery.data;
  const foreignLock = !!lock && lock.originRole !== role;
  const [draft, setDraft] = useState<Draft>(
    () =>
      (!foreignLock ? lock?.draft : undefined) ?? {
        date: member.reportDate,
        content: '',
      },
  );
  const [editing, setEditing] = useState(!!lock && !foreignLock && lock.status !== 'success');
  const showEditor = editing && !foreignLock;
  const [filter, setFilter] = useState({
    recordDateStart: member.reportDate,
    recordDateEnd: member.reportDate,
    current: 1,
  });
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    allowLeave = useRef(false);
  const dirty = !foreignLock && !!draft.content;
  function identity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  function current() {
    return mounted.current && identity();
  }
  function requireIdentity() {
    if (!identity()) throw new Error('当前身份已变化，请重新进入人员管理。');
  }
  function requireSession() {
    if (!current()) throw new Error('当前身份已变化，请重新进入人员管理。');
  }
  function setLock(value: Pending | null) {
    if (pendingWrites.has(writeKey) && pendingWrites.get(writeKey)?.originRole !== role) return;
    if ((value?.originRole ?? pendingWrites.get(writeKey)?.originRole ?? role) !== role) return;
    if (value) pendingWrites.set(writeKey, value);
    else pendingWrites.delete(writeKey);
    cache.setQueryData(lockKey, value);
    cache.setQueriesData(
      {
        queryKey: ['project-personnel-performance-write', user.id],
        predicate: (query) =>
          query.queryKey[3] === projectId && query.queryKey[4] === member.memberId,
      },
      value,
    );
  }
  function requireOrigin() {
    const previous = pendingWrites.get(writeKey);
    if (previous && previous.originRole !== role)
      throw new Error('此成员存在其他角色的待核实表现记录，请切回原角色核实，不可换角色重复新增。');
  }
  const query = useQuery({
    queryKey: ['project-personnel-performance', user.id, role, projectId, member.memberId, filter],
    queryFn: async () => {
      requireIdentity();
      const result = await api.listProjectMemberPerformance({
        projectId,
        memberId: member.memberId,
        current: filter.current,
        ...(filter.recordDateStart ? { recordDateStart: filter.recordDateStart } : {}),
        ...(filter.recordDateEnd ? { recordDateEnd: filter.recordDateEnd } : {}),
        size: 20,
      });
      requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  function mayLeave() {
    return (
      allowLeave.current ||
      (!working.current && (!dirty || window.confirm('尚有未完成的表现记录，确认离开当前页面？')))
    );
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const leave = (event: Event) => {
      if (identity() && !mayLeave()) event.preventDefault();
    };
    window.addEventListener(PERSONNEL_LEAVE_REQUEST, leave);
    window.addEventListener(PRODUCTION_TASKS_LEAVE_REQUEST, leave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => {
      window.removeEventListener(PERSONNEL_LEAVE_REQUEST, leave);
      window.removeEventListener(PRODUCTION_TASKS_LEAVE_REQUEST, leave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    };
  }, [dirty, role, user.id]);
  useBlocker({
    shouldBlockFn: () => identity() && !mayLeave(),
    enableBeforeUnload: () => identity() && !allowLeave.current && (working.current || dirty),
  });
  const blocked = busy || !!lock || !canWrite || !query.isSuccess || query.isFetching;
  async function followUp() {
    requireOrigin();
    await query.refetch({ throwOnError: true });
    allowLeave.current = true;
    await onChanged();
    if (!identity()) return;
    setLock(null);
    if (current()) {
      setDraft({ date: member.reportDate, content: '' });
      setEditing(false);
    }
  }
  async function reread() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const previous = cache.getQueryData<Pending | null>(lockKey);
    try {
      if (foreignLock) {
        await query.refetch({ throwOnError: true });
        requireSession();
        requireOrigin();
        return;
      }
      if (previous?.status === 'success') await followUp();
      else {
        const permission = role === 'PM' ? await api.getExpertRecruitmentDetail(projectId) : null;
        requireSession();
        if (permission)
          cache.setQueryData(['project-expert-recruitment', user.id, 'PM', projectId], permission);
        await query.refetch({ throwOnError: true });
        if (!current()) return;
        requireOrigin();
        if (
          previous?.status === 'conflict' &&
          (role === 'PM' ? permission?.canChangeHandler : canWrite)
        ) {
          setLock(null);
          setNotice('已读取最新表现，请核对内容后再保存。');
        } else if (previous)
          setNotice('已读取最新表现，仍无法精确确认上次新增结果；内容继续保留，不会自动重发。');
      }
    } catch (value) {
      if (current()) setError(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (blocked || working.current || pendingWrites.has(writeKey)) return;
    let input;
    try {
      input = personnelPerformanceInput(projectId, member.memberId, draft.date, draft.content, []);
    } catch (value) {
      setError(value);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    const state: Pending = { status: 'unknown', draft, originRole: role };
    let written = false;
    try {
      requireSession();
      setLock(state);
      await api.createProjectMemberPerformance(input);
      written = true;
      setLock({ ...state, status: 'success' });
      requireSession();
      setNotice('表现记录已保存。');
      await followUp();
    } catch (value) {
      if (current()) {
        setError(value);
        if (written) setNotice('表现记录已保存，后续信息读取失败，请重新读取表现。');
        else
          setLock({
            ...state,
            status:
              value instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(value.status)
                ? 'conflict'
                : 'unknown',
          });
      }
      if (value instanceof ApiError && value.status === 401)
        void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function read(key: string, name: string) {
    if (download) return;
    setDownload(key);
    setError(null);
    try {
      requireSession();
      const blob = await api.readMemberPerformanceAttachment(key);
      if (current()) saveExamBlob(blob, name);
    } catch (value) {
      if (current()) setError(value);
    } finally {
      if (mounted.current) setDownload(null);
    }
  }
  function close() {
    if (working.current) return;
    if (showEditor) {
      setEditing(false);
      return;
    }
    if (mayLeave()) onClose();
  }
  return (
    <Dialog
      title={showEditor ? '新增表现记录' : '成员表现'}
      aria-label={showEditor ? '新增表现记录' : '成员表现'}
      size="lg"
      busy={busy}
      onClose={close}
      footer={
        <>
          <Button variant="outline" size="mobileTouch" disabled={busy} onClick={close}>
            {showEditor ? '返回表现列表' : '关闭'}
          </Button>
          <Button
            variant="outline"
            size="mobileTouch"
            loading={busy || query.isFetching}
            onClick={() => void reread()}
          >
            重新读取表现
          </Button>
          {showEditor && (
            <Button
              size="mobileTouch"
              loading={busy}
              disabled={blocked}
              onClick={() => void save()}
            >
              保存表现记录
            </Button>
          )}
        </>
      }
    >
      <p className="text-[13px] text-muted-foreground">
        {member.displayName} · {member.organizationName || '个人'}；已离项成员仍保留历史表现。
      </p>
      <ErrorNotice error={error ?? query.error} />
      {notice && <Alert>{notice}</Alert>}
      {lock && (
        <Alert>
          {foreignLock
            ? '此成员存在其他角色的待核实表现记录，请切回原角色核实，不可换角色重复新增。'
            : lock.status === 'unknown'
              ? '表现记录保存结果尚未确认，已保留内容并暂停重发。'
              : lock.status === 'success'
                ? '表现记录已保存，后续信息尚未读取完成，请重新读取表现。'
                : '权限或成员状态已变化，请重新读取表现后核对。'}
        </Alert>
      )}
      {showEditor ? (
        <div className="space-y-4">
          <p className="text-[13px]">生产日期：{member.reportDate}</p>
          <label className="block space-y-2 text-[13px]">
            表现内容
            <Textarea
              value={draft.content}
              maxLength={2000}
              rows={5}
              disabled={blocked}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[13px]">生产日期：{member.reportDate}</p>
            {canWrite && (
              <Button size="mobileTouch" disabled={blocked} onClick={() => setEditing(true)}>
                新增表现记录
              </Button>
            )}
          </div>
          {query.isPending && <LoadingState>正在读取成员表现…</LoadingState>}
          {query.isSuccess && identity() && (
            <>
              {!query.data.records.length && <EmptyState title="暂无成员表现记录" />}
              {query.data.records.map((record) => (
                <Card asChild key={record.performanceId}>
                  <article
                    aria-label={`表现记录${record.performanceId}`}
                    className="space-y-3 p-4 text-[13px]"
                  >
                    <p>
                      {record.recordDate} · {record.recordedByName}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{record.content}</p>
                    <p className="text-xs text-muted-foreground">
                      记录时间：{record.createdAt || '未记录'}
                    </p>
                    {record.attachments.map((file) => (
                      <Button
                        key={file.fileId}
                        className="h-auto min-h-11 max-w-full whitespace-normal break-all py-2"
                        variant="outline"
                        size="mobileTouch"
                        loading={download === file.objectKey}
                        disabled={download !== null}
                        onClick={() => void read(file.objectKey, file.fileName)}
                      >
                        下载{file.fileName}
                      </Button>
                    ))}
                  </article>
                </Card>
              ))}
              <Pagination
                aria-label="成员表现分页"
                {...query.data}
                loading={query.isFetching}
                onPageChange={(current) => setFilter({ ...filter, current })}
              />
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
