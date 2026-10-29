import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  requiresExpertProjectOwners,
  type AuthUser,
  type ExpertTask,
  type ExpertTaskResponse,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { OrganizationDialog, positionLabels } from '@/modules/organizations/common';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';

export function ExpertTaskResponseDialog({
  task,
  decision,
  user,
  onClose,
  onReload,
  onUncertain,
  onWritten,
}: {
  task: ExpertTask;
  decision: 'ACCEPT' | 'REJECT';
  user: AuthUser;
  onClose: () => void;
  onReload: () => Promise<ExpertTask | null>;
  onUncertain: () => Promise<void>;
  onWritten: (result: ExpertTaskResponse) => Promise<void>;
}) {
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sessionMatches = () => {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current &&
      session?.id === user.id &&
      (session.selectedRole ?? session.role) === 'EXPERT'
    );
  };
  const [current, setCurrent] = useState<ExpertTask | null>(task);
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [notice, setNotice] = useState('');
  const accepting = decision === 'ACCEPT';
  const ownersRequired = !!current && accepting && requiresExpertProjectOwners(current, user);
  const candidates = useQuery({
    queryKey: ['expert-owner-candidates', user.id, task.assignmentId],
    queryFn: () => api.getExpertProjectOwnerCandidates(task.assignmentId!),
    enabled: ownersRequired,
    retry: false,
  });
  const allowed = !!current && current.operations[accepting ? 'canAccept' : 'canReject'];

  async function failed(failure: unknown) {
    if (!sessionMatches()) return;
    setError(failure);
    // 未收到确定结果时，先读真值；不自动重放接单或拒绝请求。
    if (
      !(failure instanceof ApiError) ||
      failure.status === 0 ||
      failure.status >= 500 ||
      [401, 403, 404, 409].includes(failure.status)
    ) {
      setNeedsReload(true);
      await onUncertain();
    }
    if (failure instanceof ApiError && failure.status === 401 && sessionMatches())
      await cache.invalidateQueries({ queryKey: SESSION_KEY });
  }
  async function reload() {
    if (submitting.current || !sessionMatches()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const latest = await onReload();
      if (!sessionMatches()) return;
      setCurrent(latest);
      if (latest && accepting && requiresExpertProjectOwners(latest, user)) {
        const result = await candidates.refetch();
        if (!sessionMatches()) return;
        if (result.isError) throw result.error;
      }
      setNeedsReload(false);
      setNotice(
        latest
          ? '已读取最新任务，请核对后再提交。'
          : '当前任务已处理或已移出待办，请关闭弹窗查看最新列表。',
      );
    } catch (failure) {
      await failed(failure);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || needsReload || !allowed || !current || !sessionMatches()) return;
    setError(null);
    setNotice('');
    if (!accepting && !reason.trim()) {
      setError(new Error('请填写拒绝原因'));
      return;
    }
    if (
      ownersRequired &&
      (!candidates.isSuccess ||
        ownerIds.length < 1 ||
        ownerIds.length > 20 ||
        ownerIds.some((id) => !candidates.data.some((candidate) => candidate.userId === id)))
    ) {
      setError(new Error('请选择 1 至 20 名当前有效的项目负责人'));
      return;
    }
    submitting.current = true;
    setBusy(true);
    let result: ExpertTaskResponse;
    try {
      result = await api.respondExpertTask({
        ...(current.assignmentId === null
          ? { movementId: current.movementId }
          : { assignmentId: current.assignmentId }),
        decision,
        ...(ownersRequired ? { projectOwnerUserIds: ownerIds } : {}),
        ...(!accepting ? { rejectReason: reason.trim() } : {}),
      });
    } catch (failure) {
      await failed(failure);
      submitting.current = false;
      if (mounted.current) setBusy(false);
      return;
    }
    if (sessionMatches()) await onWritten(result);
  }

  return (
    <OrganizationDialog title={accepting ? '确认接单' : '拒绝项目'} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-2 text-[13px] leading-6">
          <p className="break-words font-medium">{task.basicInfo.projectName || '未命名项目'}</p>
          <p className="text-muted-foreground">
            {task.basicInfo.organizationName || '个人参与'}
            {task.sourceBizType === 'PROJECT_MEMBER_TRANSFER' && ' · 转入项目'}
          </p>
          <p>
            {accepting
              ? '确认接受该任务，后续安排以最新项目状态为准。'
              : '拒绝后当前任务将移出待办，请确认原因后提交。'}
          </p>
        </div>
        {ownersRequired && (
          <fieldset disabled={busy} className="space-y-3">
            <legend className="text-[13px] font-medium">
              选择项目负责人（可多选，1 至 20 人）
            </legend>
            <ErrorNotice error={candidates.error} />
            {candidates.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取负责人候选…
              </p>
            )}
            {candidates.isError && (
              <Button
                variant="outline"
                size="mobileTouch"
                onClick={() => void candidates.refetch()}
              >
                重试读取负责人
              </Button>
            )}
            {candidates.isSuccess && !candidates.data.length && (
              <p className="text-sm text-muted-foreground">暂无有效负责人候选，暂不能接单。</p>
            )}
            <div className="max-h-64 overflow-y-auto rounded-xl border p-2">
              {(candidates.data ?? []).map((candidate) => (
                <label
                  key={candidate.userId}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg p-2 text-[13px]"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={ownerIds.includes(candidate.userId)}
                    disabled={!ownerIds.includes(candidate.userId) && ownerIds.length >= 20}
                    onChange={(event) =>
                      setOwnerIds((ids) =>
                        event.target.checked
                          ? [...ids, candidate.userId]
                          : ids.filter((id) => id !== candidate.userId),
                      )
                    }
                  />
                  <span className="min-w-0 break-words">
                    {candidate.name} · {positionLabels[candidate.position]}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              已选择 {ownerIds.length} 人；接单后由所选负责人管理项目成员。
            </p>
          </fieldset>
        )}
        {!accepting && (
          <div className="space-y-2">
            <label htmlFor="expert-reject-reason" className="text-[13px] font-medium">
              拒绝原因
            </label>
            <Textarea
              id="expert-reject-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={4}
              disabled={busy}
              required
            />
            <p className="text-xs text-muted-foreground">最多 500 字。</p>
          </div>
        )}
        <ErrorNotice error={error} />
        {notice && (
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            {notice}
          </p>
        )}
        {needsReload && (
          <p className="text-sm leading-6 text-muted-foreground">
            请先刷新任务状态，核对操作结果后再决定是否提交。
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3 border-t pt-4">
          <Button variant="outline" size="mobileTouch" disabled={busy} onClick={onClose}>
            取消
          </Button>
          {needsReload && (
            <Button
              variant="outline"
              size="mobileTouch"
              loading={busy}
              onClick={() => void reload()}
            >
              刷新任务状态
            </Button>
          )}
          <Button
            type="submit"
            variant={accepting ? 'success' : 'destructive'}
            size="mobileTouch"
            loading={busy}
            disabled={
              !allowed ||
              needsReload ||
              (ownersRequired && (!candidates.isSuccess || !ownerIds.length))
            }
          >
            {accepting ? '确认接单' : '确认拒绝'}
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}
