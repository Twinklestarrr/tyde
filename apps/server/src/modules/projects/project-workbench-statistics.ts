import { Prisma, type Project } from '@prisma/client';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { participatingStatuses } from '../organizations/organization.service.js';
import { collectRecruitmentTasks } from './project-recruitment-snapshot.js';
import { collectGradingTasks } from '../entrance-exams/exam-grading-tasks.js';
import { entryTasks } from '../personnel/personnel-progress.js';
import {
  currentApprovers,
  transferInclude,
  isManualTransferStep,
} from '../personnel/personnel-transfer.js';
import { memberInclude, qualifiedForEntry } from '../personnel/personnel-access.js';
import { outputTasks } from '../production/output-report-progress.js';
import { acceptanceTasks } from '../production/acceptance.service.js';
import { creationTasks } from '../production/production.service.js';
import { candidateContext } from '../entrance-exams/exam-candidate.service.js';
import type { TaskSnapshot } from './project-task-rounds.js';

export type WorkbenchMode = 'TASK' | 'BOARD';
export const startupNodes = [
  'RECRUIT_PROJECT_MANAGER',
  'PRODUCTION_PLAN',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
];
// 统计与108不同：仅已在任PM，不包括待接受候选。
export function boardStatisticsScope(p: AuthPrincipal): Prisma.ProjectWhereInput {
  if (p.role === 'NAVIGATOR') return { createdBy: p.uid };
  if (p.role === 'PM')
    return {
      managerRecruitments: {
        some: {
          status: 'ASSIGNED',
          OR: [{ candidateUserId: p.userId }, { expertRecruitmentHandlerUserId: p.userId }],
        },
      },
    };
  if (p.role !== 'EXPERT') throw new AuthError(403, 'FORBIDDEN', '当前角色无工作台统计权限');
  const member = { userId: p.userId, joinStatus: { in: participatingStatuses } };
  return {
    expertAssignments: {
      some: {
        subjectType: 'ORGANIZATION',
        status: 'ACCEPTED',
        organization: { deleted: false, memberships: { some: member } },
        OR: [
          { organization: { memberships: { some: { ...member, position: 'OWNER' } } } },
          { owners: { some: { userId: p.userId, status: 'ACTIVE' } } },
          { projectOwnerUserId: p.userId, owners: { none: {} } },
        ],
      },
    },
  };
}
export function taskStatisticsScope(p: AuthPrincipal): Prisma.ProjectWhereInput {
  const board = boardStatisticsScope(p);
  if (p.role !== 'EXPERT')
    return {
      OR: [
        board,
        {
          entranceExams: {
            some: {
              deleted: false,
              versions: {
                some: {
                  gradingRounds: {
                    some: {
                      gradingMode: 'MANUAL',
                      reviewersJson: { array_contains: [{ userId: p.userId }] },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };
  return {
    OR: [
      board,
      {
        expertAssignments: {
          some: {
            status: 'ACCEPTED',
            OR: [
              { subjectType: 'INDIVIDUAL', expertUserId: p.userId },
              {
                subjectType: 'ORGANIZATION',
                organization: {
                  deleted: false,
                  memberships: {
                    some: { userId: p.userId, joinStatus: { in: participatingStatuses } },
                  },
                },
                memberResponses: {
                  some: { userId: p.userId, status: { in: ['ACCEPTED', 'SELECTED'] } },
                },
              },
            ],
          },
        },
      },
      {
        members: {
          some: {
            userId: p.userId,
            status: {
              in: [
                'ACTIVE',
                'PENDING_TRANSFER',
                'PENDING_EXIT',
                'PENDING_CONFIRM',
                'PENDING_ENTRY',
              ],
            },
            OR: [
              { organizationId: null },
              {
                organization: { deleted: false },
                organizationMembership: { joinStatus: { in: participatingStatuses } },
              },
            ],
          },
        },
      },
      {
        incomingMovements: {
          some: {
            userId: p.userId,
            status: 'PROCESSING',
            flow: { status: 'PENDING', currentNodeCode: 'TARGET_ENTRANCE_EXAM' },
          },
        },
      },
    ],
  };
}
export const statisticsTaskType = (type: string) =>
  type === 'SUBTASK_REWORK_REVIEW' ? 'SUBTASK_ACCEPTANCE' : type;
export function taskCounts(
  sources: Map<number, Set<string>>,
  rounds: { projectId: number; taskType: string; status: string; finishedAt: Date | null }[],
  now: Date,
) {
  const start = new Date(now);
  start.setTime(Math.floor((now.getTime() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000);
  const seen = new Set<string>();
  let completedTaskCount = 0;
  // 查询必须按id倒序；不能先按日期/状态过滤，否则会把旧完成轮次算进来。
  for (const r of rounds) {
    const type = statisticsTaskType(r.taskType),
      key = `${r.projectId}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      !sources.get(r.projectId)?.has(type) &&
      r.status === 'COMPLETED' &&
      r.finishedAt &&
      r.finishedAt >= start &&
      r.finishedAt.getTime() < start.getTime() + 86400000
    )
      completedTaskCount++;
  }
  return {
    mode: 'TASK' as const,
    pendingTaskCount: [...sources.values()].reduce((n, types) => n + types.size, 0),
    completedTaskCount,
    involvedProjectCount: [...sources.values()].filter((types) => types.size > 0).length,
  };
}
export async function personalTasks(
  tx: Prisma.TransactionClient,
  project: Project,
  p: AuthPrincipal,
  now: Date,
) {
  const types = new Set<string>();
  if (p.role !== 'EXPERT') return types;
  const member = await tx.projectMember.findFirst({
    where: { projectId: project.id, userId: p.userId },
    orderBy: { id: 'desc' },
    include: memberInclude,
  });
  const plan = await tx.projectProductionPlan.findUnique({ where: { projectId: project.id } });
  const isOwner = await tx.projectExpertAssignment.count({
    where: {
      projectId: project.id,
      subjectType: 'ORGANIZATION',
      status: 'ACCEPTED',
      organization: {
        deleted: false,
        memberships: { some: { userId: p.userId, joinStatus: { in: participatingStatuses } } },
      },
      OR: [
        { owners: { some: { userId: p.userId, status: 'ACTIVE' } } },
        { projectOwnerUserId: p.userId, owners: { none: {} } },
      ],
    },
  });
  if (!isOwner && member) {
    if (
      ['ACTIVE', 'PENDING_TRANSFER', 'PENDING_EXIT'].includes(member.status) &&
      member.joinedAt &&
      member.entryDecision !== 'NO' &&
      !member.standardTrainingConfirmedAt &&
      qualifiedForEntry(member, plan?.needWrittenExam ?? false)
    )
      types.add('STANDARD_TRAINING');
    return types;
  }
  try {
    const context = await candidateContext(tx, project.id, p.userId, true);
    if (
      context.movement &&
      (context.movement.status !== 'PROCESSING' ||
        context.movement.flow?.currentNodeCode !== 'TARGET_ENTRANCE_EXAM')
    )
      return types;
    if (!context.movement && !plan?.needWrittenExam) return types;
    const submitted = await tx.entranceExamAttempt.count({
      where: {
        candidateUserId: p.userId,
        exam: { projectId: project.id, deleted: false },
        ...(context.movement
          ? { sourceBizType: context.sourceBizType, sourceBizId: context.sourceBizId }
          : {}),
        submittedAt: { not: null },
      },
    });
    if (submitted) return types;
    if (isOwner) {
      const exams = await tx.projectEntranceExam.findMany({
        where: { projectId: project.id, deleted: false, status: 'ACTIVE' },
        include: { currentVersion: true },
      });
      if (
        !exams.some(
          (e) =>
            e.currentVersion?.examId === e.id &&
            e.currentVersion.registrationDeadline &&
            e.currentVersion.registrationDeadline > now,
        )
      )
        return types;
    }
    types.add('ENTRANCE_EXAM');
  } catch (error) {
    if (!(error instanceof AuthError && error.status === 403)) throw error;
  }
  return types;
}
async function currentMovementTask(
  tx: Prisma.TransactionClient,
  projectId: number,
  p: AuthPrincipal,
) {
  if (p.role === 'NAVIGATOR') return false;
  const rows = await tx.projectMemberMovement.findMany({
    where: {
      OR: [{ sourceProjectId: projectId }, { targetProjectId: projectId }],
      status: 'PROCESSING',
      flow: { status: 'PENDING' },
    },
    include: transferInclude,
  });
  for (const row of rows) {
    const code = row.flow?.currentNodeCode;
    if (
      !code ||
      !isManualTransferStep(code) ||
      (code === 'SOURCE_ORG_OWNER' ? row.sourceProjectId : row.targetProjectId) !== projectId ||
      (code === 'TARGET_MANAGER' ? p.role !== 'PM' : p.role !== 'EXPERT')
    )
      continue;
    try {
      if ((await currentApprovers(tx, row, code)).some((u) => u.id === p.userId)) return true;
    } catch (error) {
      if (!(error instanceof AuthError && error.status === 403)) throw error;
    }
  }
  return false;
}
export async function workbenchStatistics(
  tx: Prisma.TransactionClient,
  mode: WorkbenchMode,
  p: AuthPrincipal,
  now: Date,
) {
  const scope = boardStatisticsScope(p);
  if (mode === 'BOARD') {
    const where = { deleted: false, status: 'PUBLISHED', AND: [scope] };
    return {
      mode,
      totalProjectCount: await tx.project.count({ where }),
      startupProjectCount: await tx.project.count({
        where: { ...where, currentNodeCode: { in: startupNodes } },
      }),
      assemblyProjectCount: await tx.project.count({
        where: { ...where, currentNodeCode: 'RECRUIT_EXECUTION_EXPERT' },
      }),
      productionProjectCount: await tx.project.count({
        where: {
          ...where,
          currentNodeCode: 'PRODUCTION_TASK',
          subtasks: { some: { outputReports: { some: {} } } },
        },
      }),
    };
  }
  const projects = await tx.project.findMany({
    where: { deleted: false, status: 'PUBLISHED', AND: [taskStatisticsScope(p)] },
    orderBy: { id: 'asc' },
  });
  const sources = new Map<number, Set<string>>();
  const visible: number[] = [];
  for (const project of projects) {
    // 最终资格再次用实际关系校验；成员/历史阅卷可见项目不要求管理看板资格。
    const management = await collectRecruitmentTasks(tx, project);
    const grading = await collectGradingTasks(tx, project.id);
    let eligible = [...management.scopes, ...grading.scopes].some(
      (s) => s.userId === p.userId && s.role === p.role,
    );
    if (p.role === 'EXPERT') {
      eligible = !!(await tx.project.count({ where: { id: project.id, AND: [scope] } }));
      if (!eligible) {
        try {
          await candidateContext(tx, project.id, p.userId, true);
          eligible = true;
        } catch (error) {
          if (!(error instanceof AuthError && error.status === 403)) throw error;
        }
      }
    }
    if (!eligible) continue;
    visible.push(project.id);
    const types = new Set<string>();
    sources.set(project.id, types);
    if (project.currentNodeCode === 'COMPLETED') continue;
    const snapshots: TaskSnapshot[] = [
      management,
      grading,
      await entryTasks(tx, project.id),
      await outputTasks(tx, project.id, now),
      await acceptanceTasks(tx, project.id),
      await creationTasks(tx, project.id),
    ];
    for (const snapshot of snapshots)
      for (const source of snapshot.sources)
        if (
          source.userId === p.userId &&
          source.role === p.role &&
          source.sources.length &&
          !['PRODUCTION_TASK', 'OUTPUT_REPORT_CORRECTION'].includes(source.taskType)
        )
          types.add(statisticsTaskType(source.taskType));
    if (await currentMovementTask(tx, project.id, p)) types.add('MEMBER_MOVEMENT_APPROVAL');
    for (const type of await personalTasks(tx, project, p, now)) types.add(type);
  }
  const rounds = visible.length
    ? await tx.projectTaskRound.findMany({
        where: { userId: p.userId, role: p.role, projectId: { in: visible } },
        orderBy: { id: 'desc' },
        select: { projectId: true, taskType: true, status: true, finishedAt: true },
      })
    : [];
  return taskCounts(sources, rounds, now);
}
