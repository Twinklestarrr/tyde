import { test, expect, _electron as electron, type Page, type Locator } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createRealWorkbenchFixture,
  realApiOrigin,
  realPassword,
  type RealAccount,
  type RealProject,
  type RealWorkbenchFixture,
} from '../helpers/workbench-projects-real';

const root = process.cwd();
const require = createRequire(resolve(root, 'apps/electron/package.json'));
async function screenshot(page: Page, mode: string, name: string) {
  const directory = resolve(root, 'artifacts/workbench-projects-real');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${mode.toLowerCase()}-${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

async function requestFrom(
  page: Page,
  path: string,
  method: string,
  action: () => Promise<unknown>,
) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1' + path &&
      response.request().method() === method,
  );
  await action();
  const response = await pending;
  expect(response.status(), `${method} ${path}`).toBe(200);
  expect((await response.json()).code).toBe(200);
  return response;
}

async function login(page: Page, origin: string, user: RealAccount, role: string) {
  await page.goto(origin + '/#/auth');
  await page.getByRole('tab', { name: '密码登录', exact: true }).click();
  await page.getByLabel(/^手机号/).fill(user.phone);
  await page.getByLabel(/^密码\s*\*?\s*$/).fill(realPassword);
  await requestFrom(page, '/auth/login', 'POST', () =>
    page.getByRole('button', { name: '登录', exact: true }).click(),
  );
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toBeVisible();
  if (role !== '执行专家') {
    await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
    await requestFrom(page, '/auth/switch-role', 'POST', () =>
      page.getByRole('option', { name: role, exact: true }).click(),
    );
  }
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(role);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await requestFrom(page, '/auth/logout', 'POST', () =>
    page
      .getByRole('navigation', { name: '账户选项', exact: true })
      .getByRole('button', { name: '退出登录', exact: true })
      .click(),
  );
  await expect(page).toHaveURL(/#\/auth$/);
}

async function archive(page: Page, project: RealProject) {
  await page.getByRole('button', { name: '查看项目详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目详情', exact: true });
  await expect(dialog).toContainText(project.projectName);
  await expect(dialog).toContainText('人员画像');
  await expect(dialog).toContainText('核对真实业务记录');
  await expect(dialog).toContainText('标准配置');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '查看项目详情', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭项目详情', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function recruitManager(
  page: Page,
  panel: Locator,
  account: RealAccount,
  replacement: boolean,
) {
  await panel.getByLabel('搜索策略官', { exact: true }).fill(account.nickname);
  const candidates = await requestFrom(page, '/projects/manager-candidates', 'GET', () =>
    panel.getByRole('button', { name: '查询', exact: true }).click(),
  );
  expect((await candidates.json()).data).toEqual(
    expect.arrayContaining([expect.objectContaining({ userId: account.id })]),
  );
  await panel.getByRole('button', { name: '重置', exact: true }).click();
  await expect(panel.getByLabel('搜索策略官', { exact: true })).toHaveValue('');
  await panel
    .getByRole('radio', { name: `${account.nickname}(${account.realName})`, exact: true })
    .check();
  const open = () =>
    panel
      .getByRole('button', { name: replacement ? '确认更换' : '指定策略官', exact: true })
      .click();
  const dialog = page.getByRole('dialog', {
    name: replacement ? '确认更换策略官' : '确认指定策略官',
    exact: true,
  });
  await open();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await open();
  const result = await requestFrom(page, '/projects/manager-recruitments', 'POST', () =>
    dialog
      .getByRole('button', { name: replacement ? '确认更换' : '确认指定', exact: true })
      .click(),
  );
  expect((await result.json()).data).toMatchObject({
    recruitmentType: replacement ? 'REPLACEMENT' : 'INITIAL',
    currentNodeCode: 'PRODUCTION_PLAN',
    manager: { userId: account.id },
  });
  await expect(panel.getByRole('region', { name: '当前策略官', exact: true })).toContainText(
    account.nickname,
  );
}

async function navigatorFlow(page: Page, origin: string, f: RealWorkbenchFixture, mode: string) {
  await login(page, origin, f.navigator, '领航员');
  const card = page.getByRole('article').filter({ hasText: f.main.projectName });
  await expect(card).toBeVisible();
  await screenshot(page, mode, 'navigator-list');
  const refresh = await requestFrom(page, '/projects/list', 'GET', () =>
    page.getByRole('button', { name: '刷新项目', exact: true }).click(),
  );
  expect((await refresh.json()).data).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: f.main.id })]),
  );
  await page.getByLabel('筛选当前待办', { exact: true }).fill('不存在的真实项目');
  await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
  await page.getByLabel('筛选当前待办', { exact: true }).fill(f.main.projectName);
  await expect(card).toBeVisible();
  await page.getByLabel('筛选当前待办', { exact: true }).fill('');
  await page.getByRole('link', { name: '创建项目', exact: true }).click();
  await expect(page).toHaveURL(/#\/projects\/create$/);
  await page.goto(origin + '/#/');
  await requestFrom(page, `/projects/${f.main.id}`, 'GET', () =>
    card.getByRole('link', { name: '查看项目', exact: true }).click(),
  );
  await expect(page.getByRole('heading', { name: f.main.projectName, exact: true })).toBeVisible();
  await screenshot(page, mode, 'navigator-detail');
  await requestFrom(page, `/projects/${f.main.id}`, 'GET', () =>
    page.getByRole('button', { name: '刷新详情', exact: true }).click(),
  );
  await archive(page, f.main);
  const tabs = page.getByRole('tablist', { name: '领航员项目模块', exact: true });
  for (const name of ['准入考试', '标准与培训', '生产任务']) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true })).toContainText('入口暂未开放');
  }
  await tabs.getByRole('tab', { name: /^招募策略官/ }).click();
  const panel = page.getByRole('region', { name: '招募策略官', exact: true });
  await requestFrom(page, '/projects/manager-candidates', 'GET', () =>
    panel.getByRole('button', { name: '重新读取策略官', exact: true }).click(),
  );
  await recruitManager(page, panel, f.firstManager, false);
  const afterInitial = await f.api<RealProject>(`/projects/${f.main.id}`, f.navigator);
  expect(afterInitial.currentNodeCode).toBe('PRODUCTION_PLAN');
  const pending = await f.api<RealProject[]>('/projects/list', f.navigator);
  expect(pending.some(({ id }) => id === f.main.id)).toBe(false);
  await panel.getByRole('button', { name: '更换策略官', exact: true }).click();
  await panel.getByRole('button', { name: '取消更换', exact: true }).click();
  await expect(panel.getByRole('button', { name: '更换策略官', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '更换策略官', exact: true }).click();
  await recruitManager(page, panel, f.manager, true);
  await screenshot(page, mode, 'navigator-replaced');
  expect((await f.api<RealProject>(`/projects/${f.main.id}`, f.navigator)).currentNodeCode).toBe(
    'PRODUCTION_PLAN',
  );
  const managers = await f.api<{ userId: string; status: string }[]>(
    `/projects/manager-candidates?projectId=${f.main.id}`,
    f.navigator,
  );
  expect(managers.find(({ status }) => status === 'CURRENT')?.userId).toBe(f.manager.id);
  expect(await f.api<RealProject[]>('/projects/manager/list', f.firstManager)).toEqual([]);
  await page.getByRole('link', { name: '返回我的项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我创建的项目', exact: true })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: f.main.projectName })).toHaveCount(0);
}

async function strategistFlow(page: Page, origin: string, f: RealWorkbenchFixture, mode: string) {
  await login(page, origin, f.manager, '策略官');
  const card = page.getByRole('article').filter({ hasText: f.main.projectName });
  await expect(card).toBeVisible();
  await screenshot(page, mode, 'strategist-list');
  const response = await requestFrom(page, '/projects/manager/list', 'GET', () =>
    page.getByRole('button', { name: '刷新项目', exact: true }).click(),
  );
  expect((await response.json()).data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: f.main.id, primaryProjectManager: true }),
    ]),
  );
  await page.getByLabel('筛选当前待办', { exact: true }).fill('不存在的项目');
  await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
  await page.getByLabel('筛选当前待办', { exact: true }).fill(f.main.projectName);
  await requestFrom(page, '/projects/production-plan', 'GET', () =>
    card.getByRole('link', { name: '生产计划', exact: true }).click(),
  );
  await archive(page, f.main);
  await screenshot(page, mode, 'strategist-detail');
  await requestFrom(page, `/projects/${f.main.id}`, 'GET', () =>
    page.getByRole('button', { name: '刷新详情', exact: true }).click(),
  );
  const panel = page.getByRole('region', { name: '生产计划', exact: true });
  await requestFrom(page, '/projects/production-plan', 'GET', () =>
    panel.getByRole('button', { name: '重新读取生产计划', exact: true }).click(),
  );
  await panel.getByRole('spinbutton', { name: '作业人数', exact: true }).fill('4');
  await panel.getByRole('spinbutton', { name: '作业 CPD', exact: true }).fill('10.25');
  await panel.getByRole('checkbox', { name: '需要笔试', exact: true }).uncheck();
  await panel.getByRole('textbox', { name: '人群1名称', exact: true }).fill('熟练组');
  await panel.getByRole('textbox', { name: '人群1画像要求', exact: true }).fill('完成相关培训');
  await panel.getByRole('button', { name: '添加人群', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '人群2名称', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '删除人群2', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '人群2名称', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '添加阶段', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '阶段3名称', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '删除阶段3', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '阶段3名称', exact: true })).toHaveCount(0);
  for (const stage of [1, 2]) {
    await panel.getByLabel(new RegExp(`^阶段${stage}开始日期\\s*\\*$`)).fill('2099-01-05');
    await panel.getByLabel(new RegExp(`^阶段${stage}结束日期\\s*\\*$`)).fill('2099-01-09');
    await panel.getByRole('spinbutton', { name: `阶段${stage}作业人数`, exact: true }).fill('4');
  }
  const submit = panel.getByRole('button', { name: '确认生产计划', exact: true });
  const dialog = page.getByRole('dialog', { name: '确认生产计划', exact: true });
  await submit.click();
  await dialog.getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(panel.getByRole('spinbutton', { name: '作业 CPD', exact: true })).toHaveValue(
    '10.25',
  );
  await submit.click();
  const confirmed = await requestFrom(page, '/projects/production-plan/confirm', 'POST', () =>
    dialog.getByRole('button', { name: '确认提交', exact: true }).click(),
  );
  expect((await confirmed.json()).data).toMatchObject({
    hasPlan: true,
    editable: false,
    operatorHeadcount: 4,
    operatorCpd: 10.25,
    currentNodeCode: 'STANDARD_TRAINING',
    needWrittenExam: false,
    totalExpectedOutput: 410,
  });
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await expect(submit).toHaveCount(0);
  await expect(page.getByText('当前阶段：标准与培训', { exact: true })).toBeVisible();
  await screenshot(page, mode, 'strategist-confirmed');
  const saved = await f.api(`/projects/production-plan?projectId=${f.main.id}`, f.manager);
  expect(saved).toMatchObject({ hasPlan: true, editable: false, totalExpectedOutput: 410 });
  await page.reload();
  await expect(panel.getByRole('spinbutton', { name: '作业 CPD', exact: true })).toHaveValue(
    '10.25',
  );
  await expect(panel.getByRole('spinbutton', { name: '作业 CPD', exact: true })).toBeDisabled();
  const tabs = page.getByRole('tablist', { name: '策略官项目模块', exact: true });
  await tabs.getByRole('tab', { name: '准入考试', exact: true }).click();
  await expect(page.getByRole('region', { name: '准入考试', exact: true })).toContainText(
    '生产计划未配置准入考试',
  );
  for (const name of ['标准与培训', '招募执行专家', '人员管理', '生产任务']) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true })).toContainText('入口暂未开放');
  }
  await tabs.getByRole('tab', { name: '生产计划', exact: true }).click();
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '返回我的项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
}

async function expertDetails(page: Page, project: RealProject) {
  const card = page.getByRole('article').filter({ hasText: project.projectName });
  const read = await requestFrom(page, '/expert-assignments/detail', 'GET', () =>
    card.getByRole('button', { name: '查看项目', exact: true }).click(),
  );
  expect((await read.json()).data.projectDetail).toMatchObject({ id: project.id });
  const dialog = page.getByRole('dialog', { name: '项目详情', exact: true });
  await expect(dialog).toContainText(project.projectName);
  await expect(dialog).toContainText('标准配置');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
}

async function expertDecision(page: Page, project: RealProject, reject: boolean) {
  const card = page.getByRole('article').filter({ hasText: project.projectName });
  await card.getByRole('button', { name: reject ? '拒绝' : '接单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: reject ? '拒绝项目' : '确认接单', exact: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await card.getByRole('button', { name: reject ? '拒绝' : '接单', exact: true }).click();
  if (reject)
    await dialog.getByLabel('拒绝原因', { exact: true }).fill('本轮真实联调验证拒绝与回读');
  const response = await requestFrom(page, '/expert-assignments/respond', 'POST', () =>
    dialog.getByRole('button', { name: reject ? '确认拒绝' : '确认接单', exact: true }).click(),
  );
  expect((await response.json()).data.status).toBe(reject ? 'REJECTED' : 'ACCEPTED');
}

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron', true],
] as const) {
  test(`${mode} 真实非空三角色列表、详情、招募更换、计划确认及专家接拒单`, async ({
    page: webPage,
  }, testInfo) => {
    test.setTimeout(300_000);
    const f = await createRealWorkbenchFixture(mode);
    const origin = `http://127.0.0.1:${desktop ? 5178 : 5175}`;
    let page = webPage;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    let profile: string | undefined;
    const errors: string[] = [];
    const apiResponses: { method: string; path: string; status: number }[] = [];
    try {
      if (desktop) {
        await mkdir('.local/e2e', { recursive: true });
        profile = await mkdtemp(resolve(root, '.local/e2e/workbench-'));
        const env = {
          ...process.env,
          TYDE_WEB_URL: origin + '/',
          TYDE_API_BASE_URL: realApiOrigin,
          TYDE_TEST_USER_DATA: profile,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({
          executablePath: require('electron') as string,
          args: [resolve(root, 'apps/electron/out/main/index.js')],
          env,
        });
        page = await app.firstWindow();
        expect(await page.evaluate(() => window.tydeDesktop!.getRuntimeConfig())).toEqual({
          ok: true,
          data: { apiBaseUrl: realApiOrigin },
        });
      }
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/v1/'))
          apiResponses.push({
            method: response.request().method(),
            path,
            status: response.status(),
          });
      });
      await test.step('领航员非空列表、资料弹窗、真实招募和更换策略官', async () => {
        await navigatorFlow(page, origin, f, mode);
        await page.screenshot({ path: testInfo.outputPath('navigator.png'), fullPage: true });
        await logout(page);
      });
      await test.step('策略官非空列表、编辑确认生产计划并验证只读与阶段', async () => {
        await strategistFlow(page, origin, f, mode);
        await page.screenshot({ path: testInfo.outputPath('strategist.png'), fullPage: true });
        await logout(page);
      });
      await test.step('执行专家非空普通来源、真实详情、个人接单与拒绝', async () => {
        const projects = await f.prepareExpertProjects();
        await login(page, origin, f.expert, '执行专家');
        await expect(page.getByRole('article')).toHaveCount(2);
        await screenshot(page, mode, 'expert-list');
        const cards = await requestFrom(page, '/expert-assignments/my-tasks', 'POST', () =>
          page.getByRole('button', { name: '刷新项目', exact: true }).click(),
        );
        expect((await cards.json()).data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              basicInfo: expect.objectContaining({ projectId: projects.accepted.id }),
            }),
            expect.objectContaining({
              basicInfo: expect.objectContaining({ projectId: projects.rejected.id }),
            }),
          ]),
        );
        await page.getByLabel('筛选当前待办', { exact: true }).fill('不存在的真实项目');
        const empty = await requestFrom(page, '/expert-assignments/my-tasks', 'POST', () =>
          page.getByRole('button', { name: '查询项目', exact: true }).click(),
        );
        expect((await empty.json()).data).toEqual([]);
        await page.getByLabel('筛选当前待办', { exact: true }).fill('');
        await page.getByRole('button', { name: '查询项目', exact: true }).click();
        await expect(page.getByRole('article')).toHaveCount(2);
        await requestFrom(page, '/expert-assignments/my-tasks', 'POST', () =>
          page.getByRole('button', { name: '刷新项目', exact: true }).click(),
        );
        await expertDetails(page, projects.accepted);
        await expertDetails(page, projects.rejected);
        const before = await f.tasks(f.expert);
        const accepted = before.find(
          ({ basicInfo }) => basicInfo.projectId === projects.accepted.id,
        )!;
        const rejected = before.find(
          ({ basicInfo }) => basicInfo.projectId === projects.rejected.id,
        )!;
        expect(accepted.operations).toMatchObject({ canAccept: true, canReject: true });
        await expertDecision(page, projects.accepted, false);
        await expertDecision(page, projects.rejected, true);
        const acceptedRead = await f.api<{ assignmentId: number }>(
          `/expert-assignments/detail?assignmentId=${accepted.assignmentId}`,
          f.expert,
        );
        expect(acceptedRead.assignmentId).toBe(accepted.assignmentId);
        const rejectedRead = await f.api<{ assignmentId: number }>(
          `/expert-assignments/detail?assignmentId=${rejected.assignmentId}`,
          f.expert,
        );
        expect(rejectedRead.assignmentId).toBe(rejected.assignmentId);
        const acceptedRecruitment = await f.api(
          `/projects/expert-recruitments/detail?projectId=${projects.accepted.id}`,
          f.manager,
        );
        expect(acceptedRecruitment).toMatchObject({
          summary: { acceptedCount: 1, rejectedCount: 0 },
        });
        const rejectedRecruitment = await f.api(
          `/projects/expert-recruitments/detail?projectId=${projects.rejected.id}`,
          f.manager,
        );
        expect(rejectedRecruitment).toMatchObject({
          summary: { acceptedCount: 0, rejectedCount: 1 },
        });
        const myProjects = await f.api<{ projectId: number }[]>(
          '/expert-assignments/my-projects',
          f.expert,
        );
        expect(myProjects.some(({ projectId }) => projectId === projects.accepted.id)).toBe(true);
        expect(myProjects.some(({ projectId }) => projectId === projects.rejected.id)).toBe(false);
        await page.screenshot({ path: testInfo.outputPath('expert.png'), fullPage: true });
        await logout(page);
      });
      await test.step('组织主管真实选择负责人接单、组织普通成员真实接单', async () => {
        const { organizationProject } = await f.prepareOrganizationProject();
        await login(page, origin, f.firstManager, '执行专家');
        const card = page.getByRole('article').filter({ hasText: organizationProject.projectName });
        await expect(card).toContainText('组织主管');
        await expertDetails(page, organizationProject);
        const candidates = await requestFrom(
          page,
          '/expert-assignments/project-owner-candidates',
          'GET',
          () => card.getByRole('button', { name: '接单', exact: true }).click(),
        );
        expect((await candidates.json()).data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ userId: f.firstManager.id }),
            expect.objectContaining({ userId: f.expert.id }),
          ]),
        );
        const dialog = page.getByRole('dialog', { name: '确认接单', exact: true });
        await dialog.getByRole('checkbox', { name: new RegExp(f.firstManager.realName) }).check();
        const accepted = await requestFrom(page, '/expert-assignments/respond', 'POST', () =>
          dialog.getByRole('button', { name: '确认接单', exact: true }).click(),
        );
        expect((await accepted.json()).data).toMatchObject({
          status: 'ACCEPTED',
          notifiedMemberCount: 2,
        });
        await logout(page);
        await login(page, origin, f.expert, '执行专家');
        const memberCards = await f.tasks(f.expert);
        const memberCard = memberCards.find(
          ({ basicInfo }) => basicInfo.projectId === organizationProject.id,
        )!;
        expect(memberCard).toMatchObject({
          acceptanceStatus: 'PENDING_ACCEPTANCE',
          operations: { canAccept: true },
        });
        await expertDetails(page, organizationProject);
        const member = page
          .getByRole('article')
          .filter({ hasText: organizationProject.projectName });
        await member.getByRole('button', { name: '接单', exact: true }).click();
        const result = await requestFrom(page, '/expert-assignments/respond', 'POST', () =>
          page
            .getByRole('dialog', { name: '确认接单', exact: true })
            .getByRole('button', { name: '确认接单', exact: true })
            .click(),
        );
        expect((await result.json()).data).toMatchObject({
          status: 'ACCEPTED',
          memberStatus: 'ACCEPTED',
        });
        const after = await f.api<{ assignmentId: number; projectId: number }[]>(
          '/expert-assignments/my-projects',
          f.expert,
        );
        expect(after).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              assignmentId: memberCard.assignmentId,
              projectId: organizationProject.id,
            }),
          ]),
        );
        await logout(page);
      });
      expect(errors).toEqual([]);
      expect(
        apiResponses.filter(
          ({ path, status }) => status >= 400 && !(path === '/api/v1/users/me' && status === 401),
        ),
      ).toEqual([]);
    } finally {
      await testInfo.attach('real-http-evidence', {
        body: JSON.stringify({ mode, run: f.run, project: f.main, errors, apiResponses }, null, 2),
        contentType: 'application/json',
      });
      if (app) await app.close();
      if (profile) await rm(profile, { recursive: true, force: true });
      await f.close();
    }
  });
}
