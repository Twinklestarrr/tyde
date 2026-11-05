import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthUser, ProductionTask, ProductionTaskStatus } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProductionTaskCreate } from './ProductionTaskCreate';
import { ProductionTaskSummary } from './ProductionTaskSummary';
import { ProductionTaskMembers } from './ProductionTaskMembers';
import { ProductionOutputReports } from './ProductionOutputReports';
import { SubtaskAcceptance } from './SubtaskAcceptance';
import { NavigatorAcceptanceReview } from './NavigatorAcceptanceReview';
import { useProductionFeedback } from './production-feedback';
import { PRODUCTION_TASKS_LEAVE_REQUEST, type ProductionTaskDraft } from './production-task-form';

function PendingAcceptanceEntry({
  user,
  role,
  projectId,
  task,
  onOpen,
}: {
  user: AuthUser;
  role: 'PM' | 'NAVIGATOR';
  projectId: number;
  task: ProductionTask;
  onOpen: () => void;
}) {
  const feedback = useProductionFeedback(
    user,
    `acceptance:${projectId}:${task.subtaskId}`,
    false,
    role,
  );
  if (feedback.lock && !feedback.foreignLock) {
    return (
      <Button size="mobileTouch" variant="outline" onClick={onOpen}>
        恢复验收操作
      </Button>
    );
  }
  return role === 'NAVIGATOR' ? (
    <p className="text-xs text-muted-foreground">
      {task.operationHint ||
        (task.status === 'ACCEPTED'
          ? '验收已通过'
          : task.status === 'PENDING_ACCEPTANCE'
            ? '暂无验收权限'
            : '待策略官提交验收')}
    </p>
  ) : null;
}

const statuses: Record<ProductionTaskStatus, string> = {
  IN_PROGRESS: '作业中',
  PENDING_ACCEPTANCE: '验收中',
  REWORK_REQUIRED: '驳回返修',
  ACCEPTED: '验收通过',
};
export function ProductionTasksPanel({
  user,
  projectId,
  onChanged,
  role = 'PM',
}: {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
  role?: 'PM' | 'NAVIGATOR';
}) {
  const createFeedback = useProductionFeedback<ProductionTaskDraft>(
    user,
    `create:${projectId}`,
    false,
    role,
  );
  const [view, setView] = useState('tasks');
  const [keyword, setKeyword] = useState('');
  const [states, setStates] = useState<ProductionTaskStatus[]>([]);
  const [filter, setFilter] = useState({ keyword: '', statuses: states, current: 1 });
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState<ProductionTask | null>(null);
  const [reports, setReports] = useState<ProductionTask | null>(null);
  const [acceptance, setAcceptance] = useState<ProductionTask | null>(null);
  const permission = useQuery({
    queryKey: ['project-expert-recruitment', user.id, 'PM', projectId],
    enabled: role === 'PM' && (user.selectedRole ?? user.role) === role,
    queryFn: async () => {
      createFeedback.requireIdentity();
      const result = await api.getExpertRecruitmentDetail(projectId);
      createFeedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const tasks = useQuery({
    queryKey: ['production-tasks', user.id, role, projectId, filter],
    enabled: (user.selectedRole ?? user.role) === role,
    queryFn: async () => {
      createFeedback.requireIdentity();
      const result = await api.listProductionTasks({ projectId, ...filter, size: 20 });
      createFeedback.requireIdentity();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const canWrite =
    role === 'PM' &&
    permission.isSuccess &&
    permission.data.canChangeHandler &&
    !permission.isFetching;
  const canCreate = canWrite && permission.data?.currentNodeCode !== 'COMPLETED';
  async function changed() {
    if (role === 'PM') await permission.refetch({ throwOnError: true });
    await tasks.refetch({ throwOnError: true });
    await onChanged();
  }
  return (
    <section aria-label="生产任务" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle asChild>
          <h2>生产任务</h2>
        </CardTitle>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={tasks.isFetching || permission.isFetching}
          onClick={() => {
            void tasks.refetch();
            if (role === 'PM') void permission.refetch();
          }}
        >
          刷新生产任务
        </Button>
      </div>
      <ErrorNotice error={role === 'PM' ? permission.error : null} />
      {role === 'PM' && permission.isSuccess && !permission.data.canChangeHandler && (
        <Alert>
          当前为招募协作负责人，可查看生产任务、报量、质量与验收信息；写操作由主策略官处理。
        </Alert>
      )}
      {role === 'PM' && createFeedback.lock && !createFeedback.foreignLock && (
        <Alert>
          <div className="space-y-2">
            <p>
              {createFeedback.lock.status === 'success'
                ? '子任务已创建，后续信息尚未读取完成。'
                : '上次创建结果待核实，创建草稿保留在本次页面运行中，暂不重复创建。'}
            </p>
            <Button variant="outline" size="mobileTouch" onClick={() => setCreating(true)}>
              恢复创建草稿
            </Button>
          </div>
        </Alert>
      )}
      <Tabs
        value={view}
        onValueChange={(next) => {
          if (
            next !== view &&
            window.dispatchEvent(new Event(PRODUCTION_TASKS_LEAVE_REQUEST, { cancelable: true }))
          )
            setView(next);
        }}
      >
        <TabsList
          aria-label="生产任务模块"
          variant="business"
          className="mb-4 grid h-auto w-full grid-cols-3 sm:flex sm:flex-wrap sm:justify-start"
        >
          {[['tasks', '任务列表']].map(([value, label]) => (
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
        <TabsContent value="tasks" className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter({ keyword: keyword.trim(), statuses: states, current: 1 });
            }}
          >
            <SearchInput
              id="production-task-search"
              label="筛选生产任务"
              value={keyword}
              maxLength={128}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="子任务名称或编号"
              containerClassName="flex-1 basis-[220px]"
            />
            <Button type="submit" size="mobileTouch" loading={tasks.isFetching}>
              查询任务
            </Button>
            <Button
              variant="outline"
              size="mobileTouch"
              onClick={() => {
                setKeyword('');
                setStates([]);
                setFilter({ keyword: '', statuses: [], current: 1 });
              }}
            >
              重置任务筛选
            </Button>
            {canCreate && (
              <Button
                size="mobileTouch"
                disabled={!!createFeedback.lock || tasks.isFetching || !tasks.isSuccess}
                onClick={() => setCreating(true)}
              >
                创建子任务
              </Button>
            )}
          </form>
          <fieldset className="flex flex-wrap gap-4 rounded-xl border p-3">
            <legend className="px-1 text-xs">任务状态</legend>
            {(Object.entries(statuses) as [ProductionTaskStatus, string][]).map(
              ([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={states.includes(value)}
                    onChange={(e) =>
                      setStates((old) =>
                        e.target.checked ? [...old, value] : old.filter((state) => state !== value),
                      )
                    }
                  />
                  {label}
                </label>
              ),
            )}
          </fieldset>
          <ErrorNotice error={tasks.error} />
          {tasks.isPending && <LoadingState>正在读取生产任务…</LoadingState>}
          {tasks.isSuccess && (
            <>
              <ProductionTaskSummary total={tasks.data.total} tasks={tasks.data.records} />
              <div
                role="group"
                aria-label="生产任务列表"
                tabIndex={0}
                className="grid max-h-[42rem] gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
              >
                {tasks.data.records.map((task) => (
                  <Card asChild key={task.subtaskId}>
                    <article aria-label={task.subtaskName} className="space-y-3 p-5">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="min-w-0 break-words text-base font-semibold">
                          {task.subtaskName}
                        </h3>
                        <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs">
                          {statuses[task.status]}
                        </span>
                      </div>
                      <p className="break-words text-xs text-muted-foreground">
                        {task.subtaskNo} ·{' '}
                        {task.distributionMode === 'POOL' ? '任务池' : '指定人员'}
                      </p>
                      <dl className="grid grid-cols-2 gap-3 text-[13px]">
                        {[
                          ['预期交付量', `${task.expectedQuantity} ${task.quantityUnit}`],
                          ['预期交付日期', task.expectedDeliveryDate],
                          ['实际交付日期', task.actualDeliveryDate || '尚未提交'],
                          ['已指定 / 认领人数', task.assigneeCount],
                          [
                            '实际交付量',
                            task.actualQuantity === null
                              ? '尚未提交'
                              : `${task.actualQuantity} ${task.quantityUnit}`,
                          ],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-xs text-muted-foreground">{label}</dt>
                            <dd className="mt-1 break-words">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="break-words text-[13px]">
                        成员：{task.assigneeNames.join('、') || '暂无已指定或认领人员'}
                        {task.assigneeCount > task.assigneeNames.length ? ' 等' : ''}
                      </p>
                      {task.rejectReason && (
                        <Alert variant="destructive">返修原因：{task.rejectReason}</Alert>
                      )}
                      {task.quantityAdjustmentRemark && (
                        <p className="whitespace-pre-wrap break-words text-[13px]">
                          数量调整说明：{task.quantityAdjustmentRemark}
                        </p>
                      )}
                      {task.submittedAt && (
                        <p className="text-xs text-muted-foreground">
                          提交：{task.submittedByName || '未记录'} · {task.submittedAt}
                        </p>
                      )}
                      {task.reviewedAt && (
                        <p className="text-xs text-muted-foreground">
                          验收审核：{task.reviewedByName || '未记录'} · {task.reviewedAt}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="mobileTouch"
                          onClick={() => setMembers(task)}
                        >
                          查看任务成员
                        </Button>
                        {role === 'PM' &&
                          task.status === 'IN_PROGRESS' &&
                          task.allowedActions.includes('CHECK_DATA') && (
                            <Button
                              variant="outline"
                              size="mobileTouch"
                              onClick={() => setReports(task)}
                            >
                              检查数据
                              {task.pendingReportCount > 0 ? `(${task.pendingReportCount})` : ''}
                            </Button>
                          )}
                        {(role === 'PM' &&
                          ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(task.status) &&
                          task.allowedActions.includes('SUBMIT_ACCEPTANCE')) ||
                        (role === 'NAVIGATOR' &&
                          task.status === 'PENDING_ACCEPTANCE' &&
                          task.allowedActions.some(
                            (action) => action === 'ACCEPT' || action === 'REJECT',
                          )) ? (
                          <Button size="mobileTouch" onClick={() => setAcceptance(task)}>
                            {role === 'PM' ? '提交验收' : '审核验收'}
                          </Button>
                        ) : (
                          <PendingAcceptanceEntry
                            user={user}
                            role={role}
                            projectId={projectId}
                            task={task}
                            onOpen={() => setAcceptance(task)}
                          />
                        )}
                      </div>
                    </article>
                  </Card>
                ))}
              </div>
              {!tasks.data.records.length && <EmptyState title="暂无符合条件的生产子任务" />}
              {tasks.data.pages > 1 && (
                <Pagination
                  aria-label="生产任务分页"
                  {...tasks.data}
                  loading={tasks.isFetching}
                  onPageChange={(current) => setFilter({ ...filter, current })}
                />
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
      {role === 'PM' && creating && !createFeedback.foreignLock && (
        <ProductionTaskCreate
          user={user}
          projectId={projectId}
          canWrite={canCreate}
          initialDraft={createFeedback.lock?.draft}
          quantityUnit={permission.data?.quantityUnit}
          onChanged={changed}
          onClose={() => setCreating(false)}
        />
      )}
      {members && (
        <Dialog
          title="子任务成员"
          aria-label="子任务成员"
          size="lg"
          onClose={() => setMembers(null)}
        >
          <p className="text-[13px] text-muted-foreground">
            {members.subtaskName} · 仅显示实际指定或认领的成员。
          </p>
          <ProductionTaskMembers
            user={user}
            projectId={projectId}
            subtaskId={members.subtaskId}
            role={role}
          />
        </Dialog>
      )}
      {role === 'PM' && reports && (
        <Dialog
          title="子任务报量"
          aria-label="子任务报量"
          size="lg"
          onClose={() => {
            if (
              window.dispatchEvent(new Event(PRODUCTION_TASKS_LEAVE_REQUEST, { cancelable: true }))
            )
              setReports(null);
          }}
        >
          <p className="text-[13px] text-muted-foreground">{reports.subtaskName}</p>
          <ProductionOutputReports
            user={user}
            projectId={projectId}
            subtaskId={reports.subtaskId}
            canWrite={canWrite && reports.allowedActions.includes('CHECK_DATA')}
            writable={reports.status === 'IN_PROGRESS'}
            onChanged={changed}
          />
        </Dialog>
      )}
      {acceptance &&
        (role === 'NAVIGATOR' ? (
          <NavigatorAcceptanceReview
            user={user}
            projectId={projectId}
            subtask={acceptance}
            onChanged={changed}
            onClose={() => setAcceptance(null)}
          />
        ) : (
          <SubtaskAcceptance
            user={user}
            projectId={projectId}
            subtask={acceptance}
            canWrite={canWrite && acceptance.allowedActions.includes('SUBMIT_ACCEPTANCE')}
            onChanged={changed}
            onClose={() => setAcceptance(null)}
          />
        ))}
    </section>
  );
}
