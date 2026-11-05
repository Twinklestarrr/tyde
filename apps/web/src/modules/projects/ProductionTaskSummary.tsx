import type { ProductionTask } from '@tyde/shared';

/** 与旧工作台一致：总数使用服务端分页总数，状态计数只统计当前页。 */
export function ProductionTaskSummary({
  total,
  tasks,
}: {
  total: number;
  tasks: ProductionTask[];
}) {
  const values = [
    ['总子任务数', total],
    [
      '作业中 / 返修',
      tasks.filter((task) => ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(task.status)).length,
    ],
    ['验收中', tasks.filter((task) => task.status === 'PENDING_ACCEPTANCE').length],
    ['通过 / 完成', tasks.filter((task) => task.status === 'ACCEPTED').length],
  ];
  return (
    <dl
      aria-label="子任务统计"
      className="grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-4"
    >
      {values.map(([label, count]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-lg font-semibold">{count}</dd>
        </div>
      ))}
    </dl>
  );
}
