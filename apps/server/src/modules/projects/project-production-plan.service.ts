import {
  Prisma,
  type PrismaClient,
  type Project,
  type ProjectProductionStage,
} from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { ManagementService } from '../management/management.service.js';
import { projectTime } from './project-time.js';
import { refreshManagementCardSnapshots } from './project-management-card-snapshot.js';
import { refreshOwnerProgress } from '../expert/expert-owner-command.js';
import {
  collectManagementTasks,
  managementTaskTypes,
  reconcileTaskRounds,
} from './project-task-rounds.js';

export interface ProductionStageInput {
  stageName: string;
  startDate: string;
  endDate: string;
  workdayCount?: number | null;
  workdayCountSource?: 'AUTO' | 'MANUAL' | null;
  operatorHeadcount: number;
  operatorCpd?: number | null;
  accuracyRate?: number | null;
}
export interface ProductionPlanInput {
  operatorHeadcount: number;
  operatorCpd: number;
  inspectorHeadcount?: number | null;
  inspectorCpd?: number | null;
  needWrittenExam?: boolean | null;
  maxActiveExamCount?: number | null;
  needInterview?: boolean | null;
  extJson?: Prisma.InputJsonValue | null;
  crowds: { crowdName: string; profileRequirement: string }[];
  stages: ProductionStageInput[];
}
// 独立上下文，避免默认20位精度在DECIMAL(30,4)产出乘加时提前舍入。
const Decimal = Prisma.Decimal.clone({ precision: 60 });
const invalid = (message: string): never => {
  throw new AuthError(400, 'VALIDATION_ERROR', message);
};
const integer = (value: number, name: string) => {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647)
    invalid(`${name}必须为32位正整数`);
  return value;
};
// 与旧表DECIMAL边界一致；先验证尺度，避免数据库静默四舍五入后与计算值不一致。
export function planDecimal(value: number, precision = 20): Prisma.Decimal {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    invalid('产能/准确率必须为正数');
  const decimal = new Decimal(value);
  if (decimal.decimalPlaces() > 4 || decimal.gte(new Decimal(10).pow(precision - 4)))
    invalid(`数值最多${precision - 4}位整数及4位小数`);
  return decimal;
}
export function planDate(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    invalid('日期格式必须为有效yyyy-MM-dd');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    invalid('日期不合法');
  return date;
}
export function buildProductionPlan(input: ProductionPlanInput, now = new Date()) {
  const operatorHeadcount = integer(input.operatorHeadcount, '作业人数');
  const operatorCpd = planDecimal(input.operatorCpd);
  if ((input.inspectorHeadcount == null) !== (input.inspectorCpd == null))
    invalid('质检人数和质检CPD需同时填写');
  const inspectorHeadcount =
    input.inspectorHeadcount == null ? null : integer(input.inspectorHeadcount, '质检人数');
  const inspectorCpd = input.inspectorCpd == null ? null : planDecimal(input.inspectorCpd);
  const maxActiveExamCount = integer(input.maxActiveExamCount ?? 1, '准入考试数量');
  if (
    !input.crowds?.length ||
    input.crowds.length > 50 ||
    !input.stages?.length ||
    input.stages.length > 50
  )
    invalid('人群和阶段分别需要1至50项');
  const crowds = input.crowds.map((crowd, index) => {
    if (
      !crowd?.crowdName?.trim() ||
      crowd.crowdName.length > 100 ||
      !crowd.profileRequirement?.trim()
    )
      invalid('人群名称和画像要求必填，名称最多100字符');
    return {
      sequenceNo: index + 1,
      crowdName: crowd.crowdName.trim(),
      profileRequirement: crowd.profileRequirement.trim(),
    };
  });
  const stages = input.stages.map((stage, index) => {
    if (!stage?.stageName?.trim() || stage.stageName.length > 100)
      invalid('阶段名称必填且最多100字符');
    const startDate = planDate(stage.startDate),
      endDate = planDate(stage.endDate);
    if (stage.startDate < projectTime(now).slice(0, 10)) invalid('开始日期早于当前日期');
    if (endDate < startDate) invalid('结束日期早于开始日期');
    const naturalDayCount = (endDate.getTime() - startDate.getTime()) / 86400000 + 1;
    const workdayCountSource = stage.workdayCountSource ?? 'AUTO';
    if (!['AUTO', 'MANUAL'].includes(workdayCountSource)) invalid('天数来源只能为AUTO或MANUAL');
    if (stage.workdayCount != null) integer(stage.workdayCount, '阶段有效生产天数');
    // 整周批算，余数最多6天；不按日期跨度循环，且不扣除法定节假日。
    let weekdays = Math.floor(naturalDayCount / 7) * 5;
    for (let day = 0; day < naturalDayCount % 7; day++) {
      const weekday = (startDate.getUTCDay() + day) % 7;
      if (weekday !== 0 && weekday !== 6) weekdays++;
    }
    const workdayCount = integer(
      workdayCountSource === 'MANUAL' ? stage.workdayCount! : weekdays,
      '阶段有效生产天数',
    );
    const headcount = integer(stage.operatorHeadcount, '阶段作业人数');
    const cpd = stage.operatorCpd == null ? operatorCpd : planDecimal(stage.operatorCpd);
    const accuracyRate = stage.accuracyRate == null ? null : planDecimal(stage.accuracyRate, 7);
    if (accuracyRate?.gt(100)) invalid('准确率需大于0且不超过100');
    const expectedOutput = cpd.mul(headcount).mul(workdayCount);
    if (expectedOutput.gte('1e26')) invalid('阶段预期产出超过DECIMAL(30,4)范围');
    return {
      sequenceNo: index + 1,
      stageName: stage.stageName.trim(),
      startDate,
      endDate,
      naturalDayCount,
      workdayCount,
      workdayCountSource,
      operatorHeadcount: headcount,
      operatorCpd: cpd,
      accuracyRate,
      expectedOutput,
    };
  });
  const totalExpectedOutput = stages.reduce(
    (sum, stage) => sum.add(stage.expectedOutput),
    new Decimal(0),
  );
  if (totalExpectedOutput.gte('1e26')) invalid('总预期产出超过DECIMAL(30,4)范围');
  return {
    operatorHeadcount,
    operatorCpd,
    inspectorHeadcount,
    inspectorCpd,
    maxActiveExamCount,
    needWrittenExam: input.needWrittenExam ?? true,
    needInterview: input.needInterview ?? false,
    totalExpectedOutput,
    crowds,
    stages,
  };
}
const nodes = [
  'RECRUIT_PROJECT_MANAGER',
  'PRODUCTION_PLAN',
  'ENTRANCE_EXAM',
  'STANDARD_TRAINING',
  'RECRUIT_EXECUTION_EXPERT',
  'PERSONNEL_MANAGEMENT',
  'PRODUCTION_TASK',
  'COMPLETED',
];
export function nodeAfterPlan(current: string | null, written: boolean) {
  const target = written ? 'ENTRANCE_EXAM' : 'STANDARD_TRAINING';
  return current && nodes.indexOf(current) >= nodes.indexOf(target) ? current : target;
}
const include = {
  crowds: { orderBy: { sequenceNo: 'asc' as const } },
  stages: { orderBy: { sequenceNo: 'asc' as const } },
};
type Plan = Prisma.ProjectProductionPlanGetPayload<{ include: typeof include }>;
const number = (value: Prisma.Decimal | null) => (value == null ? null : value.toNumber());
export class ProjectProductionPlanService {
  readonly management: ManagementService;
  constructor(readonly db: PrismaClient) {
    this.management = new ManagementService(db);
  }
  private async accessible(
    tx: Prisma.TransactionClient,
    projectId: number,
    principal: AuthPrincipal,
    write: boolean,
  ) {
    const project = await tx.project.findFirst({ where: { id: projectId, deleted: false } });
    if (!project) throw new AuthError(404, 'NOT_FOUND', '项目不存在');
    if (project.status !== 'PUBLISHED')
      throw new AuthError(
        write ? 400 : 404,
        write ? 'VALIDATION_ERROR' : 'NOT_FOUND',
        '只有已发布项目可以配置生产计划',
      );
    const assigned = await tx.projectManagerRecruitment.findFirst({
      where: { projectId, status: 'ASSIGNED' },
    });
    const primary = assigned?.candidateUserId === principal.userId;
    if (
      !primary &&
      (write || !assigned || assigned.expertRecruitmentHandlerUserId !== principal.userId)
    )
      throw new AuthError(403, 'FORBIDDEN', '当前用户无权操作该项目生产计划');
    return { project, primary };
  }
  private response(project: Project, plan: Plan | null, primary: boolean) {
    const projectReference = {
      projectQuantity: number(project.projectQuantity),
      quantityUnit: project.quantityUnit,
      deadline: project.deadline ? projectTime(project.deadline) : null,
      requiredHeadcount: project.requiredHeadcount,
      educationRequirement: project.educationRequirement,
      employmentType: project.employmentType,
      experienceRequirement: project.experienceRequirement,
      workSummary: project.workSummary,
      specialRequirement: project.specialRequirement,
      mandatoryRequirement: project.mandatoryRequirement,
    };
    return {
      hasPlan: Boolean(plan),
      editable: !plan && primary,
      id: plan?.id ?? null,
      projectId: project.id,
      currentNodeCode: project.currentNodeCode,
      operatorHeadcount: plan?.operatorHeadcount ?? null,
      operatorCpd: plan ? number(plan.operatorCpd) : null,
      inspectorHeadcount: plan?.inspectorHeadcount ?? null,
      inspectorCpd: plan ? number(plan.inspectorCpd) : null,
      needWrittenExam: plan?.needWrittenExam ?? true,
      maxActiveExamCount: plan?.maxActiveExamCount ?? 1,
      needInterview: plan?.needInterview ?? false,
      totalExpectedOutput: plan ? number(plan.totalExpectedOutput) : null,
      confirmedBy: plan?.confirmedBy ?? null,
      confirmedAt: plan ? projectTime(plan.confirmedAt) : null,
      nextStage: plan ? (plan.needWrittenExam ? 'ENTRANCE_EXAM' : 'STANDARD_TRAINING') : null,
      extJson: plan?.extJson ?? null,
      projectReference,
      crowds: plan
        ? plan.crowds.map(({ id, sequenceNo, crowdName, profileRequirement }) => ({
            id,
            sequenceNo,
            crowdName,
            profileRequirement,
          }))
        : [{ id: null, sequenceNo: 1, crowdName: null, profileRequirement: null }],
      stages: plan
        ? plan.stages.map(productionStageData)
        : ['爬坡期', '稳定生产期'].map((stageName, index) => ({
            id: null,
            sequenceNo: index + 1,
            stageName,
            startDate: null,
            endDate: null,
            naturalDayCount: null,
            workdayCount: null,
            workdayCountSource: 'AUTO',
            operatorHeadcount: null,
            operatorCpd: null,
            accuracyRate: null,
            expectedOutput: null,
          })),
    };
  }
  async get(projectId: number, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'PM');
    return this.db.$transaction(
      async (tx) => {
        const { project, primary } = await this.accessible(tx, projectId, principal, false);
        return this.response(
          project,
          await tx.projectProductionPlan.findUnique({ where: { projectId }, include }),
          primary,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async confirm(projectId: number, input: ProductionPlanInput, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'PM');
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deleted" = false FOR UPDATE`;
        const { project } = await this.accessible(tx, projectId, principal, true);
        if (await tx.projectProductionPlan.findUnique({ where: { projectId } }))
          invalid('已确认的生产计划不可修改');
        const now = new Date(),
          data = buildProductionPlan(input, now);
        const before = await collectManagementTasks(tx, project);
        const audit = { createdBy: principal.uid, updatedBy: principal.uid };
        const plan = await tx.projectProductionPlan.create({
          data: {
            ...data,
            projectId,
            ...audit,
            confirmedBy: principal.uid,
            confirmedAt: now,
            extJson: input.extJson == null ? Prisma.DbNull : input.extJson,
            crowds: { create: data.crowds.map((c) => ({ ...c, ...audit })) },
            stages: { create: data.stages.map((s) => ({ ...s, ...audit })) },
          },
          include,
        });
        const currentNodeCode = nodeAfterPlan(project.currentNodeCode, data.needWrittenExam);
        const changed = await tx.project.updateMany({
          where: { id: projectId, deleted: false, status: 'PUBLISHED' },
          data: { currentNodeCode, updatedBy: principal.uid },
        });
        if (changed.count !== 1)
          throw new AuthError(409, 'DUPLICATE', '项目已发生变化，请刷新后重试');
        const updated = { ...project, currentNodeCode };
        const after = await collectManagementTasks(tx, updated);
        await reconcileTaskRounds(
          tx,
          projectId,
          before,
          after,
          { userId: principal.userId, role: 'PM' },
          ['MAIN_PRODUCTION_PLAN'],
          ['MAIN_PRODUCTION_PLAN'],
          managementTaskTypes,
          now,
        );
        // 后补计划会改变准入资格；先同步全部真实来源及遗留独立轮次，再仲裁展示卡片。
        await refreshOwnerProgress(tx, projectId, null, now);
        await refreshManagementCardSnapshots(tx, projectId, now);
        // 旧确认动作publishRealtimeEvent=false；轮次原子结算，但不额外写通知事件。
        return this.response(updated, plan, true);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(409, 'DUPLICATE', '生产计划被并发确认，请刷新后重试');
      throw error;
    }
  }
}

export function productionStageData(s: ProjectProductionStage) {
  return {
    id: s.id,
    sequenceNo: s.sequenceNo,
    stageName: s.stageName,
    startDate: s.startDate.toISOString().slice(0, 10),
    endDate: s.endDate.toISOString().slice(0, 10),
    naturalDayCount: s.naturalDayCount,
    workdayCount: s.workdayCount,
    workdayCountSource: s.workdayCountSource,
    operatorHeadcount: s.operatorHeadcount,
    operatorCpd: number(s.operatorCpd),
    accuracyRate: number(s.accuracyRate),
    expectedOutput: number(s.expectedOutput),
  };
}
