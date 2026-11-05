import { expect, test, type Page } from '@playwright/test';
import { materialsExample } from '../../apps/server/src/modules/projects/project-materials.schema';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { projectCardExample } from '../../apps/server/src/modules/projects/project-list.schema';
import { examManagementExample } from '../../apps/server/src/modules/entrance-exams/exam-query.schema';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import type {
  AuthUser,
  NavigatorProjectCard,
  ProjectStandardMaterials,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176',
  projectId = 3001;
const materialPath = '/api/v1/projects/standard-materials/';
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'NAVTRAINING10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '领航材料创建人',
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
const existingAttachment: WorkbenchProjectDetail['attachments'][number] = {
  id: 81,
  attachmentType: 'CASE',
  fileName: '原始案例.txt',
  objectKey: `project-attachment/2026/11/04/${'a'.repeat(32)}.txt`,
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 8,
  fileHash: 'a'.repeat(64),
  sortNo: 0,
  status: 'ACTIVE',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectName: '领航员标准材料项目',
  requesterId: uuid(88),
  requesterName: '材料需求方',
  creatorUid: user.uid,
  creatorName: user.realName,
  projectDescription: '真实创建人材料读写契约',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  standardLink: 'https://example.com/standard',
  standardContent: '创建人保存的标准正文',
  currentNodeCode: 'STANDARD_TRAINING',
  attachments: [existingAttachment],
} as WorkbenchProjectDetail;
const uploaded = {
  fileId: uuid(90),
  objectKey: `project-attachment/2026/11/04/${'b'.repeat(32)}.txt`,
  uploadToken: 't'.repeat(43),
  url: null,
  sensitive: true,
  fileName: '新增标准.txt',
  extension: 'txt',
  size: 8,
  contentType: 'text/plain',
  fileHash: 'b'.repeat(64),
};
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  raw: string;
}

/** NAV标准材料只读，展示不推进主节点；所有HTTP和文件均隔离在当前测试内存。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.context().addCookies([
    {
      name: 'nav_training_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const materials = {
    ...structuredClone(materialsExample),
    projectId,
    standardContent: project.standardContent,
    standardLink: project.standardLink,
    attachments: [structuredClone(existingAttachment)],
    currentNodeCode: 'STANDARD_TRAINING',
    versionNo: 2,
  } as ProjectStandardMaterials;
  const card = {
    ...structuredClone(projectCardExample),
    id: projectId,
    projectName: project.projectName,
    creatorId: user.id,
    creatorName: user.realName,
    requesterName: project.requesterName,
    currentNodeCode: 'STANDARD_TRAINING',
    branchNodeCode: null,
    currentAction: 'VIEW_DETAIL',
    currentActionDescription: '查看项目详情',
    workbenchStatus: 'PROCESSING',
  } as NavigatorProjectCard;
  const state = {
    user: structuredClone(user),
    project: structuredClone(project),
    materials,
    cards: [card],
    readStatus: 200,
    listStatus: 200,
    readNetwork: false,
    writeStatus: 200,
    writeNetwork: false,
    commitOnFailure: false,
    failReadAfterWrite: false,
    removeAfterSave: false,
    uploadStatus: 200,
    fileStatus: 200,
    holdFile: false,
    holdWrite: false,
  };
  const requests: RequestLog[] = [];
  let releaseFile: (() => void) | undefined, releaseWrite: (() => void) | undefined;
  function save(input: Record<string, unknown>) {
    state.materials = {
      ...state.materials,
      standardContent: input.standardContent == null ? null : String(input.standardContent),
      standardLink: input.standardLink == null ? null : String(input.standardLink),
      attachments: (input.attachments as Record<string, unknown>[]).map((file, sortNo) =>
        file.id
          ? { ...existingAttachment, sortNo }
          : {
              ...existingAttachment,
              id: 82,
              attachmentType: 'STANDARD_REFERENCE',
              fileName: uploaded.fileName,
              objectKey: uploaded.objectKey,
              fileHash: uploaded.fileHash,
              sortNo,
            },
      ),
      versionNo: state.materials.versionNo + 1,
      stateTransitioned: false,
    };
    if (state.removeAfterSave) state.cards = [];
  }
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = await request.allHeaders();
    const raw = request.postDataBuffer()?.toString('utf8') ?? '';
    const body = headers['content-type']?.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    requests.push({
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
      raw,
    });
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/auth/switch-role') {
      state.user.role = body!.role as AuthUser['role'];
      state.user.selectedRole = state.user.role;
      return reply({ selectedRole: state.user.role, roles: state.user.roles });
    }
    if (path === '/api/v1/projects/list')
      return reply(
        state.listStatus === 200
          ? state.user.role === 'NAVIGATOR' && state.project.creatorUid !== state.user.uid
            ? []
            : state.cards
          : null,
        state.listStatus,
        '项目待办读取失败',
      );
    if (path === '/api/v1/projects/manager/list')
      return reply([strategistProjectCard(state.project)]);
    if (path === '/api/v1/projects/manager-candidates') return reply([]);
    if (path === '/api/v1/entrance-exams/management')
      return reply({
        ...structuredClone(examManagementExample),
        canCreateExam: false,
        createDisabledReason: '阅卷人仅可查看考试信息',
      });
    if (path === '/api/v1/projects/draft/current') return reply({ hasDraft: false, draft: null });
    if (path === `/api/v1/projects/${projectId}`)
      return state.user.role === 'NAVIGATOR' && state.project.creatorUid !== state.user.uid
        ? reply(null, 403, '当前用户无权查看该项目')
        : reply({ ...state.project, ...state.materials, id: projectId });
    if (path === '/api/v1/expert-assignments/my-tasks') return reply([]);
    if (path === '/api/v1/entrance-exams/reviewers') return reply([]);
    if (path.startsWith(materialPath)) {
      if (state.user.role === 'NAVIGATOR' && state.project.creatorUid !== state.user.uid)
        return reply(null, 403, '当前角色及项目关系无权操作标准材料');
      if (path === `${materialPath}detail`) {
        if (state.readNetwork) return route.abort('failed');
        return reply(
          state.readStatus === 200 ? state.materials : null,
          state.readStatus,
          state.readStatus === 200 ? '操作成功' : '标准材料读取被拒绝',
        );
      }
      if (path === `${materialPath}update`) {
        if (state.holdWrite)
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        if (state.commitOnFailure) save(body!);
        if (state.writeNetwork) return route.abort('failed');
        if (state.writeStatus !== 200) return reply(null, state.writeStatus, '标准材料保存被拒绝');
        if (!state.commitOnFailure) save(body!);
        if (state.failReadAfterWrite) state.listStatus = 503;
        return reply(state.materials);
      }
      return reply(null, 403, '领航员不使用普通专家确认阅读入口');
    }
    if (path === '/api/v1/files/upload')
      return reply(
        state.uploadStatus === 200 ? uploaded : null,
        state.uploadStatus,
        '项目附件上传失败',
      );
    if (path === '/api/v1/files/view') {
      if (state.holdFile)
        await new Promise<void>((resolve) => {
          releaseFile = resolve;
        });
      return state.fileStatus === 200
        ? route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: 'isolated material',
          })
        : reply(null, state.fileStatus, '材料附件无读取权限');
    }
    return reply(null, 404, '夹具未配置此接口');
  });
  return {
    state,
    requests,
    calls: (suffix: string) => requests.filter((request) => request.path === `/api/v1/${suffix}`),
    releaseFile: () => {
      if (!releaseFile) throw new Error('没有等待中的文件');
      state.holdFile = false;
      releaseFile();
    },
    releaseWrite: () => {
      if (!releaseWrite) throw new Error('没有等待中的保存');
      state.holdWrite = false;
      releaseWrite();
    },
  };
}
const panel = (page: Page) => page.getByRole('region', { name: '标准与培训', exact: true });
const writes = (f: Awaited<ReturnType<typeof backend>>) =>
  f.calls('projects/standard-materials/update');
async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/projects/${projectId}`);
  await page
    .getByRole('tablist', { name: '领航员项目模块', exact: true })
    .getByRole('tab', { name: '标准与培训', exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}
async function chooseRole(page: Page, name: '领航员' | '策略官') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(name);
}

for (const desktop of [false, true])
  test(`${desktop ? '桌面配置' : 'Web'}领航员标准材料只读，正文链接附件可查看且无任何写入口`, async ({
    page,
  }) => {
    const f = await backend(page, desktop);
    const region = await open(page);
    await expect(region).toContainText('创建人保存的标准正文');
    await expect(
      region.getByRole('link', { name: 'https://example.com/standard', exact: true }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
    for (const name of ['编辑标准材料', '保存标准材料', '标准发布', '确认已阅读'])
      await expect(region.getByRole('button', { name, exact: true })).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      region.getByRole('button', { name: '下载原始案例.txt', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(existingAttachment.fileName);
    expect(f.calls('files/view')[0]!.headers.cookie).toContain('nav_training_session=active');
    await region.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
    await expect
      .poll(() => f.calls('projects/standard-materials/detail').length)
      .toBeGreaterThan(1);
    expect(writes(f)).toHaveLength(0);
    expect(f.calls('entrance-exams/reviewers')).toHaveLength(0);
    expect(f.calls('projects/standard-materials/confirm-read')).toHaveLength(0);
  });

test('未到达考试和标准培训时仅提示前置节点，不发对应业务查询或写入', async ({ page }) => {
  const f = await backend(page);
  f.state.project.currentNodeCode = 'RECRUIT_PROJECT_MANAGER';
  f.state.materials.currentNodeCode = 'RECRUIT_PROJECT_MANAGER';
  f.state.cards[0]!.currentNodeCode = 'RECRUIT_PROJECT_MANAGER';
  await page.goto(`${origin}/#/projects/${projectId}`);
  const tabs = page.getByRole('tablist', { name: '领航员项目模块', exact: true });
  await tabs.getByRole('tab', { name: '准入考试', exact: true }).click();
  await expect(page.getByText('请先完成上一节点「生产计划」', { exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: '标准与培训', exact: true }).click();
  await expect(page.getByText('请先完成上一节点「准入考试」', { exact: true })).toBeVisible();
  expect(f.calls('entrance-exams/management')).toHaveLength(0);
  expect(f.calls('projects/standard-materials/detail')).toHaveLength(0);
  expect(writes(f)).toHaveLength(0);
});

test('领航员读取失败后只重试GET，恢复后仍保持只读', async ({ page }) => {
  const f = await backend(page);
  f.state.readStatus = 503;
  const region = await open(page);
  await expect(region.getByRole('alert')).toContainText('标准材料读取被拒绝');
  await expect(region.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  f.state.readStatus = 200;
  await region.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(region).toContainText('创建人保存的标准正文');
  expect(writes(f)).toHaveLength(0);
});

test('无标准正文和附件不展示空材料表单或发布入口', async ({ page }) => {
  const f = await backend(page);
  f.state.materials.standardContent = null;
  f.state.materials.attachments = [];
  const region = await open(page);
  await expect(region).toContainText('暂无数据');
  await expect(region.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  expect(writes(f)).toHaveLength(0);
});

test('375px标准只读长内容可滚动且无横向溢出', async ({ page }) => {
  const f = await backend(page);
  f.state.materials.standardContent = '# 作业标准\n\n' + '请逐条核对。\n\n'.repeat(100);
  f.state.materials.attachments[0]!.fileName = '超长案例文件名称'.repeat(12) + '.txt';
  await open(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(panel(page).getByRole('heading', { name: '作业标准', exact: true })).toBeVisible();
  expect(writes(f)).toHaveLength(0);
});
test('历史HTML和不安全链接不执行，鉴权附件403与切角色后迟到响应均不下载', async ({ page }) => {
  const f = await backend(page);
  f.state.materials.standardContent =
    '<p>安全正文</p><script>document.documentElement.dataset.trainingScript="ran"</script><img src="https://unsafe-training.invalid/pixel">';
  f.state.materials.standardLink =
    'javascript:document.documentElement.dataset.trainingScript="ran"';
  const external: string[] = [];
  await page.route('https://unsafe-training.invalid/**', (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  const region = await open(page);
  await expect(region).toContainText('安全正文');
  expect(
    await page.evaluate(() => document.documentElement.dataset.trainingScript),
  ).toBeUndefined();
  expect(external).toEqual([]);
  await expect(region.locator('a[href^="javascript:"]')).toHaveCount(0);
  f.state.fileStatus = 403;
  await region.getByRole('button', { name: '下载原始案例.txt', exact: true }).click();
  await expect(region).toContainText('材料附件无读取权限');
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  f.state.fileStatus = 200;
  f.state.holdFile = true;
  await region.getByRole('button', { name: '下载原始案例.txt', exact: true }).click();
  await expect.poll(() => f.calls('files/view').length).toBe(2);
  await chooseRole(page, '策略官');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/files/view' && response.status() === 200,
    ),
    Promise.resolve().then(() => f.releaseFile()),
  ]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(downloads).toEqual([]);
});
