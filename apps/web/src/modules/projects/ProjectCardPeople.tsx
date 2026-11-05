import type { NavigatorProjectCard } from '@tyde/shared';
import { EntranceExamText } from './EntranceExamText';

/** 管理角色沿用旧任务卡的人员摘要；相同用户去重，同名不同用户仍分别保留。 */
export function ProjectCardPeople({ project }: { project: NavigatorProjectCard }) {
  const owners = [...new Map(project.projectOwners.map((owner) => [owner.userId, owner])).values()]
    .map((owner) => owner.name?.trim())
    .filter(Boolean)
    .join('、');
  return (
    <div className="mt-3 space-y-3 text-xs">
      <p className="text-muted-foreground">{project.categoryDisplayName || '未设置分类'}</p>
      <div className="line-clamp-2">
        <EntranceExamText value={project.projectDescription} empty="暂无项目简介" />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 [&_dd]:min-w-0 [&_dd]:break-words">
        <dt className="text-muted-foreground">项目创建人</dt>
        <dd>{project.creatorName || '暂无'}</dd>
        <dt className="text-muted-foreground">策略官</dt>
        <dd>{project.projectManagerName || '暂无'}</dd>
        <dt className="text-muted-foreground">执行专家负责人</dt>
        <dd>{owners || '待指定'}</dd>
        <dt className="text-muted-foreground">协作人数</dt>
        <dd>
          {Math.max(0, project.activeExpertCount) +
            1 +
            (project.projectManagerName?.trim() ? 1 : 0)}{' '}
          人
        </dd>
      </dl>
    </div>
  );
}
