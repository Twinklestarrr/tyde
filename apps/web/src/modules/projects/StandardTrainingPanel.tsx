import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Pencil, RefreshCw } from 'lucide-react';
import { ApiError, type AuthUser, type ProjectStandardMaterialsInput } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { MarkdownEditor } from '@/components/ui/shared/MarkdownEditor';
import { FormField } from '@/components/ui/shared/FormField';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { EntranceExamDialog } from './EntranceExamDialog';
import { StandardMaterialsContent } from './StandardMaterialsContent';
import { StrategistExamFiles } from './StrategistExamFiles';
import {
  standardTrainingDraft,
  standardTrainingFailureIsUnknown,
  standardTrainingInput,
  type StandardTrainingDraft,
} from './standard-training-form';

export const STANDARD_TRAINING_LEAVE_REQUEST = 'tyde:before-standard-training-leave';
type WriteLock = 'unknown' | 'conflict' | 'access' | 'success';
interface MaterialsWrite {
  id: string;
  originRole: 'PM' | 'NAVIGATOR';
  status: WriteLock;
  input: ProjectStandardMaterialsInput;
  draft: StandardTrainingDraft;
}
// 角色切换可清读取缓存，原保存及附件凭证仅在本次页面运行中按账号/项目保留。
const pendingWrites = new Map<string, MaterialsWrite>();
interface StandardTrainingProps {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
  role?: 'PM' | 'NAVIGATOR';
}

/** 现有候选读取明确要求当前主PM，协作403只读；不以流程阶段或考试数量推断权限。 */
async function materialsManagement(projectId: number) {
  try {
    await api.listEntranceExamReviewers(projectId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return false;
    throw error;
  }
}

/** 标准材料沿用项目附件台账，保存/发布为同一个现有命令。 */
export function StandardTrainingPanel(props: StandardTrainingProps) {
  return (
    <StandardTrainingContent
      key={JSON.stringify([props.user.id, props.projectId, props.role ?? 'PM'])}
      {...props}
    />
  );
}

function StandardTrainingContent({
  user,
  projectId,
  onChanged,
  role = 'PM',
}: StandardTrainingProps) {
  const cache = useQueryClient();
  const isRole = (user.selectedRole ?? user.role) === role;
  const scope = ['project-standard-materials', user.id, role, projectId] as const;
  const permissionsKey = [...scope, 'can-manage'];
  const writeKey = JSON.stringify([user.id, projectId]);
  const lockKey = ['project-standard-materials-write', user.id, role, projectId];
  const materials = useQuery({
    queryKey: scope,
    queryFn: async () => {
      requireSession();
      const result = await api.getProjectStandardMaterials(projectId);
      requireSession();
      return result;
    },
    enabled: isRole,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const permission = useQuery({
    queryKey: permissionsKey,
    queryFn: async () => {
      requireSession();
      const result = await materialsManagement(projectId);
      requireSession();
      return result;
    },
    enabled: isRole && role === 'PM',
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // 未核实的写结果跨Tab保留，重新挂载的自动读取不能自行解锁旧操作。
  const lockState = useQuery<MaterialsWrite | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: () => pendingWrites.get(writeKey) ?? null,
    enabled: false,
    gcTime: Infinity,
  });
  const pending = lockState.data;
  const foreignLock = !!pending && pending.originRole !== role;
  const lock = pending?.status;
  const [draft, setDraft] = useState<StandardTrainingDraft | null>(() =>
    pending && !foreignLock && pending.status !== 'success' ? pending.draft : null,
  );
  const original = useRef('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const writing = useRef(false);
  const allowLeave = useRef(false);
  const dirty = !lock && draft !== null && JSON.stringify(draft) !== original.current;
  const uploading = draft?.files.some((file) => file.status === 'uploading') ?? false;
  const canManage =
    isRole &&
    role === 'PM' &&
    permission.data === true &&
    !permission.isError &&
    !permission.isFetching &&
    materials.isSuccess &&
    !materials.isError &&
    !materials.isFetching &&
    !readError;
  const disabled = !canManage || Boolean(lock) || saving || reading;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function sameIdentity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return current?.id === user.id && (current.selectedRole ?? current.role) === role;
  }
  function sameSession() {
    return mounted.current && sameIdentity();
  }
  function requireSession() {
    if (!sameSession()) throw new Error('当前账号或角色已变化，请重新进入标准材料。');
  }
  function requireOrigin() {
    const previous = pendingWrites.get(writeKey);
    if (previous && previous.originRole !== role)
      throw new Error('此项目存在其他角色的待核实标准材料，请切回原角色核实，不能换角色重发。');
  }
  function setPending(next: MaterialsWrite | null, expectedId?: string) {
    const previous = pendingWrites.get(writeKey);
    if (expectedId && previous?.id !== expectedId) return;
    if (previous && previous.originRole !== role) return;
    if (next) pendingWrites.set(writeKey, next);
    else pendingWrites.delete(writeKey);
    cache.setQueryData(lockKey, next);
    cache.setQueriesData(
      {
        queryKey: ['project-standard-materials-write', user.id],
        predicate: (query) => query.queryKey[3] === projectId,
      },
      next,
    );
  }
  function mayLeave(message = '未保存的标准材料将会丢失，确认离开？') {
    return (
      allowLeave.current || (!writing.current && !uploading && (!dirty || window.confirm(message)))
    );
  }
  useEffect(() => {
    function beforeLeave(event: Event) {
      if (sameIdentity() && !mayLeave()) event.preventDefault();
    }
    window.addEventListener(STANDARD_TRAINING_LEAVE_REQUEST, beforeLeave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(STANDARD_TRAINING_LEAVE_REQUEST, beforeLeave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    };
  }, [dirty, uploading, role, user.id]);
  useBlocker({
    shouldBlockFn: () => sameIdentity() && !mayLeave(),
    enableBeforeUnload: () =>
      sameIdentity() && !allowLeave.current && (writing.current || uploading || dirty),
  });
  async function readLatest() {
    requireSession();
    const [result, allowed] = await Promise.all([
      api.getProjectStandardMaterials(projectId),
      role === 'PM' ? materialsManagement(projectId) : Promise.resolve(false),
    ]);
    requireSession();
    cache.setQueryData(scope, result);
    if (role === 'PM') cache.setQueryData(permissionsKey, allowed);
    return { result, allowed };
  }
  async function finish(state: MaterialsWrite) {
    requireOrigin();
    allowLeave.current = true;
    try {
      await onChanged();
      if (!sameIdentity()) return;
      if (mounted.current) {
        try {
          await readLatest();
          if (mounted.current) setDraft(null);
        } catch (failure) {
          if (mounted.current || !sameIdentity()) throw failure;
        }
      }
      if (sameIdentity()) setPending(null, state.id);
    } finally {
      allowLeave.current = false;
    }
  }
  async function reread(discard = true) {
    if (reading || writing.current || uploading || !sameSession()) return;
    const previous = pendingWrites.get(writeKey);
    if (
      discard &&
      !previous &&
      dirty &&
      !window.confirm('重新读取将替换未保存的标准材料，确认继续？')
    )
      return;
    writing.current = true;
    setReading(true);
    setReadError(null);
    try {
      if (previous?.originRole === role && previous.status === 'success') {
        await finish(previous);
        if (sameSession()) {
          setError(null);
          setNotice('标准材料已保存，最新资料已读取。');
        }
        return;
      }
      const { allowed } = await readLatest();
      requireOrigin();
      if (previous?.status === 'unknown') {
        setNotice('已读取当前材料，上次保存仍无法精确确认；原稿和附件凭证继续保留，不会重复提交。');
        return;
      }
      if (previous) {
        if (!allowed) {
          setPending({ ...previous, status: 'access' }, previous.id);
          setNotice('当前仅可查看标准材料，原稿保留，请恢复原维护资格后重新读取。');
          return;
        }
        setPending(null, previous.id);
        setDraft((current) => current ?? previous.draft);
      } else setDraft(null);
      setError(null);
      setNotice(
        previous
          ? '已读取最新材料和权限，本次原稿已保留；请重新核对完整内容及附件后保存。'
          : '已读取最新标准材料，请核对当前内容。',
      );
    } catch (failure) {
      if (sameSession()) setReadError(failure);
    } finally {
      writing.current = false;
      allowLeave.current = false;
      if (mounted.current) setReading(false);
    }
  }

  function input(values = draft) {
    if (!materials.data || !values) return null;
    try {
      return standardTrainingInput(materials.data, values);
    } catch (failure) {
      setError(failure);
      return null;
    }
  }
  async function submit(source = draft) {
    if (disabled || writing.current || uploading || !sameSession() || !source) return;
    const values = input(source);
    if (!values) {
      setConfirming(false);
      return;
    }
    const previous = pendingWrites.get(writeKey);
    if (previous) return;
    const state: MaterialsWrite = {
      id: crypto.randomUUID(),
      originRole: role,
      status: 'unknown',
      input: values,
      draft: source,
    };
    writing.current = true;
    setSaving(true);
    setError(null);
    setReadError(null);
    setNotice('');
    let saved = false;
    try {
      requireSession();
      requireOrigin();
      setPending(state);
      const result = await api.updateProjectStandardMaterials(values);
      saved = true;
      setPending({ ...state, status: 'success' }, state.id);
      if (!sameSession()) return;
      cache.setQueryData(scope, result);
      setDraft(null);
      setConfirming(false);
      setNotice('标准材料已保存并发布。');
      await finish(state);
    } catch (failure) {
      if (!saved) {
        if (standardTrainingFailureIsUnknown(failure))
          setPending({ ...state, status: 'unknown' }, state.id);
        else if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setPending({ ...state, status: 'access' }, state.id);
        else if (failure instanceof ApiError && failure.status === 409)
          setPending({ ...state, status: 'conflict' }, state.id);
        else setPending(null, state.id);
      }
      if (sameSession()) {
        if (saved) {
          setReadError(failure);
          setNotice('标准材料已保存，最新资料尚未读取完成；只需重新读取，不会重复提交。');
        } else setError(failure);
      }
      if (failure instanceof ApiError && failure.status === 401 && sameIdentity())
        void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } finally {
      writing.current = false;
      allowLeave.current = false;
      if (mounted.current) {
        setSaving(false);
        setConfirming(false);
      }
    }
  }

  if (!isRole) return null;
  const data = materials.isSuccess ? materials.data : undefined;
  return (
    <section aria-label="标准与培训" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>标准与培训</CardTitle>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={reading || materials.isFetching || permission.isFetching}
          disabled={saving || uploading}
          onClick={() => void reread()}
        >
          <RefreshCw className="size-4" aria-hidden />
          重新读取标准材料
        </Button>
      </header>
      <ErrorNotice error={materials.error} />
      <ErrorNotice error={role === 'PM' ? permission.error : null} />
      <ErrorNotice error={readError} />
      {notice && (
        <p role="status" className="text-[13px] text-primary">
          {notice}
        </p>
      )}
      {!data && materials.isPending && <LoadingState>正在读取标准材料…</LoadingState>}
      {lock && (
        <Alert>
          {foreignLock
            ? '此项目存在其他角色的未核实材料保存，请切回原角色处理；当前只读，不展示或恢复原稿。'
            : lock === 'success'
              ? '标准材料已保存，但最新资料读取尚未完成，请重新读取核对。'
              : lock === 'unknown'
                ? '提交结果暂未确认，原稿和附件凭证已保留；读取当前材料不能证明上次保存成功，不会重复提交。'
                : lock === 'conflict'
                  ? '标准材料已发生变化，请重新读取后核对。'
                  : '当前无权维护标准材料，请重新读取权限或返回项目列表。'}
        </Alert>
      )}
      {role === 'PM' && pending && !foreignLock && pending.status !== 'success' && !draft && (
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={saving || reading}
          onClick={() => setDraft(pending.draft)}
        >
          恢复上次标准材料
        </Button>
      )}
      {data && !data.standardContent?.trim() && !data.attachments.length && (
        <EmptyState title="暂无数据" />
      )}
      {data && (Boolean(data.standardContent?.trim()) || data.attachments.length > 0) && (
        <>
          {role === 'PM' && permission.data === false && (
            <p className="text-[13px] text-muted-foreground">当前材料仅可查看，由主策略官维护。</p>
          )}
          {draft && role === 'PM' ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                if (!disabled && !uploading && input()) setConfirming(true);
              }}
              className="space-y-4"
            >
              <fieldset disabled={disabled} className="min-w-0 space-y-4">
                <FormField
                  controlId="standard-content"
                  label="标准正文"
                  description="请填写标准正文。"
                >
                  <MarkdownEditor
                    id="standard-content"
                    ariaLabel="标准正文"
                    disabled={disabled}
                    value={draft.standardContent}
                    onValueChange={(value) => setDraft({ ...draft, standardContent: value })}
                  />
                </FormField>
                <StrategistExamFiles
                  label="标准附件"
                  purpose="project"
                  files={draft.files}
                  limit={20}
                  disabled={disabled}
                  user={user}
                  role={role}
                  onChange={(update) =>
                    setDraft((current) =>
                      current ? { ...current, files: update(current.files) } : current,
                    )
                  }
                />
              </fieldset>
              <ErrorNotice error={error} />
              <footer className="flex flex-wrap justify-end gap-3 border-t pt-3">
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={saving || reading || uploading}
                  onClick={() => {
                    if (!dirty || window.confirm('未保存的标准材料将会丢失，确认取消编辑？')) {
                      setDraft(null);
                      setError(null);
                    }
                  }}
                >
                  取消编辑
                </Button>
                <Button
                  type="submit"
                  size="mobileTouch"
                  loading={saving}
                  disabled={disabled || uploading}
                >
                  保存并发布标准
                </Button>
              </footer>
            </form>
          ) : (
            <>
              <StandardMaterialsContent user={user} materials={data} />
              <ErrorNotice error={error} />
              {canManage && (
                <div className="flex flex-wrap justify-end gap-3 border-t pt-3">
                  <Button
                    size="mobileTouch"
                    disabled={disabled}
                    onClick={() => {
                      const next = standardTrainingDraft(data);
                      original.current = JSON.stringify(next);
                      setDraft(next);
                      setNotice('');
                      setError(null);
                    }}
                  >
                    <Pencil className="size-4" aria-hidden />
                    编辑标准材料
                  </Button>
                  <Button
                    size="mobileTouch"
                    disabled={disabled}
                    loading={saving}
                    onClick={() => void submit(standardTrainingDraft(data))}
                  >
                    标准发布
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {confirming && (
        <EntranceExamDialog
          label="发布标准材料"
          title="发布标准材料"
          busy={saving}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={saving}
                onClick={() => setConfirming(false)}
              >
                继续编辑
              </Button>
              <Button
                size="mobileTouch"
                loading={saving}
                disabled={disabled || uploading}
                onClick={() => void submit()}
              >
                确认发布
              </Button>
            </>
          }
        >
          <p className="text-[14px] leading-6">
            确认后标准材料将保存并对有权查看的执行专家可见。前序标准环节会推进至招募执行专家，后续阶段保持当前进度。
          </p>
        </EntranceExamDialog>
      )}
    </section>
  );
}
