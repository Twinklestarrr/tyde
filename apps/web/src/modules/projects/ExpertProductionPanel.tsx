import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthUser, ExpertTask, ProductionOutputReport, ProductionTask } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProductionOutputReports } from './ProductionOutputReports';
import { ProductionTaskSummary } from './ProductionTaskSummary';
import { ProductionTaskMembers } from './ProductionTaskMembers';
import { useProductionFeedback } from './production-feedback';
import {
  EXPERT_PRODUCTION_LEAVE_REQUEST,
  isExpertProductionTask,
  sameExpertProductionSource,
} from './expert-production-form';
import {
  ExpertOutputDialog,
  expertOutputSource,
  expertOutputOrigin,
  type ExpertOutputPending,
  type ExpertOutputIntent,
} from './ExpertOutputDialog';

const statusNames = {
  IN_PROGRESS: '作业中',
  PENDING_ACCEPTANCE: '验收中',
  REWORK_REQUIRED: '驳回返修',
  ACCEPTED: '验收通过',
};
export function ExpertProductionPanel({
  user,
  task,
  onChanged,
}: {
  user: AuthUser;
  task: ExpertTask;
  onChanged: () => Promise<void>;
}) {
  const projectId = task.basicInfo.projectId;
  // ponytail: 每个项目只保留一笔待核实报量/修正；需要并行编辑时再提供逐记录恢复队列。
  const feedback = useProductionFeedback<ExpertOutputPending>(
    user,
    expertOutputSource(task),
    false,
    'EXPERT',
  );
  const [view, setView] = useState(
    task.branchNodeCode === 'OUTPUT_DATA_REVIEW' ? 'history' : 'available',
  );
  useEffect(
    () => setView(task.branchNodeCode === 'OUTPUT_DATA_REVIEW' ? 'history' : 'available'),
    [task.branchNodeCode],
  );
  const [keyword, setKeyword] = useState('');
  const [historyKeyword, setHistoryKeyword] = useState('');
  const [filter, setFilter] = useState({ keyword: '', current: 1 });
  const [intent, setIntent] = useState<ExpertOutputIntent | null>(null);
  const [reports, setReports] = useState<ProductionTask | null>(null);
  const [members, setMembers] = useState<ProductionTask | null>(null);
  const sources = useQuery({
    queryKey: ['expert-projects', user.id, 'EXPERT', ''],
    queryFn: async () => {
      feedback.requireIdentity();
      const result = await api.getMyExpertTasks();
      feedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const current = sources.isSuccess
    ? sources.data.find((item) => sameExpertProductionSource(item, task))
    : undefined;
  const sourceReady = !!current && isExpertProductionTask(current);
  const canReport = sourceReady && current.operations.canReportOutput && !sources.isFetching;
  const reportable = useQuery({
    queryKey: [
      'expert-reportable-production',
      user.id,
      'EXPERT',
      projectId,
      task.sourceBizType,
      task.sourceBizId,
    ],
    enabled: sourceReady,
    queryFn: async () => {
      feedback.requireIdentity();
      const result = await api.listReportableProductionTasks(projectId);
      feedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const tasks = useQuery({
    queryKey: [
      'expert-production-tasks',
      user.id,
      'EXPERT',
      projectId,
      task.sourceBizType,
      task.sourceBizId,
      filter,
    ],
    enabled: sourceReady,
    queryFn: async () => {
      feedback.requireIdentity();
      const result = await api.listProductionTasks({ projectId, ...filter, size: 20 });
      feedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const hasWrite = !!feedback.lock;
  const otherSourceWrite =
    !!feedback.lock && feedback.lock.draft.source !== expertOutputOrigin(task);
  // 待后端提供待报日期后恢复新报量，不能用任意日期替代原报量规则。
  const canNew = false;
  const ownTasks = reportable.isSuccess ? reportable.data : [];
  function openReport(subtaskId: number | null) {
    if (!canNew) return;
    setIntent({ kind: 'save', subtaskId });
  }
  function correct(report: ProductionOutputReport) {
    if (!sourceReady || hasWrite || !report.allowedActions.includes('SAVE_REPORT')) return;
    setIntent({ kind: 'correct', report });
  }
  async function changed() {
    await onChanged();
  }
  function closeReport() {
    if (window.dispatchEvent(new Event(EXPERT_PRODUCTION_LEAVE_REQUEST, { cancelable: true })))
      setReports(null);
  }
  return (
    <section aria-label="执行专家生产任务" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h2>生产任务</h2>
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="mobileTouch"
            loading={sources.isFetching || tasks.isFetching || reportable.isFetching}
            onClick={() => {
              void sources.refetch();
              if (sourceReady) {
                void tasks.refetch();
                void reportable.refetch();
              }
            }}
          >
            刷新生产数据
          </Button>
        </div>
      </div>
      <ErrorNotice error={sources.error} />
      {sources.isPending && <LoadingState>正在核对当前生产来源…</LoadingState>}
      {sources.isSuccess && !sourceReady && (
        <Alert>
          当前来源已无生产待办，请刷新项目核对；不会借用同项目的其他分配或转入来源开放写操作。
        </Alert>
      )}
      {feedback.lock && (
        <Alert>
          <div className="space-y-2">
            <p>
              {otherSourceWrite
                ? '本项目其他来源仍有待核实报量，请返回原来源核实；当前来源暂停提交。'
                : feedback.lock.status === 'success'
                  ? '报量操作已保存，后续待办尚未读取完成。'
                  : '上次报量或修正结果尚待核实，原内容保留在本次页面运行中，暂停重复提交。'}
            </p>
            <Button
              variant="outline"
              size="mobileTouch"
              disabled={otherSourceWrite}
              onClick={() => {
                const pending = feedback.lock?.draft;
                if (pending)
                  setIntent(
                    pending.kind === 'save'
                      ? { kind: 'save', subtaskId: pending.rows[0]?.subtaskId ?? null }
                      : { kind: 'correct', report: pending.report },
                  );
              }}
            >
              恢复报量操作
            </Button>
          </div>
        </Alert>
      )}
      {sourceReady && (
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (
              next !== view &&
              window.dispatchEvent(new Event(EXPERT_PRODUCTION_LEAVE_REQUEST, { cancelable: true }))
            )
              setView(next);
          }}
        >
          <TabsList
            aria-label="专家生产模块"
            variant="business"
            className="mb-4 grid h-auto w-full grid-cols-2 sm:flex sm:flex-wrap sm:justify-start"
          >
            {[
              ['available', '可报任务'],
              ['history', '生产子任务'],
            ].map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value!}
                variant="business"
                className="min-h-11 min-w-0 px-2 sm:px-3"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="available" className="space-y-4">
            <p className="text-[13px] leading-6 text-muted-foreground">
              此处列出本人可报的任务池及已指定任务。
            </p>
            <Alert>报量暂不可用，请稍后重试。</Alert>
            <SearchInput
              id="expert-reportable-search"
              label="筛选可报任务"
              value={keyword}
              maxLength={128}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="本地筛选可报任务名称或编号"
            />
            <ErrorNotice error={reportable.error} />
            {reportable.isPending && <LoadingState>正在读取本人可报任务…</LoadingState>}
            {reportable.isSuccess && (
              <>
                <div
                  role="group"
                  aria-label="可报任务列表"
                  tabIndex={0}
                  className="grid max-h-[36rem] gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
                >
                  {ownTasks
                    .filter(
                      (item) =>
                        !keyword.trim() ||
                        `${item.subtaskName} ${item.subtaskNo}`.includes(keyword.trim()),
                    )
                    .map((item) => (
                      <Card asChild key={item.subtaskId}>
                        <article aria-label={item.subtaskName} className="space-y-3 p-4">
                          <h3 className="break-words text-base font-semibold">
                            {item.subtaskName}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {item.subtaskNo} ·{' '}
                            {item.distributionMode === 'POOL' ? '任务池' : '指定人员'} · 单位：
                            {item.quantityUnit}
                          </p>
                          <Button
                            size="mobileTouch"
                            disabled={!canNew}
                            onClick={() => openReport(item.subtaskId)}
                          >
                            填写子任务报量
                          </Button>
                        </article>
                      </Card>
                    ))}
                </div>
                {!ownTasks.length && (
                  <EmptyState
                    title="暂无本人可报子任务"
                    description="暂无本人可报的任务池或指定任务。"
                  />
                )}
              </>
            )}
          </TabsContent>
          <TabsContent value="history" className="space-y-4">
            <p className="text-[13px] leading-6 text-muted-foreground">
              普通成员仅查看本人已报量的子任务；主管或项目负责人可见当前账号职责范围内的任务池、指定任务及退回修正来源。
            </p>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setFilter({ keyword: historyKeyword.trim(), current: 1 });
              }}
            >
              <SearchInput
                id="expert-production-history-search"
                label="筛选生产子任务"
                value={historyKeyword}
                maxLength={128}
                onChange={(e) => setHistoryKeyword(e.target.value)}
                placeholder="子任务名称或编号"
                containerClassName="flex-1 basis-[220px]"
              />
              <Button type="submit" size="mobileTouch" loading={tasks.isFetching}>
                查询生产子任务
              </Button>
            </form>
            <ErrorNotice error={tasks.error} />
            {tasks.isPending && <LoadingState>正在读取生产子任务…</LoadingState>}
            {tasks.isSuccess && (
              <>
                <ProductionTaskSummary total={tasks.data.total} tasks={tasks.data.records} />
                <div
                  role="group"
                  aria-label="专家生产子任务列表"
                  tabIndex={0}
                  className="grid max-h-[36rem] gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
                >
                  {tasks.data.records.map((item) => (
                    <Card asChild key={item.subtaskId}>
                      <article aria-label={item.subtaskName} className="space-y-3 p-4">
                        <h3 className="break-words text-base font-semibold">{item.subtaskName}</h3>
                        <p className="text-xs text-muted-foreground">
                          {item.subtaskNo} · {statusNames[item.status]} ·{' '}
                          {item.distributionMode === 'POOL' ? '任务池' : '指定人员'}
                        </p>
                        <p className="text-[13px]">
                          预期交付 {item.expectedQuantity} {item.quantityUnit} ·{' '}
                          {item.expectedDeliveryDate}
                        </p>
                        {item.actualQuantity !== null && (
                          <p className="text-[13px]">
                            实际交付 {item.actualQuantity} {item.quantityUnit} ·{' '}
                            {item.actualDeliveryDate || '未记录'}
                          </p>
                        )}
                        {item.rejectReason && (
                          <p className="whitespace-pre-wrap break-words text-[13px]">
                            返修原因：{item.rejectReason}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {item.allowedActions.includes('CORRECT_REPORT') && (
                            <Button
                              variant="outline"
                              size="mobileTouch"
                              onClick={() => setReports(item)}
                            >
                              修正
                              {item.pendingReportCount > 0 ? `(${item.pendingReportCount})` : ''}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="mobileTouch"
                            onClick={() => setMembers(item)}
                          >
                            查看任务成员
                          </Button>
                        </div>
                      </article>
                    </Card>
                  ))}
                </div>
                {!tasks.data.records.length && <EmptyState title="暂无可查看的生产子任务" />}
                {tasks.data.pages > 1 && (
                  <Pagination
                    aria-label="专家生产子任务分页"
                    {...tasks.data}
                    loading={tasks.isFetching}
                    onPageChange={(page) => setFilter({ ...filter, current: page })}
                  />
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
      {intent && (
        <ExpertOutputDialog
          key={intent.kind === 'save' ? 'save' : `correct:${intent.report.reportId}`}
          user={user}
          task={current ?? task}
          intent={intent}
          initialPending={feedback.lock?.draft}
          reportable={ownTasks}
          canReport={canReport}
          onChanged={changed}
          onClose={() => setIntent(null)}
        />
      )}
      {reports && (
        <Dialog title="子任务生产报量" aria-label="子任务生产报量" size="lg" onClose={closeReport}>
          <p className="text-[13px]">{reports.subtaskName}</p>
          <ProductionOutputReports
            user={user}
            projectId={projectId}
            subtaskId={reports.subtaskId}
            role="EXPERT"
            canWrite={false}
            writable={reports.status === 'IN_PROGRESS'}
            onChanged={changed}
            onCorrect={
              !sourceReady || hasWrite || !reports.allowedActions.includes('CORRECT_REPORT')
                ? undefined
                : correct
            }
          />
        </Dialog>
      )}
      {members && (
        <Dialog
          title="子任务成员"
          aria-label="子任务成员"
          size="lg"
          onClose={() => setMembers(null)}
        >
          <ProductionTaskMembers
            user={user}
            projectId={projectId}
            role="EXPERT"
            subtaskId={members.subtaskId}
          />
        </Dialog>
      )}
    </section>
  );
}
