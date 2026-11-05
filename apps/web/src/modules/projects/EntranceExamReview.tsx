import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { AuthUser, EntranceExamCard, EntranceExamRosterItem } from '@tyde/shared';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { EntranceExamRoster } from './EntranceExamRosterViews';
import { EntranceExamGradingWorkspace } from './EntranceExamGradingWorkspace';

/** 每场考试的名单独立展开，选中的历史卷面始终保留在右侧。 */
export function EntranceExamReview({
  user,
  projectId,
  exams,
  role = 'PM',
  canManage,
  renderActions,
  onChanged,
}: {
  user: AuthUser;
  projectId: number;
  exams: EntranceExamCard[];
  role?: 'PM' | 'NAVIGATOR';
  canManage: boolean;
  renderActions: (exam: EntranceExamCard) => ReactNode;
  onChanged: (written?: boolean) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [selected, setSelected] = useState<{
    exam: EntranceExamCard;
    row: EntranceExamRosterItem;
  } | null>(null);
  const [selectedOnce, setSelectedOnce] = useState(false);
  function select(exam: EntranceExamCard, row: EntranceExamRosterItem, automatic = false) {
    if (automatic && selectedOnce) return;
    if (
      !automatic &&
      selected?.row.attemptId !== row.attemptId &&
      !window.dispatchEvent(new Event(ENTRANCE_EXAM_LEAVE_REQUEST, { cancelable: true }))
    )
      return;
    setSelectedOnce(true);
    setSelected((current) => (automatic && current ? current : { exam, row }));
  }
  if (!exams.length) return <EmptyState title="暂无考试" />;
  return (
    <section
      aria-label="考试名单"
      className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"
    >
      <div className="min-w-0 space-y-4">
        {exams.map((exam) => {
          const expanded = !collapsed.includes(exam.examId);
          return (
            <Card asChild key={exam.examId}>
              <article aria-label={exam.examName} className="min-w-0 overflow-hidden p-4">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsed((current) =>
                      expanded
                        ? [...current, exam.examId]
                        : current.filter((id) => id !== exam.examId),
                    )
                  }
                >
                  <span className="min-w-0 space-y-2">
                    <span className="block text-xs text-muted-foreground">
                      {exam.examNo} · {exam.status === 'ACTIVE' ? '进行中' : '已关闭'}
                    </span>
                    <CardTitle asChild>
                      <h3>{exam.examName}</h3>
                    </CardTitle>
                    <span className="block text-[13px] text-muted-foreground">
                      已交卷 {exam.examineeCount} 人 · 考试通过 {exam.admittedCount} 人 · 通过率{' '}
                      {exam.admissionRate}%
                    </span>
                  </span>
                  {expanded ? (
                    <ChevronUp className="size-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronDown className="size-4 shrink-0" aria-hidden />
                  )}
                </button>
                <div hidden={!expanded} className="mt-4 space-y-4 border-t pt-4">
                  <p className="text-xs text-muted-foreground">
                    创建：{exam.createdAt}（上海时间）
                    {exam.closedAt ? ` · 关闭：${exam.closedAt}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">{renderActions(exam)}</div>
                  <EntranceExamRoster
                    user={user}
                    projectId={projectId}
                    examId={exam.examId}
                    role={role}
                    selectedAttemptId={selected?.row.attemptId}
                    autoSelect={!selectedOnce}
                    active={expanded}
                    onSelect={(row, automatic) => select(exam, row, automatic)}
                  />
                </div>
              </article>
            </Card>
          );
        })}
      </div>
      <div className="min-w-0 rounded-xl border p-4 sm:p-5">
        {selected ? (
          <EntranceExamGradingWorkspace
            key={`${selected.exam.examId}:${selected.row.attemptId}`}
            user={user}
            projectId={projectId}
            examId={selected.exam.examId}
            attemptId={selected.row.attemptId}
            candidateUserId={selected.row.candidateUserId}
            role={role}
            canManage={canManage}
            onChanged={onChanged}
            onBack={() => setSelected(null)}
          />
        ) : (
          <EmptyState title="选择考生查看阅卷详情" />
        )}
      </div>
    </section>
  );
}
