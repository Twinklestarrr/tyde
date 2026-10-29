import { expect, test } from '@playwright/test';
import { expertTaskExample } from '../../apps/server/src/modules/expert/expert-task.schema';
import type { AuthUser } from '../../packages/shared/src/index';

const origin = process.env.EXPERT_ACTIONS_ORIGIN ?? 'http://127.0.0.1:5176';
const user: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: 'EXPERT10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '专家联调员',
  realName: '测试成员',
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
  createdAt: '2026-10-27T02:00:00.000Z',
  updatedAt: '2026-10-27T02:00:00.000Z',
};

test('专家未知响应关闭弹窗仍锁定来源，已成功但回读失败不会恢复旧接单按钮', async ({ page }) => {
  const state = {
    unknown: true,
    readStatus: 200,
    failReadAfterWrite: false,
    completed: false,
    writes: 0,
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        json: { code: status, message: status === 200 ? '操作成功' : '待办读取暂不可用', data },
      });
    if (path === '/api/v1/users/me') return reply(user);
    if (path === '/api/v1/expert-assignments/my-tasks') {
      const task = state.completed
        ? {
            ...expertTaskExample,
            acceptanceStatus: 'ACCEPTED',
            branchNodeCode: 'STANDARD_TRAINING',
            operations: { canAccept: false, canReject: false, canReportOutput: false },
          }
        : expertTaskExample;
      return reply(state.readStatus === 200 ? [task] : null, state.readStatus);
    }
    if (path === '/api/v1/expert-assignments/respond') {
      state.writes++;
      if (state.unknown) return route.abort('failed');
      state.completed = true;
      if (state.failReadAfterWrite) state.readStatus = 503;
      return reply({
        assignmentId: 1,
        movementId: null,
        status: 'ACCEPTED',
        memberStatus: null,
        nextAction: 'WAIT_ENTRY_CONFIRMATION',
        notifiedMemberCount: 0,
      });
    }
    return reply(null, 404);
  });
  await page.goto(`${origin}/#/`);
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '拒绝项目', exact: true });
  await dialog.getByLabel('拒绝原因', { exact: true }).fill('暂不参加，保留该输入');
  await dialog.getByRole('button', { name: '确认拒绝', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '刷新任务状态', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('拒绝原因', { exact: true })).toHaveValue('暂不参加，保留该输入');
  await expect(dialog.getByRole('button', { name: '确认拒绝', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '接单', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
  expect(state.writes).toBe(1);

  state.readStatus = 503;
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page.getByText('待办读取暂不可用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '接单', exact: true })).toHaveCount(0);
  state.readStatus = 200;
  state.unknown = false;
  await page.getByRole('button', { name: '重试读取项目', exact: true }).click();
  await page.getByRole('button', { name: '接单', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认接单', exact: true });
  state.failReadAfterWrite = true;
  await dialog.getByRole('button', { name: '确认接单', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('接单成功。等待确认入项安排。最新项目读取失败，请刷新项目确认当前状态。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '接单', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重试读取项目', exact: true }).click();
  expect(state.writes).toBe(2);
  state.readStatus = 200;
  await page.getByRole('button', { name: '重试读取项目', exact: true }).click();
  await expect(page.getByText('已接单', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '接单', exact: true })).toHaveCount(0);
  expect(state.writes).toBe(2);
});
