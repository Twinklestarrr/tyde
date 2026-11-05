import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ExpertTask } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { sameExpertProductionSource } from './expert-production-form';
import {
  canManageExpertPersonnel,
  expertOwnerIds,
  expertOwnersInput,
} from './expert-personnel-form';
import { useProductionFeedback, type ProductionWrite } from './production-feedback';

export function ExpertProjectOwners({
  user,
  task,
  onChanged,
  onClose,
}: {
  user: AuthUser;
  task: ExpertTask;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string[]>(() => expertOwnerIds(task));
  const dirty =
    JSON.stringify([...selected].sort()) !== JSON.stringify(expertOwnerIds(task).sort());
  const feedback = useProductionFeedback<string[]>(
    user,
    `expert-owners:${task.assignmentId}`,
    dirty,
    'EXPERT',
  );
  const [keyword, setKeyword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const ids = feedback.lock?.draft ?? selected;
  const candidates = useQuery({
    queryKey: ['expert-owner-candidates', user.id, 'EXPERT', task.assignmentId],
    queryFn: async () => {
      feedback.requireIdentity();
      const rows = await api.getExpertProjectOwnerCandidates(task.assignmentId!);
      feedback.requireIdentity();
      return rows;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const initializedCandidates = useRef(false);
  useEffect(() => {
    if (
      initializedCandidates.current ||
      !candidates.isSuccess ||
      candidates.isFetching ||
      feedback.lock
    )
      return;
    initializedCandidates.current = true;
    setSelected(
      candidates.data
        .filter((candidate) => candidate.projectOwner)
        .map((candidate) => candidate.userId),
    );
  }, [candidates.data, candidates.isSuccess, candidates.isFetching, feedback.lock]);
  const blocked =
    feedback.busy || !!feedback.lock || !candidates.isSuccess || candidates.isFetching;
  async function latestTask() {
    feedback.requireSession();
    const tasks = await api.getMyExpertTasks();
    feedback.requireSession();
    const latest = tasks.find((row) => sameExpertProductionSource(row, task));
    if (
      !latest ||
      !canManageExpertPersonnel(latest) ||
      !latest.accessContext.acceptedOrganizationOwner
    )
      throw new Error('原组织来源或主管资格已变化，请重新读取项目。');
    return latest;
  }
  async function complete(state: ProductionWrite<string[]>) {
    await feedback.finish(state, async () => {
      await onChanged();
      if (!feedback.sameIdentity()) return;
      await cache.invalidateQueries(
        { queryKey: ['expert-owner-candidates', user.id, 'EXPERT', task.assignmentId] },
        { throwOnError: true },
      );
    });
    if (feedback.sameSession()) onClose();
  }
  async function reread() {
    if (!feedback.start()) return;
    setError(null);
    try {
      feedback.requireSession();
      feedback.requireOrigin();
      const state = feedback.lock;
      if (state?.status === 'success') {
        await complete(state);
        return;
      }
      await latestTask();
      await candidates.refetch({ throwOnError: true });
      feedback.requireSession();
      if (state?.status === 'unknown')
        setNotice(
          '已读取当前负责人和候选，仍无法确认上次命令的结果。原集合继续保留，暂停重复提交。',
        );
      else if (state) {
        setSelected(state.draft);
        feedback.clear(state);
        setNotice('已读取最新资格与候选，请核对原完整集合后操作。');
      }
    } catch (value) {
      if (feedback.sameSession()) setError(value);
    } finally {
      feedback.stop();
    }
  }
  async function save() {
    if (blocked || !feedback.start()) return;
    setError(null);
    let state: ProductionWrite<string[]> | undefined;
    let written = false;
    try {
      const latest = await latestTask();
      const rows = await candidates.refetch({ throwOnError: true });
      feedback.requireSession();
      const input = expertOwnersInput(latest, selected, rows.data ?? []);
      state = feedback.begin([...selected]);
      if (!state) return;
      await api.setExpertProjectOwners(input);
      written = true;
      feedback.markSuccess(state);
      feedback.requireSession();
      setConfirm(false);
      setNotice('项目负责人已更换。');
      await complete(state);
    } catch (value) {
      if (state && !written) feedback.markFailure(state, value);
      if (feedback.sameSession()) {
        setConfirm(false);
        setError(value);
        if (written) setNotice('负责人已保存，后续待办读取失败，请重新读取负责人信息。');
      }
    } finally {
      feedback.stop();
    }
  }
  function close() {
    if (
      feedback.busy ||
      (!feedback.lock && dirty && !window.confirm('负责人选择尚未保存，确认放弃？'))
    )
      return;
    onClose();
  }
  return (
    <>
      <Dialog
        title="管理项目负责人"
        aria-label="管理项目负责人"
        size="md"
        onClose={close}
        busy={feedback.busy}
        footer={
          <>
            <Button variant="outline" size="mobileTouch" disabled={feedback.busy} onClick={close}>
              关闭负责人管理
            </Button>
            {feedback.lock ? (
              <Button size="mobileTouch" loading={feedback.busy} onClick={() => void reread()}>
                重新读取负责人信息
              </Button>
            ) : (
              <Button
                size="mobileTouch"
                disabled={blocked}
                onClick={() => {
                  try {
                    expertOwnersInput(task, selected, candidates.data ?? []);
                    setError(null);
                    setConfirm(true);
                  } catch (value) {
                    setError(value);
                  }
                }}
              >
                保存项目负责人
              </Button>
            )}
          </>
        }
      >
        <p className="text-[13px] leading-6 text-muted-foreground">
          选择1至20名当前组织的有效成员。保存将完整替换负责人集合；移除负责人身份保留已有考试、参与及成员历史。
        </p>
        <ErrorNotice error={error} />
        <ErrorNotice error={candidates.error} />
        {notice && <Alert>{notice}</Alert>}
        {feedback.lock && (
          <Alert>
            {feedback.lock.status === 'success'
              ? '负责人更换已成功，后续读取尚未完成；只重试读取。'
              : feedback.lock.status === 'unknown'
                ? '负责人更换结果尚未确认，原集合保留，暂停重发。'
                : '来源、候选或权限已变化，请先重新读取负责人信息。'}
          </Alert>
        )}
        <div className="space-y-2 text-[13px]">
          <p>已选 {ids.length} / 20 名</p>
          <div className="flex flex-wrap gap-2">
            {ids.map((id) => {
              const name =
                candidates.data?.find((row) => row.userId === id)?.name ??
                task.basicInfo.projectOwners.find((row) => row.userId === id)?.name ??
                (task.basicInfo.projectOwnerUserId === id
                  ? task.basicInfo.projectOwnerName
                  : null) ??
                id;
              return (
                <Button
                  key={id}
                  variant="outline"
                  size="mobileTouch"
                  className="h-auto min-h-11 max-w-full whitespace-normal"
                  disabled={blocked}
                  aria-label={`移除负责人${name}`}
                  onClick={() => setSelected((old) => old.filter((value) => value !== id))}
                >
                  <span className="min-w-0 break-words">{name} · 移除</span>
                </Button>
              );
            })}
          </div>
        </div>
        <SearchInput
          id="expert-owner-filter"
          label="筛选负责人候选"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="姓名或用户 ID"
        />
        {candidates.isPending && <LoadingState>正在读取负责人候选…</LoadingState>}
        {candidates.isError && (
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={feedback.busy}
            onClick={() => void candidates.refetch()}
          >
            重试读取负责人候选
          </Button>
        )}
        <fieldset
          tabIndex={0}
          aria-label="项目负责人候选"
          disabled={blocked}
          className="max-h-96 space-y-2 overflow-y-auto rounded-xl border p-3"
        >
          <legend className="px-1 text-[13px]">当前组织有效候选</legend>
          {candidates.data
            ?.filter(
              (row) => !keyword.trim() || `${row.name} ${row.userId}`.includes(keyword.trim()),
            )
            .map((row) => (
              <label
                key={row.userId}
                className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-[13px]"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label={`选择负责人${row.name}`}
                  checked={ids.includes(row.userId)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...new Set([...old, row.userId])]
                        : old.filter((id) => id !== row.userId),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {row.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.userId}
                    {row.projectOwner ? ' · 现任负责人' : ''}
                  </span>
                </span>
              </label>
            ))}
          {candidates.isSuccess && !candidates.data.length && (
            <EmptyState title="暂无有效负责人候选" />
          )}
        </fieldset>
      </Dialog>
      {confirm && (
        <Dialog
          title="确认更换项目负责人"
          aria-label="确认更换项目负责人"
          size="sm"
          busy={feedback.busy}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={feedback.busy}
                onClick={() => setConfirm(false)}
              >
                取消
              </Button>
              <Button size="mobileTouch" loading={feedback.busy} onClick={() => void save()}>
                确认更换
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6">
            将使用所选 {selected.length}{' '}
            名成员作为完整负责人集合。保存前会重新核对当前主管资格和有效候选。
          </p>
        </Dialog>
      )}
    </>
  );
}
