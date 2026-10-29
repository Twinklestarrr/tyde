import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, UserRound } from 'lucide-react';
import { ApiError, type AuthUser, type ProjectManagerCandidate } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** 任职摘要始终来自无关键词查询，搜索不能把当前策略官变成“尚未招募”。 */
export function ProjectManagerPanel({
  user,
  projectId,
  refreshProject,
}: {
  user: AuthUser;
  projectId: number;
  refreshProject: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [changing, setChanging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lock, setLock] = useState<'conflict' | 'unknown' | 'success' | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState<ProjectManagerCandidate | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = ['project-managers', user.id, 'NAVIGATOR', projectId] as const;
  const candidates = useQuery({
    queryKey: [...key, ''],
    queryFn: () => api.listProjectManagerCandidates({ projectId }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const filtered = useQuery({
    queryKey: [...key, search],
    queryFn: () => api.listProjectManagerCandidates({ projectId, keyword: search }),
    enabled: Boolean(search),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const list = search ? filtered : candidates;
  const current = confirmed ?? candidates.data?.find((candidate) => candidate.status === 'CURRENT');
  const options =
    list.data?.filter(
      (candidate) => candidate.status === 'RECOMMENDED' && candidate.userId !== current?.userId,
    ) ?? [];
  const candidate = options.find((option) => option.userId === selected);
  const sessionMatches = () => {
    const session = client.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current &&
      session?.id === user.id &&
      (session.selectedRole ?? session.role) === 'NAVIGATOR'
    );
  };

  async function reread() {
    setReading(true);
    setReadError(null);
    setSelected('');
    setConfirming(false);
    setChanging(false);
    try {
      await Promise.all([
        candidates.refetch({ throwOnError: true }),
        refreshProject(),
        ...(search ? [filtered.refetch({ throwOnError: true })] : []),
      ]);
      if (sessionMatches()) {
        setConfirmed(null);
        setLock(null);
      }
    } catch (error) {
      if (sessionMatches()) setReadError(error);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  const recruit = useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: (candidateUserId: string) =>
      api.recruitProjectManager({ projectId, candidateUserId }),
    onSuccess: async (result) => {
      if (!sessionMatches()) return;
      setConfirmed(result.manager);
      setNotice(
        `${result.recruitmentType === 'INITIAL' ? '已指定' : '已更换为'}策略官：${result.manager.name}。${result.recruitmentType === 'INITIAL' ? '项目已进入生产计划阶段。' : '项目阶段保持不变。'}`,
      );
      setLock('success');
      setConfirming(false);
      // 已确认写成功；任何回读失败均只重试GET，绝不重新派发任职请求。
      void client.invalidateQueries({ queryKey: ['navigator-projects', user.id, 'NAVIGATOR'] });
      await reread();
    },
    onError: (error) => {
      if (!sessionMatches()) return;
      setConfirming(false);
      if (error instanceof ApiError && error.status === 409) setLock('conflict');
      else if (
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500 ||
        error.code === 'INVALID_RESPONSE'
      )
        setLock('unknown');
    },
  });
  const denied = [candidates.error, list.error, readError, recruit.error].some(
    (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  const busy = recruit.isPending || reading;
  const blocked =
    busy ||
    Boolean(lock) ||
    Boolean(readError) ||
    denied ||
    candidates.isError ||
    candidates.isFetching ||
    !candidates.data;
  const choosing = !current || changing;

  async function confirm() {
    if (sending.current || blocked || !candidate || !sessionMatches()) return;
    sending.current = true;
    try {
      await recruit.mutateAsync(candidate.userId);
    } catch {
      // mutation状态展示真实错误；显式回读后才能解除冲突或未知结果锁定。
    } finally {
      sending.current = false;
    }
  }

  return (
    <section
      id="project-manager"
      aria-labelledby="project-manager-title"
      className="scroll-mt-24 space-y-5 rounded-[16px] border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="project-manager-title" className="text-base font-semibold">
            招募策略官
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
            选择策略官后直接生效，无需对方确认。首次指定后进入生产计划，更换不改变项目阶段。
          </p>
        </div>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={reading}
          disabled={recruit.isPending}
          onClick={() => {
            recruit.reset();
            void reread();
          }}
        >
          <RefreshCw className="size-4" aria-hidden />
          重新读取策略官
        </Button>
      </div>
      <ErrorNotice error={candidates.error} />
      <ErrorNotice error={recruit.error} />
      {readError !== candidates.error && readError !== list.error && (
        <ErrorNotice error={readError} />
      )}
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
      {lock && (
        <Alert>
          {lock === 'success'
            ? '操作已完成，最新资料尚未读取成功。请重新读取策略官，读取不会重复提交。'
            : lock === 'conflict'
              ? '任职信息已发生变化，请重新读取策略官后再选择。'
              : '暂时无法确认本次操作结果，请重新读取策略官核实后再继续。'}
        </Alert>
      )}
      {candidates.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取策略官…
        </p>
      )}
      {!denied && candidates.data && (
        <>
          <div
            role="region"
            aria-label="当前策略官"
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-muted/30 p-4"
          >
            {current ? (
              <CandidateInfo candidate={current} />
            ) : (
              <p className="text-sm text-muted-foreground">尚未指定策略官</p>
            )}
            {current && !changing && (
              <Button
                variant="primaryOutline"
                size="mobileTouch"
                disabled={blocked}
                onClick={() => {
                  setChanging(true);
                  setSelected('');
                  setNotice('');
                }}
              >
                更换策略官
              </Button>
            )}
          </div>
          {choosing && (
            <>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearch(keyword.trim());
                  setSelected('');
                }}
              >
                <div className="min-w-0 flex-1 space-y-2 sm:max-w-sm">
                  <label htmlFor="project-manager-search" className="text-[13px] font-medium">
                    搜索策略官
                  </label>
                  <Input
                    id="project-manager-search"
                    type="search"
                    maxLength={100}
                    placeholder="姓名或昵称"
                    value={keyword}
                    disabled={blocked}
                    onChange={(event) => setKeyword(event.target.value)}
                  />
                </div>
                <Button type="submit" variant="outline" size="mobileTouch" disabled={blocked}>
                  查询
                </Button>
                <Button
                  variant="ghost"
                  size="mobileTouch"
                  disabled={blocked}
                  onClick={() => {
                    setKeyword('');
                    setSearch('');
                    setSelected('');
                  }}
                >
                  重置
                </Button>
              </form>
              {search && <ErrorNotice error={filtered.error} />}
              {list.isFetching && (
                <p role="status" className="text-sm text-muted-foreground">
                  正在查询候选…
                </p>
              )}
              {!list.isFetching && !list.isError && !options.length && (
                <p className="py-5 text-sm text-muted-foreground">
                  没有匹配的可选策略官，请更换关键词或重新读取。
                </p>
              )}
              <fieldset disabled={blocked || list.isFetching || list.isError}>
                <legend className="mb-3 text-[13px] font-medium">选择策略官</legend>
                <div className="grid gap-3 lg:grid-cols-2">
                  {(list.data ?? []).map((option) => (
                    <label
                      key={option.userId}
                      className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border p-4 focus-within:ring-2 focus-within:ring-primary ${selected === option.userId ? 'border-primary bg-accent' : ''}`}
                    >
                      <input
                        type="radio"
                        name="project-manager-candidate"
                        value={option.userId}
                        checked={selected === option.userId}
                        disabled={option.status === 'CURRENT' || option.userId === current?.userId}
                        onChange={() => setSelected(option.userId)}
                        className="size-4 shrink-0 accent-primary"
                        aria-label={option.name}
                      />
                      <CandidateInfo candidate={option} />
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex flex-wrap justify-end gap-3 border-t pt-4">
                {current && (
                  <Button
                    variant="outline"
                    size="mobileTouch"
                    disabled={busy}
                    onClick={() => {
                      setChanging(false);
                      setSelected('');
                      setSearch('');
                      setKeyword('');
                    }}
                  >
                    取消更换
                  </Button>
                )}
                <Button
                  size="mobileTouch"
                  disabled={blocked || !candidate || list.isFetching || list.isError}
                  loading={recruit.isPending}
                  onClick={() => setConfirming(true)}
                >
                  {current ? '确认更换' : '指定策略官'}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {confirming && candidate && (
        <RecruitConfirmation
          candidate={candidate}
          replacing={Boolean(current)}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirm()}
        />
      )}
    </section>
  );
}

function CandidateInfo({ candidate }: { candidate: ProjectManagerCandidate }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-primary">
        <UserRound className="size-5" aria-hidden />
        {candidate.avatarUrl && (
          <img
            src={candidate.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full object-cover"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </span>
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{candidate.name}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">用户 ID：{candidate.userId}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          当前负责项目：{candidate.currentProjectCount}
        </p>
      </div>
    </div>
  );
}

function RecruitConfirmation({
  candidate,
  replacing,
  busy,
  onCancel,
  onConfirm,
}: {
  candidate: ProjectManagerCandidate;
  replacing: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="manager-confirm-title"
      aria-describedby="manager-confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-32px)] max-w-[480px] rounded-[12px] border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <h2 id="manager-confirm-title" className="text-lg font-semibold">
        {replacing ? '确认更换策略官' : '确认指定策略官'}
      </h2>
      <p
        id="manager-confirm-description"
        className="mt-3 break-words text-sm leading-6 text-muted-foreground"
      >
        {replacing
          ? `将当前策略官更换为 ${candidate.name}，原任职将被替换，项目阶段保持不变。`
          : `将 ${candidate.name} 指定为本项目策略官，任职立即生效，项目进入生产计划。`}
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" size="account" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button size="account" loading={busy} onClick={onConfirm}>
          {replacing ? '确认更换' : '确认指定'}
        </Button>
      </div>
    </dialog>
  );
}
