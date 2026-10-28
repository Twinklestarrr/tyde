import { test, expect, type Page } from '@playwright/test';
import type {
  AuthUser,
  WorkbenchAttendanceDay,
  WorkbenchAttendanceMonth,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const orgId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const applicationId = '00000000-0000-4000-8000-000000000004';
const userFixture: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: 'ATTENDANCE10001',
  accountType: 'INDIVIDUAL',
  phone: '138****5678',
  nickname: '考勤联调员',
  realName: '测试成员',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  selectedRole: 'EXPERT',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
type Captured = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

async function backend(page: Page, position: 'MEMBER' | 'ADMIN' | 'OWNER' | null, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  const user = structuredClone(userFixture);
  if (position)
    user.organization = {
      id: orgId,
      name: '考勤联调组织',
      position,
      joinStatus: 'ACTIVE',
      status: 'ACTIVE',
      verifyStatus: 'APPROVED',
    };
  const state = {
    scheduleStatus: 503,
    applyStatus: 200,
    updateStatus: 200,
    dailyVersionNo: 2,
    pending: false,
    allow: true,
  };
  const requests: Captured[] = [];
  const calendar = (month: string): WorkbenchAttendanceMonth => {
    const count = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
    ).getUTCDate();
    const days: WorkbenchAttendanceDay[] = Array.from({ length: count }, (_, index) => {
      const scheduleDate = `${month}-${String(index + 1).padStart(2, '0')}`;
      const work = position != null && index === 0;
      const past = position != null && index === 1;
      return {
        scheduleId: work || past ? 11 + index : null,
        scheduleDate,
        calendarStatus: work ? 'PENDING_ATTENDANCE' : past ? 'ABSENT' : 'UNSCHEDULED',
        dayType: work || past ? 'WORK' : null,
        shiftStartAt: work || past ? `${scheduleDate} 09:00:00` : null,
        shiftEndAt: work || past ? `${scheduleDate} 18:00:00` : null,
        timezone: work || past ? 'Asia/Shanghai' : null,
        sourceType: work || past ? 'MANUAL' : null,
        batchNo: null,
        status: work || past ? 'ACTIVE' : null,
        versionNo: work || past ? 17 : null,
        dailyId: past ? 71 : null,
        autoStatus: past ? 'ABSENT' : null,
        finalStatus: past ? 'ABSENT' : null,
        firstClockInAt: null,
        lastClockOutAt: null,
        reviewRequired: past ? false : null,
        reviewReason: null,
        manualOverride: past ? false : null,
        dailyVersionNo: past ? state.dailyVersionNo : null,
        application:
          work && state.pending
            ? {
                applicationId,
                flowNo: 'ATTENDANCE-FLOW',
                flowVersionNo: 7,
                applicationType: 'LEAVE',
                status: 'PENDING',
                finalStatus: 'LEAVE',
                canWithdraw: true,
              }
            : null,
        permissions: {
          canApplyLeave: work && position !== 'OWNER' && !state.pending && state.allow,
          canApplyCorrection: past && position !== 'OWNER' && state.allow,
          canWithdraw: work && state.pending,
          canDirectUpdate: past && position !== 'MEMBER' && state.allow,
        },
      };
    });
    return {
      organizationId: position ? orgId : null,
      independentSchedule: !position,
      month,
      memberId: position ? memberId : null,
      userId: user.id,
      realName: user.realName,
      nickname: user.nickname,
      summary: {
        presentCount: 0,
        lateCount: 0,
        earlyLeaveCount: 0,
        leaveCount: 0,
        absentCount: position ? 1 : 0,
      },
      days,
      permissions: {
        canBatchSchedule: !position,
        canDirectUpdate: position === 'OWNER' || position === 'ADMIN',
        canApply: position === 'MEMBER' || position === 'ADMIN',
        canWithdraw: state.pending,
      },
    };
  };
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : {};
    requests.push({ path, method: request.method(), body, headers: await request.allHeaders() });
    const reply = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        json: {
          code: status,
          message:
            status === 503 ? '考勤写入暂不可用' : status === 409 ? '考勤版本已变化' : '操作成功',
          data,
        },
      });
    if (path === '/api/v1/users/me') return reply(user);
    if (path === '/api/v1/expert-assignments/my-projects') return reply([]);
    if (path === '/api/v1/organizations/attendance')
      return reply(calendar(url.searchParams.get('month')!));
    if (path === '/api/v1/organizations/calendar/holidays')
      return reply({ month: url.searchParams.get('month'), days: [] });
    if (path === '/api/v1/organizations/schedules')
      return reply({ month: body.month, total: 0, pages: 0, current: 1, size: 20, members: [] });
    if (path === '/api/v1/organizations')
      return reply({
        id: orgId,
        name: '考勤联调组织',
        unifiedCreditCode: null,
        description: null,
        businessLicenseUrl: null,
        logoUrl: null,
        expertiseTags: [],
        verifyStatus: 'APPROVED',
        status: 'ACTIVE',
        position,
        createdAt: user.createdAt,
      });
    if (path === '/api/v1/users/me/schedules/batch')
      return reply(
        state.scheduleStatus === 200
          ? {
              batchNo: 'SELF-ATTENDANCE-BATCH',
              createdCount: 1,
              updatedCount: 0,
              skippedCount: 1,
              conflicts: [{ scheduleDate: '2026-10-02', scheduleId: 51, versionNo: 2 }],
            }
          : null,
        state.scheduleStatus,
      );
    if (path === '/api/v1/organizations/attendance/update')
      return reply(
        state.updateStatus === 200
          ? {
              id: 71,
              beforeStatus: 'ABSENT',
              finalStatus: body.finalStatus,
              manualOverride: true,
              manualRemark: body.manualRemark,
              correctedBy: user.uid,
              correctedAt: '2026-10-22 10:00:00',
              versionNo: state.dailyVersionNo + 1,
              adjustmentId: 91,
            }
          : null,
        state.updateStatus,
      );
    if (
      path === '/api/v1/organizations/attendance/apply' ||
      path === '/api/v1/organizations/attendance/withdraw'
    ) {
      const withdraw = path.endsWith('/withdraw');
      if (!withdraw && state.applyStatus !== 200) return reply(null, state.applyStatus);
      state.pending = !withdraw;
      return reply({
        applicationId,
        flowNo: 'ATTENDANCE-FLOW',
        flowVersionNo: withdraw ? 8 : 7,
        businessType:
          body.applicationType === 'CORRECTION' ? 'ATTENDANCE_CORRECTION' : 'ATTENDANCE_LEAVE',
        applicationType: body.applicationType || 'LEAVE',
        attendanceDate: body.attendanceDate || '2026-10-01',
        finalStatus: body.finalStatus || 'LEAVE',
        status: withdraw ? 'WITHDRAWN' : 'PENDING',
        versionNo: body.versionNo ?? null,
        dailyId: body.dailyId ?? null,
        leaveStartAt:
          body.applicationType === 'CORRECTION' ? null : body.leaveStartAt || '2026-10-01 10:00:00',
        leaveEndAt:
          body.applicationType === 'CORRECTION' ? null : body.leaveEndAt || '2026-10-01 12:00:00',
        appliedAt: '2026-10-22T02:00:00.000Z',
        finishedAt: withdraw ? '2026-10-22T03:00:00.000Z' : null,
      });
    }
    return reply(null, 404);
  });
  return { state, requests };
}
async function openAttendance(page: Page) {
  await page.goto(`${origin}/#/profile`);
  const attendanceTab = page.getByRole('tab', { name: '排班考勤', exact: true });
  await attendanceTab.click();
  await expect(attendanceTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '返回个人主页', exact: true })).toHaveCount(0);
  await page.getByLabel('考勤月份', { exact: true }).fill('2026-10');
  await page.getByRole('button', { name: '查询考勤', exact: true }).click();
  await expect(page.getByLabel('2026-10 本人考勤月历')).toBeVisible();
}

for (const desktop of [false, true])
  test(`${desktop ? '桌面适配' : 'Web'}个人排班失败保留草稿，同稿复用幂等键，编辑换键并展示跳过明细`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page, null, desktop);
    await openAttendance(page);
    const attendance = page.getByRole('region', { name: '我的排班考勤', exact: true });
    await expect(attendance.getByText('个人排班', { exact: true })).toBeVisible();
    await expect(
      attendance.getByText('可为自己设置工作日、休息日和班次。', { exact: true }),
    ).toBeVisible();
    await expect(
      attendance.getByText('当前组织排班仅支持查看，暂不支持新增或修改班次。', { exact: true }),
    ).toHaveCount(0);
    await attendance.getByRole('button', { name: '为自己排班', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '为自己排班', exact: true });
    await dialog.getByLabel('排班结束日期').fill('2026-10-02');
    await dialog.getByRole('button', { name: '生成排班日期' }).click();
    await dialog.getByLabel('2026-10-02 日类型').selectOption('REST');
    await dialog.getByRole('button', { name: '保存排班' }).click();
    await expect(dialog.getByText('考勤写入暂不可用', { exact: true })).toBeVisible();
    const writes = () => requests.filter(({ path }) => path.endsWith('/schedules/batch'));
    expect(writes()).toHaveLength(1);
    await dialog.getByRole('button', { name: '保存排班' }).click();
    await expect.poll(() => writes().length).toBe(2);
    expect(writes()[1].headers['idempotency-key']).toBe(writes()[0].headers['idempotency-key']);
    await expect(dialog.getByRole('button', { name: '保存排班' })).toBeEnabled();
    await dialog.getByLabel('2026-10-01 上班时间').fill('10:00');
    state.scheduleStatus = 200;
    await dialog.getByRole('button', { name: '保存排班' }).click();
    await expect(dialog.getByText(/已有排班未覆盖：2026-10-02/)).toBeVisible();
    expect(writes()).toHaveLength(3);
    expect(writes()[2].method).toBe('PUT');
    expect(writes()[2].headers['idempotency-key']).not.toBe(writes()[1].headers['idempotency-key']);
    expect(writes()[2].body).toMatchObject({
      overwrite: false,
      timezone: 'Asia/Shanghai',
      schedules: [
        { scheduleDate: '2026-10-01', dayType: 'WORK', startTime: '10:00' },
        { scheduleDate: '2026-10-02', dayType: 'REST' },
      ],
    });
    expect((writes()[2].body.schedules as unknown[])[1]).toEqual({
      scheduleDate: '2026-10-02',
      dayType: 'REST',
    });
    expect(writes()[2].body).not.toHaveProperty('userId');
    expect(writes()[2].body).not.toHaveProperty('orgId');
  });

test('组织成员按日权限请假，使用null日版本并按真实流程版本撤回', async ({ page }) => {
  const { requests } = await backend(page, 'MEMBER');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAttendance(page);
  const attendance = page.getByRole('region', { name: '我的排班考勤', exact: true });
  await expect(attendance.getByText('组织排班', { exact: true })).toBeVisible();
  await expect(
    attendance.getByText('组织班次由主管或管理员统一安排；你可以在这里查看本人排班与考勤。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(attendance.getByRole('button', { name: '为自己排班', exact: true })).toHaveCount(0);
  await expect(attendance.getByRole('link', { name: '管理组织排班', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '2026-10-01 待出勤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '排班考勤详情', exact: true });
  await expect(dialog.getByRole('button', { name: '直接修正考勤', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '申请请假', exact: true }).click();
  await dialog.getByLabel('请假开始时间').fill('10:00');
  await dialog.getByLabel('请假结束时间').fill('12:00');
  await dialog.getByLabel('请假事由').fill('个人事务');
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const apply = requests.find(({ path }) => path.endsWith('/attendance/apply'))!;
  expect(apply.body).toEqual({
    orgId,
    attendanceDate: '2026-10-01',
    applicationType: 'LEAVE',
    finalStatus: 'LEAVE',
    reason: '个人事务',
    versionNo: null,
    leaveStartAt: '2026-10-01 10:00:00',
    leaveEndAt: '2026-10-01 12:00:00',
  });
  await page.getByRole('button', { name: '2026-10-01 待出勤', exact: true }).click();
  await dialog.getByRole('button', { name: '撤回考勤申请', exact: true }).click();
  await dialog.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.find(({ path }) => path.endsWith('/attendance/withdraw'))!.body).toEqual({
    applicationId,
    flowVersionNo: 7,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const position of ['OWNER', 'ADMIN'] as const)
  test(`${position}从个人考勤直达组织排班管理，普通人员列表不预加载`, async ({ page }) => {
    const { requests } = await backend(page, position);
    await openAttendance(page);
    await page.getByRole('link', { name: '管理组织排班', exact: true }).click();
    await expect(page).toHaveURL(/#\/organization\?tab=schedules$/);
    await expect(page.getByRole('tab', { name: '排班管理', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect
      .poll(() => requests.filter(({ path }) => path === '/api/v1/organizations/schedules').length)
      .toBe(1);
    expect(
      requests.find(({ path }) => path === '/api/v1/organizations/schedules')?.body,
    ).toMatchObject({
      orgId,
      current: 1,
      size: 20,
    });
    expect(requests.filter(({ path }) => path === '/api/v1/organizations/members')).toHaveLength(0);
  });

test('考勤修正冲突保留事由，显式重读后使用新日版本，不使用排班版本', async ({ page }) => {
  const { state, requests } = await backend(page, 'MEMBER');
  state.applyStatus = 409;
  await openAttendance(page);
  await page.getByRole('button', { name: '2026-10-02 缺勤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '排班考勤详情', exact: true });
  await dialog.getByRole('button', { name: '申请考勤修正', exact: true }).click();
  await dialog.getByLabel('修正后的考勤状态').selectOption('PRESENT');
  await dialog.getByLabel('修正事由').fill('已核实现场出勤');
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog.getByText('考勤版本已变化', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  const writes = () => requests.filter(({ path }) => path.endsWith('/attendance/apply'));
  expect(writes()).toHaveLength(1);
  expect(writes()[0].body).toMatchObject({ dailyId: 71, versionNo: 2 });
  state.dailyVersionNo = 3;
  state.applyStatus = 200;
  await dialog.getByRole('button', { name: '重读考勤', exact: true }).click();
  await expect(dialog.getByLabel('修正事由')).toHaveValue('已核实现场出勤');
  await expect(dialog.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  expect(writes()).toHaveLength(1);
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes()[1].body).toEqual({
    orgId,
    attendanceDate: '2026-10-02',
    applicationType: 'CORRECTION',
    finalStatus: 'PRESENT',
    reason: '已核实现场出勤',
    dailyId: 71,
    versionNo: 3,
  });
});

test('管理员本人日考勤可直接修正，只发送dailyId与dailyVersionNo', async ({ page }) => {
  const { requests } = await backend(page, 'ADMIN');
  await openAttendance(page);
  await page.getByRole('button', { name: '2026-10-02 缺勤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '排班考勤详情', exact: true });
  await dialog.getByRole('button', { name: '直接修正考勤', exact: true }).click();
  await dialog.getByLabel('修正后的考勤状态').selectOption('PRESENT');
  await dialog.getByLabel('修正事由').fill('核实本人正常出勤');
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.find(({ path }) => path.endsWith('/attendance/update'))!.body).toEqual({
    orgId,
    dailyId: 71,
    finalStatus: 'PRESENT',
    manualRemark: '核实本人正常出勤',
    versionNo: 2,
  });
  expect(requests.filter(({ path }) => path.endsWith('/attendance/apply'))).toHaveLength(0);
});

test('主管概览与顶层入口保留考勤和申请，隐藏项目且不请求专家项目列表', async ({ page }) => {
  const { requests } = await backend(page, 'OWNER');
  await page.goto(`${origin}/#/profile`);
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(
    page.getByRole('tablist', { name: '个人中心设置', exact: true }).getByRole('tab'),
  ).toHaveText(['概览', '个人资料', '账户安全', '排班考勤', '组织与申请']);
  await expect(page.getByRole('tab', { name: '我的项目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看全部项目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理排班与考勤', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看全部申请', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理排班与考勤', exact: true }).click();
  await expect(page.getByRole('tab', { name: '排班考勤', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: '我的排班考勤', exact: true })).toBeVisible();
  const attendance = page.getByRole('region', { name: '我的排班考勤', exact: true });
  await expect(attendance.getByText('组织排班', { exact: true })).toBeVisible();
  await expect(
    attendance.getByText('可前往组织管理的排班管理，为自己和组织成员安排班次。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(attendance.getByRole('link', { name: '管理组织排班', exact: true })).toBeVisible();
  await expect(attendance.getByRole('button', { name: '为自己排班', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '组织与申请', exact: true }).click();
  await expect(page.getByRole('region', { name: '组织与申请', exact: true })).toBeVisible();
  expect(
    requests.filter(({ path }) => path.endsWith('/expert-assignments/my-projects')),
  ).toHaveLength(0);
});
