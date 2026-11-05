import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  ApiError,
  type AuthUser,
  type PersonnelMovement,
  type PersonnelMovementCreateInput,
  type PersonnelMovementProcessInput,
  type PersonnelMovementStatus,
  type PersonnelMovementType,
  type PersonnelMovementWithdrawInput,
  type ProjectPersonnelMember,
} from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  personnelMovementApprovalStep,
  personnelMovementCreateInput,
  personnelMovementDateFilters,
  personnelMovementProcessConfirmed,
  personnelMovementProcessInput,
  type PersonnelMovementForm,
} from './personnel-movement-form';
import { productionPlanToday } from './production-plan-form';

export const PERSONNEL_MOVEMENT_LEAVE_REQUEST = 'tyde:before-project-personnel-leave';
const movementTypes = { REMOVAL: '人员汰换', TRANSFER: '人员转项' };
const canCreateMovement = (members: ProjectPersonnelMember[], type: PersonnelMovementType) =>
  members.length > 0 &&
  members.every((member) =>
    (member.allowedActions as readonly string[]).includes(`CREATE_${type}`),
  );
const movementStatuses = {
  PROCESSING: '审批处理中',
  WAITING_EFFECTIVE: '待生效',
  EFFECTIVE: '已生效',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};
type WriteState = {
  id: string;
  originRole: 'PM' | 'EXPERT';
  organizationId?: string;
  status: 'unknown' | 'success' | 'conflict' | 'access';
} & (
  | { kind: 'create'; input: PersonnelMovementCreateInput; members: ProjectPersonnelMember[] }
  | { kind: 'process'; input: PersonnelMovementProcessInput }
  | { kind: 'withdraw'; input: PersonnelMovementWithdrawInput }
);
// 读取缓存会在角色切换时清空；未确认命令只在本次页面运行中按账号、业务来源保留。
const pendingWrites = new Map<string, WriteState>();

function useMovementWrite(
  userId: string,
  source: string,
  role: 'PM' | 'EXPERT',
  organizationId?: string,
) {
  const cache = useQueryClient();
  const key = JSON.stringify([userId, source]);
  const queryKey = ['personnel-movement-write', userId, role, source];
  const retained = useQuery<WriteState | null>({
    queryKey,
    queryFn: async () => null,
    initialData: () => pendingWrites.get(key) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  function set(value: WriteState | null, expectedId?: string) {
    const previous = pendingWrites.get(key);
    if (expectedId && previous?.id !== expectedId) return;
    if (
      previous &&
      (previous.originRole !== role ||
        (source.startsWith('create:') &&
          role === 'EXPERT' &&
          previous.organizationId !== organizationId))
    )
      return;
    if (value) pendingWrites.set(key, value);
    else pendingWrites.delete(key);
    cache.setQueryData(queryKey, value);
    cache.setQueriesData(
      {
        queryKey: ['personnel-movement-write', userId],
        predicate: (query) => query.queryKey[3] === source,
      },
      value,
    );
  }
  function begin(value: WriteState) {
    if (pendingWrites.has(key)) return false;
    set(value);
    return true;
  }
  function requireOrigin() {
    const previous = pendingWrites.get(key);
    if (
      previous &&
      (previous.originRole !== role ||
        (source.startsWith('create:') &&
          role === 'EXPERT' &&
          previous.organizationId !== organizationId))
    )
      throw new Error(
        '此业务来源存在其他角色或组织的待核实操作，请回原角色和原组织核实，不能重复提交。',
      );
  }
  const foreignLock =
    !!retained.data &&
    (retained.data.originRole !== role ||
      (source.startsWith('create:') &&
        role === 'EXPERT' &&
        retained.data.organizationId !== organizationId));
  return { lock: retained.data, foreignLock, requireOrigin, set, begin };
}

function useMovementSession(user: AuthUser, role: 'PM' | 'EXPERT') {
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function sameIdentity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === role;
  }
  function requireIdentity() {
    if (!sameIdentity()) throw new Error('登录身份已变化，请重新打开人员管理。');
  }
  function requireSession() {
    if (!mounted.current || !sameIdentity())
      throw new Error('登录身份已变化，请重新打开人员管理。');
  }
  return { mounted, sameIdentity, requireIdentity, requireSession };
}

function useMovementLeaveGuard(
  dirty: boolean,
  working: RefObject<boolean>,
  allowLeave: RefObject<boolean>,
  sameIdentity: () => boolean,
) {
  function mayLeave() {
    return (
      allowLeave.current ||
      (!working.current &&
        (!dirty || window.confirm('尚有未完成的人员变动申请，确认离开当前页面？')))
    );
  }
  useEffect(() => {
    const leave = (event: Event) => {
      if (sameIdentity() && !mayLeave()) event.preventDefault();
    };
    window.addEventListener(PERSONNEL_MOVEMENT_LEAVE_REQUEST, leave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    return () => {
      window.removeEventListener(PERSONNEL_MOVEMENT_LEAVE_REQUEST, leave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    };
  }, [dirty]);
  useBlocker({
    shouldBlockFn: () => sameIdentity() && !mayLeave(),
    enableBeforeUnload: () => sameIdentity() && !allowLeave.current && (working.current || dirty),
  });
}

function failureStatus(error: unknown): WriteState['status'] {
  if (
    !(error instanceof ApiError) ||
    ['SESSION_CHANGED', 'INVALID_RESPONSE'].includes(String(error.code)) ||
    error.status === 0 ||
    error.status >= 500
  )
    return 'unknown';
  return [401, 403, 404].includes(error.status) ? 'access' : 'conflict';
}

function MovementSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Record<string, string>;
}) {
  const id = useId();
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setPortal} className="min-w-[140px] space-y-2">
      <label htmlFor={id} className="text-[13px]">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} size="profile" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent container={portal}>
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function PersonnelMovements({
  user,
  projectId,
  canWrite,
  selectedMembers,
  onChanged,
  active = true,
  role = 'PM',
  organizationId,
  initialMovementId,
  approvalOnly = false,
}: {
  user: AuthUser;
  projectId: number;
  canWrite: boolean;
  selectedMembers: ProjectPersonnelMember[];
  onChanged: () => Promise<void>;
  active?: boolean;
  role?: 'PM' | 'EXPERT';
  organizationId?: string;
  initialMovementId?: number;
  approvalOnly?: boolean;
}) {
  const session = useMovementSession(user, role);
  const scope = useId();
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [filter, setFilter] = useState({
    keyword: '',
    type: 'ALL',
    status: 'ALL',
    start: '',
    end: '',
    current: 1,
  });
  const [error, setError] = useState<unknown>(null);
  const [creation, setCreation] = useState<{
    type: PersonnelMovementType;
    members: ProjectPersonnelMember[];
  } | null>(null);
  const [selected, setSelected] = useState<PersonnelMovement | null>(null);
  const createWrite = useMovementWrite(user.id, `create:${projectId}`, role, organizationId);
  const list = useQuery({
    queryKey: [
      'personnel-movements',
      user.id,
      role,
      projectId,
      organizationId,
      initialMovementId,
      filter,
    ],
    enabled: active && (user.selectedRole ?? user.role) === role,
    queryFn: async () => {
      session.requireIdentity();
      const result = await api.listPersonnelMovements({
        projectId,
        ...(initialMovementId ? { movementId: initialMovementId } : {}),
        current: filter.current,
        size: 20,
        ...(filter.keyword ? { keyword: filter.keyword } : {}),
        ...(filter.type === 'ALL' ? {} : { movementTypes: [filter.type as PersonnelMovementType] }),
        ...(filter.status === 'ALL'
          ? {}
          : { statuses: [filter.status as PersonnelMovementStatus] }),
        ...personnelMovementDateFilters(filter.start, filter.end),
      });
      session.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  });
  async function refresh() {
    await onChanged();
    if (!session.sameIdentity()) return;
    if (session.mounted.current) {
      try {
        await list.refetch({ throwOnError: true });
      } catch (value) {
        if (session.mounted.current || !session.sameIdentity()) throw value;
      }
    }
  }
  const data = !list.isError && session.sameIdentity() ? list.data : undefined;
  const records =
    data?.records.filter((row) => !organizationId || row.organizationId === organizationId) ?? [];
  const openedInitial = useRef<number | null>(null);
  useEffect(() => {
    if (
      !initialMovementId ||
      openedInitial.current === initialMovementId ||
      !session.sameIdentity()
    )
      return;
    const row = data?.records.find(
      (item) =>
        item.movementId === initialMovementId &&
        (!organizationId || item.organizationId === organizationId),
    );
    if (row) {
      openedInitial.current = initialMovementId;
      setSelected(row);
    }
  }, [data, initialMovementId, organizationId]);
  const eligible =
    selectedMembers.length > 0 &&
    selectedMembers.length <= 100 &&
    selectedMembers.every(
      (member) =>
        member.status === 'ACTIVE' && (role === 'PM' || member.organizationId === organizationId),
    );
  return (
    <section aria-label="人员异动记录" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h3>人员异动</h3>
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {canWrite &&
            role === 'PM' &&
            !approvalOnly &&
            (['REMOVAL', 'TRANSFER'] as const).map((movementType) => (
              <Button
                key={movementType}
                variant={movementType === 'REMOVAL' ? 'destructiveOutline' : 'default'}
                size="mobileTouch"
                disabled={
                  !eligible ||
                  !canCreateMovement(selectedMembers, movementType) ||
                  !!createWrite.lock
                }
                title="请先选择具有相应变动权限的成员。"
                onClick={() => setCreation({ type: movementType, members: [...selectedMembers] })}
              >
                {movementType === 'REMOVAL' ? '发起汰换' : '发起转项'}
              </Button>
            ))}
          <Button
            variant="outline"
            size="mobileTouch"
            loading={list.isFetching}
            onClick={() => void list.refetch()}
          >
            刷新异动记录
          </Button>
        </div>
      </div>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {role === 'EXPERT'
          ? `${organizationId ? '仅展示当前组织的' : '展示当前授权的'}相关异动；可按实时授权处理原项目或目标项目组织人工节点，成员接单、考试及策略官节点不能代办。`
          : '原项目和目标项目的相关记录均在此展示。成员接单、考试和组织负责人审批由对应角色处理，策略官仅处理当前授权的人工节点。'}
      </p>
      {createWrite.foreignLock && (
        <Alert>
          此项目存在其他角色或组织的待核实发起，请回原角色和原组织核实；不展示或恢复原申请。
        </Alert>
      )}
      {!createWrite.foreignLock && createWrite.lock?.kind === 'create' && (
        <Alert>
          <p>
            {createWrite.lock.status === 'success'
              ? '变动已发起，后续信息尚未读取完成，请恢复申请后重新读取。'
              : '上次变动申请仍待核实，暂不重复发起。申请保留在本次页面运行中，刷新页面会丢失。'}
          </p>
          <Button
            className="mt-3"
            variant="outline"
            size="mobileTouch"
            onClick={() => {
              const lock = createWrite.lock;
              if (lock?.kind === 'create')
                setCreation({ type: lock.input.movementType, members: lock.members });
            }}
          >
            恢复变动申请
          </Button>
        </Alert>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            personnelMovementDateFilters(start, end);
            setFilter({ keyword: keyword.trim(), type, status, start, end, current: 1 });
            setError(null);
          } catch (value) {
            setError(value);
          }
        }}
      >
        <SearchInput
          id={`${scope}-search`}
          label="搜索人员异动"
          value={keyword}
          maxLength={100}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="成员姓名、昵称或用户 ID"
          containerClassName="self-end sm:max-w-none"
        />
        <MovementSelect
          label="变动类型"
          value={type}
          onChange={setType}
          options={{ ALL: '全部类型', ...movementTypes }}
        />
        <MovementSelect
          label="变动状态"
          value={status}
          onChange={setStatus}
          options={{ ALL: '全部状态', ...movementStatuses }}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-2 text-[13px]">
            发起日期从
            <Input
              type="date"
              aria-label="发起日期从"
              size="profile"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label className="space-y-2 text-[13px]">
            发起日期至
            <Input
              type="date"
              aria-label="发起日期至"
              size="profile"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4">
          <Button type="submit" size="settings" loading={list.isFetching}>
            查询异动记录
          </Button>
          <Button
            variant="outline"
            size="settings"
            onClick={() => {
              setKeyword('');
              setType('ALL');
              setStatus('ALL');
              setStart('');
              setEnd('');
              setFilter({
                keyword: '',
                type: 'ALL',
                status: 'ALL',
                start: '',
                end: '',
                current: 1,
              });
              setError(null);
            }}
          >
            重置异动筛选
          </Button>
        </div>
      </form>
      <ErrorNotice error={error} />
      <ErrorNotice error={list.error} />
      {list.isPending && active && <LoadingState>正在读取人员异动…</LoadingState>}
      {data && (
        <>
          {records.length ? (
            <div className="space-y-3">
              {records.map((row) => (
                <Card key={row.movementId} asChild>
                  <article
                    aria-label={`${row.displayName} ${row.movementNo}`}
                    className="space-y-3 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="break-words text-sm font-semibold">
                        {row.displayName} · {movementTypes[row.movementType]}
                      </h4>
                      <span className="text-[13px] text-muted-foreground">{row.statusName}</span>
                    </div>
                    <p className="break-words text-[13px] leading-5">
                      {row.movementNo} · {row.sourceProjectName || `项目 ${row.sourceProjectId}`}
                      {row.targetProjectId &&
                        ` → ${row.targetProjectName || `项目 ${row.targetProjectId}`}`}
                    </p>
                    <p className="break-words text-[12px] text-muted-foreground">
                      预计生效 {row.plannedEffectiveDate} · 发起于 {row.initiatedAt}（上海时间）
                    </p>
                    <Button variant="outline" size="mobileTouch" onClick={() => setSelected(row)}>
                      查看变动详情
                    </Button>
                  </article>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState title="暂无匹配的人员异动记录" />
            </Card>
          )}
          {organizationId && (
            <p className="text-xs text-muted-foreground">
              分页和总数为服务端当前账号全部有权查看的项目异动，本页仅保留当前组织记录，并非当前组织总数；本页为空时可继续翻页。
            </p>
          )}
          <Pagination
            aria-label="人员异动分页"
            current={data.current}
            total={data.total}
            pages={data.pages}
            loading={list.isFetching}
            onPageChange={(current) => setFilter((value) => ({ ...value, current }))}
          />
        </>
      )}
      {role === 'PM' && creation && (
        <CreateMovementDialog
          user={user}
          projectId={projectId}
          role={role}
          organizationId={organizationId}
          canWrite={canWrite}
          members={creation.members}
          movementType={creation.type}
          onChanged={refresh}
          onClose={() => setCreation(null)}
        />
      )}
      {selected && (
        <MovementDetailsDialog
          key={selected.movementId}
          user={user}
          projectId={projectId}
          role={role}
          canWrite={canWrite}
          snapshot={selected}
          canSelectLatest={!initialMovementId}
          onChanged={refresh}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function CreateMovementDialog({
  user,
  projectId,
  role,
  organizationId,
  canWrite,
  members,
  movementType,
  onChanged,
  onClose,
}: {
  user: AuthUser;
  projectId: number;
  canWrite: boolean;
  members: ProjectPersonnelMember[];
  movementType: PersonnelMovementType;
  role: 'PM' | 'EXPERT';
  organizationId?: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const session = useMovementSession(user, role);
  const write = useMovementWrite(user.id, `create:${projectId}`, role, organizationId);
  const previous = !write.foreignLock && write.lock?.kind === 'create' ? write.lock.input : null;
  const [form, setForm] = useState<PersonnelMovementForm>(() => ({
    movementType,
    reason: previous?.reason ?? '',
    plannedEffectiveDate: previous?.plannedEffectiveDate ?? productionPlanToday(),
    targetProjectId: previous?.targetProjectId?.toString() ?? '',
  }));
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState({ keyword: '', current: 1 });
  const working = useRef(false);
  const allowLeave = useRef(false);
  useMovementLeaveGuard(true, working, allowLeave, session.sameIdentity);
  const memberIds = members.map((member) => member.memberId);
  const targets = useQuery({
    queryKey: ['personnel-transfer-targets', user.id, role, projectId, memberIds, filter],
    enabled:
      role === 'PM' &&
      form.movementType === 'TRANSFER' &&
      canWrite &&
      canCreateMovement(members, movementType),
    queryFn: async () => {
      session.requireIdentity();
      const result = await api.listPersonnelTransferTargets({
        projectId,
        memberIds,
        keyword: filter.keyword || undefined,
        current: filter.current,
        size: 20,
      });
      session.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  async function complete(state: WriteState) {
    write.requireOrigin();
    allowLeave.current = true;
    await onChanged();
    if (!session.sameIdentity()) return;
    write.set(null, state.id);
    if (session.mounted.current) onClose();
  }
  async function reread() {
    if (working.current || !write.lock) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const state = write.lock;
    try {
      session.requireSession();
      write.requireOrigin();
      if (state.status === 'success') await complete(state);
      else {
        await api.listPersonnelMovements({ projectId, current: 1, size: 20 });
        session.requireSession();
        await cache.invalidateQueries(
          { queryKey: ['personnel-movements', user.id, role, projectId] },
          { throwOnError: true },
        );
        session.requireSession();
        if (state.status === 'unknown')
          setNotice(
            '已读取当前变动记录，但接口不提供本批次ID，仍无法确认上次整批发起结果；申请继续保留，不会自动重发。',
          );
        else {
          write.set(null, state.id);
          setNotice('已读取当前变动记录，请核对成员状态与目标后再发起。');
        }
      }
    } catch (value) {
      if (session.mounted.current && session.sameIdentity()) setError(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (session.mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (
      role !== 'PM' ||
      working.current ||
      write.lock ||
      !canWrite ||
      !canCreateMovement(members, movementType)
    )
      return;
    let state: WriteState | undefined;
    let written = false;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      session.requireSession();
      write.requireOrigin();
      if (
        movementType === 'TRANSFER' &&
        !targets.data?.records.some((target) => String(target.projectId) === form.targetProjectId)
      )
        throw new Error('请从当前人员的候选项目中选择转入项目。');
      const input = personnelMovementCreateInput(projectId, memberIds, form, undefined, role);
      state = {
        id: crypto.randomUUID(),
        originRole: role,
        organizationId,
        kind: 'create',
        status: 'unknown',
        input,
        members,
      };
      if (!write.begin(state)) return;
      await api.createPersonnelMovement(input);
      written = true;
      write.set({ ...state, status: 'success' }, state.id);
      session.requireSession();
      setNotice('人员变动已发起，正在读取后续信息。');
      await complete(state);
    } catch (value) {
      if (state && !written) write.set({ ...state, status: failureStatus(value) }, state.id);
      if (session.mounted.current && session.sameIdentity()) setError(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (session.mounted.current) setBusy(false);
    }
  }
  const targetAccessDenied =
    targets.error instanceof ApiError && [401, 403, 404].includes(targets.error.status);
  const blocked =
    busy ||
    !!write.lock ||
    !canWrite ||
    !canCreateMovement(members, movementType) ||
    targetAccessDenied;
  return (
    <Dialog
      title={movementType === 'REMOVAL' ? '发起人员汰换' : '发起人员转项'}
      aria-label={movementType === 'REMOVAL' ? '发起人员汰换' : '发起人员转项'}
      size={movementType === 'TRANSFER' ? 'lg' : 'md'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="mobileTouch" disabled={busy} onClick={onClose}>
            关闭申请
          </Button>
          {write.lock ? (
            <Button size="mobileTouch" loading={busy} onClick={() => void reread()}>
              {write.lock.status === 'success' ? '重新读取变动信息' : '核实发起结果'}
            </Button>
          ) : (
            <Button
              size="mobileTouch"
              loading={busy}
              disabled={blocked}
              onClick={() => void submit()}
            >
              确认发起变动
            </Button>
          )}
        </>
      }
    >
      <p className="break-words text-[13px] leading-6">
        本次成员：{members.map((member) => member.displayName).join('、')}（共{members.length}
        人）。全部成功或全部失败；当天汰换立即生效，转项需完成全部流程，未来日期不会因打开页面自动生效。
      </p>
      <ErrorNotice error={error} />
      {notice && <Alert>{notice}</Alert>}
      {write.lock && (
        <Alert>
          {write.lock.status === 'success'
            ? '发起已成功；当前仅重新读取信息，不会重复创建。'
            : write.lock.status === 'unknown'
              ? '发起结果尚未确认，已保留申请并暂停重发。'
              : '当前成员、权限或目标状态已变化，请先重新读取核对。'}
        </Alert>
      )}
      <label className="block space-y-2 text-[13px]">
        变动原因
        <Textarea
          aria-label="变动原因"
          value={form.reason}
          maxLength={500}
          rows={3}
          disabled={blocked}
          onChange={(event) => setForm((value) => ({ ...value, reason: event.target.value }))}
        />
      </label>
      <label className="block space-y-2 text-[13px]">
        预计生效日期
        <Input
          type="date"
          aria-label="预计生效日期"
          min={productionPlanToday()}
          value={form.plannedEffectiveDate}
          disabled={blocked}
          onChange={(event) =>
            setForm((value) => ({ ...value, plannedEffectiveDate: event.target.value }))
          }
        />
      </label>
      {movementType === 'TRANSFER' && (
        <>
          <p className="text-[13px] leading-6 text-muted-foreground">
            请从服务端返回的当前人员候选项目中选择转入项目。转项仍须完成对应审批与准入流程。
          </p>
          <label className="block space-y-2 text-[13px]">
            已选目标项目ID
            <Input
              aria-label="已选目标项目ID"
              inputMode="numeric"
              maxLength={10}
              value={form.targetProjectId}
              readOnly
            />
          </label>
          <form
            className="flex flex-wrap gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setFilter({ keyword: keyword.trim(), current: 1 });
            }}
          >
            <SearchInput
              id="personnel-transfer-target-search"
              label="搜索转项目标"
              value={keyword}
              maxLength={128}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="目标项目名称或编号"
              containerClassName="flex-1"
            />
            <Button type="submit" variant="outline" size="settings" loading={targets.isFetching}>
              查询目标项目
            </Button>
          </form>
          <ErrorNotice error={targets.error} />
          {targets.isPending && <LoadingState>正在读取转项目标…</LoadingState>}
          {!targets.isError && targets.data && (
            <>
              {!targets.data.records.length && (
                <EmptyState
                  title="暂无匹配的转项目标"
                  description="当前没有可选转入项目，请调整搜索或联系项目负责人。"
                />
              )}
              {targets.data.records.map((target) => (
                <Card asChild key={target.projectId}>
                  <article
                    aria-label={target.projectName || target.projectNo}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <p className="min-w-0 break-words text-[13px]">
                      {target.projectName || target.projectNo} · {target.projectNo}
                      <span className="block text-xs text-muted-foreground">
                        {target.requesterName} · ID {target.projectId}
                      </span>
                    </p>
                    <Button
                      variant="outline"
                      size="mobileTouch"
                      disabled={blocked || targets.isFetching}
                      onClick={() =>
                        setForm((value) => ({
                          ...value,
                          targetProjectId: String(target.projectId),
                        }))
                      }
                    >
                      选择目标项目
                    </Button>
                  </article>
                </Card>
              ))}
              <Pagination
                aria-label="转项目标分页"
                current={targets.data.current}
                total={targets.data.total}
                pages={targets.data.pages}
                loading={targets.isFetching}
                onPageChange={(current) => setFilter((value) => ({ ...value, current }))}
              />
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

function MovementDetailsDialog({
  user,
  projectId,
  role,
  canWrite,
  snapshot,
  canSelectLatest,
  onChanged,
  onSelect,
  onClose,
}: {
  user: AuthUser;
  projectId: number;
  canWrite: boolean;
  snapshot: PersonnelMovement;
  canSelectLatest: boolean;
  role: 'PM' | 'EXPERT';
  onChanged: () => Promise<void>;
  onSelect: (value: PersonnelMovement) => void;
  onClose: () => void;
}) {
  const session = useMovementSession(user, role);
  const write = useMovementWrite(user.id, `item:${snapshot.movementId}`, role);
  const [intent, setIntent] = useState<'WITHDRAW' | 'APPROVE' | 'REJECT' | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const allowLeave = useRef(false);
  useMovementLeaveGuard(!!intent, working, allowLeave, session.sameIdentity);
  const detail = useQuery({
    queryKey: [
      'personnel-movement-detail',
      user.id,
      role,
      snapshot.sourceProjectId,
      snapshot.memberId,
      snapshot.movementId,
    ],
    queryFn: async () => {
      session.requireIdentity();
      const result = await api.getPersonnelMovementDetail({
        projectId: snapshot.sourceProjectId,
        memberId: snapshot.memberId,
      });
      session.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  });
  const sameRecord = detail.data?.movementId === snapshot.movementId;
  const accessDenied = error instanceof ApiError && [401, 403, 404].includes(error.status);
  const current = detail.isError || accessDenied ? null : sameRecord ? detail.data! : snapshot;
  const verified = detail.isSuccess && sameRecord && !detail.isFetching && !accessDenied;
  const blocked = busy || !!write.lock || (role === 'PM' && !canWrite) || !verified;
  const approvalStep = current ? personnelMovementApprovalStep(current, role) : null;
  const actionNames = { WITHDRAW: '撤回变动', APPROVE: '同意转项', REJECT: '驳回转项' };
  async function complete(state: WriteState) {
    write.requireOrigin();
    allowLeave.current = true;
    await onChanged();
    if (!session.sameIdentity()) return;
    write.set(null, state.id);
    if (session.mounted.current) onClose();
  }
  async function reread() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const state = write.lock;
    try {
      session.requireSession();
      if (write.foreignLock) {
        await detail.refetch({ throwOnError: true });
        write.requireOrigin();
        return;
      }
      write.requireOrigin();
      if (state?.status === 'success') {
        await complete(state);
        return;
      }
      if (state) {
        const page = await api.listPersonnelMovements({
          projectId,
          movementId: snapshot.movementId,
          current: 1,
          size: 1,
        });
        session.requireSession();
        const record = page.records.find((item) => item.movementId === snapshot.movementId);
        if (!record) throw new Error('当前无法读取此变动，不能确认上次操作结果。');
        const confirmed =
          state.kind === 'withdraw'
            ? record.status === 'WITHDRAWN' && !!record.withdrawnAt
            : state.kind === 'process' &&
              personnelMovementProcessConfirmed(state.input, record, user.id);
        if (confirmed) {
          write.set({ ...state, status: 'success' }, state.id);
          await complete(state);
          return;
        }
        if (state.status === 'unknown')
          setNotice('已读取该变动的最新记录，仍未核实目标节点动作，继续暂停重发。');
        else {
          write.set(null, state.id);
          setNotice('已读取当前状态，请核对当前节点后重新选择操作。');
        }
      }
      await detail.refetch({ throwOnError: true });
    } catch (value) {
      if (session.mounted.current && session.sameIdentity()) setError(value);
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (session.mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (working.current || write.lock || !intent || blocked || !current) return;
    let state: WriteState | undefined;
    let written = false;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      session.requireSession();
      write.requireOrigin();
      const expected =
        intent === 'WITHDRAW'
          ? null
          : personnelMovementProcessInput(projectId, current, intent, comment, role);
      const latest = await api.getPersonnelMovementDetail({
        projectId: snapshot.sourceProjectId,
        memberId: snapshot.memberId,
      });
      session.requireSession();
      if (
        (intent === 'WITHDRAW' && role !== 'PM') ||
        latest.movementId !== snapshot.movementId ||
        !latest.allowedActions.includes(intent)
      )
        throw new Error('变动或当前权限已变化，请重新读取详情。');
      if (intent === 'WITHDRAW')
        state = {
          id: crypto.randomUUID(),
          originRole: role,
          kind: 'withdraw',
          status: 'unknown',
          input: { projectId: latest.sourceProjectId, movementId: latest.movementId },
        };
      else {
        const input = personnelMovementProcessInput(projectId, latest, intent, comment, role);
        if (
          !expected ||
          input.flowNo !== expected.flowNo ||
          input.nodeId !== expected.nodeId ||
          input.flowVersionNo !== expected.flowVersionNo ||
          input.nodeVersionNo !== expected.nodeVersionNo
        )
          throw new Error('审批节点版本已变化，请重新读取详情后操作。');
        state = {
          id: crypto.randomUUID(),
          originRole: role,
          kind: 'process',
          status: 'unknown',
          input,
        };
      }
      if (!write.begin(state)) return;
      if (state.kind === 'withdraw') await api.withdrawPersonnelMovement(state.input);
      else if (state.kind === 'process') await api.processPersonnelMovement(state.input);
      written = true;
      write.set({ ...state, status: 'success' }, state.id);
      session.requireSession();
      setIntent(null);
      await complete(state);
    } catch (value) {
      if (state && !written) write.set({ ...state, status: failureStatus(value) }, state.id);
      if (session.mounted.current && session.sameIdentity()) {
        setError(value);
        setIntent(null);
      }
    } finally {
      working.current = false;
      allowLeave.current = false;
      if (session.mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        title="人员变动详情"
        aria-label="人员变动详情"
        size="lg"
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <Button variant="outline" size="mobileTouch" disabled={busy} onClick={onClose}>
              关闭详情
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={busy || detail.isFetching}
              onClick={() => void reread()}
            >
              {write.lock ? '核实变动结果' : '重新读取变动详情'}
            </Button>
          </>
        }
      >
        <ErrorNotice error={error} />
        <ErrorNotice error={detail.error} />
        {notice && <Alert>{notice}</Alert>}
        {write.lock && (
          <Alert>
            {write.foreignLock
              ? '此变动存在其他角色的待核实操作，请切回原角色核实；当前仅可读取。'
              : write.lock.status === 'success'
                ? '操作已成功，当前仅重试读取后续信息，不会重复提交。'
                : '上次操作结果或当前资格尚待核实，已暂停此变动的重复操作。'}
          </Alert>
        )}
        {detail.isPending && <LoadingState>正在核对该成员最新变动…</LoadingState>}
        {detail.isSuccess && !sameRecord && (
          <Alert>
            <p>该成员已有较新的变动，当前显示所选历史记录，不提供操作。</p>
            {canSelectLatest && (
              <Button
                className="mt-3"
                variant="outline"
                size="mobileTouch"
                onClick={() => detail.data && onSelect(detail.data)}
              >
                查看该成员最新变动
              </Button>
            )}
          </Alert>
        )}
        {current && (
          <>
            <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
              {[
                ['成员', `${current.displayName} · ${current.userId}`],
                ['变动编号', current.movementNo],
                ['变动类型', movementTypes[current.movementType]],
                ['变动状态', current.statusName],
                ['原项目', current.sourceProjectName || current.sourceProjectId],
                ['目标项目', current.targetProjectName || current.targetProjectId || '不适用'],
                ['预计生效日期', current.plannedEffectiveDate],
                ['实际生效时间', current.effectiveAt || '尚未生效'],
                ['发起人', current.initiatorName],
                ['发起时间', current.initiatedAt],
                ['目标考试结果', current.examStatus || '尚无最终考试结果'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-2 text-[13px]">
              <h3 className="font-semibold">变动原因</h3>
              <p className="whitespace-pre-wrap break-words leading-6">{current.reason}</p>
            </div>
            <section aria-label="转项审批流程" className="space-y-3">
              <h3 className="text-base font-semibold">审批流程</h3>
              {!current.approvalSteps.length && (
                <p className="text-[13px] text-muted-foreground">人员汰换无需转项审批流程。</p>
              )}
              {current.approvalSteps.map((step) => (
                <Card key={step.nodeId} className="space-y-2 p-4 text-[13px]">
                  <p>
                    {step.nodeSeq}. {step.nodeName} ·{' '}
                    {(
                      {
                        WAITING: '未激活',
                        PENDING: '待处理',
                        APPROVED: '已通过',
                        REJECTED: '已驳回',
                        CANCELED: '已关闭',
                        SKIPPED: '已跳过',
                      } as Record<string, string>
                    )[step.nodeStatus] || step.nodeStatus}
                  </p>
                  {step.operatorName && (
                    <p className="text-muted-foreground">
                      最近操作：{step.operatorName}
                      {step.actionAt && ` · ${step.actionAt}`}
                    </p>
                  )}
                  {step.actionComment && (
                    <p className="whitespace-pre-wrap break-words">{step.actionComment}</p>
                  )}
                </Card>
              ))}
            </section>
            {current.allowedActions.some((action) => action === 'APPROVE' || action === 'REJECT') &&
              !approvalStep && (
                <Alert>
                  当前无法精确定位本人的有效审批节点，请重新读取；旧服务未返回本人节点且存在多人候选时仅可查看，不会猜测或代办他人节点。
                </Alert>
              )}
            <div className="flex flex-wrap gap-2">
              {(['WITHDRAW', 'APPROVE', 'REJECT'] as const)
                .filter(
                  (action) =>
                    current.allowedActions.includes(action) &&
                    (action !== 'WITHDRAW' || role === 'PM'),
                )
                .map((action) => (
                  <Button
                    key={action}
                    variant={action === 'REJECT' ? 'destructiveOutline' : 'outline'}
                    size="mobileTouch"
                    disabled={blocked || (action !== 'WITHDRAW' && !approvalStep)}
                    onClick={() => {
                      setError(null);
                      setComment('');
                      setIntent(action);
                    }}
                  >
                    {actionNames[action]}
                  </Button>
                ))}
            </div>
            {!current.allowedActions.some((action) =>
              ['WITHDRAW', 'APPROVE', 'REJECT'].includes(action),
            ) && (
              <p className="text-[13px] leading-6 text-muted-foreground">
                {role === 'PM'
                  ? '当前没有可执行的策略官人工操作；成员接单、目标考试及组织负责人节点不能在此代办。'
                  : '当前没有可执行的本角色人工操作；成员接单、目标考试及策略官节点不能在此代办。'}
              </p>
            )}
          </>
        )}
      </Dialog>
      {intent && (
        <Dialog
          title={actionNames[intent]}
          aria-label={actionNames[intent]}
          size="sm"
          busy={busy}
          onClose={() => setIntent(null)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy}
                onClick={() => setIntent(null)}
              >
                取消操作
              </Button>
              <Button
                size="mobileTouch"
                loading={busy}
                disabled={blocked}
                onClick={() => void submit()}
              >
                确认操作
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            确认对 {snapshot.displayName} 的变动 {snapshot.movementNo} 执行“{actionNames[intent]}
            ”？提交前会重新核对最新记录和审批版本。
          </p>
          {intent !== 'WITHDRAW' && (
            <label className="block space-y-2 text-[13px]">
              审批意见{intent === 'REJECT' ? '（必填）' : '（选填）'}
              <Textarea
                aria-label="审批意见"
                value={comment}
                maxLength={500}
                rows={3}
                disabled={busy}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
          )}
        </Dialog>
      )}
    </>
  );
}
