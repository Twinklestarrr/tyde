/** 八个主流程归属项目内部；进度只使用后端返回的主节点，不推算业务完成事实。 */
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

export function ProjectWorkflow({ currentNodeCode }: { currentNodeCode: string | null }) {
  return (
    <section aria-label="项目主流程" className="rounded-[16px] border bg-card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">项目主流程</h2>
        <p className="text-[13px] text-muted-foreground">
          当前阶段：{projectNodeLabel(currentNodeCode)}
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {stages.map(([code, label], index) => (
          <li
            key={code}
            aria-current={code === currentNodeCode ? 'step' : undefined}
            className={`flex items-center gap-2 rounded-lg border px-3 py-3 text-[13px] ${code === currentNodeCode ? 'border-primary bg-accent font-medium text-primary' : 'text-muted-foreground'}`}
          >
            <span aria-hidden className="text-xs opacity-70">
              {index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
}
