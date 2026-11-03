import type { ReactNode } from 'react';
import type { NavigatorProjectCard } from '@tyde/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';

/** 完整节点仅用于解释服务端状态，不作为各角色共用的操作导航。 */
const stages = [
  ['RECRUIT_PROJECT_MANAGER', '招募策略官'],
  ['PRODUCTION_PLAN', '生产计划'],
  ['ENTRANCE_EXAM', '准入考试'],
  ['STANDARD_TRAINING', '标准与培训'],
  ['RECRUIT_EXECUTION_EXPERT', '招募执行专家'],
  ['PERSONNEL_MANAGEMENT', '人员管理'],
  ['PRODUCTION_TASK', '生产任务'],
  ['COMPLETED', '结项'],
] as const;

export function projectNodeLabel(code: string | null) {
  return stages.find(([value]) => value === code)?.[1] ?? '待确认阶段';
}

/** 卡片支线是当前待办，不能被项目主线进度覆盖。 */
export function projectCardNode(
  card: Pick<NavigatorProjectCard, 'branchNodeCode' | 'currentNodeCode'>,
) {
  const modules: Record<string, string> = {
    ENTRANCE_EXAM_GRADING: 'ENTRANCE_EXAM',
    ENTRANCE_EXAM_GRADING_RETRY: 'ENTRANCE_EXAM',
    EXPERT_RECRUITMENT_RETRY: 'RECRUIT_EXECUTION_EXPERT',
    MEMBER_MOVEMENT_APPROVAL: 'PERSONNEL_MANAGEMENT',
    MEMBER_ENTRY_CONFIRM: 'PERSONNEL_MANAGEMENT',
    SUBTASK_REWORK_REVIEW: 'PRODUCTION_TASK',
    SUBTASK_REWORK_SUBMIT: 'PRODUCTION_TASK',
    SUBTASK_ACCEPTANCE: 'PRODUCTION_TASK',
    OUTPUT_DATA_REVIEW: 'PRODUCTION_TASK',
    SUBTASK_CREATE: 'PRODUCTION_TASK',
  };
  return modules[card.branchNodeCode ?? ''] ?? card.branchNodeCode ?? card.currentNodeCode;
}

const navigatorTabs = [
  'RECRUIT_PROJECT_MANAGER',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
  'PRODUCTION_TASK',
] as const;

/** 本路由只接入领航员；其他角色的工作台按各自职责单独迁移。 */
export function NavigatorProjectWorkflow({
  currentNodeCode,
  recruitment,
  tab,
  onTabChange,
}: {
  currentNodeCode: string | null;
  recruitment: ReactNode;
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  return (
    <Tabs value={tab} onValueChange={onTabChange}>
      <TabsList
        aria-label="领航员项目模块"
        variant="business"
        className="mb-3 grid h-auto w-full min-w-0 grid-cols-2 sm:flex sm:flex-wrap sm:justify-start"
      >
        {navigatorTabs.map((code) => (
          <TabsTrigger
            key={code}
            value={code}
            variant="business"
            aria-current={code === currentNodeCode ? 'step' : undefined}
            className="min-h-11 min-w-0 px-2 sm:flex-none sm:px-3"
          >
            {projectNodeLabel(code)}
            {code === currentNodeCode && (
              <span aria-hidden className="text-[11px] font-normal text-primary">
                当前
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="RECRUIT_PROJECT_MANAGER">{recruitment}</TabsContent>
      {navigatorTabs.slice(1).map((code) => (
        <TabsContent key={code} value={code}>
          <EmptyState
            title={`${projectNodeLabel(code)}入口暂未开放`}
            description="可点击“查看项目详情”查看项目资料。"
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
