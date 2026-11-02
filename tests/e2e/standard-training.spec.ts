import { expect, test, type Page } from '@playwright/test';
import type {
  AuthUser,
  ProjectStandardMaterials,
  ProjectStandardMaterialsInput,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = 701;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'MATERIAL10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '标准材料联调员',
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
  createdAt: '2026-11-02T02:00:00.000Z',
  updatedAt: '2026-11-02T02:00:00.000Z',
};
const existingAttachment: WorkbenchProjectDetail['attachments'][number] = {
  id: 81,
  attachmentType: 'CASE',
  fileName: '原始案例.txt',
  objectKey: `project-attachment/2026/11/02/${'a'.repeat(32)}.txt`,
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 12,
  fileHash: 'a'.repeat(64),
  sortNo: 0,
  status: 'ACTIVE',
};
const project: WorkbenchProjectDetail = {
  id: projectId,
  projectNo: 'MATERIAL-PROJECT-701',
  requesterType: 'INDIVIDUAL',
  requesterId: uuid(2),
  requesterName: '材料需求方',
  projectName: '标准培训隔离项目',
  projectDescription: '使用本机隔离 HTTP 夹具验证标准材料维护',
  categoryLevel1Id: 1,
  categoryLevel2Id: 2,
  categoryLevel1Name: '数据处理',
  categoryLevel2Name: '文本标注',
  categoryLevel3Ids: [3],
  categoryLevel3Names: ['内容分类'],
  difficultyLevel: 'MEDIUM',
  projectQuantity: 500,
  quantityUnit: '条',
  deadline: '2099-12-31 18:00:00',
  requiredHeadcount: 4,
  educationRequirement: null,
  employmentType: null,
  experienceRequirement: null,
  workSummary: '按标准完成作业',
  specialRequirement: null,
  mandatoryRequirement: null,
  standardContent: '逐条核对标准与案例',
  standardLink: 'https://example.com/standard',
  status: 'PUBLISHED',
  currentNodeCode: 'STANDARD_TRAINING',
  versionNo: 2,
  creatorUid: 'MATERIAL10002',
  creatorName: '测试创建人',
  createdAt: '2026-11-02 10:00:00',
  updatedAt: '2026-11-02 10:00:00',
  attachments: [existingAttachment],
};

interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  raw: string;
}

/** 所有写操作仅修改内存夹具；不连接业务数据库或远程文档。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'materials_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const materials: ProjectStandardMaterials = {
    projectId,
    standardContent: project.standardContent,
    standardLink: project.standardLink,
    attachments: structuredClone(project.attachments),
    currentNodeCode: 'STANDARD_TRAINING',
    versionNo: 2,
    stateTransitioned: false,
    canConfirmRead: false,
    confirmedReadAt: null,
    readConfirmationTransitioned: false,
  };
  const state = {
    user: structuredClone(user),
    materials,
    reviewerStatus: 200,
    readStatus: 200,
    writeStatus: 200,
    uploadStatus: 200,
    networkFailure: false,
    failReadAfterWrite: false,
  };
  const requests: RequestLog[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const raw = request.postDataBuffer()?.toString('utf8') ?? '';
    const body = headers['content-type']?.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    const log = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
      raw,
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!headers.cookie?.includes('materials_session=active')) return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      const role = body!.role as AuthUser['role'];
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (['/api/v1/projects/list', '/api/v1/projects/manager/list'].includes(log.path))
      return reply([]);
    if (log.path === '/api/v1/projects/draft/current')
      return reply({ hasDraft: false, draft: null });
    if (log.path === '/api/v1/expert-assignments/my-tasks') return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`)
      return reply({ ...project, ...state.materials, id: projectId });
    if (log.path === '/api/v1/entrance-exams/reviewers')
      return reply(
        state.reviewerStatus === 200 ? [] : null,
        state.reviewerStatus,
        state.reviewerStatus === 403 ? '仅当前主策略官可操作' : '管理资格读取失败',
      );
    if (log.path === '/api/v1/projects/standard-materials/detail')
      return reply(
        state.readStatus === 200 ? state.materials : null,
        state.readStatus,
        '标准材料读取结果',
      );
    if (log.path === '/api/v1/projects/standard-materials/update') {
      if (state.networkFailure) return route.abort('failed');
      if (state.writeStatus !== 200)
        return reply(
          null,
          state.writeStatus,
          state.writeStatus === 409 ? '标准材料已变化，请重新读取' : '标准材料保存被拒绝',
        );
      const input = body as unknown as ProjectStandardMaterialsInput;
      state.materials = {
        ...state.materials,
        standardContent: input.standardContent ?? null,
        standardLink: input.standardLink ?? null,
        attachments: (input.attachments ?? []).map((item, index) =>
          item.id
            ? { ...existingAttachment, sortNo: index }
            : {
                ...existingAttachment,
                id: 82,
                attachmentType: 'STANDARD_REFERENCE',
                objectKey: item.objectKey!,
                fileName: '新增标准.txt',
                fileSize: 8,
                sortNo: index,
              },
        ),
        versionNo: state.materials.versionNo + 1,
        currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
        stateTransitioned: true,
      };
      if (state.failReadAfterWrite) state.readStatus = 503;
      return reply(state.materials);
    }
    if (log.path === '/api/v1/files/upload')
      return reply(
        state.uploadStatus === 200
          ? {
              fileId: uuid(90),
              objectKey: `project-attachment/2026/11/02/${'b'.repeat(32)}.txt`,
              uploadToken: 't'.repeat(43),
              fileName: '新增标准.txt',
              extension: 'txt',
              size: 8,
              contentType: 'text/plain',
              fileHash: 'b'.repeat(64),
              url: null,
              sensitive: true,
            }
          : null,
        state.uploadStatus,
        '项目附件上传结果',
      );
    if (log.path === '/api/v1/files/view')
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: '案例内容',
      });
    return reply(null, 404, '测试未约定此接口');
  });
  const calls = (suffix: string) => requests.filter((row) => row.path === `/api/v1/${suffix}`);
  return { state, requests, calls };
}

async function openMaterials(page: Page) {
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=STANDARD_TRAINING`);
  const panel = page.getByRole('region', { name: '标准与培训', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function editMaterials(page: Page) {
  const panel = await openMaterials(page);
  await panel.getByRole('button', { name: '编辑标准材料', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '标准正文', exact: true })).toBeVisible();
  return panel;
}

async function publish(page: Page) {
  const panel = page.getByRole('region', { name: '标准与培训', exact: true });
  await panel.getByRole('button', { name: '保存并发布标准', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '发布标准材料', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认发布', exact: true }).click();
}

for (const [mode, desktop] of [
  ['Web', false],
  ['桌面运行配置', true],
] as const) {
  test(`${mode}标准读取、附件下载及发布使用现有Cookie契约，发布后停留标准模块`, async ({
    page,
  }) => {
    const { requests, calls } = await backend(page, desktop);
    const panel = await openMaterials(page);
    await expect(panel).toContainText('逐条核对标准与案例');
    expect(calls('projects/standard-materials/update')).toHaveLength(0);
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载原始案例.txt', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('原始案例.txt');
    await panel.getByRole('button', { name: '编辑标准材料', exact: true }).click();
    await panel.getByRole('textbox', { name: '标准正文', exact: true }).fill('  新版作业标准  ');
    await panel
      .getByRole('textbox', { name: '标准链接', exact: true })
      .fill('https://example.com/new-standard');
    await publish(page);
    await expect(panel).toContainText('新版作业标准');
    await expect(page.getByRole('tab', { name: '标准与培训', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: '招募执行专家', exact: true })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(calls('projects/standard-materials/update').map((row) => row.body)).toEqual([
      {
        projectId,
        standardContent: '新版作业标准',
        standardLink: 'https://example.com/new-standard',
        attachments: [{ id: 81, sortNo: 0 }],
      },
    ]);
    expect(calls('projects/standard-materials/detail')[0].query).toEqual({ projectId: '701' });
    expect(calls('files/view')[0].query).toEqual({ objectKey: existingAttachment.objectKey });
    expect(requests.every((row) => row.headers.cookie?.includes('materials_session=active'))).toBe(
      true,
    );
    expect(requests.every((row) => !row.headers['x-role'])).toBe(true);
  });
}

test('协作负责人只读，管理资格读取失败时禁止编辑，显式重读后恢复', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.reviewerStatus = 403;
  const panel = await openMaterials(page);
  await expect(panel).toContainText('逐条核对标准与案例');
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  state.reviewerStatus = 503;
  await panel.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(panel).toContainText('管理资格读取失败');
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  state.reviewerStatus = 200;
  await panel.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toBeEnabled();
  expect(calls('projects/standard-materials/update')).toHaveLength(0);
});

test('材料首次读取失败不开放空白编辑，手动恢复只发读取请求', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.readStatus = 503;
  const panel = await openMaterials(page);
  await expect(panel).toContainText('标准材料读取结果');
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  state.readStatus = 200;
  await panel.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(panel).toContainText('逐条核对标准与案例');
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toBeEnabled();
  expect(calls('projects/standard-materials/update')).toHaveLength(0);
});

test('上传失败与保存400均保留草稿，手动重试保存复用已上传凭证', async ({ page }) => {
  const { state, calls } = await backend(page);
  const panel = await editMaterials(page);
  await panel.getByRole('textbox', { name: '标准正文', exact: true }).fill('保留输入与附件凭证');
  state.uploadStatus = 503;
  await panel.getByLabel('上传标准附件', { exact: true }).setInputFiles({
    name: '新增标准.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('standard'),
  });
  await expect(panel.getByRole('button', { name: '重试上传', exact: true })).toBeVisible();
  state.uploadStatus = 200;
  await panel.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(panel.getByRole('button', { name: '下载新增标准.txt', exact: true })).toBeVisible();
  state.writeStatus = 400;
  await publish(page);
  await expect(panel).toContainText('标准材料保存被拒绝');
  await expect(panel.getByRole('textbox', { name: '标准正文', exact: true })).toHaveValue(
    '保留输入与附件凭证',
  );
  await expect(panel.getByRole('button', { name: '保存并发布标准', exact: true })).toBeEnabled();
  state.writeStatus = 200;
  await publish(page);
  await expect(panel.getByRole('textbox', { name: '标准正文', exact: true })).toHaveCount(0);
  expect(calls('files/upload')).toHaveLength(2);
  expect(calls('files/upload').every((row) => row.raw.includes('PROJECT_ATTACHMENT'))).toBe(true);
  const writes = calls('projects/standard-materials/update');
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(writes[1].body?.attachments).toEqual([
    { id: 81, sortNo: 0 },
    {
      attachmentType: 'STANDARD_REFERENCE',
      objectKey: `project-attachment/2026/11/02/${'b'.repeat(32)}.txt`,
      uploadToken: 't'.repeat(43),
      sortNo: 1,
    },
  ]);
});

for (const failure of ['冲突', '网络未知'] as const) {
  test(`${failure}提交结果锁定旧动作，切换模块后仍需显式重读核实`, async ({ page }) => {
    const { state, calls } = await backend(page);
    const panel = await editMaterials(page);
    await panel
      .getByRole('textbox', { name: '标准正文', exact: true })
      .fill('未确认保存的本地内容');
    state.writeStatus = failure === '冲突' ? 409 : 200;
    state.networkFailure = failure === '网络未知';
    await publish(page);
    await expect(panel.getByRole('button', { name: '保存并发布标准', exact: true })).toBeDisabled();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
    await page.getByRole('tab', { name: '标准与培训', exact: true }).click();
    await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toBeDisabled();
    expect(calls('projects/standard-materials/update')).toHaveLength(1);
    state.writeStatus = 200;
    state.networkFailure = false;
    page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
    await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toBeEnabled();
    await expect(panel).toContainText('逐条核对标准与案例');
    expect(calls('projects/standard-materials/update')).toHaveLength(1);
  });
}

test('保存成功而回读失败时不重复提交，跨模块恢复只读取最新材料', async ({ page }) => {
  const { state, calls } = await backend(page);
  const panel = await editMaterials(page);
  await panel.getByRole('textbox', { name: '标准正文', exact: true }).fill('已保存但待核实的标准');
  state.failReadAfterWrite = true;
  await publish(page);
  await expect(panel).toContainText('标准材料已保存，但最新资料读取尚未完成，请重新读取核对。');
  await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
  await page.getByRole('tab', { name: '标准与培训', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '编辑标准材料', exact: true }).and(panel.locator(':enabled')),
  ).toHaveCount(0);
  state.readStatus = 200;
  await panel.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(panel).toContainText('已保存但待核实的标准');
  await expect(panel.getByRole('button', { name: '编辑标准材料', exact: true })).toBeEnabled();
  expect(calls('projects/standard-materials/update')).toHaveLength(1);
});

test('未保存标准保护模块与角色切换，375px布局和详情弹框保留草稿', async ({ page }) => {
  const { requests, calls } = await backend(page);
  const panel = await editMaterials(page);
  await panel.getByRole('textbox', { name: '标准正文', exact: true }).fill('保留未保存草稿');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
  await expect(page.getByRole('tab', { name: '标准与培训', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  expect(calls('auth/switch-role')).toHaveLength(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const before = requests.length;
  await page.getByRole('button', { name: '查看项目详情', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '项目详情', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('textbox', { name: '标准正文', exact: true })).toHaveValue(
    '保留未保存草稿',
  );
  expect(requests).toHaveLength(before);
  await page.screenshot({ path: 'artifacts/standard-training-mobile.png', animations: 'disabled' });
  expect(calls('projects/standard-materials/update')).toHaveLength(0);
});

test('不执行不安全材料链接或正文脚本，并在HTTP前阻止超16KiB完整请求', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.materials.standardLink = 'javascript:window.materialExecuted=true';
  state.materials.standardContent = '<script>window.materialExecuted=true</script>安全标准正文';
  const panel = await openMaterials(page);
  await expect(panel).toContainText('安全标准正文');
  expect(await panel.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(await page.evaluate(() => 'materialExecuted' in window)).toBe(false);
  await panel.getByRole('button', { name: '编辑标准材料', exact: true }).click();
  await panel.getByRole('textbox', { name: '标准链接', exact: true }).fill('');
  await panel.getByRole('textbox', { name: '标准正文', exact: true }).fill('标准'.repeat(4000));
  await panel.getByRole('button', { name: '保存并发布标准', exact: true }).click();
  await expect(panel).toContainText('内容过长');
  await expect(page.getByRole('dialog', { name: '发布标准材料', exact: true })).toHaveCount(0);
  expect(calls('projects/standard-materials/update')).toHaveLength(0);
});
