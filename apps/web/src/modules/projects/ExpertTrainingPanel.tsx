import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import {
  ApiError,
  type AuthUser,
  type ExpertTask,
  type ProjectStandardMaterials,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/empty-state';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { StandardMaterialsContent } from './StandardMaterialsContent';

export const EXPERT_TRAINING_LEAVE_REQUEST = 'tyde:before-expert-training-leave';
type ReadLock = 'unknown' | 'conflict' | 'access' | 'success' | null;
const contentKey = (data: ProjectStandardMaterials) =>
  JSON.stringify([data.standardContent, data.standardLink, data.attachments]);

/** 阅读资格以服务端字段为准，确认后只读取原来源的新待办，不猜测生产阶段。 */
export function ExpertTrainingPanel({
  user,
  task,
  onConfirmed,
}: {
  user: AuthUser;
  task: ExpertTask;
  onConfirmed: () => Promise<void>;
}) {
  const cache = useQueryClient();
  const projectId = task.basicInfo.projectId;
  const scope = [
    'expert-standard-materials',
    user.id,
    'EXPERT',
    projectId,
    task.sourceBizType,
    task.sourceBizId,
  ];
  const lockKey = [...scope, 'read-lock'];
  const lock = useQuery<ReadLock>({
    queryKey: lockKey,
    queryFn: async () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  }).data;
  const setLock = (value: ReadLock) => cache.setQueryData(lockKey, value);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const working = useRef(false);
  const materials = useQuery({
    queryKey: scope,
    queryFn: readMaterials,
    enabled: open,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = materials.data;
  const checked = !!data && acknowledged === contentKey(data);
  const canConfirm =
    data?.canConfirmRead === true &&
    data.confirmedReadAt === null &&
    !materials.isError &&
    !materials.isFetching &&
    !lock;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const beforeLeave = (event: Event) => {
      if (working.current) event.preventDefault();
    };
    window.addEventListener(EXPERT_TRAINING_LEAVE_REQUEST, beforeLeave);
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    return () => {
      window.removeEventListener(EXPERT_TRAINING_LEAVE_REQUEST, beforeLeave);
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeLeave);
    };
  }, []);
  useBlocker({ shouldBlockFn: () => working.current, enableBeforeUnload: () => working.current });

  function sameSession() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current &&
      session?.id === user.id &&
      (session.selectedRole ?? session.role) === 'EXPERT'
    );
  }
  function requireSession() {
    if (!sameSession()) throw new Error('登录身份已变化，请重新打开工作台。');
  }
  async function readMaterials() {
    requireSession();
    const result = await api.getProjectStandardMaterials(projectId);
    requireSession();
    return result;
  }
  async function requireTrainingTask() {
    requireSession();
    const tasks = await api.getMyExpertTasks();
    requireSession();
    if (
      !tasks.some(
        (item) =>
          item.sourceBizType === task.sourceBizType &&
          item.sourceBizId === task.sourceBizId &&
          item.basicInfo.projectId === projectId &&
          item.acceptanceStatus === 'ACCEPTED' &&
          item.branchNodeCode === 'STANDARD_TRAINING',
      )
    ) {
      setLock('access');
      throw new Error('当前来源已无标准培训待办，请刷新项目。');
    }
  }
  function failed(value: unknown, write = false) {
    if (!sameSession()) return;
    setError(value);
    if (value instanceof ApiError && [401, 403, 404].includes(value.status)) {
      setLock('access');
      if (value.status === 401) void cache.invalidateQueries({ queryKey: SESSION_KEY });
    } else if (write) {
      setLock(
        value instanceof ApiError && [400, 409].includes(value.status) ? 'conflict' : 'unknown',
      );
    }
  }
  async function complete() {
    setOpen(false);
    setAcknowledged(null);
    try {
      await onConfirmed();
    } catch (value) {
      if (sameSession()) setError(value);
    }
  }
  async function reread(verify = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    let confirmed = false;
    try {
      const latest = await readMaterials();
      cache.setQueryData(scope, latest);
      setAcknowledged(null);
      if (verify) {
        if (latest.confirmedReadAt) {
          setLock('success');
          confirmed = true;
        } else if (latest.canConfirmRead) {
          await requireTrainingTask();
          setLock(null);
          setNotice('已核实当前仍可确认阅读，请重新勾选后确认。');
        } else {
          setNotice('当前仅可查看材料，尚不能确认上次操作结果。请刷新项目核对本人资格。');
        }
      } else setNotice('已读取最新标准材料。');
    } catch (value) {
      failed(value);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
    if (confirmed && sameSession()) await complete();
  }
  async function confirmRead() {
    if (
      !data ||
      !checked ||
      !canConfirm ||
      working.current ||
      cache.getQueryData<ReadLock>(lockKey)
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    let confirmed = false;
    let sent = false;
    try {
      await requireTrainingTask();
      const latest = await readMaterials();
      cache.setQueryData(scope, latest);
      if (latest.confirmedReadAt) {
        setLock('success');
        confirmed = true;
      } else if (!latest.canConfirmRead) {
        setLock('access');
        setNotice('当前仅可查看材料，尚无确认阅读资格。');
      } else if (contentKey(latest) !== contentKey(data)) {
        setAcknowledged(null);
        setNotice('标准材料已更新，请重新阅读后再确认。');
      } else {
        sent = true;
        const result = await api.confirmProjectStandardMaterialsRead(projectId);
        requireSession();
        cache.setQueryData(scope, result);
        setLock('success');
        confirmed = true;
        await cache.invalidateQueries({
          queryKey: ['profile-workbench', user.id],
          refetchType: 'none',
        });
      }
    } catch (value) {
      failed(value, sent);
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        setConfirming(false);
      }
    }
    if (confirmed && sameSession()) await complete();
  }
  function close() {
    if (working.current) return;
    setOpen(false);
    setAcknowledged(null);
    setConfirming(false);
  }
  return (
    <>
      <Card asChild>
        <section aria-label="标准培训待办" className="space-y-4 p-5">
          <CardTitle asChild>
            <h2>标准与培训</h2>
          </CardTitle>
          <p className="text-[13px] leading-6 text-muted-foreground">
            阅读当前项目的作业标准与参考材料。符合入项资格的普通成员可确认已阅读。
          </p>
          <Button size="mobileTouch" onClick={() => setOpen(true)}>
            查看标准与培训
          </Button>
        </section>
      </Card>
      {open && (
        <Dialog
          title="标准与培训"
          aria-label="标准与培训"
          closeLabel="关闭标准与培训"
          size="lg"
          busy={busy}
          onClose={close}
          footer={
            <>
              <Button variant="outline" size="mobileTouch" disabled={busy} onClick={close}>
                关闭
              </Button>
              {lock && lock !== 'success' && (
                <Button
                  variant="outline"
                  size="mobileTouch"
                  loading={busy}
                  onClick={() => void reread(true)}
                >
                  核实阅读状态
                </Button>
              )}
              {(lock === 'success' || data?.confirmedReadAt) && (
                <Button size="mobileTouch" disabled={busy} onClick={() => void complete()}>
                  更新项目待办
                </Button>
              )}
              {data?.canConfirmRead && !data.confirmedReadAt && !lock && (
                <Button
                  size="mobileTouch"
                  disabled={!checked || !canConfirm || busy}
                  onClick={() => setConfirming(true)}
                >
                  确认已阅读
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">请阅读正文、标准链接及参考附件。</p>
            <Button
              variant="outline"
              size="mobileTouch"
              loading={busy || materials.isFetching}
              onClick={() => void reread()}
            >
              <RefreshCw className="size-4" aria-hidden />
              重新读取标准材料
            </Button>
          </div>
          {materials.isPending && <LoadingState>正在读取标准材料…</LoadingState>}
          <ErrorNotice error={materials.error} />
          <ErrorNotice error={error} />
          {notice && <Alert>{notice}</Alert>}
          {lock && lock !== 'success' && (
            <Alert>
              {lock === 'unknown'
                ? '阅读确认结果尚未确认，请先核实阅读状态，避免重复提交。'
                : lock === 'conflict'
                  ? '本人阅读状态已变化，请先核实阅读状态。'
                  : '当前确认操作已暂停，请核实阅读状态或刷新项目。'}
            </Alert>
          )}
          {data && !materials.isError && (
            <>
              <StandardMaterialsContent user={user} materials={data} />
              {data.confirmedReadAt ? (
                <Alert>本人已确认阅读：{data.confirmedReadAt}（上海时间）。</Alert>
              ) : !data.canConfirmRead ? (
                <p className="text-[13px] leading-6 text-muted-foreground">
                  当前仅可查看材料，已实际入项的普通成员可确认阅读；项目负责人无需使用此入口。
                </p>
              ) : (
                <label className="flex min-h-11 items-start gap-3 text-[13px] leading-6">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={checked}
                    disabled={busy || !canConfirm}
                    onChange={(event) =>
                      setAcknowledged(event.target.checked ? contentKey(data) : null)
                    }
                  />
                  我已阅读并理解以上标准与培训材料。
                </label>
              )}
            </>
          )}
        </Dialog>
      )}
      {open && confirming && (
        <Dialog
          title="确认已阅读"
          aria-label="确认已阅读"
          size="sm"
          busy={busy}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                继续阅读
              </Button>
              <Button
                size="mobileTouch"
                loading={busy}
                disabled={!checked || !canConfirm}
                onClick={() => void confirmRead()}
              >
                确认已阅读
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            确认已理解当前作业标准及参考材料后，将记录本人的阅读时间，并重新读取后续待办。
          </p>
        </Dialog>
      )}
    </>
  );
}
