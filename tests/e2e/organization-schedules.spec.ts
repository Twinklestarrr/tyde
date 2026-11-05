import { expect, test, type Page } from '@playwright/test';
import type {
  AuthUser,
  OrganizationDetail,
  OrganizationScheduleDay,
  OrganizationScheduleMember,
  OrganizationSchedulesInput,
} from '../../packages/shared/src/index';
import { expectPickerOnBodyClick } from './native-picker';

const origin = 'http://127.0.0.1:5176';
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const orgId = uuid(100);
const timestamp = '2026-10-26T01:00:00.000Z';
const organization: OrganizationDetail = {
  id: orgId,
  name: '排班联调组织',
  unifiedCreditCode: null,
  description: null,
  businessLicenseUrl: null,
  logoUrl: null,
  expertiseTags: [],
  verifyStatus: 'APPROVED',
  status: 'ACTIVE',
  position: 'OWNER',
  createdAt: timestamp,
};
const user: AuthUser = {
  id: uuid(1),
  uid: 'SCHEDULE10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '排班主管',
  realName: '测试主管',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['EXPERT', 'PM', 'NAVIGATOR'],
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
const summary = {
  presentCount: 0,
  lateCount: 0,
  earlyLeaveCount: 0,
  leaveCount: 0,
  absentCount: 0,
};
function member(id: number, month: string): OrganizationScheduleMember {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return {
    memberId: uuid(1000 + id),
    userId: uuid(id),
    realName: id === 2 ? '联调成员甲' : `排班成员${id}`,
    nickname: null,
    joinStatus: id === 3 ? 'PENDING_ACTIVATION' : 'ACTIVE',
    canSchedule: id !== 3,
    summary,
    days: Array.from({ length: last.getUTCDate() }, (_, index): OrganizationScheduleDay => ({
      scheduleDate: `${month}-${String(index + 1).padStart(2, '0')}`,
      scheduleId: null,
      calendarStatus: 'UNSCHEDULED',
      dayType: null,
      shiftStartAt: null,
      shiftEndAt: null,
      timezone: null,
      sourceType: null,
      batchNo: null,
      status: null,
      versionNo: null,
      dailyId: null,
      autoStatus: null,
      finalStatus: null,
      firstClockInAt: null,
      lastClockOutAt: null,
      reviewRequired: null,
      reviewReason: null,
      manualOverride: null,
      dailyVersionNo: null,
      ...(id === 2 && index === 11
        ? {
            scheduleId: 12,
            calendarStatus: 'PENDING_ATTENDANCE',
            dayType: 'WORK',
            shiftStartAt: `${month}-12T09:00:30`,
            shiftEndAt: `${month}-12T18:00:45`,
            timezone: 'Asia/Shanghai',
            sourceType: 'MANUAL',
            batchNo: 'SCH-FIXTURE',
            status: 'ACTIVE',
            versionNo: 3,
          }
        : {}),
    })),
  };
}
type RequestLog = {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
};
async function backend(page: Page, desktop = false, position: 'OWNER' | 'MEMBER' = 'OWNER') {
  const state = {
    batchStatus: 200,
    detailStatus: 200,
    listStatus: 200,
    holidayStatus: 200,
    skippedCount: 0,
    failReadAfterWrite: false,
  };
  const requests: RequestLog[] = [];
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'schedules_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = await request.allHeaders();
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    requests.push({ path, method: request.method(), body, headers });
    const reply = (data: unknown, status = 200, message = '成功') =>
      route.fulfill({
        status,
        json: {
          code: status,
          message,
          data,
        },
      });
    if (path === '/api/v1/organizations/calendar/holidays') {
      if (state.holidayStatus !== 200) return reply(null, state.holidayStatus, '节假日读取失败');
      const month = new URL(request.url()).searchParams.get('month');
      return reply({
        month,
        days:
          month === '2026-10'
            ? [
                {
                  date: '2026-10-01',
                  dayOfWeek: 4,
                  weekName: '星期四',
                  calendarDayType: 'PUBLIC_HOLIDAY',
                  holidayName: '节假日',
                  defaultScheduleDayType: 'REST',
                },
                {
                  date: '2026-10-10',
                  dayOfWeek: 6,
                  weekName: '星期六',
                  calendarDayType: 'MAKEUP_WORKDAY',
                  holidayName: '调休',
                  defaultScheduleDayType: 'WORK',
                },
              ]
            : [],
      });
    }
    if (path === '/api/v1/projects/workbench/statistics')
      return reply({
        mode: 'TASK',
        pendingTaskCount: 0,
        completedTaskCount: 0,
        involvedProjectCount: 0,
      });
    if (path === '/api/v1/users/me')
      return reply({ ...user, organization: { ...user.organization!, position } });
    if (path === '/api/v1/organizations' && request.method() === 'GET')
      return reply({ ...organization, position });
    if (path === '/api/v1/organizations/members')
      return reply({ total: 0, pages: 0, current: 1, size: 20, records: [] });
    if (path === '/api/v1/organizations/schedules') {
      if (state.listStatus !== 200) return reply(null, state.listStatus, '排班列表暂时不可用');
      const query = body as unknown as OrganizationSchedulesInput;
      const total = query.keyword ? 1 : 21;
      const current = query.current ?? 1,
        size = query.size ?? 20;
      const count = Math.min(size, Math.max(0, total - (current - 1) * size));
      return reply({
        month: query.month,
        total,
        pages: Math.ceil(total / size),
        current,
        size,
        members: Array.from({ length: count }, (_, index) =>
          member(2 + (current - 1) * size + index, query.month),
        ),
      });
    }
    if (
      path === '/api/v1/organizations/schedules/batch' ||
      path === '/api/v1/organizations/schedules/details/batch'
    ) {
      const detail = path.includes('/details/');
      const status = detail ? state.detailStatus : state.batchStatus;
      if (status !== 200)
        return reply(null, status, status === 409 ? '排班版本冲突，请核对' : '排班保存暂时不可用');
      if (state.failReadAfterWrite) state.listStatus = 503;
      const submittedRows = detail
        ? (body!.schedules as { memberId: string; scheduleDate: string }[])
        : [];
      return reply({
        batchNo: 'SCH-ISOLATED-TEST',
        createdCount: 0,
        updatedCount: detail ? submittedRows.length - state.skippedCount : 0,
        skippedCount: detail ? state.skippedCount : 1,
        conflicts: detail
          ? submittedRows.slice(0, state.skippedCount).map((row, index) => ({
              memberId: row.memberId,
              scheduleDate: row.scheduleDate,
              scheduleId: 12 + index,
              versionNo: 3,
            }))
          : [{ memberId: uuid(1002), scheduleDate: '2026-10-12', scheduleId: 12, versionNo: 3 }],
      });
    }
    return reply(null, 404, '未匹配接口');
  });
  const calls = (path: string) =>
    requests.filter((request) => request.path === `/api/v1/organizations/schedules${path}`);
  return { state, requests, calls };
}
async function openSchedules(page: Page) {
  await page.goto(`${origin}/#/organization?tab=schedules`);
  await expect(page.getByRole('heading', { name: '组织排班', exact: true })).toBeVisible();
  await page.getByLabel('排班月份', { exact: true }).fill('2026-10');
  await expect(page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true })).toBeVisible();
}

test('组织排班活动页签加载、服务器筛选分页、月份变化清选且待激活不可选', async ({ page }) => {
  const { calls } = await backend(page);
  await page.goto(`${origin}/#/organization`);
  await expect(page.getByRole('tab', { name: '排班管理' })).toBeVisible();
  expect(calls('')).toHaveLength(0);
  await page.getByRole('tab', { name: '排班管理' }).click();
  await page.getByLabel('排班月份', { exact: true }).fill('2026-10');
  await expect(page.getByRole('checkbox', { name: '选择 排班成员3', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true }).check();
  await expect(page.getByRole('button', { name: '批量排班（1 人）' })).toBeEnabled();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择 排班成员22', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '批量排班（1 人）', exact: true })).toBeEnabled();
  expect(calls('').at(-1)?.body?.current).toBe(2);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true }).check();
  await page.getByLabel('排班月份', { exact: true }).fill('2026-11');
  await expect(page.getByRole('button', { name: '批量排班', exact: true })).toBeDisabled();
  await page.getByLabel('姓名 / 完整手机号', { exact: true }).fill('联调成员甲');
  await page.getByRole('button', { name: '查询排班', exact: true }).click();
  await expect
    .poll(() => calls('').at(-1)?.body)
    .toEqual({ orgId, month: '2026-11', current: 1, size: 20, keyword: '联调成员甲' });
  await expect(page.getByRole('checkbox', { name: '选择 排班成员3', exact: true })).toHaveCount(0);
});

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron 运行配置', true],
] as const) {
  test(`${mode} 组织排班失败保留草稿、同内容复用幂等键、修改内容换键及保存后回读失败`, async ({
    page,
  }) => {
    const { state, calls } = await backend(page, desktop);
    await openSchedules(page);
    await expectPickerOnBodyClick(page.getByLabel('排班月份', { exact: true }));
    await page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true }).check();
    await page.getByRole('button', { name: '批量排班（1 人）' }).click();
    const dialog = page.getByRole('dialog', { name: '组织批量排班', exact: true });
    await expectPickerOnBodyClick(dialog.getByLabel(/^目标月份/));
    await expectPickerOnBodyClick(dialog.getByLabel(/^基础上班时间/));
    await expectPickerOnBodyClick(dialog.getByLabel(/^基础下班时间/));
    await dialog.getByRole('button', { name: /联调成员甲 2026-10-12 已有出勤/ }).click();
    await dialog.getByLabel('当天上班', { exact: true }).fill('10:00');
    state.detailStatus = 503;
    await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认提交组织排班', exact: true })
      .getByRole('button', { name: '确认提交', exact: true })
      .click();
    await expect(dialog.getByText('排班保存暂时不可用')).toBeVisible();
    expect(calls('/details/batch')).toHaveLength(1);
    await expect(dialog.getByLabel('当天上班', { exact: true })).toHaveValue('10:00');
    await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认提交组织排班', exact: true })
      .getByRole('button', { name: '确认提交', exact: true })
      .click();
    await expect.poll(() => calls('/details/batch').length).toBe(2);
    expect(calls('/details/batch')[1]?.headers['idempotency-key']).toBe(
      calls('/details/batch')[0]?.headers['idempotency-key'],
    );
    await dialog.getByLabel('当天排班类型', { exact: true }).selectOption('REST');
    state.detailStatus = 200;
    state.failReadAfterWrite = true;
    await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认提交组织排班', exact: true })
      .getByRole('button', { name: '确认提交', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText('排班已保存，但读取最新数据失败，请点击刷新排班重新读取。'),
    ).toBeVisible();
    const request = calls('/details/batch').at(-1)!;
    expect(request.headers['idempotency-key']).not.toBe(
      calls('/details/batch')[0]?.headers['idempotency-key'],
    );
    expect(request.headers.cookie).toContain('schedules_session=active');
    expect(request.headers['x-tyde-client']).toBe('web');
    expect(request.body).toEqual({
      orgId,
      schedules: [
        {
          memberId: uuid(1002),
          scheduleDate: '2026-10-12',
          dayType: 'REST',
          timezone: 'Asia/Shanghai',
        },
      ],
      timezone: 'Asia/Shanghai',
      overwrite: false,
    });
    expect(calls('/details/batch')).toHaveLength(3);
    state.listStatus = 200;
    await page.getByRole('button', { name: '刷新排班', exact: true }).click();
    await expect(page.getByText('排班列表暂时不可用')).not.toBeVisible();
    expect(calls('/details/batch')).toHaveLength(3);
    // 已成功的操作不再沿用旧回执；相同内容的新一次排班须重新执行。
    state.failReadAfterWrite = false;
    await page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true }).check();
    await page.getByRole('button', { name: '批量排班（1 人）' }).click();
    await dialog.getByRole('button', { name: /联调成员甲 2026-10-12 已有出勤/ }).click();
    await dialog.getByLabel('当天排班类型', { exact: true }).selectOption('REST');
    await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认提交组织排班', exact: true })
      .getByRole('button', { name: '确认提交', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(calls('/details/batch')).toHaveLength(4);
    expect(calls('/details/batch')[3]?.body).toEqual(calls('/details/batch')[2]?.body);
    expect(calls('/details/batch')[3]?.headers['idempotency-key']).not.toBe(
      calls('/details/batch')[2]?.headers['idempotency-key'],
    );
  });
}

test('每日排班使用明细接口，409后显式读取保留草稿并手动重试', async ({ page }) => {
  const { state, calls } = await backend(page);
  await openSchedules(page);
  await page.getByRole('button', { name: '编辑 联调成员甲 2026-10-12 排班', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑每日排班', exact: true });
  await expect(dialog.getByLabel(/^上班时间/)).toHaveValue('09:00:30');
  await expect(dialog.getByLabel(/^下班时间/)).toHaveValue('18:00:45');
  await dialog.getByLabel(/^上班时间/).fill('10:00');
  await dialog.getByLabel('覆盖已有排班（未勾选时跳过已有排班）', { exact: true }).check();
  state.detailStatus = 409;
  await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认提交组织排班', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect(dialog.getByText('排班版本冲突，请核对')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '提交排班', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '读取最新排班', exact: true }).click();
  await expect(dialog.getByLabel(/^上班时间/)).toHaveValue('10:00');
  state.detailStatus = 200;
  await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认提交组织排班', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(calls('/batch')).toHaveLength(0);
  const requests = calls('/details/batch');
  expect(requests).toHaveLength(2);
  expect(requests[0]?.headers['idempotency-key']).toBe(requests[1]?.headers['idempotency-key']);
  expect(requests[1]?.body).toEqual({
    orgId,
    schedules: [
      {
        memberId: uuid(1002),
        scheduleDate: '2026-10-12',
        dayType: 'WORK',
        startTime: '10:00',
        endTime: '18:00:45',
        timezone: 'Asia/Shanghai',
      },
    ],
    overwrite: true,
  });
});

test('普通成员不展示组织排班页签或发起管理请求', async ({ page }) => {
  const { calls } = await backend(page, false, 'MEMBER');
  await page.goto(`${origin}/#/organization?tab=schedules`);
  await expect(page.getByRole('heading', { name: '我的组织关系', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '排班管理' })).toHaveCount(0);
  expect(calls('')).toHaveLength(0);
});

test('批量草稿按成员整月生成、节假日调休优先且单日修改即时生效，换月清空', async ({ page }) => {
  const { calls, state } = await backend(page);
  await openSchedules(page);
  await page.getByRole('checkbox', { name: '选择 联调成员甲', exact: true }).check();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 排班成员22', exact: true }).check();
  await page.getByRole('button', { name: '批量排班（2 人）', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '组织批量排班', exact: true });
  await expect(dialog.getByRole('button', { name: '提交排班', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^基础下班时间/).fill('19:00');
  await expect(
    dialog.getByText('基础班次扣除 1 小时休息后有效工时为 9 小时，超过 8 小时。'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '一键排班', exact: true }).click();
  await expect(dialog.getByText(/本次草稿 62 条/)).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '联调成员甲 2026-10-01 本次休息', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '联调成员甲 2026-10-10 本次出勤', exact: true }),
  ).toBeVisible();
  expect(calls('/details/batch')).toHaveLength(0);
  await dialog.getByLabel(/^目标月份/).fill('2026-11');
  await expect(dialog.getByText(/本次草稿 0 条/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /2026-10-/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: '一键排班', exact: true }).click();
  await expect(dialog.getByText(/本次草稿 60 条/)).toBeVisible();
  await dialog.getByRole('button', { name: '联调成员甲 2026-11-02 本次出勤', exact: true }).click();
  await dialog.getByLabel('当天排班类型', { exact: true }).selectOption('REST');
  await dialog.getByRole('button', { name: '排班成员22 2026-11-02 本次出勤', exact: true }).click();
  await dialog.getByLabel('当天上班', { exact: true }).fill('20:00');
  await expect(dialog.getByRole('button', { name: '提交排班', exact: true })).toBeDisabled();
  await dialog.getByLabel('当天上班', { exact: true }).fill('10:00');
  await dialog.getByRole('button', { name: '提交排班', exact: true }).click();
  expect(calls('/details/batch')).toHaveLength(0);
  const confirm = page.getByRole('dialog', { name: '确认提交组织排班', exact: true });
  await expect(confirm.getByText('目标月份 2026-11；排班 2 人，明细 60 条。')).toBeVisible();
  state.skippedCount = 2;
  await confirm.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(calls('/batch')).toHaveLength(0);
  await expect(page.getByText('有 2 条已有排班冲突未覆盖', { exact: true })).toBeVisible();
  await expect(page.getByText(/排班已保存：新增/)).toHaveCount(0);
  const input = calls('/details/batch')[0]!.body!;
  const rows = input.schedules as {
    memberId: string;
    scheduleDate: string;
    dayType: string;
    timezone: string;
    startTime?: string;
    endTime?: string;
  }[];
  expect(input).toMatchObject({ orgId, timezone: 'Asia/Shanghai', overwrite: false });
  expect(rows).toHaveLength(60);
  expect(
    rows.every(
      (row) => row.timezone === 'Asia/Shanghai' && row.scheduleDate.startsWith('2026-11-'),
    ),
  ).toBe(true);
  expect(
    rows.find((row) => row.memberId === uuid(1002) && row.scheduleDate === '2026-11-02'),
  ).toEqual({
    memberId: uuid(1002),
    scheduleDate: '2026-11-02',
    dayType: 'REST',
    timezone: 'Asia/Shanghai',
  });
  expect(
    rows.find((row) => row.memberId === uuid(1022) && row.scheduleDate === '2026-11-02'),
  ).toMatchObject({ dayType: 'WORK', startTime: '10:00', endTime: '19:00' });
});
