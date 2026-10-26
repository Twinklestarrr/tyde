import type { ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
  onViewDetails,
}: {
  currentNodeCode: string | null;
  recruitment: ReactNode;
  onViewDetails: () => void;
}) {
  return (
    <section aria-label="项目主流程" className="rounded-[16px] border bg-card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">领航员项目流程</h2>
        <p className="text-[13px] text-muted-foreground">
          当前阶段：{projectNodeLabel(currentNodeCode)}
        </p>
      </div>
      <Tabs defaultValue="RECRUIT_PROJECT_MANAGER">
        <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
          <TabsList
            aria-label="领航员项目模块"
            variant="business"
            className="mb-0 flex h-auto w-full min-w-0 flex-none flex-wrap justify-start sm:w-auto sm:flex-1"
          >
            {navigatorTabs.map((code) => (
              <TabsTrigger
                key={code}
                value={code}
                variant="business"
                aria-current={code === currentNodeCode ? 'step' : undefined}
                className="min-h-11 flex-1 sm:flex-none"
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
          <Button variant="primaryOutline" size="mobileTouch" onClick={onViewDetails}>
            <FileText className="size-4" aria-hidden />
            查看项目详情
          </Button>
        </div>
        <TabsContent value="RECRUIT_PROJECT_MANAGER">{recruitment}</TabsContent>
        {navigatorTabs.slice(1).map((code) => (
          <TabsContent
            key={code}
            value={code}
            className="rounded-xl border border-dashed p-5 text-[13px] leading-6 text-muted-foreground"
          >
            {projectNodeLabel(code)}入口暂未开放，可点击“查看项目详情”查看项目资料。
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
