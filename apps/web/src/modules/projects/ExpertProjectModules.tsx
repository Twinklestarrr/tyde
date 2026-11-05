import { ExpertProductionPlanView } from './ExpertProductionPlanView';
import { EmptyState } from '@/components/ui/empty-state';
import { useEffect, useState } from 'react';
import type { AuthUser, ExpertTask } from '@tyde/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ExpertExamPanel, ExpertExamStatus, EXPERT_EXAM_LEAVE_REQUEST } from './ExpertExamPanel';
import { ExpertTrainingPanel, EXPERT_TRAINING_LEAVE_REQUEST } from './ExpertTrainingPanel';
import { ExpertProductionPanel } from './ExpertProductionPanel';
import { ExpertPersonnelPanel } from './ExpertPersonnelPanel';
import { EXPERT_PRODUCTION_LEAVE_REQUEST, isExpertProductionTask } from './expert-production-form';
import { canManageExpertPersonnel, isExpertPersonnelApproval } from './expert-personnel-form';
import { PERSONNEL_LEAVE_REQUEST } from './personnel-form';

/** 仅列出当前真实待办与已接单组织管理能力；普通成员不借组织ID获得人员入口。 */
export function ExpertProjectModules({
  user,
  task,
  onExamChanged,
  onExamCancelled,
  onTrainingConfirmed,
  onProductionChanged,
  onPersonnelChanged,
}: {
  user: AuthUser;
  task: ExpertTask;
  onExamChanged: () => Promise<void>;
  onExamCancelled?: () => Promise<void>;
  onTrainingConfirmed: () => Promise<void>;
  onProductionChanged: () => Promise<void>;
  onPersonnelChanged: () => Promise<void>;
}) {
  const exam = task.acceptanceStatus === 'ACCEPTED' && task.branchNodeCode === 'ENTRANCE_EXAM';
  const leadership =
    task.accessContext.projectOwner || task.accessContext.acceptedOrganizationOwner;
  const node = leadership ? task.currentNodeCode : (task.branchNodeCode ?? task.currentNodeCode);
  const pastTraining = [
    'RECRUIT_EXECUTION_EXPERT',
    'PERSONNEL_MANAGEMENT',
    'PRODUCTION_TASK',
    'OUTPUT_DATA_REVIEW',
    'COMPLETED',
  ].includes(node);
  const training =
    task.acceptanceStatus === 'ACCEPTED' &&
    (node === 'STANDARD_TRAINING' ||
      pastTraining ||
      (node === 'ENTRANCE_EXAM' && !task.needWrittenExam && !exam));
  const pastExam =
    training || node === 'MEMBER_ENTRY_CONFIRM' || node === 'MEMBER_MOVEMENT_APPROVAL';
  // 当前考试分支是实际待办；转项可独立触发考试，不受项目初始笔试配置覆盖。
  const showExam = exam || (pastExam && task.needWrittenExam);
  const production = isExpertProductionTask(task);
  const personnel = canManageExpertPersonnel(task) || isExpertPersonnelApproval(task);
  const preferred =
    isExpertPersonnelApproval(task) || task.branchNodeCode === 'MEMBER_ENTRY_CONFIRM'
      ? 'personnel'
      : production
        ? 'production'
        : exam
          ? 'exam'
          : training
            ? 'training'
            : personnel
              ? 'personnel'
              : 'planning';
  const [view, setView] = useState(preferred);
  useEffect(() => setView(preferred), [preferred]);
  const modules = [
    ...(leadership ? [['planning', '生产计划']] : []),
    ...(showExam ? [['exam', '准入考试']] : []),
    ...(training ? [['training', '标准与培训']] : []),
    ...(production ? [['production', '生产任务']] : []),
    ...(personnel ? [['personnel', '人员管理']] : []),
  ];
  if (!modules.length) return null;
  return (
    <Tabs
      value={view}
      onValueChange={(next) => {
        if (next === view) return;
        for (const name of [
          EXPERT_EXAM_LEAVE_REQUEST,
          EXPERT_TRAINING_LEAVE_REQUEST,
          EXPERT_PRODUCTION_LEAVE_REQUEST,
          PERSONNEL_LEAVE_REQUEST,
        ])
          if (!window.dispatchEvent(new Event(name, { cancelable: true }))) return;
        setView(next);
      }}
    >
      {modules.length > 1 && (
        <TabsList
          aria-label="执行专家项目模块"
          variant="business"
          className="mb-4 flex h-auto flex-wrap justify-start"
        >
          {modules.map(([value, label]) => (
            <TabsTrigger key={value} value={value!} variant="business" className="min-h-11 px-3">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      {leadership && (
        <TabsContent value="planning">
          <ExpertProductionPlanView user={user} task={task} />
        </TabsContent>
      )}
      {showExam && (
        <TabsContent value="exam">
          {exam && !leadership ? (
            <ExpertExamPanel
              user={user}
              task={task}
              onChanged={onExamChanged}
              onCancelled={onExamCancelled}
            />
          ) : leadership ? (
            <EmptyState title="考试管理暂不可用" />
          ) : (
            <ExpertExamStatus user={user} projectId={task.basicInfo.projectId} />
          )}
        </TabsContent>
      )}
      {training && (
        <TabsContent value="training">
          <ExpertTrainingPanel user={user} task={task} onConfirmed={onTrainingConfirmed} />
        </TabsContent>
      )}
      {production && (
        <TabsContent value="production">
          <ExpertProductionPanel user={user} task={task} onChanged={onProductionChanged} />
        </TabsContent>
      )}
      {personnel && (
        <TabsContent value="personnel">
          <ExpertPersonnelPanel user={user} task={task} onChanged={onPersonnelChanged} />
        </TabsContent>
      )}
    </Tabs>
  );
}
