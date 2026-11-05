import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ExpertTask } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** 专家管理者只读生产计划来自本人真实分配详情，不借用 PM 确认计划接口。 */
export function ExpertProductionPlanView({ user, task }: { user: AuthUser; task: ExpertTask }) {
  const cache = useQueryClient();
  const detail = useQuery({
    queryKey: ['expert-project-detail', user.id, 'EXPERT', task.sourceBizType, task.sourceBizId],
    queryFn: async () => {
      const requireIdentity = () => {
        const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
        if (session?.id !== user.id || (session.selectedRole ?? session.role) !== 'EXPERT')
          throw new Error('当前账号或角色已变化，请重新读取。');
      };
      requireIdentity();
      const result = await api.getExpertAssignmentDetail(
        task.assignmentId !== null
          ? { assignmentId: task.assignmentId, movementId: null }
          : { assignmentId: null, movementId: task.movementId },
      );
      requireIdentity();
      return result;
    },
    retry: false,
  });
  const plan = detail.data?.productionPlan;
  return (
    <section aria-label="生产计划" className="space-y-4">
      <h2 className="text-sm font-semibold">生产计划</h2>
      <ErrorNotice error={detail.error} />
      {detail.isPending && <LoadingState>正在读取生产计划…</LoadingState>}
      {detail.isError && (
        <Button variant="outline" size="mobileTouch" onClick={() => void detail.refetch()}>
          重新读取生产计划
        </Button>
      )}
      {plan &&
        (!plan.hasPlan ? (
          <EmptyState title="暂无生产计划" />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['作业人数', plan.operatorHeadcount],
                ['作业CPD', plan.operatorCpd],
                ['质检人数', plan.inspectorHeadcount],
                ['质检CPD', plan.inspectorCpd],
                ['预计产出', plan.totalExpectedOutput],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd>{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {plan.crowds.map((crowd) => (
              <p key={crowd.sequenceNo} className="text-sm">
                {crowd.crowdName}：{crowd.profileRequirement || '—'}
              </p>
            ))}
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    '阶段',
                    '开始日期',
                    '结束日期',
                    '工作日',
                    '作业人数',
                    'CPD',
                    '正确率',
                    '预计产出',
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.stages.map((stage) => (
                  <TableRow key={stage.sequenceNo}>
                    {[
                      stage.stageName,
                      stage.startDate,
                      stage.endDate,
                      stage.workdayCount,
                      stage.operatorHeadcount,
                      stage.operatorCpd,
                      stage.accuracyRate == null ? null : `${stage.accuracyRate}%`,
                      stage.expectedOutput,
                    ].map((value, i) => (
                      <TableCell key={i}>{value ?? '—'}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ))}
    </section>
  );
}
