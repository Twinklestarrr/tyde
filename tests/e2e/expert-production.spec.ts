import { expect, test, type Page } from '@playwright/test';
import { assignmentDetailExample } from '../../apps/server/src/modules/expert/expert-assignment.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import { expertTaskExample } from '../../apps/server/src/modules/expert/expert-task.schema';
import { taskExample } from '../../apps/server/src/modules/production/production.schema';
import {
  reportsResponse,
  reportableResponse,
} from '../../apps/server/src/modules/production/output-report.schema';
import { rosterExample } from '../../apps/server/src/modules/personnel/personnel.schema';
import {
  productionListResponse,
  qualityContextResponse,
} from '../../apps/server/src/modules/production/quality-acceptance.schema';
import { performanceExample } from '../../apps/server/src/modules/personnel/personnel-records.schema';
import type {
  AuthUser,
  ExpertTask,
  ProjectPersonnelMember,
  ProductionTask,
  ProductionOutputReport,
  PersonnelProductionRow,
  PersonnelQualityContext,
  ProjectMemberPerformanceRecord,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = expertTaskExample.basicInfo.projectId;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const organizationId = uuid(50);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const user: AuthUser = {
  id: uuid(1),
  uid: 'EXPERTPRODUCTION10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '生产执行专家',
  realName: '测试专家',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'EXPERT',
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  organizations: [],
  createdAt: '2026-11-03T02:00:00.000Z',
  updatedAt: '2026-11-03T02:00:00.000Z',
};
interface RequestLog {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  query: Record<string, string>;
  headers: Record<string, string>;
}
type Identity = 'PERSONAL' | 'MEMBER' | 'SUPERVISOR' | 'OWNER';

/** 真实schema的内存HTTP夹具；无业务数据库、作业系统或真实生产写入。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.context().addCookies([
    {
      name: 'expert_production_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const task = {
    ...structuredClone(expertTaskExample),
    acceptanceStatus: 'ACCEPTED',
    currentNodeCode: 'PRODUCTION_TASK',
    branchNodeCode: 'PRODUCTION_TASK',
    basicInfo: {
      ...structuredClone(expertTaskExample.basicInfo),
      projectName: '执行专家生产任务项目',
    },
    operations: { canAccept: false, canReject: false, canReportOutput: true },
  } as ExpertTask;
  const roster: ProjectPersonnelMember[] = [11, 12, 13, 14].map((memberId, index) => ({
    ...(structuredClone(rosterExample.records[0]) as ProjectPersonnelMember),
    memberId,
    userId: index === 0 ? user.id : uuid(memberId),
    uid: index === 0 ? user.uid : `MEMBER${memberId}`,
    displayName: ['本人生产成员', '同组织生产成员', '已离项历史成员', '其他组织成员'][index],
    accountType: index === 0 ? 'INDIVIDUAL' : 'ORGANIZATION',
    organizationId: index === 0 ? null : index === 3 ? uuid(51) : organizationId,
    organizationName: index === 0 ? null : index === 3 ? '远洋组织' : '海潮组织',
    status: index === 2 ? 'LEFT' : 'ACTIVE',
    statusName: index === 2 ? '已离项' : '在项',
    entryDecision: 'YES',
    plannedEntryDate: '2026-10-25',
    joinedAt: '2026-10-25 09:00:00',
    leftAt: index === 2 ? '2026-10-30 18:00:00' : null,
    allowedActions: [],
  }));
  const tasks: ProductionTask[] = [1, 2, 3].map((id) => ({
    ...(structuredClone(taskExample.records[0]) as ProductionTask),
    subtaskId: id,
    subtaskNo: `ST-EXPERT-${id}`,
    subtaskName: ['本人历史子任务', '离项成员历史子任务', '其他组织历史子任务'][id - 1],
    allowedActions: [],
  }));
  const reportBase = reportsResponse.examples[0].page.records[0] as ProductionOutputReport;
  const reports: ProductionOutputReport[] = [
    {
      ...structuredClone(reportBase),
      reportId: 201,
      subtaskId: 1,
      memberId: 11,
      userId: user.id,
      displayName: '本人生产成员',
      reportDate: '2026-10-29',
      reviewStatus: 'RETURNED',
      returnReason: '请核对历史数量',
      allowedActions: ['SAVE_REPORT'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 202,
      subtaskId: 1,
      memberId: 11,
      userId: user.id,
      displayName: '本人生产成员',
      reportDate: '2026-10-28',
      reviewStatus: 'RETURNED',
      returnReason: '请修正子任务数量',
      allowedActions: ['SAVE_REPORT'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 203,
      subtaskId: 1,
      memberId: 11,
      userId: user.id,
      displayName: '本人生产成员',
      reportDate: today(),
      reviewStatus: 'PENDING',
      allowedActions: [],
    },
    {
      ...structuredClone(reportBase),
      reportId: 204,
      subtaskId: null,
      memberId: 12,
      userId: uuid(12),
      displayName: '同组织生产成员',
      reportDate: today(),
      reviewStatus: 'PENDING',
      allowedActions: ['VERIFY', 'RETURN'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 205,
      subtaskId: 2,
      memberId: 13,
      userId: uuid(13),
      displayName: '已离项历史成员',
      reportDate: '2026-10-29',
      reviewStatus: 'RETURNED',
      returnReason: '离项前数量待修正',
      allowedActions: ['SAVE_REPORT'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 206,
      subtaskId: 3,
      memberId: 14,
      userId: uuid(14),
      displayName: '其他组织成员',
      reportDate: today(),
      reviewStatus: 'PENDING',
      allowedActions: [],
    },
  ];
  const reportable = [
    {
      ...structuredClone(reportableResponse.examples[0][0]),
      subtaskId: 101,
      subtaskNo: 'ST-POOL-101',
      subtaskName: '本人可认领任务池',
      distributionMode: 'POOL',
    },
    {
      ...structuredClone(reportableResponse.examples[0][0]),
      subtaskId: 102,
      subtaskNo: 'ST-DESIGNATED-102',
      subtaskName: '本人指定新任务',
      distributionMode: 'DESIGNATED',
    },
  ];
  const daily: PersonnelProductionRow[] = [
    {
      ...(structuredClone(productionListResponse.examples[0].records[0]) as PersonnelProductionRow),
      memberId: 12,
      userId: uuid(12),
      displayName: '同组织生产成员',
      reportDate: today(),
      organizationId,
      organizationName: '海潮组织',
      accountType: 'ORGANIZATION',
      allowedActions: ['SAVE_QUALITY', 'CREATE_PERFORMANCE'],
    },
    {
      ...(structuredClone(productionListResponse.examples[0].records[0]) as PersonnelProductionRow),
      memberId: 14,
      userId: uuid(14),
      displayName: '其他组织成员',
      reportDate: today(),
      organizationId: uuid(51),
      organizationName: '远洋组织',
      accountType: 'ORGANIZATION',
      allowedActions: ['SAVE_QUALITY', 'CREATE_PERFORMANCE'],
    },
  ];
  const quality = {
    ...structuredClone(qualityContextResponse.examples[0]),
    memberId: 12,
    displayName: '同组织生产成员',
    reportDate: today(),
    items: [
      { ...structuredClone(qualityContextResponse.examples[0].items[0]), outputReportId: 204 },
    ],
  } as PersonnelQualityContext;
  const performance = structuredClone(
    performanceExample.records,
  ) as ProjectMemberPerformanceRecord[];
  const state = {
    user: structuredClone(user),
    task,
    roster,
    tasks,
    reports,
    reportable,
    daily,
    quality,
    performance,
    assignees: [{ subtaskId: 102, memberId: 11, assignmentType: 'DESIGNATED' }],
    identity: 'PERSONAL' as Identity,
    readStatuses: {} as Record<string, number>,
    writeStatuses: {} as Record<string, number>,
    unknown: '',
    applyUnknown: false,
    hold: '',
    written: false,
    remains: false,
    addOtherSource: false,
    extraInitialSource: false,
    failAfterWrite: '',
    ambiguousOwnMembership: false,
  };
  const managerProject = {
    ...structuredClone(assignmentDetailExample.projectDetail),
    id: projectId,
    currentNodeCode: 'PRODUCTION_TASK',
  } as WorkbenchProjectDetail;
  const requests: RequestLog[] = [];
  let sequence = 300;
  let release: (() => Promise<void>) | undefined;
  const managed = () => ['OWNER', 'SUPERVISOR'].includes(state.identity);
  const owns = (memberId: number) =>
    state.roster.find((member) => member.memberId === memberId)?.userId === user.id;
  const memberOfOrganization = (memberId: number) =>
    state.roster.find((member) => member.memberId === memberId)?.organizationId === organizationId;
  function reportActions(row: ProductionOutputReport): ProductionOutputReport['allowedActions'] {
    if (state.user.selectedRole === 'PM')
      return row.reviewStatus === 'PENDING' ? ['VERIFY', 'RETURN'] : [];
    if (row.reviewStatus === 'PENDING' && managed() && memberOfOrganization(row.memberId))
      return ['VERIFY', 'RETURN'];
    if (row.reviewStatus !== 'RETURNED') return [];
    const member = state.roster.find((item) => item.memberId === row.memberId);
    return (member?.status === 'ACTIVE' && owns(row.memberId)) ||
      (state.identity === 'OWNER' &&
        member?.status === 'LEFT' &&
        memberOfOrganization(row.memberId))
      ? ['SAVE_REPORT']
      : [];
  }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      headers = await request.allHeaders();
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      body: headers['content-type']?.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
      query: Object.fromEntries(url.searchParams),
      headers,
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    const read = (kind: string, data: unknown) =>
      reply(
        (state.readStatuses[kind] ?? 200) === 200 ? data : null,
        state.readStatuses[kind] ?? 200,
        `${kind}读取结果`,
      );
    const pageOf = <T>(records: T[]) => {
      const current = Number(log.body?.current ?? 1),
        size = Number(log.body?.size ?? 20);
      return {
        current,
        size,
        total: records.length,
        pages: Math.ceil(records.length / size),
        records: records.slice((current - 1) * size, current * size),
      };
    };
    const write = async (kind: string, apply: () => void) => {
      if (state.writeStatuses[kind])
        return reply(null, state.writeStatuses[kind], `${kind}当前状态不允许操作`);
      const mutate = () => {
        apply();
        state.written = true;
        if (kind === 'save') state.task.operations.canReportOutput = false;
        if (state.failAfterWrite) state.readStatuses[state.failAfterWrite] = 503;
      };
      if (state.unknown === kind) {
        if (state.applyUnknown) mutate();
        return route.abort('failed');
      }
      const finish = async () => {
        mutate();
        await reply(null);
      };
      if (state.hold === kind) {
        release = finish;
        return;
      }
      return finish();
    };
    if (!headers.cookie?.includes('expert_production_session=active'))
      return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/projects/workbench/statistics')
      return reply({
        mode: 'TASK',
        pendingTaskCount: 1,
        completedTaskCount: 0,
        involvedProjectCount: 1,
      });
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      const role = log.body?.role as AuthUser['role'];
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (log.path === '/api/v1/expert-assignments/detail')
      return read('detail', {
        ...assignmentDetailExample,
        assignmentId: state.task.assignmentId,
        movementId: state.task.movementId,
        currentNodeCode: 'PRODUCTION_TASK',
      });
    if (log.path === '/api/v1/projects/list') return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`) return reply(managerProject);
    if (log.path === '/api/v1/projects/manager/list')
      return read('managerProjects', [strategistProjectCard(managerProject)]);
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return read('permission', {
        ...recruitmentDetailExample,
        projectId,
        currentNodeCode: 'PRODUCTION_TASK',
        currentOperatorRole: 'PRIMARY_MANAGER',
        canChangeHandler: true,
      });
    if (log.path === '/api/v1/expert-assignments/my-tasks') {
      const otherSource: ExpertTask =
        state.task.sourceBizType === 'EXPERT_ASSIGNMENT'
          ? {
              ...state.task,
              sourceBizType: 'PROJECT_MEMBER_TRANSFER',
              assignmentId: null,
              movementId: state.task.sourceBizId,
              basicInfo: { ...state.task.basicInfo, projectName: '同项目另一个转入来源' },
            }
          : {
              ...state.task,
              sourceBizType: 'EXPERT_ASSIGNMENT',
              assignmentId: state.task.sourceBizId,
              movementId: null,
              basicInfo: { ...state.task.basicInfo, projectName: '同项目另一个分配来源' },
            };
      const cards = !state.written
        ? [state.task, ...(state.extraInitialSource ? [otherSource] : [])]
        : [...(state.addOtherSource ? [otherSource] : []), ...(state.remains ? [state.task] : [])];
      return read(
        'tasks',
        cards.filter(
          (card) =>
            !log.body?.keyword || card.basicInfo.projectName?.includes(String(log.body.keyword)),
        ),
      );
    }
    if (log.path === '/api/v1/production-tasks/reportable-list')
      return read('reportable', state.reportable);
    if (log.path === '/api/v1/production-tasks/list') {
      let rows = state.tasks.filter((task) =>
        managed()
          ? task.subtaskId !== 3
          : state.reports.some(
              (report) => report.subtaskId === task.subtaskId && owns(report.memberId),
            ),
      );
      if (log.body?.keyword)
        rows = rows.filter((row) =>
          `${row.subtaskName}${row.subtaskNo}`.includes(String(log.body!.keyword)),
        );
      const statuses = log.body?.statuses as string[] | undefined;
      if (statuses?.length) rows = rows.filter((row) => statuses.includes(row.status));
      return read(
        'productionTasks',
        pageOf(
          rows.map((row) => ({
            ...row,
            allowedActions: state.reports.some(
              (report) =>
                report.subtaskId === row.subtaskId && reportActions(report).includes('SAVE_REPORT'),
            )
              ? ['CORRECT_REPORT']
              : [],
          })),
        ),
      );
    }
    if (log.path === '/api/v1/project-personnel/roster/list') {
      if (!managed()) return reply(null, 403, '普通成员不能读取组织花名册');
      let rows = state.roster.filter((row) => row.organizationId === organizationId);
      const statuses = log.body?.statuses as string[] | undefined;
      if (statuses?.length) rows = rows.filter((row) => statuses.includes(row.status));
      const organizationIds = log.body?.organizationIds as string[] | undefined;
      if (organizationIds?.length)
        rows = rows.filter(
          (row) => !!row.organizationId && organizationIds.includes(row.organizationId),
        );
      if (log.body?.keyword)
        rows = rows.filter((row) =>
          `${row.displayName}${row.uid}`.includes(String(log.body!.keyword)),
        );
      return read('roster', pageOf(rows));
    }
    if (log.path === '/api/v1/production-tasks/reports') {
      let rows = state.reports.filter(
        (row) =>
          row.subtaskId === (log.body?.subtaskId ?? null) &&
          (state.user.selectedRole === 'PM' ||
            owns(row.memberId) ||
            (managed() && memberOfOrganization(row.memberId))),
      );
      if (log.body?.keyword)
        rows = rows.filter((row) =>
          `${row.displayName}${row.uid}`.includes(String(log.body!.keyword)),
        );
      const statuses = log.body?.reviewStatuses as string[] | undefined;
      if (statuses?.length) rows = rows.filter((row) => statuses.includes(row.reviewStatus));
      if (log.body?.reportDateStart)
        rows = rows.filter((row) => row.reportDate >= String(log.body!.reportDateStart));
      if (log.body?.reportDateEnd)
        rows = rows.filter((row) => row.reportDate <= String(log.body!.reportDateEnd));
      return read('reports', {
        totalReportCount: rows.length,
        totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        pendingCount: rows.filter((row) => row.reviewStatus === 'PENDING').length,
        returnedCount: rows.filter((row) => row.reviewStatus === 'RETURNED').length,
        page: pageOf(rows.map((row) => ({ ...row, allowedActions: reportActions(row) }))),
      });
    }
    if (log.path === '/api/v1/project-personnel/production/list') {
      if (!managed()) return reply(null, 403, '当前身份无组织生产数据权限');
      const requested = log.body?.organizationIds as string[] | undefined;
      const rows = state.daily.filter(
        (row) =>
          row.organizationId === organizationId &&
          (!requested?.length || requested.includes(row.organizationId)),
      );
      return read('daily', pageOf(rows));
    }
    if (log.path === '/api/v1/project-personnel/production/quality/context') {
      if (!managed() || log.body?.memberId !== 12)
        return reply(null, 403, '当前身份无质量明细权限');
      return read('quality', state.quality);
    }
    if (log.path === '/api/v1/project-personnel/production/quality/save') {
      if (!managed() || log.body?.memberId !== 12)
        return reply(null, 403, '当前身份无质量追加权限');
      return write('quality', () => {
        for (const item of log.body!.items as {
          outputReportId: number;
          inspectedQuantity: string | number;
          qualifiedQuantity: string | number;
          unqualifiedReason: string | null;
        }[])
          state.quality.items.unshift({
            ...state.quality.items[0],
            qualityId: ++sequence,
            outputReportId: item.outputReportId,
            inspectedQuantity: Number(item.inspectedQuantity),
            qualifiedQuantity: Number(item.qualifiedQuantity),
            unqualifiedReason: item.unqualifiedReason,
            operatorName: '执行专家负责人',
          });
      });
    }
    if (log.path === '/api/v1/project-personnel/performance/list')
      return managed()
        ? read('performance', pageOf(state.performance))
        : reply(null, 403, '当前身份无表现记录权限');
    if (log.path === '/api/v1/project-personnel/performance/create')
      return managed()
        ? write('performance', () => {
            state.performance.unshift({
              ...state.performance[0],
              performanceId: ++sequence,
              recordDate: String(log.body!.recordDate),
              content: String(log.body!.content),
              attachmentIds: [],
              attachments: [],
            });
          })
        : reply(null, 403, '当前身份无表现记录权限');
    if (log.path === '/api/v1/production-tasks/report/save') {
      const items = log.body?.reports as {
        subtaskId?: number | null;
        memberId?: number | null;
        reportDate: string;
        quantity: string | number;
        remark?: string | null;
      }[];
      const resolved = items.map((item) => ({ ...item, memberId: item.memberId ?? 11 }));
      if (state.ambiguousOwnMembership && items.some((item) => !item.memberId))
        return reply(null, 400, '可报量成员不存在或身份不唯一，请明确memberId');
      if (resolved.some((item) => item.reportDate > today()))
        return reply(null, 400, '报量日期不能晚于上海当天');
      if (
        resolved.some(
          (item) =>
            !owns(item.memberId) &&
            !(state.identity === 'OWNER' && memberOfOrganization(item.memberId)),
        )
      )
        return reply(null, 403, '无当前项目报量操作权限');
      if (
        resolved.some(
          (item) =>
            item.subtaskId &&
            !state.assignees.some(
              (row) => row.subtaskId === item.subtaskId && row.memberId === item.memberId,
            ) &&
            (state.reportable.find((row) => row.subtaskId === item.subtaskId)?.distributionMode ??
              state.tasks.find((row) => row.subtaskId === item.subtaskId)?.distributionMode) !==
              'POOL',
        )
      )
        return reply(null, 403, '当前成员未获指定子任务');
      if (
        resolved.some(
          (item) => state.roster.find((row) => row.memberId === item.memberId)?.status !== 'ACTIVE',
        )
      )
        return reply(null, 403, '无当前项目报量操作权限');
      if (
        resolved.some((item) =>
          state.reports.some(
            (row) =>
              row.memberId === item.memberId &&
              row.subtaskId === (item.subtaskId ?? null) &&
              row.reportDate === item.reportDate &&
              row.reviewStatus !== 'RETURNED',
          ),
        )
      )
        return reply(null, 409, '数据状态已变化或当前节点不允许操作');
      return write('save', () => {
        for (const item of resolved) {
          const member = state.roster.find((row) => row.memberId === item.memberId)!;
          if (
            item.subtaskId &&
            !state.assignees.some(
              (row) => row.subtaskId === item.subtaskId && row.memberId === item.memberId,
            )
          )
            state.assignees.push({
              subtaskId: item.subtaskId,
              memberId: item.memberId,
              assignmentType: 'CLAIMED',
            });
          if (item.subtaskId && !state.tasks.some((row) => row.subtaskId === item.subtaskId)) {
            const available = state.reportable.find((row) => row.subtaskId === item.subtaskId)!;
            state.tasks.unshift({
              ...(structuredClone(taskExample.records[0]) as ProductionTask),
              subtaskId: available.subtaskId,
              subtaskName: available.subtaskName,
              subtaskNo: available.subtaskNo,
              distributionMode: available.distributionMode as ProductionTask['distributionMode'],
              assigneeCount: 1,
              assigneeNames: [member.displayName],
              allowedActions: [],
            });
          }
          const existing = state.reports.find(
            (row) =>
              row.memberId === item.memberId &&
              row.subtaskId === (item.subtaskId ?? null) &&
              row.reportDate === item.reportDate,
          );
          if (existing)
            Object.assign(existing, {
              quantity: Number(item.quantity),
              remark: item.remark ?? null,
              reviewStatus: 'PENDING',
              returnReason: null,
              allowedActions: [],
            });
          else
            state.reports.push({
              ...structuredClone(reportBase),
              reportId: ++sequence,
              memberId: member.memberId,
              userId: member.userId,
              displayName: member.displayName,
              subtaskId: item.subtaskId ?? null,
              reportDate: item.reportDate,
              quantity: Number(item.quantity),
              remark: item.remark ?? null,
              reviewStatus: 'PENDING',
              allowedActions: [],
            });
        }
      });
    }
    if (log.path === '/api/v1/production-tasks/report/correct') {
      const report = state.reports.find((row) => row.reportId === log.body?.reportId);
      if (!report || !reportActions(report).includes('SAVE_REPORT'))
        return reply(null, 403, '无当前项目报量操作权限');
      return write('correct', () =>
        Object.assign(report, {
          quantity: Number(log.body!.quantity),
          remark: log.body!.remark ?? null,
          reviewStatus: 'PENDING',
          returnReason: null,
          allowedActions: [],
        }),
      );
    }
    if (log.path === '/api/v1/production-tasks/report/review') {
      const ids = log.body?.reportIds as number[] | undefined;
      const rows = state.reports.filter(
        (row) =>
          row.subtaskId === (log.body?.subtaskId ?? null) &&
          (!ids?.length || ids.includes(row.reportId)) &&
          reportActions(row).includes('VERIFY'),
      );
      if (!managed() || (ids?.length && rows.length !== ids.length))
        return reply(null, 403, '无当前项目报量核查权限');
      return write('review', () => {
        for (const row of rows)
          Object.assign(row, {
            reviewStatus: log.body!.action === 'RETURN' ? 'RETURNED' : 'VERIFIED',
            returnReason: log.body!.action === 'RETURN' ? log.body!.reason : null,
            allowedActions: [],
          });
      });
    }
    if (
      log.path === '/api/v1/production-tasks/create' ||
      /\/acceptance\/(submit|review)$/.test(log.path)
    )
      return reply(null, 403, '执行专家不提供策略官创建或领航员验收入口');
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, release: async () => release?.() };
}

const requestsFor = (requests: RequestLog[], path: string) =>
  requests.filter((request) => request.path === `/api/v1/${path}`);

function organizationIdentity(
  state: Awaited<ReturnType<typeof backend>>['state'],
  identity: Exclude<Identity, 'PERSONAL'>,
) {
  state.identity = identity;
  state.task.basicInfo.subjectType = 'ORGANIZATION';
  state.task.basicInfo.organizationId = organizationId;
  state.task.basicInfo.organizationName = '海潮组织';
  state.task.accessContext = {
    projectOwner: identity === 'OWNER',
    acceptedOrganizationOwner: identity === 'SUPERVISOR',
    canViewOrganizationData: identity !== 'MEMBER',
  };
  state.user.organizations = [
    {
      id: organizationId,
      name: '海潮组织',
      position: identity === 'SUPERVISOR' ? 'OWNER' : 'MEMBER',
      joinStatus: 'ACTIVE',
      status: 'ACTIVE',
      verifyStatus: 'VERIFIED',
    },
  ];
  Object.assign(state.roster[0], {
    accountType: 'ORGANIZATION',
    organizationId,
    organizationName: '海潮组织',
  });
  for (const member of state.roster.filter((row) => row.organizationId === organizationId))
    member.projectOwners = [
      {
        userId: identity === 'OWNER' ? user.id : uuid(90),
        name: identity === 'OWNER' ? '生产执行专家' : '其他负责人',
        avatarUrl: null,
      },
    ];
}

async function openProduction(page: Page) {
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  const panel = page.getByRole('region', { name: '执行专家生产任务', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function projectReports(page: Page) {
  return historicalReports(page, '本人历史子任务');
}

async function historicalReports(page: Page, name: string) {
  const panel = page.getByRole('region', { name: '执行专家生产任务', exact: true });
  await panel.getByRole('tab', { name: '生产子任务', exact: true }).click();
  await panel
    .getByRole('article', { name, exact: true })
    .getByRole('button', { name: /^修正(?:\(\d+\))?$/ })
    .click();
  const reports = page.getByRole('region', { name: '报量核查', exact: true });
  await expect(reports).toBeVisible();
  return reports;
}

async function correctReport(page: Page, reportId: number) {
  await page
    .getByRole('article', { name: `报量 ${reportId}`, exact: true })
    .getByRole('button', { name: '修正报量', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '修正生产报量', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const identity of ['INDIVIDUAL', 'MEMBER', 'OWNER', 'SUPERVISOR'] as const) {
  test(`${identity}缺少待报日期时不可新报量，不暴露项目报量、代报或核查`, async ({ page }) => {
    const { state, requests } = await backend(page, identity === 'OWNER');
    if (identity !== 'INDIVIDUAL') organizationIdentity(state, identity);
    const panel = await openProduction(page);
    await expect(panel.getByText('报量暂不可用，请稍后重试。', { exact: true })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: '填写子任务报量', exact: true }).first(),
    ).toBeDisabled();
    await expect(panel.getByRole('button', { name: '填写项目报量', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('tab', { name: '项目报量', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('tab', { name: '人员日生产', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '报量成员', exact: true })).toHaveCount(0);
    expect(requestsFor(requests, 'production-tasks/report/save')).toHaveLength(0);
    expect(requestsFor(requests, 'production-tasks/report/review')).toHaveLength(0);
    expect(requestsFor(requests, 'project-personnel/roster/list')).toHaveLength(0);
  });
}

test('可报任务为空仍不得从历史任务代报，刷新不解开新报量限制', async ({ page }) => {
  const { state, requests } = await backend(page);
  organizationIdentity(state, 'OWNER');
  state.reportable = [];
  const panel = await openProduction(page);
  await expect(panel.getByText('暂无本人可报子任务', { exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '生产子任务', exact: true }).click();
  await expect(panel.getByRole('button', { name: /填写.*报量/ })).toHaveCount(0);
  await panel.getByRole('button', { name: '刷新生产数据', exact: true }).click();
  expect(requestsFor(requests, 'production-tasks/report/save')).toHaveLength(0);
});

test('专家修正报量列表不因后台返回VERIFY和RETURN扩展核查能力', async ({ page }) => {
  const { state, requests } = await backend(page);
  organizationIdentity(state, 'OWNER');
  state.reports.find((row) => row.reportId === 204)!.subtaskId = 1;
  await openProduction(page);
  const reports = await projectReports(page);
  await expect(reports.getByRole('button', { name: /核准|退回/ })).toHaveCount(0);
  await expect(
    reports.getByRole('group', { name: '报量列表', exact: true }).getByRole('checkbox'),
  ).toHaveCount(0);
  await expect(
    reports.getByRole('group', { name: '核查状态', exact: true }).getByRole('checkbox'),
  ).toHaveCount(3);
  expect(requestsFor(requests, 'production-tasks/report/review')).toHaveLength(0);
});

test('375px修正表单保留固定来源、日期和可用操作，页面无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await backend(page);
  await openProduction(page);
  await projectReports(page);
  const dialog = await correctReport(page, 201);
  await dialog.getByLabel('修正数量', { exact: true }).fill('1.25');
  await expect(dialog.getByLabel('作业日期', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认提交修正', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('本人历史退回修正不依赖新报量flag，提交只带原reportId且日期来源不可改', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.remains = true;
  state.task.operations.canReportOutput = false;
  await openProduction(page);
  await projectReports(page);
  const dialog = await correctReport(page, 201);
  await expect(dialog.getByLabel('作业日期', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('修正数量', { exact: true }).fill('0');
  await dialog.getByLabel('修正备注', { exact: true }).fill('历史数量核对后为零');
  await dialog.getByRole('button', { name: '确认提交修正', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/report/correct')[0].body).toEqual({
    projectId,
    reportId: 201,
    quantity: '0',
    remark: '历史数量核对后为零',
  });
  expect(state.reports.find((row) => row.reportId === 201)).toMatchObject({
    reportDate: '2026-10-29',
    subtaskId: 1,
    reviewStatus: 'PENDING',
  });
  await expect(
    page
      .getByRole('article', { name: '报量 201', exact: true })
      .getByRole('button', { name: '修正报量', exact: true }),
  ).toHaveCount(0);
});

test('负责人可修正同来源已离项成员历史，保留原子任务和日期', async ({ page }) => {
  const { state, requests } = await backend(page);
  organizationIdentity(state, 'OWNER');
  state.remains = true;
  state.task.operations.canReportOutput = false;
  await openProduction(page);
  await historicalReports(page, '离项成员历史子任务');
  const dialog = await correctReport(page, 205);
  await dialog.getByLabel('修正数量', { exact: true }).fill('7.25');
  await dialog.getByRole('button', { name: '确认提交修正', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/report/correct')[0].body).toMatchObject({
    projectId,
    reportId: 205,
    quantity: '7.25',
  });
  expect(state.reports.find((row) => row.reportId === 205)).toMatchObject({
    memberId: 13,
    subtaskId: 2,
    reportDate: '2026-10-29',
    reviewStatus: 'PENDING',
  });
});

test('修正未知即使GET显示PENDING仍不宣称本次成功，原reportId与草稿保持锁定', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'correct';
  state.applyUnknown = true;
  state.remains = true;
  await openProduction(page);
  await projectReports(page);
  const dialog = await correctReport(page, 201);
  await dialog.getByLabel('修正数量', { exact: true }).fill('6.125');
  await dialog.getByRole('button', { name: '确认提交修正', exact: true }).click();
  await dialog.getByRole('button', { name: '重新读取报量结果', exact: true }).click();
  await expect(dialog.getByLabel('修正数量', { exact: true })).toHaveValue('6.125');
  await expect(dialog.getByLabel('修正数量', { exact: true })).toBeDisabled();
  expect(state.reports.find((row) => row.reportId === 201)?.reviewStatus).toBe('PENDING');
  expect(requestsFor(requests, 'production-tasks/report/correct')).toHaveLength(1);
});

test('修正明确成功后完整待办回读失败，只读取后续信息而不重复修正', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failAfterWrite = 'tasks';
  state.remains = true;
  await openProduction(page);
  await projectReports(page);
  const dialog = await correctReport(page, 201);
  await dialog.getByLabel('修正数量', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: '确认提交修正', exact: true }).click();
  await expect(
    dialog.getByText('报量操作已保存，后续待办读取失败，请重新读取报量结果。', { exact: true }),
  ).toBeVisible();
  state.readStatuses.tasks = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '重新读取报量结果', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/report/correct')).toHaveLength(1);
  expect(requestsFor(requests, 'production-tasks/reports').at(-1)?.body?.subtaskId).toBe(1);
});

test('未知修正关闭重开后即使SAVE_REPORT已消失，仍能恢复同reportId原稿', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'correct';
  state.applyUnknown = true;
  state.remains = true;
  await openProduction(page);
  await projectReports(page);
  let dialog = await correctReport(page, 201);
  await dialog.getByLabel('修正数量', { exact: true }).fill('8.5');
  await dialog.getByRole('button', { name: '确认提交修正', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重新读取报量结果', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page
    .getByRole('dialog', { name: '子任务生产报量', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page.getByRole('button', { name: '恢复报量操作', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修正生产报量', exact: true });
  await dialog.getByRole('button', { name: '重新读取报量结果', exact: true }).click();
  await expect(dialog.getByLabel('修正数量', { exact: true })).toHaveValue('8.5');
  await expect(dialog.getByLabel('修正数量', { exact: true })).toBeDisabled();
  expect(requestsFor(requests, 'production-tasks/report/correct')[0].body?.reportId).toBe(201);
  expect(requestsFor(requests, 'production-tasks/report/correct')).toHaveLength(1);
});

test('历史报量读取403没有旧修正入口，普通成员不能借读失败扩大权限', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.readStatuses.reports = 403;
  await openProduction(page);
  const reports = await projectReports(page);
  await expect(reports.getByText('reports读取结果', { exact: true })).toBeVisible();
  await expect(reports.getByRole('button', { name: '修正报量', exact: true })).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/report/correct')).toHaveLength(0);
});

test('未接单或当前独立培训支线不挂载生产写入口，不能按主线生产越过本人待办', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.task.branchNodeCode = 'STANDARD_TRAINING';
  state.task.operations.canReportOutput = false;
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行专家生产任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '填写项目报量', exact: true })).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/reportable-list')).toHaveLength(0);
  expect(requestsFor(requests, 'production-tasks/report/save')).toHaveLength(0);
  state.task.acceptanceStatus = 'PENDING_ACCEPTANCE';
  state.task.branchNodeCode = 'PRODUCTION_TASK';
  await page.reload();
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行专家生产任务', exact: true })).toHaveCount(0);
  expect(requestsFor(requests, 'production-tasks/report/save')).toHaveLength(0);
});
