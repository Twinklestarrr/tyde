import type { Prisma } from '@prisma/client';
import { collectGradingTasks } from '../entrance-exams/exam-grading-task.repository.js';
import { expertCardPerspectives } from '../expert/expert-card.domain.js';
import { entryTasks } from '../personnel/personnel-task.repository.js';
import { currentApprovers } from '../personnel/personnel-transfer.access.js';
import { transferInclude } from '../personnel/personnel-transfer.types.js';
import { acceptanceTasks } from '../production/acceptance.repository.js';
import { outputTasks } from '../production/output-report-task.repository.js';
import { creationTasks } from '../production/production.repository.js';
import {
  type Branch,
  key,
  type ManagementBranchCandidate,
  managementBranchPriority,
  managementBranchWinners,
  managementCardChanges,
} from './project-card.domain.js';
import { collectExpertCardCandidates } from './project-expert-card-candidates.js';
import { collectRecruitmentTasks } from './project-recruitment-task.repository.js';
import type { TaskSnapshot } from './project-task.types.js';

// 统一管理 NAV/PM 与 EXPERT 多组织管理、个人履约视角。
// 调用方已持有项目锁，所有来源读取和快照落库共用业务事务。查询失败直接抛出，
// 不能把部分候选当成完整候选集，删除/覆盖正确的旧快照。
export async function refreshManagementCardSnapshots(
  tx: Prisma.TransactionClient,
  projectId: number,
  now = new Date(),
) {
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const existing = await tx.projectRoleNodeSnapshot.findMany({
    where: {
      projectId,
      perspective: {
        in: [
          'NAVIGATOR',
          'PROJECT_MANAGER',
          'EXPERT_RECRUITMENT_HANDLER',
          ...expertCardPerspectives,
        ],
      },
    },
  });
  const candidates: ManagementBranchCandidate[] = [];
  if (
    !project.deleted &&
    project.status === 'PUBLISHED' &&
    project.currentNodeCode !== 'COMPLETED'
  ) {
    const snapshots = await Promise.all([
      collectRecruitmentTasks(tx, project),
      collectGradingTasks(tx, projectId),
      entryTasks(tx, projectId),
      outputTasks(tx, projectId, now),
      acceptanceTasks(tx, projectId),
      creationTasks(tx, projectId),
    ]);
    candidates.push(...(await collectExpertCardCandidates(tx, projectId, now)));
    const movements = await tx.projectMemberMovement.findMany({
      where: {
        targetProjectId: projectId,
        status: 'PROCESSING',
        flow: { status: 'PENDING', currentNodeCode: 'TARGET_MANAGER' },
      },
      include: transferInclude,
    });
    // 审批受众按当前任职重新判定，不依赖未同步的历史 approverId。
    for (const movement of movements)
      for (const user of await currentApprovers(tx, movement, 'TARGET_MANAGER'))
        candidates.push({
          userId: user.id,
          perspective: 'PROJECT_MANAGER',
          branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
          sourceBizType: 'PROJECT_MEMBER_MOVEMENT',
          sourceBizId: movement.id,
          sourceEventAt: movement.createdAt,
        });

    const refs: {
      userId: string;
      perspective: string;
      branchNodeCode: Branch;
      type: string;
      id: number;
    }[] = [];
    for (const snapshot of snapshots)
      for (const source of snapshot.sources) {
        if (!(source.taskType in managementBranchPriority)) continue;
        for (const scope of sourceScopes(snapshot, source))
          for (const ref of source.sources) {
            const [type, id] = ref.split(':');
            refs.push({
              ...scope,
              branchNodeCode: source.taskType as Branch,
              type: type!,
              id: Number(id),
            });
          }
      }
    const ids = (type: string) => [
      ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
    ];
    const [assignments, records, members, reports, subtasks] = await Promise.all([
      tx.projectExpertAssignment.findMany({
        where: { projectId, id: { in: ids('EXPERT_ASSIGNMENT') } },
      }),
      tx.entranceExamGradingRecord.findMany({
        where: { id: { in: ids('GRADING_RECORD') }, attempt: { exam: { projectId } } },
      }),
      tx.projectMember.findMany({ where: { projectId, id: { in: ids('PROJECT_MEMBER') } } }),
      tx.projectOutputReport.findMany({ where: { projectId, id: { in: ids('OUTPUT_REPORT') } } }),
      tx.projectSubtask.findMany({ where: { projectId, id: { in: ids('SUBTASK') } } }),
    ]);
    for (const ref of refs) {
      let sourceEventAt: Date | null | undefined;
      if (ref.type === 'PROJECT') sourceEventAt = ref.id === projectId ? project.createdAt : null;
      if (ref.type === 'EXPERT_ASSIGNMENT') {
        const row = assignments.find((r) => r.id === ref.id);
        sourceEventAt = row?.rejectedAt ?? row?.createdAt;
      }
      if (ref.type === 'GRADING_RECORD')
        sourceEventAt = records.find((r) => r.id === ref.id)?.createdAt;
      if (ref.type === 'PROJECT_MEMBER') {
        const row = members.find((r) => r.id === ref.id);
        sourceEventAt = row?.admittedAt ?? row?.createdAt;
      }
      if (ref.type === 'OUTPUT_REPORT')
        sourceEventAt = reports.find((r) => r.id === ref.id)?.createdAt;
      if (ref.type === 'SUBTASK') {
        const row = subtasks.find((r) => r.id === ref.id);
        sourceEventAt =
          ref.branchNodeCode === 'SUBTASK_REWORK_SUBMIT' ? row?.reviewedAt : row?.submittedAt;
      }
      if (!sourceEventAt) throw new Error(`卡片候选缺少真实来源或业务时间：${ref.type}:${ref.id}`);
      candidates.push({ ...ref, sourceBizType: ref.type, sourceBizId: ref.id, sourceEventAt });
    }
  }
  // 统一账号的会话角色不参与候选过滤；仅账号被停用时撤销其所有管理快照。
  const active = new Set(
    (
      await tx.user.findMany({
        where: { id: { in: [...new Set(candidates.map((r) => r.userId))] }, status: 'ACTIVE' },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const winners = managementBranchWinners(candidates.filter((r) => active.has(r.userId)));
  // 在完整采集成功后才写入；失权、终态和最后一个来源消失均清除旧快照。
  for (const old of existing)
    if (!winners.has(key(old)))
      await tx.projectRoleNodeSnapshot.deleteMany({ where: { id: old.id } });
  for (const winner of winners.values()) {
    const { userId, perspective, branchNodeCode, sourceBizType, sourceBizId, sourceEventAt } =
      winner;
    const data = {
      branchNodeCode,
      branchPriority: managementBranchPriority[branchNodeCode],
      sourceBizType,
      sourceBizId,
      sourceEventAt,
      calculatedAt: now,
    };
    await tx.projectRoleNodeSnapshot.upsert({
      where: { projectId_userId_perspective: { projectId, userId, perspective } },
      create: { projectId, userId, perspective, ...data },
      update: data,
    });
  }
  return managementCardChanges(existing, [...winners.values()]);
}

function sourceScopes(snapshot: TaskSnapshot, source: TaskSnapshot['sources'][number]) {
  const scopes = snapshot.scopes.filter(
    (s) => s.role !== 'EXPERT' && s.userId === source.userId && s.role === source.role,
  );
  // 负责人兼任招募协作时，补招只落主策略官视角；协作人不获得其他 PM 支线。
  return scopes.filter(
    (s) =>
      s.perspective !== 'EXPERT_RECRUITMENT_HANDLER' ||
      (source.taskType === 'EXPERT_RECRUITMENT_RETRY' &&
        !scopes.some((r) => r.perspective === 'PROJECT_MANAGER')),
  );
}
