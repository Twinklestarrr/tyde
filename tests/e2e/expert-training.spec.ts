import { expect, test, type Page } from '@playwright/test';
import { assignmentDetailExample } from '../../apps/server/src/modules/expert/expert-assignment.schema';
import { expertTaskExample } from '../../apps/server/src/modules/expert/expert-task.schema';
import { materialsExample } from '../../apps/server/src/modules/projects/project-materials.schema';
import type { AuthUser, ProjectStandardMaterials } from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = expertTaskExample.basicInfo.projectId;
const user: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: 'TRAINING10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '培训联调员',
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
const attachment = {
  id: 81,
  attachmentType: 'STANDARD_REFERENCE' as const,
  fileName: '培训参考.txt',
  objectKey: `project-attachment/2026/11/03/${'a'.repeat(32)}.txt`,
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 18,
  fileHash: 'a'.repeat(64),
  sortNo: 0,
  status: 'ACTIVE' as const,
};
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: string | null;
  headers: Record<string, string>;
}

/** 只读材料和确认操作均为内存 HTTP 夹具，不访问业务数据库或对象存储。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'training_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const materials: ProjectStandardMaterials = {
    ...structuredClone(materialsExample),
    projectId,
    standardContent: '<p>先阅读标准，再完成培训。</p><script>window.trainingUnsafe = true</script>',
    standardLink: 'https://example.com/training-standard',
    attachments: [attachment],
    currentNodeCode: 'PRODUCTION_TASK',
    canConfirmRead: true,
    confirmedReadAt: null,
    versionNo: 4,
  };
  const state = {
    task: {
      ...structuredClone(expertTaskExample),
      acceptanceStatus: 'ACCEPTED',
      branchNodeCode: 'STANDARD_TRAINING',
      currentNodeCode: 'PRODUCTION_TASK',
      operations: { canAccept: false, canReject: false, canReportOutput: false },
    },
    materials,
    confirmed: false,
    readStatus: 200,
    listStatus: 200,
    writeStatus: 200,
    downloadStatus: 200,
    failListAfterWrite: false,
    unknownWrite: false,
    applyUnknownWrite: false,
    holdWrite: false,
    remains: true,
    addOtherSource: false,
  };
  const requests: RequestLog[] = [];
  let releaseWrite: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body: request.postData(),
      headers: await request.allHeaders(),
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!log.headers.cookie?.includes('training_session=active'))
      return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/users/me') return reply(user);
    if (log.path === '/api/v1/expert-assignments/detail') return reply(assignmentDetailExample);
    if (log.path === '/api/v1/expert-assignments/my-tasks') {
      if (state.listStatus !== 200) return reply(null, state.listStatus, '后续待办暂时无法读取');
      if (!state.confirmed) return reply([state.task]);
      const next = {
        ...state.task,
        branchNodeCode: 'PRODUCTION_TASK',
        basicInfo: { ...state.task.basicInfo, projectName: '已更新的生产待办' },
        operations: { ...state.task.operations, canReportOutput: true },
      };
      const otherSource = {
        ...next,
        assignmentId: null,
        movementId: state.task.sourceBizId,
        sourceBizType: 'PROJECT_MEMBER_TRANSFER',
        needWrittenExam: true,
        basicInfo: { ...next.basicInfo, projectName: '同项目的其他转入来源' },
      };
      return reply([
        ...(state.addOtherSource ? [otherSource] : []),
        ...(state.remains ? [next] : []),
      ]);
    }
    if (log.path === '/api/v1/projects/standard-materials/detail')
      return reply(
        state.readStatus === 200
          ? { ...state.materials, readConfirmationTransitioned: false }
          : null,
        state.readStatus,
        state.readStatus === 403 ? '当前身份无权读取标准材料' : '标准材料读取结果',
      );
    if (log.path === '/api/v1/projects/standard-materials/confirm-read') {
      if (state.writeStatus !== 200) return reply(null, state.writeStatus, '当前身份不能确认阅读');
      const apply = () => {
        state.confirmed = true;
        state.materials.canConfirmRead = false;
        state.materials.confirmedReadAt = '2026-11-03 11:00:00';
        if (state.failListAfterWrite) state.listStatus = 503;
      };
      if (state.unknownWrite) {
        if (state.applyUnknownWrite) apply();
        return route.abort('failed');
      }
      const finish = async () => {
        apply();
        await reply({ ...state.materials, readConfirmationTransitioned: true });
      };
      if (state.holdWrite) {
        releaseWrite = finish;
        return;
      }
      return finish();
    }
    if (log.path === '/api/v1/files/view')
      return state.downloadStatus === 200
        ? route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: 'isolated training',
          })
        : reply(null, state.downloadStatus, '当前身份无权下载附件');
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, releaseWrite: async () => releaseWrite?.() };
}

async function openTraining(page: Page) {
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await page.getByRole('button', { name: '查看标准与培训', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '标准与培训', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

const commitment = '我已阅读并理解以上标准与培训材料。';
const confirmations = (requests: RequestLog[]) =>
  requests.filter((request) => request.path === '/api/v1/projects/standard-materials/confirm-read');

for (const desktop of [false, true]) {
  test(`${desktop ? '桌面运行配置' : 'Web'}专家安全读取培训材料及鉴权附件，单次确认后按原来源续接`, async ({
    page,
  }) => {
    const fixture = await backend(page, desktop);
    fixture.state.addOtherSource = true;
    const dialog = await openTraining(page);
    await expect(dialog.getByText('先阅读标准，再完成培训。', { exact: true })).toBeVisible();
    if (!desktop)
      await page.screenshot({ path: 'artifacts/expert-training/training-web.png', fullPage: true });
    expect(await page.evaluate(() => 'trainingUnsafe' in window)).toBe(false);
    const link = dialog.locator('a[href="https://example.com/training-standard"]');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载培训参考.txt', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('培训参考.txt');
    const download = fixture.requests.find((request) => request.path === '/api/v1/files/view');
    expect(download?.query).toEqual({ objectKey: attachment.objectKey });
    expect(download?.headers.cookie).toContain('training_session=active');
    await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
    fixture.state.holdWrite = true;
    await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认已阅读', exact: true });
    expect(confirmations(fixture.requests)).toHaveLength(0);
    await confirmation.getByRole('button', { name: '确认已阅读', exact: true }).click();
    await expect.poll(() => confirmations(fixture.requests).length).toBe(1);
    await expect(
      confirmation.getByRole('button', { name: '确认已阅读', exact: true }),
    ).toBeDisabled();
    await fixture.releaseWrite();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '项目待办详情', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '已更新的生产待办', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('同项目的其他转入来源', { exact: true })).toHaveCount(0);
    expect(confirmations(fixture.requests)).toHaveLength(1);
    expect(confirmations(fixture.requests)[0]).toMatchObject({
      method: 'POST',
      query: { projectId: String(projectId) },
      body: null,
    });
    expect(confirmations(fixture.requests)[0].headers['x-tyde-client']).toBe('web');
    expect(confirmations(fixture.requests)[0].headers.cookie).toContain('training_session=active');
    expect(fixture.state.materials.versionNo).toBe(4);
    expect(fixture.state.materials.currentNodeCode).toBe('PRODUCTION_TASK');
    await page.getByRole('tab', { name: '标准与培训', exact: true }).click();
    await page.getByRole('button', { name: '查看标准与培训', exact: true }).click();
    const previousTraining = page.getByRole('dialog', { name: '标准与培训', exact: true });
    await expect(previousTraining).toContainText('本人已确认阅读');
    await expect(
      previousTraining.getByRole('button', { name: '确认已阅读', exact: true }),
    ).toHaveCount(0);
    expect(confirmations(fixture.requests)).toHaveLength(1);
    expect(
      fixture.requests.filter((request) => request.path.endsWith('/standard-materials/update')),
    ).toHaveLength(0);
  });
}

for (const owner of [true, false]) {
  test(`${owner ? '项目负责人' : '未实际入项专家'}只读标准，不能从任务节点推断确认权限`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    state.materials.canConfirmRead = owner;
    state.task.accessContext.projectOwner = owner;
    if (owner) {
      Object.assign(state.task.basicInfo, {
        subjectType: 'ORGANIZATION',
        organizationId: '00000000-0000-4000-8000-000000000080',
        organizationName: '培训协作组',
      });
      state.task.accessContext.canViewOrganizationData = true;
    }
    const dialog = await openTraining(page);
    await expect(dialog.getByText('先阅读标准，再完成培训。', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '确认已阅读', exact: true })).toHaveCount(0);
    expect(confirmations(requests)).toHaveLength(0);
  });
}

test('培训读取403不展示旧材料或确认入口，服务端拒绝不会冒充成功', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.readStatus = 403;
  const dialog = await openTraining(page);
  await expect(dialog.getByText('当前身份无权读取标准材料', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认已阅读', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('先阅读标准，再完成培训。', { exact: true })).toHaveCount(0);
  expect(confirmations(requests)).toHaveLength(0);
});

test('确认时服务端403锁住旧操作，关闭重开不恢复确认或冒充已阅读', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.writeStatus = 403;
  let dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(dialog.getByText('当前身份不能确认阅读', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认已阅读', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭标准与培训', exact: true }).click();
  await page.getByRole('button', { name: '查看标准与培训', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '标准与培训', exact: true });
  await expect(dialog.getByRole('button', { name: '核实阅读状态', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认已阅读', exact: true })).toHaveCount(0);
  expect(confirmations(requests)).toHaveLength(1);
  expect(state.materials.confirmedReadAt).toBeNull();
});

test('阅读确认响应丢失后关弹框与局部切页保持锁，显式核实后才能重新勾选', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownWrite = true;
  let dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(dialog.getByRole('button', { name: '核实阅读状态', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭标准与培训', exact: true }).click();
  await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await page.getByRole('button', { name: '查看标准与培训', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '标准与培训', exact: true });
  await expect(dialog.getByRole('button', { name: '核实阅读状态', exact: true })).toBeVisible();
  expect(confirmations(requests)).toHaveLength(1);
  await dialog.getByRole('button', { name: '核实阅读状态', exact: true }).click();
  const checkbox = dialog.getByRole('checkbox', { name: commitment, exact: true });
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  expect(confirmations(requests)).toHaveLength(1);
});

test('未知阅读确认只用GET核实已确认时间，不能重复POST', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownWrite = true;
  state.applyUnknownWrite = true;
  const dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(dialog.getByRole('button', { name: '核实阅读状态', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '核实阅读状态', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '已更新的生产待办', exact: true })).toBeVisible();
  expect(confirmations(requests)).toHaveLength(1);
  expect(
    requests.filter((request) => request.path.endsWith('/standard-materials/detail')).length,
  ).toBeGreaterThanOrEqual(3);
});

test('阅读明确成功但后续待办读取失败，只重读列表而不重复确认', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failListAfterWrite = true;
  const dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('阅读已确认，最新待办读取失败，请重试读取项目。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重试读取项目', exact: true }).click();
  expect(confirmations(requests)).toHaveLength(1);
  state.listStatus = 200;
  await page.getByRole('button', { name: '重试读取项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已更新的生产待办', exact: true })).toBeVisible();
  expect(confirmations(requests)).toHaveLength(1);
});

test('阅读完成后原来源消失返回卡片，不将同项目转入来源当作原任务', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.remains = false;
  state.addOtherSource = true;
  const dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '执行专家待办项目', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目待办详情', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '同项目的其他转入来源', exact: true }),
  ).toBeVisible();
  expect(confirmations(requests)).toHaveLength(1);
});

test('确认前标准材料变化必须重新阅读并勾选，不提交未阅读的新材料', async ({ page }) => {
  const { state, requests } = await backend(page);
  const dialog = await openTraining(page);
  await dialog.getByRole('checkbox', { name: commitment, exact: true }).check();
  await dialog.getByRole('button', { name: '确认已阅读', exact: true }).click();
  state.materials.standardContent = '新版本标准，请重新逐项核对';
  state.materials.versionNo++;
  await page
    .getByRole('dialog', { name: '确认已阅读', exact: true })
    .getByRole('button', { name: '确认已阅读', exact: true })
    .click();
  await expect(
    dialog.getByText('标准材料已更新，请重新阅读后再确认。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('新版本标准，请重新逐项核对', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: commitment, exact: true })).not.toBeChecked();
  expect(confirmations(requests)).toHaveLength(0);
});

test('375px培训长文本不溢出，危险协议链接不会成为可点击入口', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { state, requests } = await backend(page);
  state.materials.standardContent = `培训内容 ${'LongTrainingWord'.repeat(40)}`;
  state.materials.standardLink = 'javascript:window.trainingUnsafe=true';
  const dialog = await openTraining(page);
  await expect(dialog.getByText(state.materials.standardContent, { exact: true })).toBeVisible();
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'trainingUnsafe' in window)).toBe(false);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: 'artifacts/expert-training/training-375.png', fullPage: true });
  expect(confirmations(requests)).toHaveLength(0);
});
