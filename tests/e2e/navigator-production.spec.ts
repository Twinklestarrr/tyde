import { expect, test, type Page } from '@playwright/test';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { projectCardExample } from '../../apps/server/src/modules/projects/project-list.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import {
  memberExample,
  taskExample,
} from '../../apps/server/src/modules/production/production.schema';
import { acceptanceContextResponse } from '../../apps/server/src/modules/production/quality-acceptance.schema';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import type {
  AuthUser,
  NavigatorProjectCard,
  ProductionTask,
  ProductionTaskMember,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176',
  projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'NAVPRODUCTION10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '领航生产创建人',
  realName: '测试创建人',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'NAVIGATOR',
  selectedRole: 'NAVIGATOR',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: '2026-11-04T04:00:00.000Z',
  updatedAt: '2026-11-04T04:00:00.000Z',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectName: '领航员生产验收项目',
  projectDescription: '真实创建人审核已提交生产子任务',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  standardLink: null,
  requesterId: uuid(88),
  requesterName: '项目需求方',
  creatorUid: user.uid,
  creatorName: user.realName,
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
  role: AuthUser['role'];
}

/** NAV仅创建人任务/成员读取和验收审核；不伪造NAV报量、质量或PM验收上下文权限。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.context().addCookies([
    {
      name: 'nav_production_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const tasks: ProductionTask[] = Array.from(
    { length: 23 },
    (_, i) =>
      ({
        ...structuredClone(taskExample.records[0]),
        subtaskId: i + 1,
        subtaskNo: `ST-${i + 1}`,
        subtaskName: `生产任务${i + 1}`,
        operationHint: '待策略官提交验收',
        allowedActions: [],
      }) as ProductionTask,
  );
  Object.assign(tasks[0]!, {
    subtaskName: '指定待验收任务',
    distributionMode: 'DESIGNATED',
    assigneeCount: 22,
    assigneeNames: ['生产成员甲', '生产成员乙', '生产成员3'],
    status: 'PENDING_ACCEPTANCE',
    actualDeliveryDate: '2026-11-03',
    actualQuantity: 8.125,
    reportedQuantity: 10,
    quantityAdjustmentRemark: '本轮数量调整说明',
    submittedByName: '主策略官',
    submittedAt: '2026-11-03 12:00:00',
    operationHint: null,
    allowedActions: ['ACCEPT', 'REJECT'],
  });
  Object.assign(tasks[1]!, {
    subtaskName: '返修中的任务',
    status: 'REWORK_REQUIRED',
    actualDeliveryDate: '2026-11-02',
    actualQuantity: 8,
    reportedQuantity: 10,
    submittedAt: '2026-11-02 12:00:00',
    submittedByName: '主策略官',
    reviewedAt: '2026-11-02 13:00:00',
    reviewedByName: '创建人',
    rejectReason: '上轮驳回原因',
  });
  Object.assign(tasks[2]!, {
    subtaskName: '已验收历史任务',
    status: 'ACCEPTED',
    actualQuantity: 0,
    actualDeliveryDate: '2026-11-01',
    reportedQuantity: 0,
    submittedAt: '2026-11-01 12:00:00',
    reviewedAt: '2026-11-01 13:00:00',
    operationHint: null,
  });
  tasks[3]!.subtaskName = '空任务池';
  Object.assign(tasks[22]!, {
    ...tasks[0],
    subtaskId: 23,
    subtaskNo: 'ST-23',
    subtaskName: '另一待验收任务',
    assigneeCount: 0,
    assigneeNames: [],
    distributionMode: 'POOL',
    actualQuantity: 0,
    reportedQuantity: 0,
    quantityAdjustmentRemark: null,
    submittedAt: '2026-11-04 09:00:00',
    rejectReason: null,
  });
  const members: ProductionTaskMember[] = Array.from({ length: 22 }, (_, i) => ({
    ...structuredClone(memberExample.records[0]),
    memberId: i + 1,
    userId: uuid(100 + i),
    uid: `MEMBER${i + 1}`,
    displayName: i === 0 ? '生产成员甲' : i === 1 ? '生产成员乙' : `生产成员${i + 1}`,
    subjectType: 'INDIVIDUAL',
    assignmentType: 'DESIGNATED',
    assignedAt: '2026-11-01 10:00:00',
  }));
  const card = {
    ...structuredClone(projectCardExample),
    id: projectId,
    projectName: project.projectName,
    creatorId: user.id,
    creatorName: user.realName,
    currentNodeCode: 'PRODUCTION_TASK',
    branchNodeCode: 'SUBTASK_ACCEPTANCE',
    currentAction: 'VIEW_DETAIL',
    currentActionDescription: '查看项目详情',
    workbenchStatus: 'PENDING',
  } as NavigatorProjectCard;
  const state = {
    user: structuredClone(user),
    project: structuredClone(project),
    cards: [card],
    tasks,
    members,
    tasksStatus: 200,
    tasksNetwork: false,
    membersStatus: 200,
    listStatus: 200,
    writeStatus: 200,
    writeNetwork: false,
    commitOnFailure: false,
    holdWrite: false,
    failListAfterWrite: false,
    removeAfterWrite: false,
    // 服务端轮次是内存业务种子，不向真实生产list DTO添加不存在的字段。
    rounds: new Map([
      [1, 1],
      [23, 1],
    ]),
  };
  const requests: RequestLog[] = [];
  let release: (() => void) | undefined;
  function refreshCards() {
    const pending = state.tasks.filter((item) => item.status === 'PENDING_ACCEPTANCE');
    if (state.removeAfterWrite || !pending.length) state.cards = [];
    else
      state.cards[0]!.branchNodeCode = pending.some(
        (item) => (state.rounds.get(item.subtaskId) ?? 1) > 1,
      )
        ? 'SUBTASK_REWORK_REVIEW'
        : 'SUBTASK_ACCEPTANCE';
  }
  function apply(body: Record<string, unknown>) {
    const row = state.tasks.find((item) => item.subtaskId === body.subtaskId)!;
    Object.assign(row, {
      status: body.decision === 'ACCEPT' ? 'ACCEPTED' : 'REWORK_REQUIRED',
      reviewedByName: user.realName,
      reviewedAt: '2026-11-04 12:00:00',
      rejectReason: body.decision === 'REJECT' ? String(body.rejectReason).trim() : null,
      allowedActions: [],
      operationHint: body.decision === 'REJECT' ? '待策略官提交验收' : null,
    });
    refreshCards();
  }
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      headers = await request.allHeaders();
    const body = headers['content-type']?.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      body,
      query: Object.fromEntries(url.searchParams),
      headers,
      role: state.user.role,
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    const pageOf = <T>(rows: T[]) => {
      const current = Number(body?.current ?? 1),
        size = Number(body?.size ?? 20);
      return {
        current,
        size,
        total: rows.length,
        pages: Math.ceil(rows.length / size),
        records: rows.slice((current - 1) * size, current * size),
      };
    };
    const creator = state.user.role === 'NAVIGATOR' && state.project.creatorUid === state.user.uid;
    if (!headers.cookie?.includes('nav_production_session=active'))
      return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      state.user.role = body!.role as AuthUser['role'];
      state.user.selectedRole = state.user.role;
      return reply({ selectedRole: state.user.role, roles: state.user.roles });
    }
    if (log.path === '/api/v1/projects/list')
      return reply(
        state.listStatus === 200 ? (creator ? state.cards : []) : null,
        state.listStatus,
        '完整待办读取失败',
      );
    if (log.path === '/api/v1/projects/manager/list')
      return reply([strategistProjectCard(state.project)]);
    if (log.path === '/api/v1/expert-assignments/my-tasks') return reply([]);
    if (log.path === '/api/v1/projects/draft/current')
      return reply({ hasDraft: false, draft: null });
    if (log.path === '/api/v1/projects/manager-candidates') return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`)
      return creator || state.user.role === 'PM'
        ? reply(state.project)
        : reply(null, 403, '当前用户无权查看该项目');
    if (log.path === '/api/v1/projects/expert-recruitments/detail' && state.user.role === 'PM')
      return reply({
        ...structuredClone(recruitmentDetailExample),
        projectId,
        currentNodeCode: 'PRODUCTION_TASK',
        canChangeHandler: true,
        currentOperatorRole: 'PRIMARY_MANAGER',
      });
    if (log.path === '/api/v1/production-tasks/acceptance/context' && state.user.role === 'PM')
      return reply({
        ...acceptanceContextResponse.examples[0],
        subtaskId: body!.subtaskId,
        canSubmit: false,
      });
    if (log.path === '/api/v1/production-tasks/list') {
      if (!creator && state.user.role !== 'PM') return reply(null, 403, '当前角色无权查看任务');
      if (state.tasksNetwork) return route.abort('failed');
      if (state.tasksStatus !== 200) return reply(null, state.tasksStatus, '生产任务读取被拒绝');
      const statuses = body?.statuses as string[] | undefined;
      const rows = state.tasks.filter(
        (row) =>
          (!body?.keyword || `${row.subtaskName}${row.subtaskNo}`.includes(String(body.keyword))) &&
          (!statuses?.length || statuses.includes(row.status)),
      );
      return reply(
        pageOf(
          rows.map((row) => ({
            ...row,
            allowedActions:
              state.user.role === 'PM' || state.project.currentNodeCode === 'COMPLETED'
                ? []
                : row.allowedActions,
          })),
        ),
      );
    }
    if (log.path === '/api/v1/production-tasks/member-list') {
      if (!creator) return reply(null, 403, '当前角色无权查看成员');
      const rows =
        body?.subtaskId === 1
          ? state.members.filter(
              (row) =>
                !body.keyword || `${row.displayName}${row.uid}`.includes(String(body.keyword)),
            )
          : [];
      return reply(
        state.membersStatus === 200 ? pageOf(rows) : null,
        state.membersStatus,
        '子任务成员读取被拒绝',
      );
    }
    if (log.path === '/api/v1/production-tasks/acceptance/review') {
      if (!creator) return reply(null, 403, '仅项目创建人领航员可审核验收');
      const reason = String(body?.rejectReason ?? '').trim();
      if (
        !body ||
        body.projectId !== projectId ||
        !['ACCEPT', 'REJECT'].includes(String(body.decision)) ||
        Object.keys(body).some(
          (key) => !['projectId', 'subtaskId', 'decision', 'rejectReason'].includes(key),
        ) ||
        reason.length > 500 ||
        (body.decision === 'REJECT' ? !reason : !!reason)
      )
        return reply(null, 400, '验收审核参数不合法');
      if (
        state.project.currentNodeCode === 'COMPLETED' ||
        !state.tasks.some(
          (item) => item.subtaskId === body.subtaskId && item.status === 'PENDING_ACCEPTANCE',
        )
      )
        return reply(null, 409, '当前子任务不可验收');
      if (state.holdWrite)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (state.commitOnFailure) apply(body!);
      if (state.writeNetwork) return route.abort('failed');
      if (state.writeStatus !== 200) return reply(null, state.writeStatus, '验收审核被拒绝');
      if (!state.commitOnFailure) apply(body!);
      if (state.failListAfterWrite) state.listStatus = 503;
      return reply(null);
    }
    if (/\/production-tasks\/|\/project-personnel\//.test(log.path))
      return reply(null, 403, 'NAV不开放此PM或EXPERT接口');
    return reply(null, 404, '隔离夹具未约定此接口');
  });
  return {
    state,
    requests,
    setRound: (subtaskId: number, round: number) => {
      state.rounds.set(subtaskId, round);
      refreshCards();
    },
    calls: (suffix: string) => requests.filter((item) => item.path === `/api/v1/${suffix}`),
    release: () => {
      if (!release) throw new Error('没有待处理审核');
      state.holdWrite = false;
      release();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof backend>>;
const panel = (page: Page) => page.getByRole('region', { name: '生产任务', exact: true });
const row = (page: Page, name = '指定待验收任务') =>
  panel(page).getByRole('article', { name, exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: '验收详情', exact: true });
const writes = (f: Fixture) => f.calls('production-tasks/acceptance/review');
const tabs = (page: Page) => page.getByRole('tablist', { name: '领航员项目模块', exact: true });
async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/projects/${projectId}`);
  await expect(tabs(page).getByRole('tab', { name: '生产任务', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(row(page)).toBeVisible();
  return panel(page);
}
async function inspect(page: Page, name = '指定待验收任务') {
  await row(page, name).getByRole('button', { name: '审核验收', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }),
  ).toBeEnabled();
  return dialog(page);
}
async function confirm(page: Page, decision: 'ACCEPT' | 'REJECT' = 'ACCEPT') {
  await dialog(page)
    .getByRole('button', { name: decision === 'ACCEPT' ? '通过验收' : '驳回验收', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: decision === 'ACCEPT' ? '确认通过验收' : '确认驳回验收',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole('button', { name: decision === 'ACCEPT' ? '确认通过' : '确认驳回', exact: true })
    .click();
}
async function chooseRole(page: Page, name: '领航员' | '策略官') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(name);
}
function noForbiddenReads(f: Fixture) {
  expect(
    f.requests.filter(
      (item) =>
        item.role === 'NAVIGATOR' &&
        /\/production-tasks\/(members|create|reports|report\/|reportable|acceptance\/(context|submit))|\/project-personnel\/|\/projects\/expert-recruitments\/detail/.test(
          item.path,
        ),
    ),
  ).toEqual([]);
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document
      .querySelector('[role="group"][aria-label="生产任务列表"]')
      ?.scrollTo({ top: 0, behavior: 'instant' });
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: `artifacts/navigator-production/${name}.png`, fullPage: true });
}

for (const desktop of [false, true])
  test(`${desktop ? '桌面配置' : 'Web'}真实验收支线初始直达生产，读取交付快照及成员且不请求PM专用接口`, async ({
    page,
  }) => {
    const f = await backend(page, desktop);
    await page.goto(`${origin}/#/projects`);
    await page.getByRole('link', { name: '查看项目', exact: true }).click();
    await expect(tabs(page).getByRole('tab', { name: '生产任务', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(row(page)).toContainText('8.125');
    const detail = await inspect(page);
    for (const text of ['本轮数量调整说明', '主策略官', '2026-11-03 12:00:00', '2026-11-03'])
      await expect(detail).toContainText(text);
    await expect(detail.getByRole('button', { name: '通过验收', exact: true })).toBeEnabled();
    await detail.getByRole('button', { name: '关闭验收详情', exact: true }).click();
    await row(page).getByRole('button', { name: '查看任务成员', exact: true }).click();
    const members = page.getByRole('dialog', { name: '子任务成员', exact: true });
    await expect(members.getByRole('article', { name: '生产成员甲', exact: true })).toBeVisible();
    await members
      .getByRole('navigation', { name: '子任务成员分页', exact: true })
      .getByRole('button', { name: '下一页', exact: true })
      .click();
    await expect(members.getByRole('article', { name: '生产成员21', exact: true })).toBeVisible();
    await members.getByRole('searchbox', { name: '筛选任务成员', exact: true }).fill('生产成员乙');
    await members.getByRole('button', { name: '查询任务成员', exact: true }).click();
    await expect(members.getByRole('article')).toHaveCount(1);
    expect(f.calls('production-tasks/member-list').at(-1)!.body).toMatchObject({
      projectId,
      subtaskId: 1,
      keyword: '生产成员乙',
      current: 1,
      size: 20,
    });
    expect(f.calls('production-tasks/member-list')[0]!.headers.cookie).toContain(
      'nav_production_session=active',
    );
    await members.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await row(page, '空任务池').getByRole('button', { name: '查看任务成员', exact: true }).click();
    await expect(members).toContainText('暂无已指定或认领人员');
    await expect(members.getByRole('checkbox')).toHaveCount(0);
    await members.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    for (const name of ['创建子任务', '查看报量', '提交验收'])
      await expect(panel(page).getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('tab', { name: '项目报量', exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('tab', { name: '人员日生产', exact: true })).toHaveCount(0);
    expect(writes(f)).toHaveLength(0);
    noForbiddenReads(f);
    if (desktop) await screenshot(page, 'production-desktop');
  });

test('返修审核真实支线同样初始直达；任务搜索、状态与分页均由服务端处理', async ({ page }) => {
  const f = await backend(page);
  f.state.tasks[22]!.subtaskName = '第二轮返修待验收';
  f.setRound(23, 2);
  const region = await open(page);
  await region
    .getByRole('navigation', { name: '生产任务分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await expect(row(page, '第二轮返修待验收')).toBeVisible();
  expect(f.calls('production-tasks/list').at(-1)!.body).toMatchObject({ current: 2, size: 20 });
  await region.getByRole('searchbox', { name: '筛选生产任务', exact: true }).fill('第二轮');
  await region.getByRole('checkbox', { name: '验收中', exact: true }).check();
  await region.getByRole('button', { name: '查询任务', exact: true }).click();
  await expect(region.getByRole('article')).toHaveCount(1);
  expect(f.calls('production-tasks/list').at(-1)!.body).toMatchObject({
    keyword: '第二轮',
    statuses: ['PENDING_ACCEPTANCE'],
    current: 1,
  });
  await region.getByRole('button', { name: '重置任务筛选', exact: true }).click();
  await expect(row(page)).toBeVisible();
  noForbiddenReads(f);
});

test('仅需求方而非创建人直访基础详情403，不借项目关系读取生产或审核', async ({ page }) => {
  const f = await backend(page);
  f.state.project.requesterId = user.id;
  f.state.project.creatorUid = 'OTHER_CREATOR';
  await page.goto(`${origin}/#/projects/${projectId}`);
  await expect(page.getByText('当前用户无权查看该项目', { exact: true })).toBeVisible();
  expect(f.calls('production-tasks/list')).toHaveLength(0);
  expect(writes(f)).toHaveLength(0);
});

test('生产读取网络失败和403明确反馈，只重读任务；成员403也不借创建候选代替', async ({ page }) => {
  const f = await backend(page);
  f.state.tasksNetwork = true;
  await page.goto(`${origin}/#/projects/${projectId}`);
  await expect(panel(page)).toContainText('连接服务失败');
  f.state.tasksNetwork = false;
  f.state.tasksStatus = 403;
  await panel(page).getByRole('button', { name: '刷新生产任务', exact: true }).click();
  await expect(panel(page)).toContainText('生产任务读取被拒绝');
  await expect(panel(page).getByRole('button', { name: '审核验收', exact: true })).toHaveCount(0);
  f.state.tasksStatus = 200;
  await panel(page).getByRole('button', { name: '刷新生产任务', exact: true }).click();
  f.state.membersStatus = 403;
  await row(page).getByRole('button', { name: '查看任务成员', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '子任务成员', exact: true })).toContainText(
    '子任务成员读取被拒绝',
  );
  noForbiddenReads(f);
  expect(writes(f)).toHaveLength(0);
});

test('进行中、返修和已验收行不开放审核，真实交付结果与等待说明保留', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  for (const name of ['空任务池', '返修中的任务', '已验收历史任务']) {
    await expect(
      row(page, name).getByRole('button', { name: '审核验收', exact: true }),
    ).toHaveCount(0);
  }
  await expect(row(page, '返修中的任务')).toContainText('上轮驳回原因');
  await expect(row(page, '已验收历史任务')).toContainText('0 条');
  await expect(row(page, '空任务池')).toContainText('待策略官提交验收');
  expect(writes(f)).toHaveLength(0);
});

test('通过验收二次确认；写前无筛选完整翻页找精确任务，body仅ID及决定，主节点和版本不变', async ({
  page,
}) => {
  const f = await backend(page);
  const target = f.state.tasks.shift()!;
  const filler: ProductionTask[] = Array.from({ length: 100 }, (_, i) => ({
    ...f.state.tasks[4]!,
    subtaskId: 100 + i,
    subtaskName: `其他生产任务${i}`,
    subtaskNo: `OTHER-${i}`,
  }));
  f.state.tasks.push(...filler, target);
  await page.goto(`${origin}/#/projects/${projectId}`);
  await panel(page)
    .getByRole('searchbox', { name: '筛选生产任务', exact: true })
    .fill(target.subtaskName);
  await panel(page).getByRole('button', { name: '查询任务', exact: true }).click();
  await inspect(page);
  const before = f.requests.length;
  await dialog(page).getByRole('button', { name: '通过验收', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认通过验收', exact: true });
  await expect(confirmation).toBeVisible();
  expect(writes(f)).toHaveLength(0);
  await confirmation.getByRole('button', { name: '确认通过', exact: true }).click();
  await expect.poll(() => writes(f).length).toBe(1);
  expect(writes(f)[0]!.body).toEqual({ projectId, subtaskId: 1, decision: 'ACCEPT' });
  const writeIndex = f.requests.indexOf(writes(f)[0]!);
  const preflight = f.requests
    .slice(before, writeIndex)
    .filter((item) => item.path.endsWith('/production-tasks/list'));
  expect(preflight.map((item) => item.body)).toEqual([
    { projectId, current: 1, size: 100 },
    { projectId, current: 2, size: 100 },
  ]);
  await expect
    .poll(() => f.state.tasks.find((item) => item.subtaskId === 1)!.status)
    .toBe('ACCEPTED');
  expect(f.state.project).toMatchObject({ currentNodeCode: 'PRODUCTION_TASK', versionNo: 4 });
  await expect.poll(() => f.calls('projects/list').length).toBeGreaterThan(1);
  expect(f.calls('projects/list').at(-1)!.query).toEqual({});
  noForbiddenReads(f);
});

test('驳回原因必填且最多500字；取消二次确认不写，确认后精确保留提交快照', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  const detail = await inspect(page);
  const reason = detail.getByRole('textbox', { name: '驳回原因', exact: true });
  await expect(reason).toHaveAttribute('maxlength', '500');
  await detail.getByRole('button', { name: '驳回验收', exact: true }).click();
  await expect(detail).toContainText('请填写驳回原因。');
  await expect(page.getByRole('dialog', { name: '确认驳回验收', exact: true })).toHaveCount(0);
  expect(writes(f)).toHaveLength(0);
  await reason.fill('  需要补齐返修说明  ');
  await detail.getByRole('button', { name: '驳回验收', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认驳回验收', exact: true })
    .getByRole('button', { name: '返回核对', exact: true })
    .click();
  expect(writes(f)).toHaveLength(0);
  await expect(reason).toHaveValue('  需要补齐返修说明  ');
  await confirm(page, 'REJECT');
  await expect.poll(() => writes(f).length).toBe(1);
  expect(writes(f)[0]!.body).toEqual({
    projectId,
    subtaskId: 1,
    decision: 'REJECT',
    rejectReason: '需要补齐返修说明',
  });
  expect(f.state.tasks[0]).toMatchObject({
    status: 'REWORK_REQUIRED',
    rejectReason: '需要补齐返修说明',
    actualQuantity: 8.125,
    submittedAt: '2026-11-03 12:00:00',
  });
});

test('400明确参数拒绝保留原因可直接编辑重试，不使用新版本或轮次字段', async ({ page }) => {
  const f = await backend(page);
  f.state.writeStatus = 400;
  await open(page);
  await inspect(page);
  await dialog(page).getByRole('textbox', { name: '驳回原因', exact: true }).fill('保留的原始意见');
  await confirm(page, 'REJECT');
  await expect(dialog(page)).toContainText('验收审核被拒绝');
  const reason = dialog(page).getByRole('textbox', { name: '驳回原因', exact: true });
  await expect(reason).toBeEnabled();
  await expect(reason).toHaveValue('保留的原始意见');
  f.state.writeStatus = 200;
  await reason.fill('修改后的意见');
  await confirm(page, 'REJECT');
  await expect.poll(() => writes(f).length).toBe(2);
  expect(writes(f)[1]!.body).toEqual({
    projectId,
    subtaskId: 1,
    decision: 'REJECT',
    rejectReason: '修改后的意见',
  });
});

for (const status of [403, 409])
  test(`${status}明确拒绝需显式重读真实同任务权限，保留原稿后才可再次确认`, async ({ page }) => {
    const f = await backend(page);
    f.state.writeStatus = status;
    await open(page);
    await inspect(page);
    await dialog(page)
      .getByRole('textbox', { name: '驳回原因', exact: true })
      .fill('仍需保留的审核原因');
    await confirm(page, 'REJECT');
    await expect(dialog(page)).toContainText('验收审核被拒绝');
    await expect(
      dialog(page).getByRole('button', { name: '驳回验收', exact: true }),
    ).toBeDisabled();
    f.state.writeStatus = 200;
    await dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }).click();
    await expect(dialog(page).getByRole('textbox', { name: '驳回原因', exact: true })).toHaveValue(
      '仍需保留的审核原因',
    );
    await expect(dialog(page).getByRole('button', { name: '驳回验收', exact: true })).toBeEnabled();
    expect(writes(f)).toHaveLength(1);
    await confirm(page, 'REJECT');
    await expect.poll(() => writes(f).length).toBe(2);
  });

test('写前发现同ID已重新提交则更新快照并拒绝旧轮审核，不因仍待验收而发送', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  await inspect(page);
  f.state.tasks[0]!.submittedAt = '2026-11-04 11:30:00';
  f.state.tasks[0]!.actualQuantity = 7;
  await confirm(page);
  await expect(dialog(page)).toContainText('验收提交信息已变化');
  await expect(dialog(page)).toContainText('2026-11-04 11:30:00');
  expect(writes(f)).toHaveLength(0);
});

test('写前完整任务中精确ID消失，不借同名任务审核，也不凭卡消失宣称成功', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  await inspect(page);
  const target = f.state.tasks.shift()!;
  f.state.tasks[0] = { ...target, subtaskId: 900, subtaskNo: 'OTHER-900' };
  await confirm(page);
  await expect(dialog(page)).toContainText('当前项目列表中已无该子任务');
  expect(writes(f)).toHaveLength(0);
});

test('写前权限变为只读不发送，刷新后也不借其他待验收行恢复本行操作', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  await inspect(page);
  f.state.project.currentNodeCode = 'COMPLETED';
  await confirm(page);
  await expect(dialog(page).getByRole('button', { name: /^(通过验收|驳回验收)$/ })).toHaveCount(0);
  expect(writes(f)).toHaveLength(0);
});

test('网络未知跨关闭、模块和PM角色保留原决定原因；其他角色只读不能复用NAV草稿解锁', async ({
  page,
}) => {
  const f = await backend(page);
  f.state.writeNetwork = true;
  await open(page);
  await inspect(page);
  await dialog(page)
    .getByRole('textbox', { name: '驳回原因', exact: true })
    .fill('NAV独有待核实原因');
  await confirm(page, 'REJECT');
  await expect(dialog(page)).toContainText('上次审核结果尚未确认');
  await dialog(page).getByRole('button', { name: '关闭验收详情', exact: true }).click();
  await tabs(page).getByRole('tab', { name: '招募策略官', exact: true }).click();
  await tabs(page).getByRole('tab', { name: '生产任务', exact: true }).click();
  await inspect(page);
  await expect(dialog(page).getByRole('textbox', { name: '驳回原因', exact: true })).toHaveValue(
    'NAV独有待核实原因',
  );
  await dialog(page).getByRole('button', { name: '关闭验收详情', exact: true }).click();
  await chooseRole(page, '策略官');
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=PRODUCTION_TASK`);
  await expect(row(page)).toBeVisible();
  await expect(
    row(page).getByRole('button', { name: /^(审核验收|提交验收|恢复验收操作)$/ }),
  ).toHaveCount(0);
  await expect(page.getByText('NAV独有待核实原因', { exact: true })).toHaveCount(0);
  expect(f.calls('production-tasks/acceptance/context')).toHaveLength(0);
  await chooseRole(page, '领航员');
  await page.goto(`${origin}/#/projects/${projectId}`);
  await inspect(page);
  await expect(dialog(page).getByRole('textbox', { name: '驳回原因', exact: true })).toHaveValue(
    'NAV独有待核实原因',
  );
  await dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }).click();
  await expect(dialog(page)).toContainText('上次审核结果尚未确认');
  await expect(dialog(page).getByRole('button', { name: '驳回验收', exact: true })).toBeDisabled();
  expect(writes(f)).toHaveLength(1);
  noForbiddenReads(f);
});

test('503可能已驳回，驳回状态及真实返修重交后的PENDING均不证明原次结果或清未知锁', async ({
  page,
}) => {
  const f = await backend(page);
  f.state.writeStatus = 503;
  f.state.commitOnFailure = true;
  await open(page);
  await inspect(page);
  await dialog(page).getByRole('textbox', { name: '驳回原因', exact: true }).fill('原次审核原因');
  await confirm(page, 'REJECT');
  await expect(dialog(page)).toContainText('上次审核结果尚未确认');
  expect(f.state.tasks[0]!.status).toBe('REWORK_REQUIRED');
  await dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }).click();
  await expect(dialog(page)).toContainText('上次审核结果尚未确认');
  Object.assign(f.state.tasks[0]!, {
    status: 'PENDING_ACCEPTANCE',
    submittedAt: '2026-11-04 14:00:00',
    allowedActions: ['ACCEPT', 'REJECT'],
    rejectReason: null,
    reviewedAt: null,
    reviewedByName: null,
  });
  f.setRound(1, 2);
  await dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }).click();
  await expect(dialog(page)).toContainText('上次审核结果尚未确认');
  await expect(dialog(page).getByRole('button', { name: '通过验收', exact: true })).toBeDisabled();
  expect(writes(f)).toHaveLength(1);
});

test('成功后的完整待办回读失败保留成功事实；关闭重开后只读恢复，不重复审核', async ({ page }) => {
  const f = await backend(page);
  f.state.failListAfterWrite = true;
  await open(page);
  await inspect(page);
  await confirm(page);
  await expect(dialog(page)).toContainText('验收审核已提交');
  await expect(dialog(page)).toContainText('只需重新读取');
  await dialog(page).getByRole('button', { name: '关闭验收详情', exact: true }).click();
  await expect(row(page).getByRole('button', { name: '审核验收', exact: true })).toHaveCount(0);
  await row(page).getByRole('button', { name: '恢复验收操作', exact: true }).click();
  await expect(dialog(page)).toContainText('验收审核已提交');
  f.state.listStatus = 200;
  await dialog(page).getByRole('button', { name: '重新读取验收状态', exact: true }).click();
  await expect
    .poll(
      () =>
        f.calls('projects/list').filter((item) => item.query && !Object.keys(item.query).length)
          .length,
    )
    .toBeGreaterThan(1);
  expect(writes(f)).toHaveLength(1);
});

test('成功后完整真实待办撤卡返回列表，不靠旧卡创造后续模块', async ({ page }) => {
  const f = await backend(page);
  f.state.removeAfterWrite = true;
  Object.assign(f.state.tasks[22]!, {
    status: 'IN_PROGRESS',
    allowedActions: [],
    submittedAt: null,
  });
  await open(page);
  await inspect(page);
  await confirm(page);
  await expect(page).toHaveURL(/#\/projects$/);
  expect(writes(f)).toHaveLength(1);
  expect(f.calls('projects/list').at(-1)!.query).toEqual({});
});

test('成功后其他真实返修审核待办仍在则继续生产模块，完成锁不阻碍下一子任务', async ({ page }) => {
  const f = await backend(page);
  f.state.tasks[22]!.subtaskName = '第二轮返修待验收';
  f.setRound(23, 2);
  await open(page);
  await inspect(page);
  await confirm(page);
  await expect(row(page).getByText('验收通过', { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: '通过验收', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '关闭验收详情', exact: true }).click();
  await expect(tabs(page).getByRole('tab', { name: '生产任务', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await panel(page).getByRole('searchbox', { name: '筛选生产任务', exact: true }).fill('第二轮');
  await panel(page).getByRole('button', { name: '查询任务', exact: true }).click();
  await inspect(page, '第二轮返修待验收');
  await expect(dialog(page).getByRole('button', { name: '通过验收', exact: true })).toBeEnabled();
  await confirm(page);
  await expect.poll(() => writes(f).length).toBe(2);
  expect(writes(f)[1]!.body).toEqual({ projectId, subtaskId: 23, decision: 'ACCEPT' });
});

test('发送中确认按钮禁止连点且角色切换不离开原身份，迟到成功只收尾一次', async ({ page }) => {
  const f = await backend(page);
  f.state.holdWrite = true;
  await open(page);
  await inspect(page);
  await confirm(page);
  await expect.poll(() => writes(f).length).toBe(1);
  const confirmation = page.getByRole('dialog', { name: '确认通过验收', exact: true });
  await expect(confirmation.getByRole('button', { name: '确认通过', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event('tyde:before-role-switch', { cancelable: true })),
    ),
  ).toBe(false);
  expect(f.calls('auth/switch-role')).toHaveLength(0);
  f.release();
  await expect(confirmation).toHaveCount(0);
  await expect(row(page).getByText('验收通过', { exact: true })).toBeVisible();
  expect(writes(f)).toHaveLength(1);
});

test('尚未提交的原因草稿关闭需确认，拒绝离开保留当前编辑内容', async ({ page }) => {
  const f = await backend(page);
  await open(page);
  await inspect(page);
  const reason = dialog(page).getByRole('textbox', { name: '驳回原因', exact: true });
  await reason.fill('尚未提交的意见');
  page.once('dialog', (prompt) => prompt.dismiss());
  await dialog(page).getByRole('button', { name: '关闭验收详情', exact: true }).click();
  await expect(reason).toHaveValue('尚未提交的意见');
  expect(writes(f)).toHaveLength(0);
});

test('375px长任务名和原始HTML只作文本，快照与审核表单无横溢出且滚动后可操作', async ({ page }) => {
  const f = await backend(page);
  const longName = `待验收${'长任务名称'.repeat(17)}<img src=x onerror=alert(1)>`;
  f.state.tasks[0]!.subtaskName = longName;
  f.state.tasks[0]!.quantityAdjustmentRemark = '<script>window.__unsafe=true</script>原始说明';
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/#/projects/${projectId}`);
  await expect(row(page, longName)).toBeVisible();
  await inspect(page, longName);
  await expect(dialog(page)).toContainText('<script>window.__unsafe=true</script>原始说明');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(dialog(page).locator('script')).toHaveCount(0);
  await dialog(page)
    .getByRole('textbox', { name: '驳回原因', exact: true })
    .fill('375px可填写的原因');
  const boxes = await page.evaluate(() => {
    const modal = document.querySelector('dialog[open]')!;
    return {
      document: document.documentElement.scrollWidth,
      viewport: innerWidth,
      modal: modal.scrollWidth,
      width: modal.clientWidth,
    };
  });
  expect(boxes.document).toBeLessThanOrEqual(boxes.viewport);
  expect(boxes.modal).toBeLessThanOrEqual(boxes.width + 1);
  await dialog(page)
    .getByRole('button', { name: '驳回验收', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    dialog(page).getByRole('button', { name: '驳回验收', exact: true }),
  ).toBeInViewport();
  await screenshot(page, 'production-375');
  expect(writes(f)).toHaveLength(0);
  noForbiddenReads(f);
});
