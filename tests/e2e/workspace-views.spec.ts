import { test, expect, type Page } from '@playwright/test';
import type {
  AuthUser,
  WorkbenchAssignmentDetail,
  WorkbenchAttendanceMonth,
  WorkbenchProject,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const userFixture: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: 'VIEW10001',
  accountType: 'INDIVIDUAL',
  phone: '138****5678',
  nickname: '视图联调员',
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
  organization: {
    id: '00000000-0000-4000-8000-000000000002',
    name: '视图联调组织',
    position: 'MEMBER',
    joinStatus: 'ACTIVE',
    description: '真实成员关系摘要',
    logoUrl: null,
    expertiseTags: [],
    verifyStatus: 'APPROVED',
    status: 'ACTIVE',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
interface RecordedRequest {
  path: string;
  query: Record<string, string>;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
const expertReadPaths = new Set([
  '/api/v1/expert-assignments/my-projects',
  '/api/v1/expert-assignments/detail',
  '/api/v1/organizations/attendance',
  '/api/v1/organizations/calendar/holidays',
  '/api/v1/users/me/applications',
]);
const expertReads = (requests: RecordedRequest[]) =>
  requests.filter((request) => expertReadPaths.has(request.path));

function unscheduledAttendance(
  month: string,
  user: AuthUser,
  presentDate: string | null,
): WorkbenchAttendanceMonth {
  const [year, monthNumber] = month.split('-').map(Number);
  const attendance: WorkbenchAttendanceMonth = {
    organizationId: typeof user.organization?.id === 'string' ? user.organization.id : null,
    independentSchedule: !user.organization,
    month,
    memberId: user.organization ? '00000000-0000-4000-8000-000000000004' : null,
    userId: user.id,
    realName: user.realName,
    nickname: user.nickname,
    summary: { presentCount: 0, lateCount: 0, earlyLeaveCount: 0, leaveCount: 0, absentCount: 0 },
    days: Array.from(
      { length: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() },
      (_, day) => ({
        scheduleId: null,
        scheduleDate: `${month}-${String(day + 1).padStart(2, '0')}`,
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
        application: null,
        permissions: {
          canApplyLeave: false,
          canApplyCorrection: false,
          canWithdraw: false,
          canDirectUpdate: false,
        },
      }),
    ),
    permissions: {
      canBatchSchedule: !user.organization,
      canDirectUpdate: false,
      canApply: Boolean(user.organization),
      canWithdraw: false,
    },
  };
  const presentDay = attendance.days.find((day) => day.scheduleDate === presentDate);
  if (presentDay) {
    attendance.summary.presentCount = 1;
    Object.assign(presentDay, {
      scheduleId: 31,
      calendarStatus: 'PRESENT',
      dayType: 'WORK',
      shiftStartAt: `${presentDate} 09:00:00`,
      shiftEndAt: `${presentDate} 18:00:00`,
      timezone: 'Asia/Shanghai',
      sourceType: 'MANUAL',
      status: 'ACTIVE',
      versionNo: 1,
      dailyId: 41,
      autoStatus: 'PRESENT',
      finalStatus: 'PRESENT',
      firstClockInAt: `${presentDate} 09:00:00`,
      lastClockOutAt: `${presentDate} 18:00:00`,
      reviewRequired: false,
      manualOverride: false,
      dailyVersionNo: 1,
    });
  }
  return attendance;
}
const assignmentFixture: WorkbenchAssignmentDetail = {
  assignmentId: 41,
  currentNodeCode: 'PRODUCTION_PLAN',
  availableOperations: ['VIEW_DETAIL'],
  projectDetail: {
    id: 501,
    projectNo: 'VIEW-PROJECT-501',
    requesterType: 'INDIVIDUAL',
    requesterId: '00000000-0000-4000-8000-000000000005',
    requesterName: '联调需求方',
    projectName: '真实分配详情',
    projectDescription: '服务端分配范围内的只读详情',
    categoryLevel1Id: null,
    categoryLevel2Id: null,
    categoryLevel1Name: null,
    categoryLevel2Name: null,
    categoryLevel3Ids: [],
    categoryLevel3Names: [],
    difficultyLevel: null,
    projectQuantity: 100,
    quantityUnit: '条',
    deadline: '2099-12-31 18:00:00',
    requiredHeadcount: 2,
    educationRequirement: null,
    employmentType: 'PART_TIME',
    experienceRequirement: null,
    workSummary: null,
    specialRequirement: null,
    mandatoryRequirement: null,
    standardContent: '仅展示分配中已授权读取的作业标准',
    standardLink: null,
    status: 'PUBLISHED',
    currentNodeCode: 'PRODUCTION_PLAN',
    versionNo: 1,
    creatorUid: 'VIEW10005',
    creatorName: '联调创建人',
    createdAt: '2026-01-01 08:00:00',
    updatedAt: '2026-01-01 08:00:00',
    attachments: [],
  },
  productionPlan: {
    hasPlan: true,
    planId: 71,
    operatorHeadcount: 2,
    operatorCpd: 50,
    inspectorHeadcount: 1,
    inspectorCpd: 100,
    totalExpectedOutput: 100,
    crowds: [],
    stages: [],
  },
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};

/** 替代真实认证、会话角色切换和专家读取契约。 */
async function backend(page: Page, desktop: boolean) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = {
        getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }),
      };
    }, origin);
  const state = {
    signedIn: true,
    user: structuredClone(userFixture),
    projects: [] as WorkbenchProject[],
    projectsStatus: 200,
    detailStatus: 403,
    attendanceStatus: 200,
    presentDate: null as string | null,
    holidayStatus: 200,
    applicationsStatus: 200,
    switchStatus: 200,
    holdSwitch: false,
  };
  const pendingSwitch: { release?: () => Promise<void> } = {};
  const requests: RecordedRequest[] = [];
  const sessionResponses: Pick<AuthUser, 'role' | 'roles' | 'selectedRole'>[] = [];
  await page.context().addCookies([
    {
      name: 'view_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({
      path,
      query: Object.fromEntries(url.searchParams),
      method: request.method(),
      headers,
      body: request.postData() ? request.postDataJSON() : null,
    });
    const reply = (
      data: unknown,
      status = 200,
      extra: Record<string, string> = {},
      message?: string,
    ) =>
      route.fulfill({
        status,
        headers: extra,
        json: {
          code: status,
          message: message ?? (status === 200 ? '操作成功' : '未登录或未提供此接口'),
          data,
        },
      });
    if (path === '/api/v1/auth/login') {
      state.signedIn = true;
      state.user.role = 'EXPERT';
      state.user.selectedRole = 'EXPERT';
      return reply(tokens, 200, {
        'Set-Cookie': 'view_session=active; HttpOnly; SameSite=Lax; Path=/',
      });
    }
    const authenticated = state.signedIn && headers.cookie?.includes('view_session=active');
    if (!authenticated) return reply(null, 401);
    if (path === '/api/v1/users/me' && request.method() === 'GET') {
      sessionResponses.push({
        role: state.user.role,
        roles: [...state.user.roles],
        selectedRole: state.user.selectedRole,
      });
      return reply(state.user);
    }
    if (path === '/api/v1/projects/manager/list' && request.method() === 'GET') return reply([]);
    if (path === '/api/v1/auth/switch-role' && request.method() === 'POST') {
      if (state.switchStatus !== 200)
        return reply(null, state.switchStatus, {}, '角色切换暂不可用');
      const role = request.postDataJSON().role as AuthUser['role'];
      if (!state.user.roles.includes(role)) return reply(null, 403);
      const applySwitch = async () => {
        state.user.role = role;
        state.user.selectedRole = role;
        state.user.roles = ['NAVIGATOR', 'PM', 'EXPERT'];
        await reply({ selectedRole: role, roles: [...state.user.roles] });
      };
      if (!state.holdSwitch) return applySwitch();
      return new Promise<void>((resolve, reject) => {
        pendingSwitch.release = async () => {
          try {
            await applySwitch();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    if (path === '/api/v1/auth/logout') {
      state.signedIn = false;
      return reply(null, 200, {
        'Set-Cookie': 'view_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/',
      });
    }
    if (path === '/api/v1/projects/list' && request.method() === 'GET') return reply([]);
    if (path === '/api/v1/projects/draft/current' && request.method() === 'GET')
      return reply({ hasDraft: false, draft: null });
    if (path === '/api/v1/expert-assignments/my-projects' && request.method() === 'GET')
      return reply(
        state.projectsStatus === 200 ? state.projects : null,
        state.projectsStatus,
        {},
        state.projectsStatus === 200 ? undefined : '项目读取暂不可用',
      );
    if (path === '/api/v1/expert-assignments/detail' && request.method() === 'GET')
      return reply(
        state.detailStatus === 200 ? assignmentFixture : null,
        state.detailStatus,
        {},
        state.detailStatus === 200 ? undefined : '当前分配无访问权限',
      );
    if (path === '/api/v1/organizations/attendance' && request.method() === 'GET')
      return reply(
        state.attendanceStatus === 200
          ? unscheduledAttendance(url.searchParams.get('month')!, state.user, state.presentDate)
          : null,
        state.attendanceStatus,
        {},
        state.attendanceStatus === 200 ? undefined : '排班考勤读取暂不可用',
      );
    if (path === '/api/v1/organizations/calendar/holidays' && request.method() === 'GET')
      return reply(
        state.holidayStatus === 200 ? { month: url.searchParams.get('month'), days: [] } : null,
        state.holidayStatus,
      );
    if (path === '/api/v1/users/me/applications' && request.method() === 'POST')
      return reply(
        state.applicationsStatus === 200
          ? { total: 0, pages: 0, current: 1, size: 10, records: [] }
          : null,
        state.applicationsStatus,
        {},
        state.applicationsStatus === 200 ? undefined : '申请读取暂不可用',
      );
    return reply(null, 404);
  });
  return {
    state,
    requests,
    sessionResponses,
    releaseSwitch: async () => {
      if (!pendingSwitch.release) throw new Error('没有等待中的角色切换');
      await pendingSwitch.release();
    },
  };
}

async function chooseDesktop(page: Page, label: '执行专家' | '领航员' | '策略官') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(label);
}
async function openProfile(page: Page) {
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '账户选项', exact: true })
    .getByRole('link', { name: '个人中心', exact: true })
    .click();
  await expect(page.getByRole('tablist', { name: '个人中心设置', exact: true })).toBeVisible();
}
async function signIn(page: Page) {
  await expect(page).toHaveURL(/#\/auth$/);
  await page.getByRole('tab', { name: '密码登录', exact: true }).click();
  await page.getByLabel(/^手机号/).fill('13812345678');
  await page.getByLabel(/^密码\s*\*?\s*$/).fill('FixturePassword123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
}
async function expectNoPersistedView(page: Page) {
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  expect(await page.evaluate(() => document.cookie)).not.toContain('view_session');
}
function expectRealRoles(
  sessionResponses: Pick<AuthUser, 'role' | 'roles' | 'selectedRole'>[],
  requests: RecordedRequest[],
) {
  expect(sessionResponses.length).toBeGreaterThan(0);
  expect(
    sessionResponses.every(
      (value) => value.role === value.selectedRole && value.roles.includes(value.role),
    ),
  ).toBe(true);
  expect(
    requests.every(
      (request) => !Object.keys(request.headers).some((key) => /role|view/i.test(key)),
    ),
  ).toBe(true);
}

for (const [mode, desktop] of [
  ['Web 生产', false],
  ['Electron 运行配置', true],
] as const) {
  test(`会话角色 ${mode} 真实切换、跨页面和刷新保持，组织仅执行专家可访问`, async ({ page }) => {
    const { state, requests, sessionResponses } = await backend(page, desktop);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/#/`);
    await expect(
      page.getByRole('heading', { name: '欢迎，视图联调员', exact: true }),
    ).toBeVisible();
    const selector = page.getByRole('combobox', { name: '当前角色', exact: true });
    await expect(selector).toContainText('执行专家');
    await expect(
      page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '我的组织', exact: true }),
    ).toBeVisible();
    await chooseDesktop(page, '领航员');
    await expect(page.getByRole('heading', { name: '我创建的项目', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^(我的组织|组织管理|创建组织)$/ })).toHaveCount(0);
    await openProfile(page);
    await expect(
      page
        .getByRole('complementary', { name: '个人资料摘要' })
        .getByLabel('当前角色', { exact: true }),
    ).toHaveText('当前角色 · 领航员');
    await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveCount(0);
    for (const name of ['我的项目', '排班考勤', '组织与申请'])
      await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
    expect(expertReads(requests)).toHaveLength(0);
    await chooseDesktop(page, '策略官');
    await expect(page).toHaveURL(/#\/profile$/);
    await expect(
      page
        .getByRole('complementary', { name: '个人资料摘要' })
        .getByLabel('当前角色', { exact: true }),
    ).toHaveText('当前角色 · 策略官');
    await chooseDesktop(page, '执行专家');
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(
      page.getByRole('tablist', { name: '个人中心设置', exact: true }).getByRole('tab'),
    ).toHaveText(['概览', '个人资料', '账户安全', '我的项目', '排班考勤', '组织与申请']);
    await expect(
      page.getByRole('tablist', { name: '执行专家个人中心业务', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看全部项目', exact: true })).toBeVisible();
    await expect(page.getByText('暂无参与项目', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '管理排班与考勤', exact: true }).click();
    await expect(page.getByRole('tab', { name: '排班考勤', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('本月暂无排班记录', { exact: true })).toBeVisible();
    const attendanceCall = requests.find(
      (request) =>
        request.path === '/api/v1/organizations/attendance' &&
        request.query.month ===
          new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
          }).format(new Date()),
    )!;
    expect(attendanceCall.query).toEqual({
      month: await page.getByLabel('考勤月份', { exact: true }).inputValue(),
      orgId: state.user.organization?.id,
    });
    expect(
      requests.find((request) => request.path === '/api/v1/organizations/calendar/holidays')?.query,
    ).toEqual({ month: attendanceCall.query.month });
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '查看全部申请', exact: true }).click();
    await expect(page.getByRole('tab', { name: '组织与申请', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('暂无申请记录', { exact: true })).toBeVisible();
    expect(
      requests.find((request) => request.path === '/api/v1/users/me/applications')?.body,
    ).toEqual({ businessType: null, current: 1, size: 10 });
    await chooseDesktop(page, '领航员');
    for (const name of ['我的项目', '排班考勤', '组织与申请'])
      await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '返回个人主页', exact: true })).toHaveCount(0);
    const expertCount = expertReads(requests).length;
    await page.goto(`${origin}/#/organization`);
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '我创建的项目', exact: true })).toBeVisible();
    await page.goto(`${origin}/#/organization/create`);
    await expect(page).toHaveURL(/#\/$/);
    expect(expertReads(requests)).toHaveLength(expertCount);
    await chooseDesktop(page, '执行专家');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '我的组织', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '我的组织', exact: true })).toBeVisible();
    await chooseDesktop(page, '策略官');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
    await page.reload();
    await expect(selector).toContainText('策略官');
    const switches = requests.filter((request) => request.path === '/api/v1/auth/switch-role');
    expect(switches.map((request) => request.body)).toEqual([
      { role: 'NAVIGATOR' },
      { role: 'PM' },
      { role: 'EXPERT' },
      { role: 'NAVIGATOR' },
      { role: 'EXPERT' },
      { role: 'PM' },
    ]);
    expect(
      switches.every(
        (request) =>
          request.method === 'POST' &&
          request.headers['x-tyde-client'] === 'web' &&
          request.headers.cookie?.includes('view_session=active'),
      ),
    ).toBe(true);
    expect(state.user.selectedRole).toBe('PM');
    expect(state.user.organization?.position).toBe('MEMBER');
    expectRealRoles(sessionResponses, requests);
    await expectNoPersistedView(page);
  });

  test(`会话角色 ${mode} 初始角色和候选项来自后端，切换失败保留角色且手动重试`, async ({
    page,
  }) => {
    const { state, requests, releaseSwitch } = await backend(page, desktop);
    state.user.role = 'EXPERT';
    state.user.selectedRole = 'PM';
    state.user.roles = ['PM', 'EXPERT'];
    state.switchStatus = 503;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/#/`);
    const selector = page.getByRole('combobox', { name: '当前角色', exact: true });
    await expect(selector).toContainText('策略官');
    await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
    await selector.click();
    await expect(page.getByRole('option', { name: '领航员', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: '执行专家', exact: true }).click();
    await expect(page.getByText('角色切换暂不可用', { exact: true })).toBeVisible();
    await expect(selector).toContainText('策略官');
    await expect(page.getByRole('link', { name: /^(我的组织|组织管理|创建组织)$/ })).toHaveCount(0);
    expect(requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(
      1,
    );
    state.switchStatus = 200;
    state.holdSwitch = true;
    await selector.click();
    await page.getByRole('option', { name: '执行专家', exact: true }).click();
    await expect
      .poll(() => requests.filter((request) => request.path === '/api/v1/auth/switch-role').length)
      .toBe(2);
    await expect(selector).toContainText('策略官');
    await expect(selector).toBeDisabled();
    await releaseSwitch();
    await expect(selector).toContainText('执行专家');
    await expect(page.getByText('角色切换暂不可用', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(selector).toContainText('执行专家');
    expect(requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(
      2,
    );
  });

  test(`个人中心 ${mode} 专家读取失败明确提示且仅手动重试，详情403不产生业务写入`, async ({
    page,
  }) => {
    const { state, requests, sessionResponses } = await backend(page, desktop);
    state.projectsStatus = 503;
    state.attendanceStatus = 503;
    state.applicationsStatus = 503;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/#/profile`);
    await expect(page.getByText('项目读取暂不可用', { exact: true })).toBeVisible();
    expect(
      requests.filter((request) => request.path === '/api/v1/expert-assignments/my-projects'),
    ).toHaveLength(1);
    await expect(page.getByText('暂无参与项目', { exact: true })).toHaveCount(0);
    state.projectsStatus = 200;
    state.projects.push({
      assignmentId: 41,
      projectId: 501,
      projectName: '真实范围内项目',
      requesterName: '联调需求方',
      needWrittenExam: true,
      admissionStatus: 'NOT_EXAMINED',
      currentNodeCode: 'ENTRANCE_EXAM',
    });
    await page.getByRole('button', { name: '重新读取项目', exact: true }).click();
    await page.getByRole('tab', { name: '我的项目', exact: true }).click();
    await page.getByRole('button', { name: /真实范围内项目/ }).click();
    await expect(page.getByText('当前分配无访问权限', { exact: true })).toBeVisible();
    expect(
      requests.find((request) => request.path === '/api/v1/expert-assignments/detail')?.query,
    ).toEqual({ assignmentId: '41' });
    await expect(page.getByRole('button', { name: /^(开始考试|参加考试|确认接单)$/ })).toHaveCount(
      0,
    );
    state.detailStatus = 200;
    await page.getByRole('button', { name: '重新读取项目详情', exact: true }).click();
    const detail = page.getByRole('region', { name: '项目详情', exact: true });
    await expect(detail.getByRole('heading', { name: '真实分配详情', exact: true })).toBeVisible();
    await expect(detail.getByText('2099-12-31 18:00:00', { exact: true })).toBeVisible();
    await expect(
      detail.getByText('当前提供只读详情，接单、考试和生产操作尚未接入。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '排班考勤', exact: true }).click();
    await expect(page.getByText('排班考勤读取暂不可用', { exact: true })).toBeVisible();
    await expect(page.getByText('本月暂无排班记录', { exact: true })).toHaveCount(0);
    state.attendanceStatus = 200;
    await page.getByRole('button', { name: '重新读取考勤', exact: true }).click();
    await expect(page.getByText('本月暂无排班记录', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '组织与申请', exact: true }).click();
    await expect(page.getByText('申请读取暂不可用', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无申请记录', { exact: true })).toHaveCount(0);
    state.applicationsStatus = 200;
    await page.getByRole('button', { name: '重新读取申请', exact: true }).click();
    await expect(page.getByText('暂无申请记录', { exact: true })).toBeVisible();
    expect(
      expertReads(requests).every(
        (request) =>
          !request.headers.authorization &&
          request.headers.cookie?.includes('view_session=active') &&
          request.method === (request.path === '/api/v1/users/me/applications' ? 'POST' : 'GET'),
      ),
    ).toBe(true);
    expectRealRoles(sessionResponses, requests);
    await expectNoPersistedView(page);
  });

  test(`会话角色 ${mode} 更换账户、退出重登与401后均使用新会话角色`, async ({ page }) => {
    const { state, requests } = await backend(page, desktop);
    await page.clock.install();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/#/`);
    await chooseDesktop(page, '领航员');
    state.user.id = '00000000-0000-4000-8000-000000000003';
    state.user.uid = 'VIEW10003';
    state.user.nickname = '第二位视图联调员';
    state.user.role = 'PM';
    state.user.selectedRole = 'PM';
    await page.clock.fastForward(31_000);
    await openProfile(page);
    await expect(
      page.getByRole('heading', { name: '第二位视图联调员', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
      '策略官',
    );
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await signIn(page);
    await chooseDesktop(page, '领航员');
    state.signedIn = false;
    await page.clock.fastForward(31_000);
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page
      .getByRole('navigation', { name: '账户选项', exact: true })
      .getByRole('link', { name: '个人中心', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/auth$/);
    await signIn(page);
    expect(requests.filter((request) => request.path === '/api/v1/auth/logout')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/api/v1/auth/login')).toHaveLength(2);
    await expectNoPersistedView(page);
  });
}

test('个人主页同屏排列项目、年度考勤、能力与申请，桌面双列项目且手机无溢出', async ({ page }) => {
  const { state, requests } = await backend(page, false);
  await page.clock.install({ time: new Date('2026-10-22T04:00:00.000Z') });
  state.presentDate = '2026-10-02';
  state.projects = Array.from({ length: 5 }, (_, index) => ({
    assignmentId: 41 + index,
    projectId: 501 + index,
    projectName: `主页布局项目 ${index + 1}`,
    requesterName: '联调需求方',
    needWrittenExam: false,
    admissionStatus: 'PASSED',
    currentNodeCode: 'PRODUCTION_TASK',
  }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#/profile`);
  const sidebar = page.getByRole('complementary', { name: '个人资料摘要', exact: true });
  const projects = page.getByRole('region', { name: '所在项目', exact: true });
  const attendance = page.getByRole('region', { name: '年度考勤', exact: true });
  const capability = page.getByRole('region', { name: '履约与能力', exact: true });
  const applications = page.getByRole('region', { name: '申请动态', exact: true });
  for (const region of [projects, attendance, capability, applications])
    await expect(region).toBeVisible();
  await expect(capability.getByText('暂无能力评估数据', { exact: true })).toBeVisible();
  await expect(
    attendance.getByText('1 天正常出勤 · 已加载 10/10 个月', { exact: true }),
  ).toBeVisible();
  const attendanceMonths = () =>
    requests
      .filter((request) => request.path === '/api/v1/organizations/attendance')
      .map((request) => request.query.month);
  expect(attendanceMonths().sort()).toEqual(
    Array.from({ length: 10 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
  );
  await expect(
    attendance.getByRole('button', { name: '2026-10-02 · 正常出勤，管理本月考勤', exact: true }),
  ).toBeVisible();
  await expect(
    attendance.getByRole('button', { name: '2026-10-03 · 未排班，管理本月考勤', exact: true }),
  ).toBeVisible();
  await attendance.getByRole('combobox', { name: '年份', exact: true }).selectOption('2025');
  await expect(
    attendance.getByText('0 天正常出勤 · 已加载 12/12 个月', { exact: true }),
  ).toBeVisible();
  expect(
    attendanceMonths()
      .filter((month) => month.startsWith('2025-'))
      .sort(),
  ).toEqual(Array.from({ length: 12 }, (_, index) => `2025-${String(index + 1).padStart(2, '0')}`));
  await attendance.getByRole('combobox', { name: '年份', exact: true }).selectOption('2026');
  await expect(
    attendance.getByText('1 天正常出勤 · 已加载 10/10 个月', { exact: true }),
  ).toBeVisible();
  const cards = projects.getByRole('list', { name: '所在项目列表' }).getByRole('button');
  await expect(cards).toHaveCount(4);
  const sidebarBox = (await sidebar.boundingBox())!;
  const projectsBox = (await projects.boundingBox())!;
  const attendanceBox = (await attendance.boundingBox())!;
  const capabilityBox = (await capability.boundingBox())!;
  const applicationsBox = (await applications.boundingBox())!;
  expect(sidebarBox.x + sidebarBox.width).toBeLessThan(projectsBox.x);
  expect(projectsBox.y + projectsBox.height).toBeLessThan(attendanceBox.y);
  expect(attendanceBox.y + attendanceBox.height).toBeLessThan(capabilityBox.y);
  expect(capabilityBox.y + capabilityBox.height).toBeLessThan(applicationsBox.y);
  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  const third = (await cards.nth(2).boundingBox())!;
  expect(Math.abs(first.y - second.y)).toBeLessThan(1);
  expect(first.x + first.width).toBeLessThan(second.x);
  expect(third.y).toBeGreaterThan(first.y + first.height);
  await page.screenshot({ path: 'artifacts/profile-overview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const mobileSidebarBox = (await sidebar.boundingBox())!;
  const mobileProjectsBox = (await projects.boundingBox())!;
  expect(mobileSidebarBox.y + mobileSidebarBox.height).toBeLessThan(mobileProjectsBox.y);
  await page.screenshot({ path: 'artifacts/profile-overview-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '查看全部项目', exact: true }).click();
  await expect(page.getByRole('tab', { name: '我的项目', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('region', { name: '我的项目', exact: true }).getByRole('listitem'),
  ).toHaveCount(5);
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(projects).toBeVisible();
  await attendance
    .getByRole('button', { name: '2026-10-02 · 正常出勤，管理本月考勤', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: '排班考勤', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('考勤月份', { exact: true })).toHaveValue('2026-10');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await applications.getByRole('button', { name: '查看全部申请', exact: true }).click();
  await expect(page.getByRole('tab', { name: '组织与申请', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('region', { name: '组织与申请', exact: true })).toBeVisible();
});

test('当前角色移动账户菜单具备明确选中状态，320/375px均无横向溢出', async ({ page }) => {
  const { requests, sessionResponses } = await backend(page, false);
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(`${origin}/#/`);
  await openProfile(page);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).not.toBeVisible();
    let selected = '执行专家';
    for (const next of ['领航员', '策略官', '执行专家'] as const) {
      await page.getByRole('button', { name: '账户菜单', exact: true }).click();
      const choices = page.getByRole('group', { name: '当前角色', exact: true });
      await expect(choices).toBeVisible();
      await expect(choices.getByRole('button')).toHaveCount(3);
      await expect(choices.getByRole('button', { name: selected, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      for (const button of await choices.getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await choices.getByRole('button', { name: next, exact: true }).click();
      await expect(choices).not.toBeVisible();
      await expect(page).toHaveURL(/#\/profile$/);
      await expect(
        page
          .getByRole('complementary', { name: '个人资料摘要' })
          .getByLabel('当前角色', { exact: true }),
      ).toHaveText(`当前角色 · ${next}`);
      await expect(page.getByRole('tab', { name: '个人资料', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '账户安全', exact: true })).toBeVisible();
      for (const name of ['概览', '我的项目', '排班考勤', '组织与申请'])
        await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(
          next === '执行专家' ? 1 : 0,
        );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      selected = next;
    }
  }
  expect(
    requests.every(
      (request) =>
        (request.method === 'GET' &&
          ['/api/v1/users/me', ...expertReadPaths].includes(request.path)) ||
        (request.method === 'POST' && request.path === '/api/v1/users/me/applications') ||
        (request.method === 'POST' && request.path === '/api/v1/auth/switch-role'),
    ),
  ).toBe(true);
  expectRealRoles(sessionResponses, requests);
  await expectNoPersistedView(page);
});

test('selectedRole 为空时读取后端 role，切回专家后重读项目以清除旧角色缓存', async ({ page }) => {
  const { state, requests } = await backend(page, false);
  state.user.role = 'NAVIGATOR';
  state.user.selectedRole = null;
  state.projects = [
    {
      assignmentId: 41,
      projectId: 501,
      projectName: '角色切换前项目',
      requesterName: '联调需求方',
      needWrittenExam: true,
      admissionStatus: 'NOT_EXAMINED',
      currentNodeCode: 'ENTRANCE_EXAM',
    },
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/#/profile`);
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '领航员',
  );
  expect(expertReads(requests)).toHaveLength(0);
  await chooseDesktop(page, '执行专家');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(page.getByRole('button', { name: /角色切换前项目/ })).toBeVisible();
  await chooseDesktop(page, '策略官');
  state.projects[0]!.projectName = '角色切换后项目';
  await chooseDesktop(page, '执行专家');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(page.getByRole('button', { name: /角色切换后项目/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /角色切换前项目/ })).toHaveCount(0);
  expect(
    requests.filter((request) => request.path === '/api/v1/expert-assignments/my-projects'),
  ).toHaveLength(2);
});

for (const channelMode of ['BroadcastChannel', 'storage 回退', '发送失败回退'] as const) {
  test(`同账号双标签通过${channelMode}重读真实角色，保留资料草稿`, async ({ page }) => {
    if (channelMode === 'storage 回退')
      await page.context().addInitScript(() => {
        Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
      });
    if (channelMode === '发送失败回退')
      await page.addInitScript(() => {
        const NativeChannel = window.BroadcastChannel;
        Object.defineProperty(window, 'BroadcastChannel', {
          value: class extends NativeChannel {
            postMessage() {
              throw new Error('频道发送失败');
            }
          },
        });
      });
    const { requests, state } = await backend(page, false);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/#/profile`);
    const other = await page.context().newPage();
    await other.setViewportSize({ width: 1280, height: 800 });
    await other.goto(`${origin}/#/profile`);
    await other.getByRole('button', { name: '编辑资料', exact: true }).click();
    await other.getByLabel('个人简介', { exact: true }).fill('跨标签同步后仍保留的资料草稿');
    const sessionReads = requests.filter((request) => request.path === '/api/v1/users/me').length;
    await chooseDesktop(page, '领航员');
    await expect(other.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
      '领航员',
    );
    await expect(other.getByRole('tab', { name: '概览', exact: true })).toHaveCount(0);
    await expect(other.getByLabel('个人简介', { exact: true })).toHaveValue(
      '跨标签同步后仍保留的资料草稿',
    );
    await expect(other.getByLabel('组织身份', { exact: true })).toHaveText('视图联调组织 · 成员');
    expect(state.user.selectedRole).toBe('NAVIGATOR');
    expect(requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(
      1,
    );
    // 发送方主动重读一次、接收方收到信号重读一次；不因发送方自接收重复读取。
    expect(requests.filter((request) => request.path === '/api/v1/users/me').length).toBe(
      sessionReads + 2,
    );
    await expectNoPersistedView(page);
    await expectNoPersistedView(other);
    await other.close();
  });
}

test('跨标签信号只使同账号会话失效，不使用外部角色数据，也不广播循环', async ({ page }) => {
  const { state, requests } = await backend(page, false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/#/profile`);
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  const sender = await page.context().newPage();
  await sender.setViewportSize({ width: 1280, height: 800 });
  await sender.goto(origin);
  await expect(sender.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  const changes: unknown[] = [];
  await sender.exposeFunction('recordRoleSignal', (value: unknown) => changes.push(value));
  await sender.evaluate(() => {
    const observer = new BroadcastChannel('tyde-session-role');
    observer.onmessage = (event) => {
      void (
        window as unknown as { recordRoleSignal: (value: unknown) => Promise<void> }
      ).recordRoleSignal(event.data);
    };
  });

  state.user.role = 'PM';
  state.user.selectedRole = 'PM';
  const before = requests.filter((request) => request.path === '/api/v1/users/me').length;
  await sender.evaluate((accountId) => {
    const channel = new BroadcastChannel('tyde-session-role');
    channel.postMessage({
      type: 'SESSION_ROLE_INVALIDATED',
      accountId,
      selectedRole: 'NAVIGATOR',
      roles: ['NAVIGATOR'],
    });
    channel.close();
  }, state.user.id);
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '策略官',
  );
  await expect
    .poll(() => requests.filter((request) => request.path === '/api/v1/users/me').length)
    .toBe(before + 2);
  expect(requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(0);
  // sender 也挂载会话，但接收方只重读，不再向频道发送第二次角色变化。
  expect(changes).toHaveLength(1);

  await chooseDesktop(page, '执行专家');
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1]).toEqual({ type: 'SESSION_ROLE_INVALIDATED', accountId: state.user.id });
  await expectNoPersistedView(page);
  await sender.close();
});

test('跨标签消息的账号不匹配时保留当前身份，广播设施失败不重放成功的切换', async ({ page }) => {
  const { requests, state } = await backend(page, false);
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', {
      value: class {
        constructor() {
          throw new Error('频道已禁用');
        }
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/#/profile`);
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  const before = requests.filter((request) => request.path === '/api/v1/users/me').length;
  await page.evaluate(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'tyde:session-role-sync',
        storageArea: localStorage,
        newValue: JSON.stringify({
          type: 'SESSION_ROLE_INVALIDATED',
          accountId: '00000000-0000-4000-8000-000000000099',
          selectedRole: 'PM',
        }),
      }),
    );
  });
  // 有效账号信号作为同步屏障，确保之前账号不匹配的消息已经处理。
  state.user.role = 'NAVIGATOR';
  state.user.selectedRole = 'NAVIGATOR';
  await page.evaluate((accountId) => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'tyde:session-role-sync',
        storageArea: localStorage,
        newValue: JSON.stringify({ type: 'SESSION_ROLE_INVALIDATED', accountId }),
      }),
    );
  }, state.user.id);
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '领航员',
  );
  expect(requests.filter((request) => request.path === '/api/v1/users/me').length).toBe(before + 1);
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, 'setItem', {
      value: () => {
        throw new Error('存储已禁用');
      },
    });
  });
  await chooseDesktop(page, '策略官');
  expect(requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(1);
  expect(state.user.selectedRole).toBe('PM');
  await expectNoPersistedView(page);
});

test('个人中心顶层业务入口在窄屏可用键盘直达，并与概览共用单一页签导航', async ({ page }) => {
  await backend(page, false);
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(`${origin}/#/profile`);
  const navigation = page.getByRole('tablist', { name: '个人中心设置', exact: true });
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(navigation.getByRole('tab')).toHaveText([
    '概览',
    '个人资料',
    '账户安全',
    '我的项目',
    '排班考勤',
    '组织与申请',
  ]);
  const security = navigation.getByRole('tab', { name: '账户安全', exact: true });
  const projects = navigation.getByRole('tab', { name: '我的项目', exact: true });
  const attendance = navigation.getByRole('tab', { name: '排班考勤', exact: true });
  const organization = navigation.getByRole('tab', { name: '组织与申请', exact: true });
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await security.focus();
    await security.press('ArrowRight');
    await expect(projects).toBeFocused();
    await expect(projects).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: '我的项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '返回个人主页', exact: true })).toHaveCount(0);
    await projects.press('ArrowRight');
    await expect(attendance).toBeFocused();
    await expect(attendance).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: '我的排班考勤', exact: true })).toBeVisible();
    await attendance.press('ArrowRight');
    await expect(organization).toBeFocused();
    await expect(organization).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: '组织与申请', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '返回个人主页', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(navigation.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('region', { name: '所在项目', exact: true })).toBeVisible();
  }
});
