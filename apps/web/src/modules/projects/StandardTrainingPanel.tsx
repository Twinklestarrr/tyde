import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Pencil, RefreshCw } from 'lucide-react';
import { ApiError, type AuthUser } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { EntranceExamDialog } from './EntranceExamDialog';
import { StandardMaterialsContent } from './StandardMaterialsContent';
import { StrategistExamFiles } from './StrategistExamFiles';
import {
  standardTrainingDraft,
  standardTrainingInput,
  type StandardTrainingDraft,
} from './standard-training-form';

export const STANDARD_TRAINING_LEAVE_REQUEST = 'tyde:before-standard-training-leave';
type WriteLock = 'unknown' | 'conflict' | 'access' | 'success';

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
export function StandardTrainingPanel({
  user,
  projectId,
  onChanged,
}: {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
}) {
  const cache = useQueryClient();
  const isPm = (user.selectedRole ?? user.role) === 'PM';
  const scope = ['project-standard-materials', user.id, 'PM', projectId] as const;
  const permissionsKey = [...scope, 'can-manage'];
  const lockKey = [...scope, 'write-lock'];
  const materials = useQuery({
    queryKey: scope,
    queryFn: () => api.getProjectStandardMaterials(projectId),
    enabled: isPm,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const permission = useQuery({
    queryKey: permissionsKey,
    queryFn: () => materialsManagement(projectId),
    enabled: isPm,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // 未核实的写结果跨Tab保留，重新挂载的自动读取不能自行解锁旧操作。
  const lockState = useQuery<WriteLock | null>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const lock = lockState.data;
  const setLock = (value: WriteLock | null) => cache.setQueryData(lockKey, value);
  const [draft, setDraft] = useState<StandardTrainingDraft | null>(null);
  const original = useRef('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const writing = useRef(false);
  const dirty = draft !== null && JSON.stringify(draft) !== original.current;
  const uploading = draft?.files.some((file) => file.status === 'uploading') ?? false;
  const canManage =
    isPm &&
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
  function sameSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && current?.id === user.id && (current.selectedRole ?? current.role) === 'PM'
    );
  }
  useEffect(() => {
    function beforeLeave(event: Event) {
      if (
        writing.current ||
        uploading ||
        (dirty && !window.confirm('未保存的标准材料将会丢失，确认离开？'))
      )
        event.preventDefault();
    }
    window.addEventListener(STANDARD_TRAINING_LEAVE_REQUEST, beforeLeave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(STANDARD_TRAINING_LEAVE_REQUEST, beforeLeave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    };
  }, [dirty, uploading]);
  useBlocker({
    shouldBlockFn: () => {
      const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      if (current && (current.id !== user.id || (current.selectedRole ?? current.role) !== 'PM'))
        return false;
      return (
        writing.current ||
        uploading ||
        (dirty && !window.confirm('未保存的标准材料将会丢失，确认离开？'))
      );
    },
    enableBeforeUnload: () => writing.current || uploading || dirty,
  });

  async function reread(discard = true, written = false) {
    if (reading || writing.current || uploading || !sameSession()) return;
    if (discard && dirty && !window.confirm('重新读取将替换未保存的标准材料，确认继续？')) return;
    const previousLock = cache.getQueryData<WriteLock | null>(lockKey) ?? null;
    const confirmed = written || previousLock === 'success';
    setReading(true);
    setReadError(null);
    try {
      if (confirmed) {
        // 父级可能切换待办或返回列表，先清除已确定成功的持久锁。
        setLock(null);
        await onChanged();
        if (!sameSession()) return;
      }
      const [result, allowed] = await Promise.all([
        api.getProjectStandardMaterials(projectId),
        materialsManagement(projectId),
      ]);
      if (!sameSession()) return;
      cache.setQueryData(scope, result);
      cache.setQueryData(permissionsKey, allowed);
      setDraft(null);
      if (!confirmed) {
        setLock(null);
        await onChanged();
        if (!sameSession()) return;
      }
      setError(null);
      setNotice('已读取最新标准材料，请核对当前内容。');
    } catch (failure) {
      if (sameSession()) {
        setLock(previousLock);
        setReadError(failure);
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setLock('access');
      }
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  function input() {
    if (!materials.data || !draft) return null;
    try {
      return standardTrainingInput(materials.data, draft);
    } catch (failure) {
      setError(failure);
      return null;
    }
  }
  async function submit() {
    if (disabled || writing.current || uploading || !sameSession()) return;
    const values = input();
    if (!values) {
      setConfirming(false);
      return;
    }
    writing.current = true;
    setSaving(true);
    setError(null);
    setReadError(null);
    setNotice('');
    let saved = false;
    try {
      const result = await api.updateProjectStandardMaterials(values);
      if (!sameSession()) return;
      saved = true;
      setLock('success');
      cache.setQueryData(scope, result);
      setDraft(null);
      setNotice('标准材料已保存并发布。');
    } catch (failure) {
      if (sameSession()) {
        setError(failure);
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
          setLock('access');
        else if (failure instanceof ApiError && failure.status === 409) setLock('conflict');
        else if (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500)
          setLock('unknown');
      }
    } finally {
      writing.current = false;
      if (mounted.current) {
        setSaving(false);
        setConfirming(false);
      }
    }
    if (saved && sameSession()) await reread(false, true);
  }

  if (!isPm) return null;
  const data = materials.data;
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
      <ErrorNotice error={permission.error} />
      <ErrorNotice error={readError} />
      {notice && (
        <p role="status" className="text-[13px] text-primary">
          {notice}
        </p>
      )}
      {!data && materials.isPending && <LoadingState>正在读取标准材料…</LoadingState>}
      {lock && (
        <Alert>
          {lock === 'success'
            ? '标准材料已保存，但最新资料读取尚未完成，请重新读取核对。'
            : lock === 'unknown'
              ? '提交结果暂未确认，请先重新读取标准材料核对，避免重复发布。'
              : lock === 'conflict'
                ? '标准材料已发生变化，请重新读取后核对。'
                : '当前无权维护标准材料，请重新读取权限或返回项目列表。'}
        </Alert>
      )}
      {data && (
        <>
          {permission.data === false && (
            <p className="text-[13px] text-muted-foreground">当前材料仅可查看，由主策略官维护。</p>
          )}
          {draft ? (
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
                  description="标准正文与标准链接至少填写一项。"
                >
                  <Textarea
                    id="standard-content"
                    rows={6}
                    value={draft.standardContent}
                    onChange={(event) =>
                      setDraft({ ...draft, standardContent: event.target.value })
                    }
                  />
                </FormField>
                <FormField
                  controlId="standard-link"
                  label="标准链接"
                  description="可填写文档地址，最多2000字符。"
                >
                  <Input
                    id="standard-link"
                    value={draft.standardLink}
                    maxLength={2000}
                    onChange={(event) => setDraft({ ...draft, standardLink: event.target.value })}
                  />
                </FormField>
                <StrategistExamFiles
                  label="标准附件"
                  purpose="project"
                  files={draft.files}
                  limit={20}
                  disabled={disabled}
                  user={user}
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
                <div className="flex justify-end border-t pt-3">
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
