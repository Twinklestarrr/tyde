import { test, expect } from '@playwright/test';
import type { AuthUser, OrganizationDetail } from '../../packages/shared/src/index';

const timestamp = '2026-01-01T00:00:00.000Z';
const organization: OrganizationDetail = {
  id: '00000000-0000-4000-8000-000000000100',
  name: '潮汐协作组',
  unifiedCreditCode: null,
  description: '统一界面的隔离测试组织',
  businessLicenseUrl: null,
  logoUrl: null,
  expertiseTags: [],
  verifyStatus: 'APPROVED',
  status: 'ACTIVE',
  position: 'OWNER',
  createdAt: timestamp,
};
const user: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: 'TYDE10001',
  accountType: 'INDIVIDUAL',
  phone: '13812345678',
  nickname: '潮汐测试员',
  realName: '测试小明',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['EXPERT'],
  selectedRole: 'EXPERT',
  hasExpertManagementRole: true,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: { ...organization, joinStatus: 'ACTIVE' },
  createdAt: timestamp,
  updatedAt: timestamp,
};

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
  { width: 812, height: 375 },
]) {
  test(`统一UI在${viewport.width}×${viewport.height}保留控件尺度、内容滚动与关闭后焦点`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const writes: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const reply = (data: unknown) =>
        route.fulfill({ json: { code: 200, message: '操作成功', data } });
      if (path === '/api/v1/users/me') return reply(user);
      if (path === '/api/v1/organizations') return reply(organization);
      if (path === '/api/v1/organizations/members')
        return reply({ total: 0, pages: 0, current: 1, size: 20, records: [] });
      if (path === '/api/v1/expert-assignments/my-tasks') return reply([]);
      if (request.method() !== 'GET') writes.push(path);
      return route.fulfill({
        status: 500,
        json: { code: 500, message: '未配置的测试接口', data: null },
      });
    });

    await page.goto('/#/auth');
    const phone = page.getByRole('textbox', { name: '手机号', exact: true });
    await expect(phone).toHaveCSS('height', '40px');
    await expect(phone).toHaveCSS('border-radius', '8px');
    const submit = page.getByRole('button', { name: '继续', exact: true });
    await expect(submit).toHaveCSS('height', '52px');
    await expect(submit).toHaveCSS('border-radius', '8px');

    await page.goto('/#/organization');
    await expect(page.getByRole('heading', { name: '组织管理', exact: true })).toHaveCSS(
      'font-size',
      '24px',
    );
    await expect(page.locator('[data-slot="card"]').first()).toHaveCSS('border-radius', '12px');
    await expect(page.locator('[data-slot="card-title"]').first()).toHaveCSS('font-size', '16px');
    const opener = page.getByRole('button', { name: '编辑组织资料', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '编辑组织资料', exact: true });
    await expect(dialog).toHaveCSS('border-radius', '12px');
    await expect(dialog.locator('[data-slot="dialog-header"] h2')).toHaveCSS('font-size', '18px');
    const close = dialog.getByRole('button', { name: '关闭弹窗', exact: true });
    await expect(close).toHaveCSS('width', '44px');
    await expect(close).toHaveCSS('height', '44px');
    await expect(dialog.locator('[data-slot="dialog-content"]')).toHaveCSS('overflow-y', 'auto');
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    await page.screenshot({
      path: `artifacts/ui-unification/organization-dialog-${viewport.width}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(writes).toEqual([]);
  });
}

for (const role of ['NAVIGATOR', 'PM', 'EXPERT'] as const) {
  for (const width of [1280, 375]) {
    test(`${role}项目空状态在${width}宽度下搜索图标内嵌且工具栏紧凑`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const taskQueries: unknown[] = [];
      let listReads = 0;
      const unexpected: string[] = [];
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const reply = (data: unknown) =>
          route.fulfill({ json: { code: 200, message: '操作成功', data } });
        if (path === '/api/v1/users/me')
          return reply({ ...user, role, selectedRole: role, roles: ['NAVIGATOR', 'PM', 'EXPERT'] });
        if (path === '/api/v1/projects/draft/current')
          return reply({ hasDraft: false, draft: null });
        if (['/api/v1/projects/list', '/api/v1/projects/manager/list'].includes(path)) {
          listReads++;
          return reply([]);
        }
        if (path === '/api/v1/expert-assignments/my-tasks') {
          taskQueries.push(request.postDataJSON());
          return reply([]);
        }
        unexpected.push(path);
        return route.fulfill({
          status: 500,
          json: { code: 500, message: '未配置的测试接口', data: null },
        });
      });
      await page.goto('/#/');
      await expect(page.getByText('暂无待办项目', { exact: true })).toBeVisible();
      const search = page.getByRole('searchbox', { name: '筛选当前待办', exact: true });
      const refresh = page.getByRole('button', { name: '刷新项目', exact: true });
      const searchBox = (await search.boundingBox())!;
      const refreshBox = (await refresh.boundingBox())!;
      const icon = search.locator('..').locator('svg.lucide-search');
      await expect(icon).toHaveCount(1);
      const iconBox = (await icon.boundingBox())!;
      expect(iconBox.x).toBeGreaterThanOrEqual(searchBox.x);
      expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(searchBox.x + searchBox.width);
      expect(iconBox.width).toBe(16);
      expect(
        Math.abs(iconBox.y + iconBox.height / 2 - searchBox.y - searchBox.height / 2),
      ).toBeLessThanOrEqual(1);
      expect(searchBox.height).toBe(width <= 640 ? 44 : 40);
      expect(refreshBox.height).toBe(searchBox.height);
      expect(refreshBox.x - searchBox.x - searchBox.width).toBeGreaterThanOrEqual(0);
      expect(refreshBox.x - searchBox.x - searchBox.width).toBeLessThanOrEqual(16);
      if (role === 'EXPERT') {
        const buttonBox = (await page
          .getByRole('button', { name: '查询项目', exact: true })
          .boundingBox())!;
        expect(buttonBox.x).toBeGreaterThanOrEqual(searchBox.x);
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(searchBox.x + searchBox.width);
      }
      const empty = page.locator('[data-slot="empty-state"]');
      await expect(empty.locator('..')).toHaveCSS('border-radius', '12px');
      await expect(empty.locator('..')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      expect((await empty.boundingBox())!.height).toBeGreaterThanOrEqual(240);
      await expect(empty.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
      await expect(page.getByRole('article')).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/ui-empty-state/${role}-${width}.png`,
        fullPage: true,
      });
      const readsBefore = listReads + taskQueries.length;
      await search.fill('标注');
      expect(listReads + taskQueries.length).toBe(readsBefore);
      if (role === 'EXPERT') {
        await search.press('Enter');
        await expect.poll(() => taskQueries.at(-1)).toEqual({ keyword: '标注' });
        await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
        await search.fill('未提交的搜索');
        const beforeRefresh = taskQueries.length;
        await refresh.click();
        await expect.poll(() => taskQueries.length).toBeGreaterThan(beforeRefresh);
        expect(taskQueries.at(-1)).toEqual({ keyword: '标注' });
      } else {
        await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
      }
      await page.getByRole('button', { name: '清除搜索', exact: true }).click();
      await expect(search).toHaveValue('');
      await expect(page.getByText('暂无待办项目', { exact: true })).toBeVisible();
      const beforeReload = listReads + taskQueries.length;
      await empty.getByRole('button', { name: '重新加载', exact: true }).click();
      await expect.poll(() => listReads + taskQueries.length).toBeGreaterThan(beforeReload);
      expect(unexpected).toEqual([]);
    });
  }
}
