import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type {
  AuthUser,
  NavigatorProjectCard,
  ProjectManagerCandidate,
  ProjectManagerRecruitmentInput,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'MANAGER10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '招募联调员',
  realName: '测试创建人',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'NAVIGATOR',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'NAVIGATOR',
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: '2026-10-26T02:00:00.000Z',
  updatedAt: '2026-10-26T02:00:00.000Z',
};
const detail: WorkbenchProjectDetail = {
  id: 601,
  projectNo: 'MANAGER-PROJECT-601',
  requesterType: 'INDIVIDUAL',
  requesterId: user.id,
  requesterName: user.realName,
  projectName: '策略官招募项目',
  projectDescription: '隔离接口验证项目',
  categoryLevel1Id: null,
  categoryLevel2Id: null,
  categoryLevel1Name: null,
  categoryLevel2Name: null,
  categoryLevel3Ids: [],
  categoryLevel3Names: [],
  difficultyLevel: null,
  projectQuantity: 120,
  quantityUnit: '条',
  deadline: '2099-12-31 18:00:00',
  requiredHeadcount: 3,
  educationRequirement: null,
  employmentType: null,
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  mandatoryRequirement: null,
  standardContent: '逐条按标准完成',
  standardLink: null,
  status: 'PUBLISHED',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  versionNo: 1,
  creatorUid: user.uid,
  creatorName: user.realName,
  createdAt: '2026-10-26 10:00:00',
  updatedAt: '2026-10-26 10:00:00',
  attachments: [],
};
const candidates: ProjectManagerCandidate[] = [
  {
    status: 'RECOMMENDED',
    userId: uuid(2),
    uid: 'MANAGER10002',
    name: '策略官甲',
    avatarUrl: null,
    currentProjectCount: 0,
  },
  {
    status: 'RECOMMENDED',
    userId: uuid(3),
    uid: 'MANAGER10003',
    name: '策略官乙',
    avatarUrl: null,
    currentProjectCount: 2,
  },
];
interface RequestLog {
  path: string;
  query: Record<string, string>;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** 完整隔离会话、项目、候选及指派；不访问真实项目和业务数据库。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'manager_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const state = {
    user: structuredClone(user),
    current: null as ProjectManagerCandidate | null,
    node: 'RECRUIT_PROJECT_MANAGER',
    candidateStatus: 200,
    detailStatus: 200,
    writeStatus: 200,
    networkFailure: false,
    failReadAfterWrite: false,
    holdWrite: false,
  };
  const requests: RequestLog[] = [];
  let releaseWrite: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = await request.allHeaders();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({
      path,
      query: Object.fromEntries(url.searchParams),
      method: request.method(),
      body,
      headers,
    });
    const reply = (data: unknown, status = 200, message = '成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/projects/draft/current') return reply({ hasDraft: false, draft: null });
    if (path === '/api/v1/projects/list') {
      const card: NavigatorProjectCard = {
        id: detail.id,
        projectNo: detail.projectNo,
        projectName: detail.projectName,
        projectDescription: detail.projectDescription,
        categoryLevel1Name: null,
        categoryLevel2Name: null,
        categoryLevel3Names: [],
        categoryDisplayName: '未分类',
        status: 'PUBLISHED',
        statusDescription: '已发布',
        currentNodeCode: state.node,
        branchNodeCode: null,
        workbenchStatus: 'PENDING',
        workbenchStatusDescription: '待处理',
        currentAction: 'RECRUIT_PROJECT_MANAGER',
        currentActionDescription: '招募策略官',
        needAssistGrading: false,
        requesterName: user.realName,
        creatorId: user.id,
        creatorName: user.realName,
        projectManagerId: state.current?.userId ?? null,
        projectManagerName: state.current?.name ?? null,
        projectManagerStatusDescription: state.current ? '已指定' : '待招募',
        projectOwners: [],
        activeExpertCount: 0,
        requiredHeadcount: 3,
        deadline: detail.deadline,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      };
      return reply([card]);
    }
    if (path === `/api/v1/projects/${detail.id}`)
      return reply(
        state.detailStatus === 200 ? { ...detail, currentNodeCode: state.node } : null,
        state.detailStatus,
        '项目详情暂时不可用',
      );
    if (path === '/api/v1/projects/manager-candidates') {
      if (state.candidateStatus !== 200)
        return reply(
          null,
          state.candidateStatus,
          state.candidateStatus === 403 ? '只能招募本人项目的策略官' : '候选读取暂时不可用',
        );
      const all = [
        ...(state.current ? [{ ...state.current, status: 'CURRENT' as const }] : []),
        ...candidates.filter((candidate) => candidate.userId !== state.current?.userId),
      ];
      const keyword = url.searchParams.get('keyword')?.trim();
      return reply(keyword ? all.filter((candidate) => candidate.name.includes(keyword)) : all);
    }
    if (path === '/api/v1/projects/manager-recruitments') {
      if (state.networkFailure) return route.abort('failed');
      if (state.writeStatus !== 200)
        return reply(
          null,
          state.writeStatus,
          state.writeStatus === 409 ? '策略官任职已变化' : '策略官指派暂时不可用',
        );
      const input = body as ProjectManagerRecruitmentInput;
      const save = async () => {
        const previous = state.current;
        const chosen = candidates.find((candidate) => candidate.userId === input.candidateUserId);
        if (!chosen) return reply(null, 400, '候选已失效');
        state.current = {
          ...chosen,
          status: 'CURRENT',
          currentProjectCount: chosen.currentProjectCount + 1,
        };
        if (!previous) state.node = 'PRODUCTION_PLAN';
        if (state.failReadAfterWrite) {
          state.candidateStatus = 503;
          state.detailStatus = 503;
        }
        await reply({
          recruitmentId: requests.filter((item) => item.path === path).length,
          projectId: detail.id,
          recruitmentType: previous ? 'REPLACEMENT' : 'INITIAL',
          assignmentMode: 'DIRECT',
          status: 'ASSIGNED',
          manager: state.current,
          currentNodeCode: state.node,
          nextStage: state.node,
          primaryAction: 'CHANGE_PROJECT_MANAGER',
          assignedAt: '2026-10-26 11:00:00',
        });
      };
      if (!state.holdWrite) return save();
      return new Promise<void>((resolve, reject) => {
        releaseWrite = async () => {
          try {
            await save();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    return reply(null, 404, '测试未约定此接口');
  });
  const calls = (path: string) =>
    requests.filter((request) => request.path === `/api/v1/projects/${path}`);
  return {
    state,
    requests,
    calls,
    releaseWrite: async () => {
      if (!releaseWrite) throw new Error('没有等待中的指派');
      await releaseWrite();
    },
  };
}

async function openProject(page: Page) {
  await page.goto(`${origin}/#/projects/${detail.id}`);
  await expect(page.getByRole('heading', { name: '招募策略官', exact: true })).toBeVisible();
  return page.getByRole('region', { name: '招募策略官', exact: true });
}
async function confirm(page: Page, replacement = false) {
  const dialog = page.getByRole('dialog', {
    name: replacement ? '确认更换策略官' : '确认指定策略官',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: replacement ? '确认更换' : '确认指定', exact: true })
    .click();
  return dialog;
}
async function screenshot(page: Page, name: string, directory = 'artifacts/project-manager-audit') {
  await mkdir(directory, { recursive: true });
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: `${directory}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron 运行配置', true],
] as const) {
  test(`${mode} 首次招募单写、服务端搜索保留当前摘要、更换可取消且保留项目节点`, async ({
    page,
  }) => {
    const { state, requests, calls, releaseWrite } = await backend(page, desktop);
    await page.goto(`${origin}/#/`);
    await page.getByRole('link', { name: '招募策略官', exact: true }).click();
    const section = page.getByRole('region', { name: '招募策略官', exact: true });
    await expect(section.getByText('尚未指定策略官', { exact: true })).toBeVisible();
    const workflow = page.getByRole('region', { name: '项目主流程', exact: true });
    const tabs = workflow.getByRole('tablist', { name: '领航员项目模块', exact: true });
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    await expect(
      tabs.getByRole('tab', { name: /^(生产计划|招募执行专家|人员管理|结项)$/ }),
    ).toHaveCount(0);
    const beforeTabs = requests.length;
    for (const name of ['准入考试', '标准与培训', '生产任务']) {
      await tabs.getByRole('tab', { name, exact: true }).click();
      await expect(page.getByRole('tabpanel', { name, exact: true })).toContainText('入口暂未开放');
      await expect(section).toHaveCount(0);
    }
    expect(requests).toHaveLength(beforeTabs);
    expect(calls('manager-recruitments')).toHaveLength(0);
    await tabs.getByRole('tab', { name: '招募策略官', exact: true }).click();
    await expect(section.getByRole('radio', { name: /策略官甲/ })).toBeEnabled();
    if (!desktop) await screenshot(page, 'manager-first', 'artifacts/project-dialog-audit');
    await section.getByRole('radio', { name: /策略官甲/ }).check();
    state.holdWrite = true;
    await section.getByRole('button', { name: '指定策略官', exact: true }).click();
    expect(calls('manager-recruitments')).toHaveLength(0);
    const dialog = await confirm(page);
    await expect.poll(() => calls('manager-recruitments').length).toBe(1);
    await expect(dialog.getByRole('button', { name: '确认指定', exact: true })).toBeDisabled();
    expect(calls('manager-recruitments')[0]?.body).toEqual({
      projectId: detail.id,
      candidateUserId: uuid(2),
    });
    await releaseWrite();
    state.holdWrite = false;
    const current = section.getByRole('region', { name: '当前策略官', exact: true });
    await expect(current).toContainText('策略官甲');
    await expect(workflow.getByText('当前阶段：生产计划', { exact: true })).toBeVisible();
    await expect(tabs.locator('[aria-current="step"]')).toHaveCount(0);
    await expect(tabs.getByRole('tab', { name: '招募策略官', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await section.getByRole('button', { name: '更换策略官', exact: true }).click();
    await expect(section.getByRole('radio', { name: /策略官甲/ })).toBeDisabled();
    await section.getByLabel('搜索策略官', { exact: true }).fill('策略官乙');
    const beforeSearch = calls('manager-candidates').length;
    await section.getByRole('button', { name: '查询', exact: true }).click();
    await expect.poll(() => calls('manager-candidates').length).toBeGreaterThan(beforeSearch);
    await expect(section.getByRole('radio', { name: /策略官乙/ })).toBeVisible();
    expect(calls('manager-candidates').at(-1)?.query).toEqual({
      projectId: String(detail.id),
      keyword: '策略官乙',
    });
    await expect(current).toContainText('策略官甲');
    await section.getByRole('radio', { name: /策略官乙/ }).check();
    await section.getByRole('button', { name: '确认更换', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认更换策略官', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    expect(calls('manager-recruitments')).toHaveLength(1);
    await section.getByRole('button', { name: '取消更换', exact: true }).click();
    await expect(current).toContainText('策略官甲');
    await section.getByRole('button', { name: '更换策略官', exact: true }).click();
    await section.getByRole('button', { name: '重置', exact: true }).click();
    await section.getByRole('radio', { name: /策略官乙/ }).check();
    state.node = 'ENTRANCE_EXAM';
    const beforeDetails = requests.length;
    const detailsButton = page.getByRole('button', { name: '查看项目详情', exact: true });
    await detailsButton.click();
    await page
      .getByRole('dialog', { name: '项目详情', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(detailsButton).toBeFocused();
    await expect(section.getByRole('radio', { name: /策略官乙/ })).toBeChecked();
    expect(requests).toHaveLength(beforeDetails);
    expect(calls('manager-recruitments')).toHaveLength(1);
    if (!desktop) await screenshot(page, 'replacement-selected', 'artifacts/project-dialog-audit');
    await section.getByRole('button', { name: '确认更换', exact: true }).click();
    await confirm(page, true);
    await expect(current).toContainText('策略官乙');
    expect(calls('manager-recruitments')).toHaveLength(2);
    expect(state.node).toBe('ENTRANCE_EXAM');
    await expect(workflow.getByText('当前阶段：准入考试', { exact: true })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: '准入考试', exact: true })).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(tabs.getByRole('tab', { name: '招募策略官', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(calls('manager-recruitments')[1]?.body).toEqual({
      projectId: detail.id,
      candidateUserId: uuid(3),
    });
    expect(
      calls('manager-recruitments').every(
        (call) =>
          call.headers.cookie?.includes('manager_session=active') &&
          !call.headers.authorization &&
          !call.headers['idempotency-key'],
      ),
    ).toBe(true);
  });
}

test('指派409与网络未知结果锁写，显式回读后才可继续', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.writeStatus = 409;
  const section = await openProject(page);
  await section.getByRole('radio', { name: /策略官甲/ }).check();
  await section.getByRole('button', { name: '指定策略官', exact: true }).click();
  await confirm(page);
  await expect(section.getByText('策略官任职已变化', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: '指定策略官', exact: true })).toBeDisabled();
  expect(calls('manager-recruitments')).toHaveLength(1);
  state.current = { ...candidates[1]!, status: 'CURRENT' };
  state.node = 'ENTRANCE_EXAM';
  state.writeStatus = 200;
  await section.getByRole('button', { name: '重新读取策略官', exact: true }).click();
  await expect(section.getByRole('region', { name: '当前策略官', exact: true })).toContainText(
    '策略官乙',
  );
  await section.getByRole('button', { name: '更换策略官', exact: true }).click();
  await section.getByRole('radio', { name: /策略官甲/ }).check();
  state.networkFailure = true;
  await section.getByRole('button', { name: '确认更换', exact: true }).click();
  await confirm(page, true);
  await expect(section.getByRole('button', { name: '重新读取策略官', exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: '确认更换', exact: true })).toBeDisabled();
  expect(calls('manager-recruitments')).toHaveLength(2);
  await expect(section.getByRole('region', { name: '当前策略官', exact: true })).toContainText(
    '策略官乙',
  );
});

test('指派成功后候选和详情回读失败，只重读且不重放成功指派', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.failReadAfterWrite = true;
  const section = await openProject(page);
  await section.getByRole('radio', { name: /策略官甲/ }).check();
  await section.getByRole('button', { name: '指定策略官', exact: true }).click();
  await confirm(page);
  await expect(section.getByRole('region', { name: '当前策略官', exact: true })).toContainText(
    '策略官甲',
  );
  await expect(section.getByRole('button', { name: '重新读取策略官', exact: true })).toBeVisible();
  await expect(section.getByText('候选读取暂时不可用', { exact: true })).toBeVisible();
  expect(calls('manager-recruitments')).toHaveLength(1);
  state.candidateStatus = 200;
  state.detailStatus = 200;
  state.failReadAfterWrite = false;
  await section.getByRole('button', { name: '重新读取策略官', exact: true }).click();
  await expect(section.getByRole('button', { name: '更换策略官', exact: true })).toBeEnabled();
  expect(calls('manager-recruitments')).toHaveLength(1);
  if (await page.getByText('项目详情暂时不可用', { exact: true }).count())
    await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  const workflow = page.getByRole('region', { name: '项目主流程', exact: true });
  await expect(workflow.getByText('当前阶段：生产计划', { exact: true })).toBeVisible();
  await expect(workflow.locator('[aria-current="step"]')).toHaveCount(0);
});

test('候选403隐藏选择与指派操作，非领航员直访不读取招募接口', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.candidateStatus = 403;
  const section = await openProject(page);
  await expect(section.getByText('只能招募本人项目的策略官', { exact: true })).toBeVisible();
  await expect(section.getByRole('radio')).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: /^(指定策略官|更换策略官|确认更换)$/ }),
  ).toHaveCount(0);
  expect(calls('manager-recruitments')).toHaveLength(0);
  state.user.role = 'PM';
  state.user.selectedRole = 'PM';
  const before = calls('manager-candidates').length;
  await page.reload();
  await expect(page).toHaveURL(/#\/$/);
  expect(calls('manager-candidates')).toHaveLength(before);
  expect(calls('manager-recruitments')).toHaveLength(0);
});
