import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthUser, ExpertTask } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { LoadingState } from '@/components/ui/empty-state';
import { PersonnelManagementPanel } from './PersonnelManagementPanel';
import { ExpertProjectOwners } from './ExpertProjectOwners';
import { canManageExpertPersonnel, isExpertPersonnelApproval } from './expert-personnel-form';
import { sameExpertProductionSource } from './expert-production-form';
import { useProductionFeedback } from './production-feedback';

export function ExpertPersonnelPanel({
  user,
  task,
  onChanged,
}: {
  user: AuthUser;
  task: ExpertTask;
  onChanged: () => Promise<void>;
}) {
  const [ownersOpen, setOwnersOpen] = useState(false);
  const feedback = useProductionFeedback(
    user,
    `expert-personnel:${task.basicInfo.projectId}`,
    false,
    'EXPERT',
  );
  const sources = useQuery({
    queryKey: ['expert-projects', user.id, 'EXPERT', ''],
    queryFn: async () => {
      feedback.requireIdentity();
      const rows = await api.getMyExpertTasks();
      feedback.requireIdentity();
      return rows;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const current = sources.data?.find((row) => sameExpertProductionSource(row, task));
  const manage = !!current && canManageExpertPersonnel(current);
  const approval = !!current && isExpertPersonnelApproval(current);
  const ready = sources.isSuccess && !sources.isFetching && (manage || approval);
  return (
    <section aria-label="执行专家人员管理" className="space-y-4">
      <ErrorNotice error={sources.error} />
      {sources.isFetching && <LoadingState>正在核对原组织人员管理来源…</LoadingState>}
      {(sources.isError || (sources.isSuccess && !current)) && (
        <Button variant="outline" size="mobileTouch" onClick={() => void sources.refetch()}>
          重新读取人员来源
        </Button>
      )}
      {sources.isSuccess && !ready && !sources.isFetching && (
        <Alert>
          当前原来源已无人员管理或审批资格，请刷新项目；不会借用同项目其他组织或转入来源开放操作。
        </Alert>
      )}
      {ready && current && (
        <>
          {manage && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
              <p>
                当前组织：{current.basicInfo.organizationName || '未命名组织'} ·
                人员查询固定本组织范围
              </p>
              {current.accessContext.acceptedOrganizationOwner && (
                <Button variant="outline" size="mobileTouch" onClick={() => setOwnersOpen(true)}>
                  管理项目负责人
                </Button>
              )}
            </div>
          )}
          <PersonnelManagementPanel
            user={user}
            projectId={current.basicInfo.projectId}
            role="EXPERT"
            canManage={manage}
            organizationId={current.basicInfo.organizationId ?? undefined}
            approvalOnly={approval}
            initialMovementId={approval ? current.movementId! : undefined}
            initialView={approval ? 'movements' : 'roster'}
            onChanged={onChanged}
          />
        </>
      )}
      {ownersOpen && (
        <ExpertProjectOwners
          user={user}
          task={current ?? task}
          onChanged={onChanged}
          onClose={() => setOwnersOpen(false)}
        />
      )}
    </section>
  );
}
