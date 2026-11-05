import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_KEY } from '@/hooks/useSession';
import type {
  AuthUser,
  EntranceExamAdmissionInput,
  EntranceExamFinalResult,
  EntranceExamRosterItem,
} from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { FormField } from '@/components/ui/shared/FormField';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const examFinalLabels = { PENDING: '待阅卷', ADMITTED: '考试通过', ELIMINATED: '未通过' };
const examRoundLabels = { PENDING: '本轮待判定', ADMITTED: '本轮通过', ELIMINATED: '本轮未通过' };
const admissionLabels = {
  PENDING: '待阅卷',
  PENDING_ENTRY: '待入项',
  ADMITTED: '已入项',
  ENTRY_DECLINED: '已放弃入项',
  ELIMINATED: '未通过',
};

export function ExamSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
}) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const controlId = useId();
  return (
    <div ref={setPortal} className="min-w-0">
      <FormField
        controlId={controlId}
        label={label}
        className="gap-2"
        labelClassName="text-[13px] leading-5"
      >
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={controlId} aria-label={label} size="profile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent container={portal}>
            {options.map(([key, text]) => (
              <SelectItem key={key} value={key}>
                {text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

function ExamPagination({
  current,
  total,
  pages,
  busy,
  onPage,
}: {
  current: number;
  total: number;
  pages: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <Pagination
      current={current}
      total={total}
      pages={pages}
      loading={busy}
      onPageChange={onPage}
    />
  );
}

/** 项目级准入状态来自服务端真实成员事实，不将考试通过等同于已入项。 */
export function EntranceExamAdmissions({
  user,
  projectId,
  role = 'PM',
}: {
  user: AuthUser;
  projectId: number;
  role?: 'PM' | 'NAVIGATOR';
}) {
  const cache = useQueryClient();
  function requireSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== user.id || (current.selectedRole ?? current.role) !== role)
      throw new Error('当前身份已变化，请重新进入准入情况。');
  }
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const [filter, setFilter] = useState<{ keyword: string; status: string; current: number }>({
    keyword: '',
    status: 'ALL',
    current: 1,
  });
  const input: EntranceExamAdmissionInput = {
    projectId,
    current: filter.current,
    size: 20,
    ...(filter.keyword ? { keyword: filter.keyword } : {}),
    ...(filter.status !== 'ALL'
      ? { admissionStatus: filter.status as EntranceExamAdmissionInput['admissionStatus'] }
      : {}),
  };
  const query = useQuery({
    queryKey: ['entrance-exam-admissions', user.id, role, projectId, input],
    enabled: (user.selectedRole ?? user.role) === role,
    queryFn: async () => {
      requireSession();
      const value = await api.getEntranceExamAdmissions(input);
      requireSession();
      return value;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  return (
    <section aria-label="项目准入情况" className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">项目准入情况</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          汇总已交卷考生的准入与入项状态，时间均为上海时间。
        </p>
      </div>
      <form
        className="grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(140px,180px)_auto_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ keyword: keyword.trim(), status, current: 1 });
        }}
      >
        <FormField
          controlId="exam-admission-keyword"
          label="搜索准入人员"
          className="col-span-2 gap-2 lg:col-span-1"
          labelClassName="text-[13px] leading-5"
        >
          <Input
            id="exam-admission-keyword"
            size="profile"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="姓名、用户 ID 或组织名称"
          />
        </FormField>
        <ExamSelect
          label="准入状态"
          value={status}
          onChange={setStatus}
          options={[['ALL', '全部'], ...Object.entries(admissionLabels)]}
        />
        <Button type="submit" size="settings" disabled={query.isFetching}>
          查询
        </Button>
        <Button
          variant="outline"
          size="settings"
          onClick={() => {
            setKeyword('');
            setStatus('ALL');
            setFilter({ keyword: '', status: 'ALL', current: 1 });
          }}
        >
          重置
        </Button>
        <Button
          variant="outline"
          size="settings"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新准入情况
        </Button>
      </form>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <p role="status">正在读取准入情况…</p>
      ) : (
        query.isSuccess &&
        query.data && (
          <>
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {['考生', '组织 / 人员属性', '考试', '交卷时间', '准入状态'].map((label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.records.map((row) => (
                    <TableRow key={row.attemptId}>
                      <TableCell>
                        <p>{row.candidateName}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          用户 ID：{row.candidateUserId}
                        </p>
                      </TableCell>
                      <TableCell>
                        {row.organizationName || '个人'} /{' '}
                        {row.employmentType === 'FULL_TIME'
                          ? '全职'
                          : row.employmentType === 'PART_TIME'
                            ? '兼职'
                            : '未设置'}
                      </TableCell>
                      <TableCell>{row.examName}</TableCell>
                      <TableCell>{row.examDate}</TableCell>
                      <TableCell>{admissionLabels[row.admissionStatus]}</TableCell>
                    </TableRow>
                  ))}
                  {query.data.records.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="p-[32px] text-center text-muted-foreground">
                        暂无符合条件的准入记录
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <ExamPagination
              {...query.data}
              busy={query.isFetching}
              onPage={(current) => setFilter({ ...filter, current })}
            />
          </>
        )
      )}
    </section>
  );
}

/** 花名册按考试、关键词、最终结果由后端分页，保留0分与未出分的差别。 */
export function EntranceExamRoster({
  user,
  projectId,
  examId,
  onSelect,
  selectedAttemptId,
  autoSelect = false,
  active = true,
  role = 'PM',
}: {
  user: AuthUser;
  projectId: number;
  examId: number;
  onSelect: (row: EntranceExamRosterItem, automatic?: boolean) => void;
  selectedAttemptId?: number;
  autoSelect?: boolean;
  active?: boolean;
  role?: 'PM' | 'NAVIGATOR';
}) {
  const cache = useQueryClient();
  function requireSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (current?.id !== user.id || (current.selectedRole ?? current.role) !== role)
      throw new Error('当前身份已变化，请重新进入考试名单。');
  }
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const [filter, setFilter] = useState({ keyword: '', status: 'ALL' });
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const input = {
    projectId,
    examId,
    size: 20,
    ...(filter.keyword ? { keyword: filter.keyword } : {}),
    ...(filter.status !== 'ALL' ? { finalResult: filter.status as EntranceExamFinalResult } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: ['entrance-exam-roster', user.id, role, projectId, examId, input],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      requireSession();
      const value = await api.getEntranceExamRoster({ ...input, current: pageParam });
      requireSession();
      return value;
    },
    getNextPageParam: (last) => (last.current < last.pages ? last.current + 1 : undefined),
    enabled: active && (user.selectedRole ?? user.role) === role,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const records = query.data?.pages.flatMap((page) => page.records) ?? [];
  const first = records.find((row) => row.enteredAt);
  useEffect(() => {
    if (active && autoSelect && first) onSelect(first, true);
  }, [active, autoSelect, first, onSelect]);
  useEffect(() => {
    if (!active || !query.hasNextPage || query.isFetching || query.isError || !sentinel.current)
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void query.fetchNextPage();
      },
      { root: scroll.current, rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  return (
    <section aria-label="考试花名册" className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        轮次成绩来自考生实际绑定的历史版本。未交卷与待最终阅卷分别展示。
      </p>
      <form
        className="grid grid-cols-2 items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ keyword: keyword.trim(), status });
        }}
      >
        <FormField
          controlId={`exam-roster-keyword-${examId}`}
          label="搜索考试人员"
          className="col-span-2 gap-2"
          labelClassName="text-[13px] leading-5"
        >
          <Input
            id={`exam-roster-keyword-${examId}`}
            size="profile"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="姓名、用户 ID 或组织名称"
          />
        </FormField>
        <ExamSelect
          label="考试结果"
          value={status}
          onChange={setStatus}
          options={[['ALL', '全部'], ...Object.entries(examFinalLabels)]}
        />
        <Button type="submit" size="settings" disabled={query.isFetching}>
          查询
        </Button>
        <Button
          variant="outline"
          size="settings"
          onClick={() => {
            setKeyword('');
            setStatus('ALL');
            setFilter({ keyword: '', status: 'ALL' });
          }}
        >
          重置
        </Button>
        <Button
          variant="outline"
          size="settings"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新名单
        </Button>
      </form>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <p role="status">正在读取考试名单…</p>
      ) : (
        query.data && (
          <>
            <div ref={scroll} className="max-h-[32rem] overflow-y-auto rounded-xl border">
              <Table className="block w-full table-fixed">
                <TableHeader className="sr-only">
                  <TableRow>
                    {['考生', '组织', '轮次成绩', '最终结果', '入场 / 交卷时间', '操作'].map(
                      (label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody className="block">
                  {records.map((row) => (
                    <TableRow
                      key={row.attemptId}
                      data-state={row.attemptId === selectedAttemptId ? 'selected' : undefined}
                      className="block space-y-2 p-3 [&>td]:block [&>td]:whitespace-normal [&>td]:p-0 [&>td]:break-words"
                    >
                      <TableCell>
                        <p>{row.candidateName}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          用户 ID：{row.candidateUserId}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{row.attemptNo}</p>
                      </TableCell>
                      <TableCell>{row.organizationName || '个人'}</TableCell>
                      <TableCell>
                        {row.roundScores.length
                          ? row.roundScores.map((round) => (
                              <p key={round.roundNo}>
                                第{round.roundNo}轮{' '}
                                {round.gradingMode === 'MANUAL' ? '人工' : '自动'}：
                                {round.score ?? '未出分'} ·{' '}
                                {round.roundResult ? examRoundLabels[round.roundResult] : '未判定'}
                              </p>
                            ))
                          : '暂无成绩'}
                      </TableCell>
                      <TableCell>
                        {row.finalResult
                          ? examFinalLabels[row.finalResult]
                          : row.enteredAt
                            ? '未交卷'
                            : '未入场'}
                      </TableCell>
                      <TableCell>
                        <p>{row.enteredAt || '未入场'}</p>
                        <p className="mt-1">{row.submittedAt || '未交卷'}</p>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="mobileTouch"
                          disabled={!row.enteredAt}
                          onClick={() => onSelect(row)}
                        >
                          查看阅卷
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {records.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-[32px] text-center text-muted-foreground">
                        暂无符合条件的考生
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <div ref={sentinel} className="h-px" aria-hidden />
            </div>
            <p className="text-xs text-muted-foreground">
              已显示 {records.length} / {query.data.pages[0]?.total ?? 0} 人
            </p>
            {query.hasNextPage && (
              <Button
                variant="outline"
                size="mobileTouch"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                加载更多
              </Button>
            )}
          </>
        )
      )}
    </section>
  );
}
