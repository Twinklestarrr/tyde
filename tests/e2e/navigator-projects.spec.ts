import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type {
  AuthUser,
  NavigatorProjectCard,
  ProjectDraft,
  ProjectSaveInput,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const userId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-26 10:00:00';
const objectKey = `project-attachment/2026/10/26/${'a'.repeat(32)}.txt`;
test.use({ timezoneId: 'America/Los_Angeles' });
const user: AuthUser = {
  id: userId,
  uid: 'NAVIGATOR10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '项目联调员',
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
  id: 501,
  projectNo: 'PROJECT-501',
  requesterType: 'INDIVIDUAL',
  requesterId: userId,
  requesterName: '测试创建人',
  projectName: '待办项目甲',
  projectDescription: '来自当前待办读取接口的项目。',
  categoryLevel1Id: 1,
  categoryLevel1Name: '数据处理',
  categoryLevel2Id: 2,
  categoryLevel2Name: '文本标注',
  categoryLevel3Ids: [3],
  categoryLevel3Names: ['内容分类'],
  difficultyLevel: 'MEDIUM',
  projectQuantity: 120.5,
  quantityUnit: '条',
  deadline: '2099-12-31 18:20:30',
  requiredHeadcount: 3,
  educationRequirement: 'BACHELOR',
  employmentType: 'PART_TIME',
  experienceRequirement: '熟悉文本分类',
  workSummary: '为材料建立分类',
  specialRequirement: '按上海时间协作',
  mandatoryRequirement: '完成标准学习',
  standardContent: '逐条核对标准后完成分类。',
  standardLink: 'https://example.com/project-standard',
  status: 'PUBLISHED',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  versionNo: 7,
  creatorUid: user.uid,
  creatorName: '测试创建人',
  createdAt: timestamp,
  updatedAt: timestamp,
  attachments: [
    {
      id: 81,
      attachmentType: 'STANDARD_REFERENCE',
      fileName: '作业标准.txt',
      objectKey,
      extension: 'txt',
      contentType: 'text/plain',
      fileSize: 8,
      fileHash: 'b'.repeat(64),
      sortNo: 0,
      status: 'ACTIVE',
    },
  ],
};
const card: NavigatorProjectCard = {
  id: detail.id,
  projectNo: detail.projectNo,
  projectName: detail.projectName,
  projectDescription: detail.projectDescription,
  categoryLevel1Name: detail.categoryLevel1Name,
  categoryLevel2Name: detail.categoryLevel2Name,
  categoryLevel3Names: detail.categoryLevel3Names,
  categoryDisplayName: '数据处理 / 文本标注 / 内容分类',
  status: 'PUBLISHED',
  statusDescription: '已发布',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  branchNodeCode: null,
  workbenchStatus: 'PENDING',
  workbenchStatusDescription: '待处理',
  currentAction: 'RECRUIT_PROJECT_MANAGER',
  currentActionDescription: '招募策略官',
  needAssistGrading: false,
  requesterName: detail.requesterName,
  creatorId: userId,
  creatorName: '测试创建人',
  projectManagerId: null,
  projectManagerName: null,
  projectManagerStatusDescription: '待招募',
  projectOwners: [],
  activeExpertCount: 0,
  requiredHeadcount: detail.requiredHeadcount,
  deadline: detail.deadline,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const draftFixture = (): ProjectDraft => ({
  ...structuredClone(detail),
  projectName: '待完善草稿',
  status: 'DRAFT',
  creatorName: null,
  currentNodeCode: null,
});
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

/** 所有写操作均由页面拦截，禁止测试访问真实项目或文件服务。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'navigator_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const state = {
    signedIn: true,
    user: structuredClone(user),
    projects: [structuredClone(card)],
    draft: null as ProjectDraft | null,
    listStatus: 200,
    draftStatus: 200,
    detailStatus: 200,
    saveStatus: 200,
    saveNetworkFailure: false,
    switchStatus: 200,
    failReadAfterSave: false,
    holdSave: false,
  };
  const requests: RequestLog[] = [];
  let releaseSave: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const headers = await request.allHeaders();
    const body = headers['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : request.postData();
    requests.push({
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
    });
    const reply = (data: unknown, status = 200, message = '成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!state.signedIn) return reply(null, 401, '请先登录');
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/auth/switch-role') {
      if (state.switchStatus !== 200) return reply(null, state.switchStatus, '角色切换暂不可用');
      const role = (body as { role: AuthUser['role'] }).role;
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (path === '/api/v1/projects/list')
      return reply(
        state.listStatus === 200 ? state.projects : null,
        state.listStatus,
        '待办读取暂不可用',
      );
    if (path === '/api/v1/projects/draft/current')
      return reply(
        state.draftStatus === 200 ? { hasDraft: state.draft !== null, draft: state.draft } : null,
        state.draftStatus,
        '草稿读取暂不可用',
      );
    if (path === '/api/v1/project-categories')
      return reply(
        [
          { id: 1, categoryCode: 'DATA', categoryName: '数据处理', categoryLevel: 1, sortNo: 0 },
          { id: 2, categoryCode: 'TEXT', categoryName: '文本标注', categoryLevel: 2, sortNo: 0 },
          { id: 3, categoryCode: 'CLASS', categoryName: '内容分类', categoryLevel: 3, sortNo: 0 },
        ].filter(
          (category) =>
            !url.searchParams.has('categoryLevel') ||
            String(category.categoryLevel) === url.searchParams.get('categoryLevel'),
        ),
      );
    if (path === `/api/v1/project-requesters/INDIVIDUAL/${userId}/backfill`)
      return reply({
        requesterType: 'INDIVIDUAL',
        requesterId: userId,
        requesterName: '测试创建人',
        orgId: null,
        orgVerifyStatus: null,
      });
    if (path === '/api/v1/projects/create') {
      if (state.saveNetworkFailure) return route.abort('failed');
      if (state.saveStatus !== 200)
        return reply(
          null,
          state.saveStatus,
          state.saveStatus === 409 ? '项目草稿版本冲突' : '项目提交暂不可用',
        );
      const input = body as ProjectSaveInput;
      const save = async () => {
        const versionNo = (state.draft?.versionNo ?? 0) + 1;
        if (input.operation === 'SAVE_DRAFT') {
          state.draft = {
            ...draftFixture(),
            ...input,
            requesterType: 'INDIVIDUAL',
            requesterId: input.requesterId ?? userId,
            attachments: detail.attachments.filter((file) =>
              input.attachments?.some((item) => item.id === file.id),
            ),
            versionNo,
          } as ProjectDraft;
          if (state.failReadAfterSave) state.draftStatus = 503;
        } else state.draft = null;
        await reply({
          id: detail.id,
          projectNo: detail.projectNo,
          operation: input.operation,
          status: input.operation === 'CREATE_PROJECT' ? 'PUBLISHED' : 'DRAFT',
          currentNodeCode: input.operation === 'CREATE_PROJECT' ? 'RECRUIT_PROJECT_MANAGER' : null,
          versionNo,
          updatedAt: timestamp,
          publishedAt: input.operation === 'CREATE_PROJECT' ? timestamp : null,
        });
      };
      if (!state.holdSave) return save();
      return new Promise<void>((resolve, reject) => {
        releaseSave = async () => {
          try {
            await save();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    if (path === `/api/v1/projects/${detail.id}`)
      return reply(
        state.detailStatus === 200 ? detail : null,
        state.detailStatus,
        '项目详情无访问权限',
      );
    if (path === '/api/v1/files/upload')
      return reply({
        fileId: '00000000-0000-4000-8000-000000000081',
        objectKey,
        uploadToken: 'u'.repeat(43),
        url: null,
        sensitive: true,
        fileName: '作业标准.txt',
        extension: 'txt',
        size: 8,
        contentType: 'text/plain',
        fileHash: 'b'.repeat(64),
      });
    if (path === '/api/v1/files/view')
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'standard',
      });
    return reply(null, 404, '测试未约定此接口');
  });
  const calls = (path: string) => requests.filter((request) => request.path === `/api/v1/${path}`);
  return {
    state,
    requests,
    calls,
    releaseSave: async () => {
      if (!releaseSave) throw new Error('没有等待中的项目写入');
      await releaseSave();
    },
  };
}

async function chooseRole(page: Page, role: '领航员' | '策略官' | '执行专家') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: role, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(role);
}

async function screenshot(page: Page, name: string) {
  const directory = 'artifacts/navigator-projects-audit';
  await mkdir(directory, { recursive: true });
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
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
  test(`${mode} 领航员真实待办与草稿入口、筛选、角色隔离及敏感附件代理`, async ({ page }) => {
    const { state, calls } = await backend(page, desktop);
    state.draft = draftFixture();
    await page.goto(`${origin}/#/`);
    await expect(page.getByRole('heading', { name: '我创建的项目', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '待办项目甲', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '继续完善', exact: true })).toBeVisible();
    if (!desktop) await screenshot(page, 'workbench');
    await page.getByLabel('筛选当前待办', { exact: true }).fill('没有该项目');
    await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
    await page.getByLabel('筛选当前待办', { exact: true }).fill('PROJECT-501');
    await page.getByRole('link', { name: '查看项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '待办项目甲', exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: '项目主流程', exact: true }).getByRole('listitem'),
    ).toHaveCount(8);
    await expect(
      page
        .getByRole('region', { name: '项目主流程', exact: true })
        .locator('[aria-current="step"]'),
    ).toHaveText('1招募策略官');
    if (!desktop) await screenshot(page, 'project-detail');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('作业标准.txt');
    await expect.poll(() => calls('files/view').length).toBe(1);
    expect(calls('files/view')[0]?.query).toEqual({ objectKey });
    expect(calls('files/view')[0]?.headers.cookie).toContain('navigator_session=active');
    expect(await page.locator(`a[href*="project-attachment/"]`).count()).toBe(0);
    const before = calls('projects/list').length;
    await chooseRole(page, '策略官');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '我创建的项目', exact: true })).toHaveCount(0);
    await page.goto(`${origin}/#/projects/create`);
    await expect(page).toHaveURL(/#\/$/);
    expect(calls('projects/create')).toHaveLength(0);
    expect(calls('projects/list')).toHaveLength(before);
    state.projects[0]!.projectName = '切换后最新待办';
    await chooseRole(page, '领航员');
    await expect(page.getByRole('heading', { name: '切换后最新待办', exact: true })).toBeVisible();
    expect(calls('projects/list').length).toBeGreaterThan(before);
    expect(calls('auth/switch-role').map((call) => call.body)).toEqual([
      { role: 'PM' },
      { role: 'NAVIGATOR' },
    ]);
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain('project-attachment/');
    expect(storage).not.toContain('u'.repeat(43));
  });
}

test('项目列表与草稿独立失败、显式重读和空态，失效会话不读取项目', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.listStatus = 503;
  state.draftStatus = 503;
  await page.goto(`${origin}/#/projects`);
  await expect(page.getByText('待办读取暂不可用', { exact: true })).toBeVisible();
  await expect(page.getByText('草稿读取暂不可用', { exact: true })).toBeVisible();
  expect(calls('projects/list')).toHaveLength(1);
  expect(calls('projects/draft/current')).toHaveLength(1);
  state.draftStatus = 200;
  state.draft = draftFixture();
  await page.getByRole('button', { name: '重试读取草稿', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续完善', exact: true })).toBeVisible();
  expect(calls('projects/list')).toHaveLength(1);
  state.listStatus = 200;
  state.projects = [];
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page.getByText('暂无待办项目', { exact: true })).toBeVisible();
  state.signedIn = false;
  const before = calls('projects/list').length;
  await page.reload();
  await expect(page).toHaveURL(/#\/auth$/);
  expect(calls('projects/list')).toHaveLength(before);
});

async function select(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: new RegExp(`^${label}`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function fillBasic(page: Page) {
  await page.getByLabel(/^项目名称/).fill('完整发布项目');
  await page.getByLabel(/^项目描述/).fill('跨角色协作的项目描述');
  await select(page, '一级项目类型', '数据处理');
  await select(page, '二级项目类型', '文本标注');
  await page
    .getByRole('group', { name: '三级项目类型', exact: true })
    .getByText('内容分类', { exact: true })
    .click();
  await expect(page.getByRole('checkbox', { name: '内容分类', exact: true })).toBeChecked();
  await select(page, '难度等级', '中等');
  await page.getByLabel(/^截止时间（上海时间）/).fill('2099-12-31T18:20:30');
  await page.getByLabel(/^项目量级/).fill('120.5');
  await page.getByLabel(/^量级单位/).fill('条');
}

async function fillPeople(page: Page) {
  await page.getByLabel(/^需求人数/).fill('3');
  await select(page, '学历要求', '本科');
  await select(page, '人员属性', '兼职');
  await page.getByLabel(/^经验要求/).fill('熟悉文本分类');
  await page.getByLabel(/^工作内容摘要/).fill('为材料建立分类');
  await page.getByLabel(/^特殊要求/).fill('按上海时间协作');
  await page.getByLabel(/^必备要求/).fill('完成标准学习');
}

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron 运行配置', true],
] as const) {
  test(`${mode} 三步发布校验、上海墙钟和附件完整快照，确认后单次写入`, async ({ page }) => {
    const { state, calls, releaseSave } = await backend(page, desktop);
    state.holdSave = true;
    await page.goto(`${origin}/#/projects/create`);
    await expect(page.getByRole('heading', { name: '创建项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByText('请填写此项', { exact: true }).first()).toBeVisible();
    expect(calls('projects/create')).toHaveLength(0);
    await fillBasic(page);
    if (!desktop) await screenshot(page, 'create-basic');
    await expect(page.getByLabel('需求方', { exact: true })).toHaveValue('测试创建人');
    await expect(page.getByLabel('创建者', { exact: true })).toBeEditable({ editable: false });
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await fillPeople(page);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByLabel(/^标准说明与作业规范/).fill('逐条核对标准后完成分类。');
    await page.getByLabel(/^标准文档链接/).fill('https://example.com/project-standard');
    await page.getByLabel('选择项目附件', { exact: true }).setInputFiles({
      name: '作业标准.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('standard'),
    });
    await expect.poll(() => calls('files/upload').length).toBe(1);
    await expect(page.getByText('作业标准.txt', { exact: true })).toBeVisible();
    if (!desktop) await screenshot(page, 'create-standard');
    expect(calls('files/upload')[0]?.body).toContain('name="bizType"\r\n\r\nPROJECT_ATTACHMENT');
    await page.getByRole('button', { name: '发布项目', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认发布项目', exact: true });
    await expect(confirm).toBeVisible();
    expect(calls('projects/create')).toHaveLength(0);
    await confirm.getByRole('button', { name: '确认发布', exact: true }).click();
    await expect.poll(() => calls('projects/create').length).toBe(1);
    await expect(confirm.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled();
    expect(calls('projects/create')[0]?.body).toEqual({
      operation: 'CREATE_PROJECT',
      requesterType: 'INDIVIDUAL',
      requesterId: userId,
      projectName: '完整发布项目',
      projectDescription: '跨角色协作的项目描述',
      categoryLevel1Id: 1,
      categoryLevel2Id: 2,
      categoryLevel3Ids: [3],
      difficultyLevel: 'MEDIUM',
      projectQuantity: 120.5,
      quantityUnit: '条',
      deadline: '2099-12-31 18:20:30',
      requiredHeadcount: 3,
      educationRequirement: 'BACHELOR',
      employmentType: 'PART_TIME',
      experienceRequirement: '熟悉文本分类',
      workSummary: '为材料建立分类',
      specialRequirement: '按上海时间协作',
      mandatoryRequirement: '完成标准学习',
      standardContent: '逐条核对标准后完成分类。',
      standardLink: 'https://example.com/project-standard',
      attachments: [
        { attachmentType: 'STANDARD_REFERENCE', objectKey, uploadToken: 'u'.repeat(43), sortNo: 0 },
      ],
    });
    await releaseSave();
    await expect(page).toHaveURL(/#\/projects\?created=501$/);
    await expect(page.getByText('项目已发布，可进入详情查看。', { exact: true })).toBeVisible();
    if (!desktop) await screenshot(page, 'published');
    expect(calls('projects/create')).toHaveLength(1);
    expect(calls('projects/create')[0]?.headers.cookie).toContain('navigator_session=active');
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain('u'.repeat(43));
  });
}

test('草稿恢复完整快照和版本，冲突保留输入并要求显式重读', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.draft = draftFixture();
  state.saveStatus = 409;
  await page.goto(`${origin}/#/projects/create`);
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('待完善草稿');
  await expect(page.getByLabel(/^截止时间（上海时间）/)).toHaveValue('2099-12-31T18:20:30');
  await page.getByLabel(/^项目名称/).fill('本地尚未保存的改动');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    page.getByText('内容已发生变化，请重新读取草稿后再保存。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('本地尚未保存的改动');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(calls('projects/create')).toHaveLength(1);
  expect(calls('projects/create')[0]?.body).toMatchObject({
    operation: 'SAVE_DRAFT',
    versionNo: 7,
    deadline: '2099-12-31 18:20:30',
    attachments: [{ id: 81, sortNo: 0 }],
  });
  state.draft = { ...draftFixture(), projectName: '远端更新的草稿', versionNo: 8 };
  state.saveStatus = 200;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重新读取草稿', exact: true }).click();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('远端更新的草稿');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => calls('projects/create').length).toBe(2);
  expect(calls('projects/create')[1]?.body).toMatchObject({
    operation: 'SAVE_DRAFT',
    versionNo: 8,
    projectName: '远端更新的草稿',
  });
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('远端更新的草稿');
  expect(state.draft?.versionNo).toBe(9);
});

test('草稿写入成功而回读失败只重读，网络结果未明时禁止重放写入', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.draft = draftFixture();
  state.failReadAfterSave = true;
  await page.goto(`${origin}/#/projects/create`);
  await page.getByLabel(/^项目名称/).fill('已经保存的内容');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    page.getByText('草稿已保存，但暂时无法读取最新内容。请重新读取后继续。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(calls('projects/create')).toHaveLength(1);
  state.draftStatus = 200;
  state.failReadAfterSave = false;
  await page.getByRole('button', { name: '重新读取草稿', exact: true }).click();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('已经保存的内容');
  expect(calls('projects/create')).toHaveLength(1);
  state.saveStatus = 503;
  await page.getByLabel(/^项目名称/).fill('提交结果需要核对');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    page.getByText('提交结果暂未确认，请先重新读取草稿或返回项目列表核对。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('提交结果需要核对');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(calls('projects/create')).toHaveLength(2);
  state.saveStatus = 200;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重新读取草稿', exact: true }).click();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('已经保存的内容');
  state.saveNetworkFailure = true;
  await page.getByLabel(/^项目名称/).fill('网络中断后需核对');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    page.getByText('提交结果暂未确认，请先重新读取草稿或返回项目列表核对。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^项目名称/)).toHaveValue('网络中断后需核对');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(calls('projects/create')).toHaveLength(3);
});

test('未保存草稿取消角色切换保留输入与附件，确认后清除领航员操作', async ({ page }) => {
  const { state, calls } = await backend(page);
  await page.goto(`${origin}/#/projects/create`);
  await fillBasic(page);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await fillPeople(page);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel(/^标准说明与作业规范/).fill('尚未保存的标准');
  await page.getByLabel('选择项目附件', { exact: true }).setInputFiles({
    name: '作业标准.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('standard'),
  });
  await expect(page.getByText('上传完成，待保存', { exact: false })).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '领航员',
  );
  await expect(page.getByLabel(/^标准说明与作业规范/)).toHaveValue('尚未保存的标准');
  await expect(page.getByText('作业标准.txt', { exact: true })).toBeVisible();
  expect(calls('auth/switch-role')).toHaveLength(0);
  expect(calls('projects/create')).toHaveLength(0);
  state.switchStatus = 503;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByText('角色切换暂不可用', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '领航员',
  );
  await expect(page.getByLabel(/^标准说明与作业规范/)).toHaveValue('尚未保存的标准');
  await expect(page.getByText('作业标准.txt', { exact: true })).toBeVisible();
  expect(calls('auth/switch-role')).toHaveLength(1);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '返回项目列表', exact: true }).click();
  await expect(page).toHaveURL(/#\/projects\/create$/);
  await expect(page.getByLabel(/^标准说明与作业规范/)).toHaveValue('尚未保存的标准');
  state.switchStatus = 200;
  page.once('dialog', (dialog) => dialog.accept());
  await chooseRole(page, '策略官');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('heading', { name: '创建项目', exact: true })).toHaveCount(0);
  expect(calls('auth/switch-role')).toHaveLength(2);
  expect(calls('projects/create')).toHaveLength(0);
});
