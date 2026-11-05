import { expect, test, type Page } from '@playwright/test';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import {
  memberExample,
  taskExample,
} from '../../apps/server/src/modules/production/production.schema';
import {
  assigneesResponse,
  reportsResponse,
} from '../../apps/server/src/modules/production/output-report.schema';
import {
  productionListResponse,
  qualityContextResponse,
  acceptanceContextResponse,
} from '../../apps/server/src/modules/production/quality-acceptance.schema';
import type { AuthUser, WorkbenchProjectDetail } from '../../packages/shared/src/index';
import type {
  ProductionTask as Task,
  ProductionTaskMember,
  ProductionOutputReport,
  PersonnelQualityItem,
  PersonnelQualityContext,
  PersonnelProductionRow,
} from '../../packages/shared/src/project-production';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const user: AuthUser = {
  id: uuid(1),
  uid: 'PRODUCTION10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '生产联调员',
  realName: '测试策略官',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'PM',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'PM',
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
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectNo: 'PRODUCTION-PROJECT-3001',
  projectName: '策略官生产任务项目',
  currentNodeCode: 'PRODUCTION_TASK',
  versionNo: 4,
  attachments: [],
} as WorkbenchProjectDetail;
interface RequestLog {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  query: Record<string, string>;
  headers: Record<string, string>;
}

/** 所有生产、报量核查、质量和验收操作均为隔离内存夹具，不连接数据库或作业系统。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'production_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const tasks: Task[] = Array.from({ length: 22 }, (_, index): Task => ({
    ...(structuredClone(taskExample.records[0]) as Task),
    subtaskId: index + 1,
    subtaskName:
      index === 0 ? '指定生产任务' : index === 1 ? '返修生产任务' : `生产任务${index + 1}`,
    subtaskNo: `ST-${index + 1}`,
    allowedActions: ['CHECK_DATA', 'SUBMIT_ACCEPTANCE'],
  }));
  Object.assign(tasks[0], {
    distributionMode: 'DESIGNATED',
    assigneeCount: 2,
    assigneeNames: ['生产成员甲', '生产成员乙'],
  });
  Object.assign(tasks[1], {
    status: 'REWORK_REQUIRED',
    actualDeliveryDate: '2026-10-28',
    actualQuantity: 8,
    reportedQuantity: 10,
    quantityAdjustmentRemark: '上轮数量调整',
    submittedByName: '主策略官',
    submittedAt: '2026-10-28 12:00:00',
    reviewedByName: '领航员',
    reviewedAt: '2026-10-28 13:00:00',
    rejectReason: '交付需要返修',
  });
  const members = Array.from({ length: 22 }, (_, index): ProductionTaskMember => ({
    ...(structuredClone(memberExample.records[0]) as ProductionTaskMember),
    memberId: index + 1,
    userId: uuid(100 + index),
    uid: `MEMBER${index + 1}`,
    displayName: index === 0 ? '生产成员甲' : index === 1 ? '生产成员乙' : `生产成员${index + 1}`,
  }));
  const reportBase = reportsResponse.examples[0].page.records[0] as ProductionOutputReport;
  const reports: ProductionOutputReport[] = [
    {
      ...structuredClone(reportBase),
      reportId: 101,
      subtaskId: null as number | null,
      displayName: '生产成员甲',
      userId: uuid(100),
      reportDate: today(),
      quantity: 10,
      allowedActions: ['VERIFY', 'RETURN'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 105,
      subtaskId: null,
      memberId: 2,
      displayName: '生产成员乙',
      userId: uuid(101),
      reportDate: today(),
      quantity: 5,
      allowedActions: ['VERIFY', 'RETURN'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 102,
      subtaskId: 1,
      displayName: '生产成员甲',
      userId: uuid(100),
      reportDate: today(),
      quantity: 6,
      allowedActions: ['VERIFY', 'RETURN'],
    },
    {
      ...structuredClone(reportBase),
      reportId: 103,
      subtaskId: 1,
      memberId: 2,
      displayName: '生产成员乙',
      userId: uuid(101),
      reportDate: today(),
      quantity: 4,
      reviewStatus: 'VERIFIED',
      allowedActions: [],
    },
    {
      ...structuredClone(reportBase),
      reportId: 104,
      subtaskId: 2,
      displayName: '生产成员甲',
      userId: uuid(100),
      reportDate: today(),
      quantity: 10,
      reviewStatus: 'VERIFIED',
      allowedActions: [],
    },
  ];
  const quality: PersonnelQualityContext = {
    ...structuredClone(qualityContextResponse.examples[0]),
    memberId: 1,
    displayName: '生产成员甲',
    reportDate: today(),
    items: [
      {
        ...(structuredClone(qualityContextResponse.examples[0].items[0]) as PersonnelQualityItem),
        outputReportId: 102,
        subtaskId: 1 as number | null,
        subtaskName: '指定生产任务' as string | null,
        qualityId: 2,
        inspectedQuantity: 5,
        qualifiedQuantity: 4,
        operatorName: '主策略官',
      },
      {
        ...(structuredClone(qualityContextResponse.examples[0].items[0]) as PersonnelQualityItem),
        outputReportId: 102,
        subtaskId: 1 as number | null,
        subtaskName: '指定生产任务' as string | null,
        qualityId: 1,
        inspectedQuantity: 3,
        qualifiedQuantity: 3,
        operatorName: '历史记录人',
      },
      {
        ...(structuredClone(qualityContextResponse.examples[0].items[0]) as PersonnelQualityItem),
        outputReportId: 101,
        qualityId: 3,
        qualityDataSource: 'WORK_SYSTEM',
        editable: false,
      },
    ],
  };
  const production: PersonnelProductionRow = {
    ...(structuredClone(productionListResponse.examples[0].records[0]) as PersonnelProductionRow),
    memberId: 1,
    displayName: '生产成员甲',
    userId: uuid(100),
    reportDate: today(),
    qualityRecordCount: 3,
  };
  const state = {
    user: structuredClone(user),
    primary: true,
    tasks,
    members,
    reports,
    quality,
    production,
    productionRows: [production],
    readStatuses: {} as Record<string, number>,
    writeStatuses: {} as Record<string, number>,
    unknown: '',
    applyUnknown: false,
    hold: '',
    failAfterWrite: '',
    written: false,
    remains: true,
    branchNodeCode: null as string | null,
  };
  const requests: RequestLog[] = [];
  let release: (() => Promise<void>) | undefined;
  let sequence = 100;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      headers = await request.allHeaders();
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      headers,
      body: headers['content-type']?.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
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
        records: records.slice((current - 1) * size, current * size),
        current,
        size,
        total: records.length,
        pages: Math.ceil(records.length / size),
      };
    };
    const write = async (kind: string, apply: () => void) => {
      const status = state.writeStatuses[kind] ?? 200;
      if (status !== 200) return reply(null, status, `${kind}当前状态不允许操作`);
      const finish = async () => {
        apply();
        state.written = true;
        if (state.failAfterWrite) state.readStatuses[state.failAfterWrite] = 503;
        await reply(null);
      };
      if (state.unknown === kind) {
        if (state.applyUnknown) apply();
        return route.abort('failed');
      }
      if (state.hold === kind) {
        release = finish;
        return;
      }
      return finish();
    };
    if (!headers.cookie?.includes('production_session=active')) return reply(null, 401, '请先登录');
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
    if (log.path === '/api/v1/projects/list' || log.path === '/api/v1/expert-assignments/my-tasks')
      return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`) return reply(project);
    if (log.path === '/api/v1/projects/manager/list')
      return read(
        'projects',
        state.written && !state.remains
          ? []
          : [
              {
                ...strategistProjectCard(project),
                branchNodeCode: state.branchNodeCode,
                primaryProjectManager: state.primary,
                expertRecruitmentHandler: !state.primary,
              },
            ],
      );
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return read('permission', {
        ...recruitmentDetailExample,
        projectId,
        currentNodeCode: 'PRODUCTION_TASK',
        canChangeHandler: state.primary,
        currentOperatorRole: state.primary ? 'PRIMARY_MANAGER' : 'EXPERT_RECRUITMENT_HANDLER',
        primaryManager: {
          userId: state.primary ? user.id : uuid(9),
          uid: 'MANAGER',
          name: '主策略官',
          avatarUrl: null,
        },
        handler: {
          userId: state.primary ? uuid(9) : user.id,
          uid: 'HANDLER',
          name: '协作负责人',
          avatarUrl: null,
        },
      });
    if (log.path === '/api/v1/production-tasks/list') {
      let rows = state.tasks.filter(
        (row) =>
          !log.body?.keyword ||
          `${row.subtaskName}${row.subtaskNo}`.includes(String(log.body.keyword)),
      );
      const statuses = log.body?.statuses as string[] | undefined;
      if (statuses?.length) rows = rows.filter((row) => statuses.includes(row.status));
      return read(
        'tasks',
        pageOf(
          rows.map((row) => ({ ...row, allowedActions: state.primary ? row.allowedActions : [] })),
        ),
      );
    }
    if (log.path === '/api/v1/production-tasks/members')
      return read(
        'members',
        pageOf(
          state.members.filter(
            (row) =>
              !log.body?.keyword ||
              `${row.displayName}${row.uid}`.includes(String(log.body.keyword)),
          ),
        ),
      );
    if (log.path === '/api/v1/production-tasks/member-list')
      return read(
        'assignees',
        pageOf(
          state.members.slice(0, 2).map((row) => ({
            ...assigneesResponse.examples[0].records[0],
            ...row,
            assignmentType: 'DESIGNATED',
            assignedAt: '2026-11-03 10:00:00',
          })),
        ),
      );
    if (log.path === '/api/v1/production-tasks/create')
      return write('create', () => {
        const ids = (log.body?.memberIds ?? []) as number[];
        state.tasks.unshift({
          ...structuredClone(taskExample.records[0]),
          subtaskId: ++sequence,
          subtaskNo: `ST-${sequence}`,
          subtaskName: String(log.body!.subtaskName),
          expectedDeliveryDate: String(log.body!.expectedDeliveryDate),
          expectedQuantity: Number(log.body!.expectedQuantity),
          distributionMode: log.body!.distributionMode as Task['distributionMode'],
          assigneeCount: ids.length,
          assigneeNames: state.members
            .filter((row) => ids.includes(row.memberId))
            .map((row) => row.displayName)
            .slice(0, 3),
          allowedActions: ['CHECK_DATA', 'SUBMIT_ACCEPTANCE'],
        });
      });
    if (log.path === '/api/v1/production-tasks/reports') {
      let rows = state.reports.filter((row) => row.subtaskId === (log.body?.subtaskId ?? null));
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
        page: pageOf(
          rows.map((row) => ({ ...row, allowedActions: state.primary ? row.allowedActions : [] })),
        ),
      });
    }
    if (log.path === '/api/v1/production-tasks/report/review')
      return write('review', () => {
        const ids = log.body?.reportIds as number[] | undefined;
        for (const row of state.reports.filter(
          (row) =>
            row.subtaskId === (log.body?.subtaskId ?? null) &&
            (!ids?.length || ids.includes(row.reportId)) &&
            row.reviewStatus === 'PENDING',
        ))
          Object.assign(row, {
            reviewStatus: log.body!.action === 'RETURN' ? 'RETURNED' : 'VERIFIED',
            returnReason: log.body!.action === 'RETURN' ? log.body!.reason : null,
            allowedActions: [],
          });
      });
    if (log.path === '/api/v1/project-personnel/production/list') {
      const organizationIds = log.body?.organizationIds as string[] | undefined;
      const rows = state.productionRows.filter(
        (row) =>
          !organizationIds?.length ||
          (row.organizationId !== null && organizationIds.includes(row.organizationId)),
      );
      return read(
        'production',
        pageOf(
          rows.map((row) => ({
            ...row,
            allowedActions: state.primary ? row.allowedActions : [],
          })),
        ),
      );
    }
    if (log.path === '/api/v1/project-personnel/production/quality/context')
      return read('quality', {
        ...state.quality,
        items: state.quality.items.map((item) => ({
          ...item,
          editable: state.primary && item.editable,
        })),
      });
    if (log.path === '/api/v1/project-personnel/production/quality/save')
      return write('quality', () => {
        for (const item of log.body!.items as {
          outputReportId: number;
          inspectedQuantity: number | string;
          qualifiedQuantity: number | string;
          unqualifiedReason?: string;
        }[]) {
          const base = state.quality.items.find(
            (row) => row.outputReportId === item.outputReportId,
          )!;
          state.quality.items.unshift({
            ...base,
            qualityId: ++sequence,
            inspectedQuantity: Number(item.inspectedQuantity),
            qualifiedQuantity: Number(item.qualifiedQuantity),
            unqualifiedReason: item.unqualifiedReason ?? null,
            operatorName: '主策略官',
            operationTime: '2026-11-03 12:00:00',
            qualityDataSource: 'MANUAL',
          });
          state.production.qualityRecordCount++;
        }
      });
    if (log.path === '/api/v1/production-tasks/acceptance/context') {
      const task = state.tasks.find((row) => row.subtaskId === log.body?.subtaskId)!;
      const rows = state.reports.filter((row) => row.subtaskId === task.subtaskId);
      const pending = rows.filter((row) => row.reviewStatus === 'PENDING').length,
        returned = rows.filter((row) => row.reviewStatus === 'RETURNED').length,
        verified = rows.filter((row) => row.reviewStatus === 'VERIFIED');
      const amount = verified.reduce((sum, row) => sum + row.quantity, 0);
      return read('acceptance', {
        ...acceptanceContextResponse.examples[0],
        subtaskId: task.subtaskId,
        subtaskName: task.subtaskName,
        expectedDeliveryDate: task.expectedDeliveryDate,
        expectedQuantity: task.expectedQuantity,
        reportedQuantity: amount,
        pendingCount: pending,
        returnedCount: returned,
        defaultActualQuantity: amount,
        defaultActualDeliveryDate: today(),
        canSubmit:
          state.primary &&
          ['IN_PROGRESS', 'REWORK_REQUIRED'].includes(task.status) &&
          verified.length > 0 &&
          pending === 0 &&
          returned === 0,
      });
    }
    if (log.path === '/api/v1/production-tasks/acceptance/submit')
      return write('acceptance', () => {
        const task = state.tasks.find((row) => row.subtaskId === log.body?.subtaskId)!;
        const reportedQuantity = state.reports
          .filter((row) => row.subtaskId === task.subtaskId && row.reviewStatus === 'VERIFIED')
          .reduce((sum, row) => sum + row.quantity, 0);
        Object.assign(task, {
          status: 'PENDING_ACCEPTANCE',
          actualQuantity: Number(log.body!.actualQuantity),
          actualDeliveryDate: log.body!.actualDeliveryDate,
          quantityAdjustmentRemark:
            Number(log.body!.actualQuantity) === reportedQuantity
              ? null
              : (log.body!.quantityAdjustmentRemark ?? null),
          reportedQuantity,
          submittedAt: '2026-11-03 12:00:00',
          submittedByName: '主策略官',
          allowedActions: [],
        });
      });
    if (/\/report\/(save|correct)$|\/acceptance\/review$/.test(log.path))
      return reply(null, 403, '当前PM功能不提供此写入口');
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, release: async () => release?.() };
}

async function openProduction(page: Page) {
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=PRODUCTION_TASK`);
  const panel = page.getByRole('region', { name: '生产任务', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
const writes = (requests: RequestLog[], path: string) =>
  requests.filter((request) => request.path === `/api/v1/${path}`);
const taskRow = (page: Page, name: string) =>
  page
    .getByRole('region', { name: '生产任务', exact: true })
    .getByRole('article', { name, exact: true });
async function createDraft(page: Page, name: string, quantity = '10.1234') {
  await page.getByRole('button', { name: '创建子任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建生产子任务', exact: true });
  await dialog.getByLabel('子任务名称', { exact: true }).fill(name);
  await dialog.getByLabel('预期交付量', { exact: true }).fill(quantity);
  await dialog.getByLabel('预期交付日期', { exact: true }).fill('2099-11-03');
  return dialog;
}

test('创建任务池子任务保留26位整数4位小数原始字符串，不混入指定成员', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openProduction(page);
  const value = '12345678901234567890123456.1234';
  const dialog = await createDraft(page, '精确大数量任务', value);
  await dialog.getByRole('radio', { name: '任务池', exact: true }).check();
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(taskRow(page, '精确大数量任务')).toBeVisible();
  expect(writes(requests, 'production-tasks/create')).toHaveLength(1);
  const body = writes(requests, 'production-tasks/create')[0].body!;
  expect(body).toMatchObject({
    projectId,
    subtaskName: '精确大数量任务',
    expectedQuantity: value,
    expectedDeliveryDate: '2099-11-03',
    distributionMode: 'POOL',
  });
  expect(body.memberIds ?? []).toEqual([]);
  expect(state.tasks[0].assigneeCount).toBe(0);
});

test('桌面Cookie创建指定人员子任务，memberIds来源候选且挂起时不可重复提交', async ({ page }) => {
  const fixture = await backend(page, true);
  await openProduction(page);
  await expect(taskRow(page, '指定生产任务')).toBeVisible();
  await page.screenshot({ path: 'artifacts/strategist-production/production-desktop.png' });
  const dialog = await createDraft(page, '指定成员新任务');
  await dialog.getByRole('radio', { name: '指定人员', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '指定生产成员甲', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '指定生产成员乙', exact: true }).check();
  fixture.state.hold = 'create';
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect.poll(() => writes(fixture.requests, 'production-tasks/create').length).toBe(1);
  await expect(dialog.getByRole('button', { name: '确认创建子任务', exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: '重新读取创建结果', exact: true }),
  ).toBeDisabled();
  await fixture.release();
  await expect(dialog).toHaveCount(0);
  expect(writes(fixture.requests, 'production-tasks/create')[0].body).toMatchObject({
    projectId,
    distributionMode: 'DESIGNATED',
    memberIds: [1, 2],
  });
  expect(writes(fixture.requests, 'production-tasks/create')[0].headers.cookie).toContain(
    'production_session=active',
  );
  expect(writes(fixture.requests, 'production-tasks/create')[0].headers['x-tyde-client']).toBe(
    'web',
  );
  expect(fixture.state.tasks[0].assigneeCount).toBe(2);
});

test('子任务分页搜索由服务端处理，实际人员详情不混用创建候选', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openProduction(page);
  await panel.getByRole('navigation').getByRole('button', { name: '下一页', exact: true }).click();
  await expect(panel.getByRole('navigation').getByText(/第 2 \//)).toBeVisible();
  await panel.getByRole('searchbox', { name: '筛选生产任务', exact: true }).fill('指定生产任务');
  await panel.getByRole('button', { name: '查询任务', exact: true }).click();
  await taskRow(page, '指定生产任务')
    .getByRole('button', { name: '查看任务成员', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '子任务成员', exact: true });
  await expect(dialog.getByText('生产成员甲', { exact: true })).toBeVisible();
  await expect(dialog.getByText('生产成员乙', { exact: true })).toBeVisible();
  expect(writes(requests, 'production-tasks/member-list').at(-1)?.body).toMatchObject({
    projectId,
    subtaskId: 1,
  });
  expect(writes(requests, 'production-tasks/list').at(-1)?.body).toMatchObject({
    projectId,
    keyword: '指定生产任务',
    current: 1,
  });
});

test('协作策略官可读生产任务，不显示创建、报量核查或提交验收入口', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.primary = false;
  const panel = await openProduction(page);
  await expect(panel.getByRole('button', { name: '创建子任务', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /检查数据|提交验收/ })).toHaveCount(0);
  await expect(panel.getByRole('tab', { name: '项目报量', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('tab', { name: '人员日生产', exact: true })).toHaveCount(0);
  expect(writes(requests, 'production-tasks/report/review')).toHaveLength(0);
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(0);
});

test('本层级全部核准跨候选筛选与分页，但不会核准其他子任务报量', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.reports.find((row) => row.reportId === 101)!.subtaskId = 1;
  state.reports.find((row) => row.reportId === 105)!.subtaskId = 1;
  state.reports.find((row) => row.reportId === 102)!.subtaskId = 2;
  for (let index = 0; index < 21; index++)
    state.reports.push({
      ...state.reports[1],
      reportId: 1000 + index,
      displayName: `生产成员乙${index}`,
    });
  await openProduction(page);
  await taskRow(page, '指定生产任务')
    .getByRole('button', { name: /^检查数据/ })
    .click();
  const reports = page.getByRole('region', { name: '报量核查', exact: true });
  await reports.getByRole('searchbox', { name: '筛选报量', exact: true }).fill('生产成员甲');
  await reports.getByRole('button', { name: '查询报量', exact: true }).click();
  await reports.getByRole('button', { name: '核准本层级全部待核查', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认核准报量', exact: true })
    .getByRole('button', { name: '确认核准', exact: true })
    .click();
  await expect
    .poll(() => state.reports.find((row) => row.reportId === 105)?.reviewStatus)
    .toBe('VERIFIED');
  expect(state.reports.find((row) => row.reportId === 101)?.reviewStatus).toBe('VERIFIED');
  expect(state.reports.find((row) => row.reportId === 102)?.reviewStatus).toBe('PENDING');
  expect(state.reports.find((row) => row.reportId === 1020)?.reviewStatus).toBe('VERIFIED');
  expect(writes(requests, 'production-tasks/report/review')[0].body).toMatchObject({
    projectId,
    action: 'VERIFY',
    reportIds: [],
  });
  expect(writes(requests, 'production-tasks/report/review')[0].body?.subtaskId).toBe(1);
});

test('退回指定子任务单条报量须原因，来源层级和reportId保持精确', async ({ page }) => {
  const { requests } = await backend(page);
  await openProduction(page);
  await taskRow(page, '指定生产任务')
    .getByRole('button', { name: /^检查数据/ })
    .click();
  const reports = page.getByRole('dialog', { name: '子任务报量', exact: true });
  await reports
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '退回报量', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '确认退回报量', exact: true });
  await dialog.getByRole('button', { name: '确认退回', exact: true }).click();
  expect(writes(requests, 'production-tasks/report/review')).toHaveLength(0);
  await dialog.getByLabel('退回原因', { exact: true }).fill('请核对实际完成数量');
  await dialog.getByRole('button', { name: '确认退回', exact: true }).click();
  await expect.poll(() => writes(requests, 'production-tasks/report/review').length).toBe(1);
  expect(writes(requests, 'production-tasks/report/review')[0].body).toMatchObject({
    projectId,
    subtaskId: 1,
    action: 'RETURN',
    reportIds: [102],
    reason: '请核对实际完成数量',
  });
});

test('报量核查响应未知即使GET已显示核准也保持本次写入锁，不自动重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'review';
  state.applyUnknown = true;
  await openProduction(page);
  await taskRow(page, '指定生产任务')
    .getByRole('button', { name: /^检查数据/ })
    .click();
  const panel = page.getByRole('region', { name: '报量核查', exact: true });
  await panel
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '核准报量', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '确认核准报量', exact: true })
    .getByRole('button', { name: '确认核准', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: '确认核准报量', exact: true });
  await confirmation.getByRole('button', { name: '重新读取报量', exact: true }).click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(writes(requests, 'production-tasks/report/review')).toHaveLength(1);
  await expect(
    panel.getByRole('button', { name: '核准本层级全部待核查', exact: true }),
  ).toBeDisabled();
});

async function openQuality(page: Page) {
  await page.getByRole('tab', { name: '人员管理', exact: true }).click();
  await page.getByRole('tab', { name: '生产情况', exact: true }).click();
  await page.getByRole('button', { name: /^质量记录/ }).click();
  const dialog = page.getByRole('dialog', { name: '生产质量明细', exact: true });
  await expect(dialog.getByRole('article', { name: '报量 102', exact: true })).toBeVisible();
  return dialog;
}

async function openAcceptance(page: Page, name = '返修生产任务') {
  await taskRow(page, name).getByRole('button', { name: '提交验收', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '子任务验收', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmAcceptance(page: Page) {
  await page
    .getByRole('dialog', { name: '子任务验收', exact: true })
    .getByRole('button', { name: '提交验收', exact: true })
    .click();
  await page.getByRole('button', { name: '确认提交验收', exact: true }).click();
}

async function confirmQuality(page: Page) {
  await page
    .getByRole('dialog', { name: '生产质量明细', exact: true })
    .getByRole('button', { name: '提交新增质量', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '确认追加质量', exact: true })
    .getByRole('button', { name: '确认追加质量', exact: true })
    .click();
}

test('质量上下文保留同一报量的多次历史，每次同报量只追加一条新记录且系统报量只读', async ({
  page,
}) => {
  const { state, requests } = await backend(page);
  await openProduction(page);
  const dialog = await openQuality(page);
  const group = dialog.getByRole('article', { name: '报量 102', exact: true });
  await expect(group.getByText('历史记录人', { exact: false })).toBeVisible();
  await expect(group.getByText('主策略官', { exact: false })).toBeVisible();
  await expect(
    dialog
      .getByRole('article', { name: '报量 101', exact: true })
      .getByRole('button', { name: '新增质量记录', exact: true }),
  ).toHaveCount(0);
  await group.getByRole('button', { name: '新增质量记录', exact: true }).click();
  await expect(group.getByRole('button', { name: '新增质量记录', exact: true })).toBeDisabled();
  for (const [index, inspected, qualified] of [[1, '2.25', '2']] as const) {
    const draft = dialog.getByRole('region', { name: `新增质量记录 ${index}`, exact: true });
    await draft.getByLabel('抽检数量', { exact: true }).fill(inspected);
    await draft.getByLabel('合格数量', { exact: true }).fill(qualified);
    if (index === 1) await draft.getByLabel('不合格原因', { exact: true }).fill('边界样本需复核');
  }
  await confirmQuality(page);
  await expect.poll(() => state.quality.items.length).toBe(4);
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(1);
  expect(writes(requests, 'project-personnel/production/quality/save')[0].body).toMatchObject({
    projectId,
    memberId: 1,
    reportDate: today(),
    items: [
      {
        outputReportId: 102,
        inspectedQuantity: '2.25',
        qualifiedQuantity: '2',
        unqualifiedReason: '边界样本需复核',
      },
    ],
  });
  expect(state.quality.items.filter((row) => row.outputReportId === 102)).toHaveLength(3);
  expect(
    state.quality.items.some((row) => row.qualityId === 1 && row.operatorName === '历史记录人'),
  ).toBe(true);
});

test('质量合格量不得大于抽检量，无效输入保留草稿且不发请求', async ({ page }) => {
  const { requests } = await backend(page);
  await openProduction(page);
  const dialog = await openQuality(page);
  await dialog
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '新增质量记录', exact: true })
    .click();
  const draft = dialog.getByRole('region', { name: '新增质量记录 1', exact: true });
  await draft.getByLabel('抽检数量', { exact: true }).fill('2');
  await draft.getByLabel('合格数量', { exact: true }).fill('3');
  await dialog.getByRole('button', { name: '提交新增质量', exact: true }).click();
  await expect(draft.getByLabel('合格数量', { exact: true })).toHaveValue('3');
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(0);
});

test('质量追加未知关闭重开后仍保留草稿锁，核实读取不靠相同内容冒充本次成功', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'quality';
  state.applyUnknown = true;
  await openProduction(page);
  let dialog = await openQuality(page);
  await dialog
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '新增质量记录', exact: true })
    .click();
  let draft = dialog.getByRole('region', { name: '新增质量记录 1', exact: true });
  await draft.getByLabel('抽检数量', { exact: true }).fill('2');
  await draft.getByLabel('合格数量', { exact: true }).fill('2');
  await confirmQuality(page);
  await expect(dialog.getByRole('button', { name: '核实质量结果', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: /^质量记录/ }).click();
  dialog = page.getByRole('dialog', { name: '生产质量明细', exact: true });
  await dialog.getByRole('button', { name: '核实质量结果', exact: true }).click();
  draft = dialog.getByRole('region', { name: '新增质量记录 1', exact: true });
  await expect(draft.getByLabel('抽检数量', { exact: true })).toHaveValue('2');
  await expect(draft.getByLabel('抽检数量', { exact: true })).toBeDisabled();
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(1);
  expect(state.quality.items).toHaveLength(4);
});

test('日生产筛选发送上海日期与身份来源，协作只能查看质量历史', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.primary = false;
  await openProduction(page);
  await page.getByRole('tab', { name: '人员管理', exact: true }).click();
  await page.getByRole('tab', { name: '生产情况', exact: true }).click();
  const daily = page.getByRole('region', { name: '人员日生产', exact: true });
  await daily.getByLabel('生产日期', { exact: true }).fill(today());
  await daily.getByRole('searchbox', { name: '搜索日生产人员', exact: true }).fill('生产成员甲');
  await daily.getByRole('combobox', { name: '接单身份', exact: true }).click();
  await page.getByRole('option', { name: '个人', exact: true }).click();
  await daily.getByRole('combobox', { name: '生产数据来源', exact: true }).click();
  await page.getByRole('option', { name: '人工填报', exact: true }).click();
  await daily.getByRole('button', { name: '查询日生产', exact: true }).click();
  await expect
    .poll(() => writes(requests, 'project-personnel/production/list').at(-1)?.body?.keyword)
    .toBe('生产成员甲');
  expect(writes(requests, 'project-personnel/production/list').at(-1)?.body).toMatchObject({
    projectId,
    reportDateStart: today(),
    reportDateEnd: today(),
    accountTypes: ['INDIVIDUAL'],
    dataSources: ['MANUAL'],
  });
  await daily.getByRole('button', { name: /^质量记录/ }).click();
  const dialog = page.getByRole('dialog', { name: '生产质量明细', exact: true });
  await expect(dialog.getByRole('button', { name: '新增质量记录', exact: true })).toHaveCount(0);
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(0);
});

test('待核查报量阻止提交验收，不能绕开上下文完整性校验', async ({ page }) => {
  const { requests } = await backend(page);
  await openProduction(page);
  const dialog = await openAcceptance(page, '指定生产任务');
  await expect(dialog.getByRole('button', { name: '提交验收', exact: true })).toBeDisabled();
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(0);
  expect(writes(requests, 'production-tasks/acceptance/context').at(-1)?.body).toMatchObject({
    projectId,
    subtaskId: 1,
  });
});

test('返修子任务重新提交验收须保留调整原因，PM不调用领航员审批或专家报量写入', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openProduction(page);
  await expect(
    taskRow(page, '返修生产任务').getByText('返修原因：交付需要返修', { exact: true }),
  ).toBeVisible();
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付量', { exact: true }).fill('9.5');
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  await dialog.getByLabel('数量调整说明', { exact: true }).fill('实际验收数量较核准报量减少0.5');
  await confirmAcceptance(page);
  await expect.poll(() => state.tasks[1].status).toBe('PENDING_ACCEPTANCE');
  expect(writes(requests, 'production-tasks/acceptance/submit')[0].body).toMatchObject({
    projectId,
    subtaskId: 2,
    actualQuantity: '9.5',
    actualDeliveryDate: '2099-11-03',
    quantityAdjustmentRemark: '实际验收数量较核准报量减少0.5',
  });
  expect(
    requests.filter((request) =>
      /\/report\/(save|correct)$|\/acceptance\/review$/.test(request.path),
    ),
  ).toHaveLength(0);
});

test('验收保留用户说明由服务端精确比较数量，核准总量相等时清除历史调整说明', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openProduction(page);
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付量', { exact: true }).fill('10');
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  await dialog.getByLabel('数量调整说明', { exact: true }).fill('沿用上轮说明待服务端核对');
  await confirmAcceptance(page);
  await expect.poll(() => writes(requests, 'production-tasks/acceptance/submit').length).toBe(1);
  expect(
    writes(requests, 'production-tasks/acceptance/submit')[0].body?.quantityAdjustmentRemark,
  ).toBe('沿用上轮说明待服务端核对');
  expect(state.tasks[1].quantityAdjustmentRemark).toBeNull();
});

test('验收写入响应未知但精确同任务新提交快照可核实，不重复提交', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'acceptance';
  state.applyUnknown = true;
  await openProduction(page);
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付量', { exact: true }).fill('10');
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  await confirmAcceptance(page);
  await page.getByRole('button', { name: '核实验收结果', exact: true }).click();
  await expect.poll(() => writes(requests, 'production-tasks/list').length).toBeGreaterThan(1);
  await expect(dialog).toHaveCount(0);
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(1);
});

test('验收未知且没有新提交快照只能保持锁，不能用上下文可提交状态解锁', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'acceptance';
  await openProduction(page);
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付量', { exact: true }).fill('10');
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  await confirmAcceptance(page);
  await page.getByRole('button', { name: '核实验收结果', exact: true }).click();
  await expect(dialog.getByLabel('实际交付量', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '提交验收', exact: true })).toHaveCount(0);
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(1);
});

test('创建结果未知跨关闭、页面和角色切换保留草稿锁，显式读取也不自动重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'create';
  await openProduction(page);
  let dialog = await createDraft(page, '未知创建草稿');
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重新读取创建结果', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消创建', exact: true }).click();
  await page.getByRole('link', { name: '返回我的项目', exact: true }).click();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '策略官',
  );
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=PRODUCTION_TASK`);
  await page.getByRole('button', { name: '恢复创建草稿', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '创建生产子任务', exact: true });
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toHaveValue('未知创建草稿');
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '重新读取创建结果', exact: true }).click();
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toBeDisabled();
  expect(writes(requests, 'production-tasks/create')).toHaveLength(1);
});

test('创建明确成功后完整待办读取失败仅可重读，不再次创建', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failAfterWrite = 'projects';
  await openProduction(page);
  const dialog = await createDraft(page, '成功等待回读任务');
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect(
    dialog.getByText('子任务已创建，后续信息读取失败，请重新读取创建结果。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toBeDisabled();
  state.readStatuses.projects = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '重新读取创建结果', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(taskRow(page, '成功等待回读任务')).toBeVisible();
  expect(writes(requests, 'production-tasks/create')).toHaveLength(1);
});

test('403与409创建拒绝必须显式重读核对后才能编辑重试', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.writeStatuses.create = 409;
  await openProduction(page);
  const dialog = await createDraft(page, '同名任务');
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toBeDisabled();
  state.writeStatuses.create = 403;
  await dialog.getByRole('button', { name: '重新读取创建结果', exact: true }).click();
  await dialog.getByLabel('子任务名称', { exact: true }).fill('权限已变化任务');
  await dialog.getByRole('button', { name: '确认创建子任务', exact: true }).click();
  await expect(dialog.getByLabel('子任务名称', { exact: true })).toBeDisabled();
  expect(writes(requests, 'production-tasks/create')).toHaveLength(2);
  expect(state.tasks).toHaveLength(22);
});

test('生产任务读取403无旧任务写入口，刷新失败不伪装为空列表', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.readStatuses.tasks = 403;
  const panel = await openProduction(page);
  await expect(panel.getByText('tasks读取结果', { exact: true })).toBeVisible();
  await expect(panel.getByRole('article', { name: '指定生产任务', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '创建子任务', exact: true })).toBeDisabled();
  expect(writes(requests, 'production-tasks/create')).toHaveLength(0);
});

test('375px生产列表和质量Dialog横向不溢出，保留完整字段与固定操作', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await backend(page);
  await openProduction(page);
  await expect(taskRow(page, '指定生产任务')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const dialog = await openQuality(page);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/strategist-production/production-375.png' });
  await expect(page.getByRole('tabpanel', { name: '生产情况', exact: true })).toBeVisible();
});

test('报量核查待办卡直达完整生产列表，不把分支卡当作某个子任务', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.branchNodeCode = 'OUTPUT_DATA_REVIEW';
  await page.goto(`${origin}/#/strategist/projects`);
  const link = page.getByRole('link', { name: '生产任务', exact: true });
  await expect(link).toHaveAttribute(
    'href',
    `/#/strategist/projects/${projectId}?tab=PRODUCTION_TASK`,
  );
  await link.click();
  await expect(taskRow(page, '指定生产任务')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '子任务报量', exact: true })).toHaveCount(0);
  expect(writes(requests, 'production-tasks/reports')).toHaveLength(0);
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(0);
});

test('质量确认前重读发现来源已改为作业系统，则保留草稿且不追加', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openProduction(page);
  const dialog = await openQuality(page);
  await dialog
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '新增质量记录', exact: true })
    .click();
  const draft = dialog.getByRole('region', { name: '新增质量记录 1', exact: true });
  await draft.getByLabel('抽检数量', { exact: true }).fill('1');
  await draft.getByLabel('合格数量', { exact: true }).fill('1');
  for (const item of state.quality.items.filter((row) => row.outputReportId === 102))
    item.editable = false;
  await confirmQuality(page);
  await expect(
    dialog.getByText('报量 102 当前不可追加质量，请重新读取。', { exact: true }),
  ).toBeVisible();
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(0);
  await expect(draft.getByLabel('抽检数量', { exact: true })).toHaveValue('1');
});

test('质量追加成功但上下文回读失败，核实只重读后保留完整旧历史', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failAfterWrite = 'quality';
  await openProduction(page);
  const dialog = await openQuality(page);
  const rosterReads = () =>
    requests.filter((request) => request.path.endsWith('/project-personnel/roster/list')).length;
  const initialRosterReads = rosterReads();
  await dialog
    .getByRole('article', { name: '报量 102', exact: true })
    .getByRole('button', { name: '新增质量记录', exact: true })
    .click();
  const draft = dialog.getByRole('region', { name: '新增质量记录 1', exact: true });
  await draft.getByLabel('抽检数量', { exact: true }).fill('1');
  await draft.getByLabel('合格数量', { exact: true }).fill('1');
  const failedContextRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/project-personnel/production/quality/context') &&
      response.status() === 503,
  );
  await confirmQuality(page);
  await failedContextRead;
  await expect(
    dialog.getByText('质量追加已成功，后续读取失败时仅重新读取，不再次追加。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '核实质量结果', exact: true })).toBeEnabled();
  state.readStatuses.quality = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '核实质量结果', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '生产情况', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: /^质量记录/ }).click();
  await expect(dialog.getByRole('region', { name: '新增质量记录 1', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('历史记录人', { exact: false })).toBeVisible();
  expect(rosterReads()).toBe(initialRosterReads);
  expect(writes(requests, 'project-personnel/production/quality/save')).toHaveLength(1);
});

test('大数量验收响应存在精度损失时，即使已提交也不以近似数字自动解锁', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'acceptance';
  state.applyUnknown = true;
  await openProduction(page);
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付量', { exact: true }).fill('12345678901234567890123456.1234');
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  await dialog.getByLabel('数量调整说明', { exact: true }).fill('本次大数量调整');
  await confirmAcceptance(page);
  await dialog.getByRole('button', { name: '核实验收结果', exact: true }).click();
  await expect(dialog.getByLabel('实际交付量', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '提交验收', exact: true })).toHaveCount(0);
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(1);
});

test('仅修改验收日期关闭时询问放弃，取消关闭后保留日期且不提交', async ({ page }) => {
  const { requests } = await backend(page);
  await openProduction(page);
  const dialog = await openAcceptance(page);
  await dialog.getByLabel('实际交付日期', { exact: true }).fill('2099-11-03');
  const confirmation = page.waitForEvent('dialog');
  const closing = dialog.getByRole('button', { name: '关闭验收', exact: true }).click();
  const prompt = await confirmation;
  expect(prompt.type()).toBe('confirm');
  await prompt.dismiss();
  await closing;
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('实际交付日期', { exact: true })).toHaveValue('2099-11-03');
  expect(writes(requests, 'production-tasks/acceptance/submit')).toHaveLength(0);
});

test('日生产组织筛选提交UUID数组，由服务端过滤且保留已加载组织选项', async ({ page }) => {
  const { state, requests } = await backend(page);
  Object.assign(state.production, {
    accountType: 'ORGANIZATION',
    organizationId: uuid(200),
    organizationName: '海潮生产组织',
  });
  state.productionRows.push({
    ...state.production,
    memberId: 2,
    userId: uuid(101),
    uid: 'MEMBER2',
    displayName: '生产成员乙',
    organizationId: uuid(201),
    organizationName: '远洋生产组织',
  });
  await openProduction(page);
  await page.getByRole('tab', { name: '人员管理', exact: true }).click();
  await page.getByRole('tab', { name: '生产情况', exact: true }).click();
  const daily = page.getByRole('region', { name: '人员日生产', exact: true });
  await expect(
    daily.getByRole('article', { name: `生产成员乙 ${today()}`, exact: true }),
  ).toBeVisible();
  await daily.getByText('组织筛选', { exact: true }).click();
  await daily.getByRole('checkbox', { name: '海潮生产组织', exact: true }).check();
  await daily.getByRole('button', { name: '查询日生产', exact: true }).click();
  await expect
    .poll(() => writes(requests, 'project-personnel/production/list').at(-1)?.body?.organizationIds)
    .toEqual([uuid(200)]);
  await expect(
    daily.getByRole('article', { name: `生产成员甲 ${today()}`, exact: true }),
  ).toBeVisible();
  await expect(
    daily.getByRole('article', { name: `生产成员乙 ${today()}`, exact: true }),
  ).toHaveCount(0);
  await expect(daily.getByRole('checkbox', { name: '远洋生产组织', exact: true })).toBeVisible();
});
