import { expect, test, type Page } from '@playwright/test';
import { clockResponse } from '../../apps/server/src/modules/attendance/attendance-clock.schema';
import type {
  AttendanceClockContext,
  AttendanceClockResult,
  AttendanceClockType,
  AuthUser,
  WorkbenchAttendanceMonth,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
test.use({ timezoneId: 'America/Los_Angeles' });
const clockPath = '/api/v1/organizations/attendance/clock';
const contextPath = `${clockPath}-context`;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const organization = (id = 2) => ({
  id: uuid(id),
  name: id === 2 ? '默认海潮组织' : '其他远洋组织',
  position: 'MEMBER',
  joinStatus: 'ACTIVE',
  status: 'ACTIVE',
  verifyStatus: 'APPROVED',
});
const userFixture: AuthUser = {
  id: uuid(1),
  uid: 'CLOCK10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '打卡联调员',
  realName: '测试专家',
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
  organizations: [],
  createdAt: '2026-11-04T01:00:00.000Z',
  updatedAt: '2026-11-04T01:00:00.000Z',
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
type Failure = 'NETWORK_COMMITTED' | '503_COMMITTED' | '503_UNCOMMITTED' | 400 | 401 | 403 | 409;
type Schedule = 'NONE' | 'REST' | 'WORK' | 'INCOMPLETE' | 'CROSS_DAY' | 'REVERSED';
const active = (value: Record<string, unknown>) =>
  ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(value.joinStatus));

/** 只替代HTTP：同账号/组织/key重放不可变事件；时间和判型由服务端夹具返回。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'clock_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const state = {
    user: structuredClone(userFixture),
    signedIn: true,
    serverTime: '2026-11-04 09:00:00',
    milliseconds: '123',
    next: 'CLOCK_IN' as AttendanceClockType,
    actualType: null as AttendanceClockType | null,
    schedule: 'WORK' as Schedule,
    readStatus: 200,
    postReadFailure: false,
    hold: false,
    failures: [] as Failure[],
  };
  const requests: RequestLog[] = [];
  const events = new Map<string, AttendanceClockResult>();
  let releaseWrite: (() => void) | undefined;
  function context(orgId: string | null): AttendanceClockContext {
    const attendanceDate = state.serverTime.slice(0, 10);
    const todayEvents = [...events.values()].filter(
      (event) => event.orgId === orgId && event.dailyAttendance.attendanceDate === attendanceDate,
    );
    const invalid = ['INCOMPLETE', 'CROSS_DAY', 'REVERSED'].includes(state.schedule);
    const next = invalid ? null : todayEvents.length ? 'CLOCK_OUT' : state.next;
    return {
      orgId,
      attendanceDate,
      serverTime: state.serverTime,
      scheduleId: state.schedule === 'NONE' ? null : 51,
      dayType: state.schedule === 'NONE' ? null : state.schedule === 'REST' ? 'REST' : 'WORK',
      shiftStartAt:
        state.schedule === 'NONE' || state.schedule === 'REST'
          ? null
          : `${attendanceDate} 09:00:00`,
      shiftEndAt:
        state.schedule === 'NONE' || state.schedule === 'REST' || state.schedule === 'INCOMPLETE'
          ? null
          : state.schedule === 'CROSS_DAY'
            ? '2026-11-05 06:00:00'
            : `${attendanceDate} ${state.schedule === 'REVERSED' ? '08' : '18'}:00:00`,
      firstClockInAt: todayEvents.find((event) => event.clockType === 'CLOCK_IN')?.clockAt ?? null,
      lastClockOutAt:
        todayEvents.filter((event) => event.clockType === 'CLOCK_OUT').at(-1)?.clockAt ?? null,
      nextClockType: next,
      buttonText:
        next === 'CLOCK_IN' ? '上班打卡' : next === 'CLOCK_OUT' ? '下班打卡' : '暂不可打卡',
      canClock: !invalid,
      warning:
        state.schedule === 'NONE'
          ? '当日未配置排班，本次打卡将记录为未排班'
          : state.schedule === 'REST'
            ? '当日为休息日，本次打卡仍会正常记录'
            : invalid
              ? state.schedule === 'INCOMPLETE'
                ? '当日排班时间不完整，不能打卡'
                : '跨天班次不支持打卡'
              : state.next === 'CLOCK_OUT' && todayEvents.length === 0
                ? '已进入下班阶段且缺少上班卡，本次将记为下班卡'
                : null,
    };
  }
  function commit(orgId: string | null, key: string) {
    const identity = `${state.user.id}:${orgId ?? 'PERSONAL'}:${key}`;
    const existing = events.get(identity);
    if (existing) {
      const latest = [...events.values()]
        .filter(
          (event) =>
            event.orgId === orgId &&
            event.dailyAttendance.attendanceDate === existing.dailyAttendance.attendanceDate,
        )
        .at(-1)!;
      return { ...existing, dailyAttendance: structuredClone(latest.dailyAttendance) };
    }
    const current = context(orgId);
    const type = state.actualType ?? current.nextClockType!;
    const clockAt = `${state.serverTime}.${state.milliseconds}`;
    const event: AttendanceClockResult = {
      ...(structuredClone(clockResponse.examples[0]) as AttendanceClockResult),
      eventId: events.size + 1,
      eventNo: `CLK${(events.size + 1).toString(16).toUpperCase().padStart(40, '0')}`,
      orgId,
      memberId: orgId ? uuid(4) : null,
      userId: state.user.id,
      clockType: type,
      clockAt,
      dailyAttendance: {
        ...structuredClone(clockResponse.examples[0].dailyAttendance),
        id: orgId ? 71 : 72,
        attendanceDate: current.attendanceDate,
        scheduleId: current.scheduleId,
        expectedStartAt: current.shiftStartAt,
        expectedEndAt: current.shiftEndAt,
        firstClockInAt: type === 'CLOCK_IN' ? clockAt : current.firstClockInAt,
        lastClockOutAt: type === 'CLOCK_OUT' ? clockAt : current.lastClockOutAt,
        autoStatus:
          state.schedule === 'NONE'
            ? 'UNSCHEDULED'
            : state.schedule === 'REST'
              ? 'REST'
              : 'PRESENT',
        finalStatus:
          state.schedule === 'NONE'
            ? 'UNSCHEDULED'
            : state.schedule === 'REST'
              ? 'REST'
              : 'PRESENT',
        versionNo: events.size + 1,
      },
    };
    events.set(identity, event);
    return event;
  }
  function month(month: string, orgId: string | null): WorkbenchAttendanceMonth {
    return {
      organizationId: orgId,
      independentSchedule: orgId === null,
      month,
      memberId: orgId ? uuid(4) : null,
      userId: state.user.id,
      realName: state.user.realName,
      nickname: state.user.nickname,
      summary: { presentCount: 0, lateCount: 0, earlyLeaveCount: 0, leaveCount: 0, absentCount: 0 },
      days: Array.from(
        {
          length: new Date(
            Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
          ).getUTCDate(),
        },
        (_, i) => ({
          scheduleDate: `${month}-${String(i + 1).padStart(2, '0')}`,
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
        canBatchSchedule: orgId === null,
        canDirectUpdate: false,
        canApply: false,
        canWithdraw: false,
      },
    };
  }
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = await request.allHeaders();
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    requests.push({
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
    });
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (path === '/api/v1/auth/login') {
      state.signedIn = true;
      return reply(tokens);
    }
    if (!state.signedIn) return reply(null, 401, '请先登录');
    if (path === '/api/v1/auth/refresh') return reply(tokens);
    if (path === '/api/v1/projects/workbench/statistics')
      return reply({
        mode: 'TASK',
        pendingTaskCount: 0,
        completedTaskCount: 0,
        involvedProjectCount: 0,
      });
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/auth/switch-role') {
      state.user.role = body!.role as AuthUser['role'];
      state.user.selectedRole = state.user.role;
      return reply({ selectedRole: state.user.role, roles: state.user.roles });
    }
    if (path === contextPath || path === clockPath) {
      const orgId =
        ((path === contextPath ? url.searchParams.get('orgId') : body?.orgId) as string | null) ??
        null;
      const currentOrganizations = state.user.organizations ?? [];
      const validOrganization =
        (state.user.organization?.id === orgId && active(state.user.organization)) ||
        currentOrganizations.some((item) => item.id === orgId && active(item));
      if (
        orgId
          ? !validOrganization
          : state.user.role !== 'EXPERT' ||
            currentOrganizations.some(active) ||
            (state.user.organization && active(state.user.organization))
      )
        return reply(null, 403, '当前用户不是该组织有效成员');
      if (path === contextPath)
        return reply(
          state.readStatus === 200 ? context(orgId) : null,
          state.readStatus,
          state.readStatus === 200 ? '操作成功' : '打卡状态读取暂不可用',
        );
      if (state.hold)
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      const failure = state.failures.shift();
      if (typeof failure === 'number')
        return reply(
          null,
          failure,
          failure === 403 ? '当前用户不是该组织有效成员' : '打卡请求暂未成功',
        );
      if (failure === '503_UNCOMMITTED') return reply(null, 503, '打卡服务暂不可用');
      const original = events.get(
        `${state.user.id}:${orgId ?? 'PERSONAL'}:${headers['idempotency-key']}`,
      );
      const expected = original?.clockType ?? state.actualType ?? context(orgId).nextClockType;
      if (body?.clockType && body.clockType !== expected)
        return reply(null, 409, '打卡类型已变化，请刷新状态');
      const event = commit(orgId, headers['idempotency-key']);
      if (failure === 'NETWORK_COMMITTED') return route.abort('failed');
      if (failure === '503_COMMITTED') return reply(null, 503, '打卡结果暂不可用');
      if (state.postReadFailure) state.readStatus = 503;
      return reply(event);
    }
    if (
      [
        '/api/v1/expert-assignments/my-tasks',
        '/api/v1/expert-assignments/my-projects',
        '/api/v1/projects/manager/list',
        '/api/v1/projects/list',
      ].includes(path)
    )
      return reply([]);
    if (path === '/api/v1/projects/draft/current') return reply({ hasDraft: false, draft: null });
    if (path === '/api/v1/organizations/attendance')
      return reply(month(url.searchParams.get('month')!, url.searchParams.get('orgId')));
    if (path === '/api/v1/organizations/calendar/holidays')
      return reply({ month: url.searchParams.get('month'), days: [] });
    if (path === '/api/v1/users/me/applications')
      return reply({ total: 0, pages: 0, current: 1, size: 10, records: [] });
    return reply(null, 404, '夹具未配置此接口');
  });
  return {
    state,
    requests,
    events,
    writes: () => requests.filter((item) => item.path === clockPath),
    reads: () => requests.filter((item) => item.path === contextPath),
    release: () => {
      if (!releaseWrite) throw new Error('没有等待中的打卡');
      state.hold = false;
      releaseWrite();
    },
  };
}

const widget = (page: Page) => page.getByRole('region', { name: '今日上下班打卡', exact: true });
const clockButton = (page: Page) =>
  widget(page).getByRole('button', { name: /^(上班打卡|下班打卡)$/ });
async function clickClock(page: Page) {
  const out = (await clockButton(page).textContent()) === '下班打卡';
  await clockButton(page).click();
  if (out)
    await page
      .getByRole('dialog', { name: '确认下班打卡', exact: true })
      .getByRole('button', { name: '确认打卡', exact: true })
      .click();
}
async function openWorkspace(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/`);
  await expect(widget(page)).toBeVisible();
}
async function openProfile(page: Page) {
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '账户选项', exact: true })
    .getByRole('link', { name: '个人中心', exact: true })
    .click();
  await page.getByRole('tab', { name: '排班考勤', exact: true }).click();
  await expect(widget(page)).toBeVisible();
}
async function chooseRole(page: Page, label: '执行专家' | '策略官') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(label);
}
async function expectRecorded(page: Page, type: '上班' | '下班', time?: string) {
  await expect(widget(page).getByText(`${type}打卡已记录`, { exact: true })).toBeVisible();
  if (time) await expect(widget(page)).toContainText(time);
}

for (const desktop of [false, true])
  test(`${desktop ? '桌面配置' : 'Web'}按本人默认范围打卡，真正新点击换key且固定上海时区`, async ({
    page,
  }) => {
    const f = await backend(page, desktop);
    if (desktop) {
      f.state.user.organization = organization();
      f.state.user.organizations = [organization(3), organization()];
    } else f.state.user.accountType = 'ORGANIZATION';
    await openWorkspace(page);
    const scope = desktop
      ? { orgId: uuid(2), timezone: 'Asia/Shanghai' }
      : { timezone: 'Asia/Shanghai' };
    await expect(clockButton(page)).toHaveText('上班打卡');
    await clickClock(page);
    await expectRecorded(page, '上班', '2026-11-04 09:00:00.123');
    f.state.serverTime = '2026-11-04 18:00:00';
    await expect(clockButton(page)).toHaveText('下班打卡');
    await clickClock(page);
    await expectRecorded(page, '下班', '2026-11-04 18:00:00.123');
    expect(f.writes()).toHaveLength(2);
    expect(f.events.size).toBe(2);
    expect(f.writes()[0].headers['idempotency-key']).toBeTruthy();
    expect(f.writes()[1].headers['idempotency-key']).not.toBe(
      f.writes()[0].headers['idempotency-key'],
    );
    for (const request of [...f.reads(), ...f.writes()]) {
      if (request.path === clockPath)
        expect(request.body).toEqual({
          ...scope,
          clockType: f.writes().indexOf(request) === 0 ? 'CLOCK_IN' : 'CLOCK_OUT',
        });
      else expect(request.query).toEqual(scope);
      expect(request.headers.cookie).toContain('clock_session=active');
    }
    expect(f.writes()[0].headers['x-tyde-client']).toBe('web');
    if (desktop)
      await page.screenshot({
        path: 'artifacts/attendance-clock/clock-desktop.png',
        fullPage: true,
      });
  });

test('打卡类型变化时发送原预期类型并呈现服务端拒绝，不把上班点击变成下班', async ({ page }) => {
  const f = await backend(page);
  f.state.actualType = 'CLOCK_OUT';
  await openWorkspace(page);
  await expect(clockButton(page)).toHaveText('上班打卡');
  await clickClock(page);
  await expect(widget(page).getByText('打卡类型已变化，请刷新状态', { exact: true })).toBeVisible();
  expect(f.writes()[0].body).toEqual({ timezone: 'Asia/Shanghai', clockType: 'CLOCK_IN' });
  expect(f.events.size).toBe(0);
});

test('下班二次确认可取消，失败重试保留同一事件键', async ({ page }) => {
  const f = await backend(page);
  f.state.next = 'CLOCK_OUT';
  await openWorkspace(page);
  await clockButton(page).click();
  const dialog = page.getByRole('dialog', { name: '确认下班打卡', exact: true });
  await expect(dialog).toBeVisible();
  expect(f.writes()).toHaveLength(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(f.writes()).toHaveLength(0);
  f.state.failures = ['503_UNCOMMITTED'];
  await clockButton(page).click();
  await dialog.getByRole('button', { name: '确认打卡', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重试下班打卡', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '重试下班打卡', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.writes()).toHaveLength(2);
  expect(f.writes()[1].headers['idempotency-key']).toBe(f.writes()[0].headers['idempotency-key']);
  expect(f.events.size).toBe(1);
});

test('发送中连续点击不重发，切角色与本地路由不得丢失原操作', async ({ page }) => {
  const f = await backend(page);
  f.state.hold = true;
  await openWorkspace(page);
  await clickClock(page);
  await expect.poll(() => f.writes().length).toBe(1);
  const busyButton = widget(page).getByRole('button', { name: '重试上次打卡', exact: true });
  await expect(busyButton).toBeDisabled();
  await busyButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '账户选项', exact: true })
    .getByRole('link', { name: '个人中心', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/$/);
  expect(f.requests.filter((item) => item.path.endsWith('/switch-role'))).toHaveLength(0);
  expect(f.writes()).toHaveLength(1);
  f.release();
  await expectRecorded(page, '上班');
});

for (const schedule of ['NONE', 'REST'] as const)
  test(`${schedule === 'NONE' ? '无排班' : '休息日'}允许真实打卡并显示服务器提醒`, async ({
    page,
  }) => {
    const f = await backend(page);
    f.state.schedule = schedule;
    await openWorkspace(page);
    await expect(widget(page)).toContainText(
      schedule === 'NONE' ? '当日未配置排班' : '当日为休息日',
    );
    await clickClock(page);
    await expectRecorded(page, '上班');
    expect([...f.events.values()][0].dailyAttendance.autoStatus).toBe(
      schedule === 'NONE' ? 'UNSCHEDULED' : 'REST',
    );
  });

for (const schedule of ['INCOMPLETE', 'CROSS_DAY', 'REVERSED'] as const)
  test(`${schedule}异常WORK班次服从canClock禁用，不改造个人无班请求`, async ({ page }) => {
    const f = await backend(page);
    f.state.schedule = schedule;
    await openWorkspace(page);
    await expect(
      widget(page).getByRole('button', { name: '暂不可打卡', exact: true }),
    ).toBeDisabled();
    await expect(widget(page)).toContainText(
      schedule === 'INCOMPLETE' ? '当日排班时间不完整' : '跨天班次不支持打卡',
    );
    expect(f.writes()).toHaveLength(0);
  });

test('打卡状态读取失败只能显式GET刷新，未获得上下文前不能写', async ({ page }) => {
  const f = await backend(page);
  f.state.readStatus = 503;
  await openWorkspace(page);
  await expect(
    widget(page).getByText('打卡状态读取暂不可用', { exact: true }).first(),
  ).toBeVisible();
  expect(f.writes()).toHaveLength(0);
  f.state.readStatus = 200;
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  await expect(clockButton(page)).toBeEnabled();
  expect(f.reads().length).toBeGreaterThan(1);
  expect(f.writes()).toHaveLength(0);
});

test('已提交后断网跨工作台和个人考勤仍保留原key，GET刷新不冒充核实', async ({ page }) => {
  const f = await backend(page);
  f.state.failures = ['NETWORK_COMMITTED'];
  await openWorkspace(page);
  await clickClock(page);
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  const first = f.writes()[0];
  await openProfile(page);
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  expect(f.writes()).toHaveLength(1);
  await widget(page).getByRole('button', { name: '重试上次打卡', exact: true }).click();
  await expectRecorded(page, '上班', '2026-11-04 09:00:00.123');
  expect(f.writes()[1].headers['idempotency-key']).toBe(first.headers['idempotency-key']);
  expect(f.writes()[1].body).toEqual(first.body);
  expect(f.events.size).toBe(1);
});

for (const committed of [true, false])
  test(`5xx${committed ? '已落库返回原事件' : '未落库按服务器当前时间记录'}，显式重试沿原key`, async ({
    page,
  }) => {
    const f = await backend(page);
    f.state.failures = [committed ? '503_COMMITTED' : '503_UNCOMMITTED'];
    await openWorkspace(page);
    await clickClock(page);
    const retry = widget(page).getByRole('button', { name: '重试上次打卡', exact: true });
    await expect(retry).toBeEnabled();
    await expect(widget(page)).toContainText(/服务器当前时间/);
    expect(f.writes()).toHaveLength(1);
    f.state.serverTime = '2026-11-04 10:15:00';
    await retry.click();
    await expectRecorded(
      page,
      '上班',
      committed ? '2026-11-04 09:00:00.123' : '2026-11-04 10:15:00.123',
    );
    expect(f.writes()).toHaveLength(2);
    expect(f.writes()[1].headers['idempotency-key']).toBe(f.writes()[0].headers['idempotency-key']);
    expect(f.events.size).toBe(1);
  });

test('真实登录后的401会话刷新重放保留同key，不制造第二次点击', async ({ page }) => {
  const f = await backend(page);
  f.state.signedIn = false;
  f.state.failures = [401];
  await page.goto(`${origin}/#/auth`);
  await page.getByRole('tab', { name: '密码登录', exact: true }).click();
  await page.getByLabel(/^手机号/).fill('13812345678');
  await page.getByLabel(/^密码\s*\*?\s*$/).fill('FixturePassword123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(clockButton(page)).toBeEnabled();
  await clickClock(page);
  await expectRecorded(page, '上班');
  expect(f.requests.filter((item) => item.path === '/api/v1/auth/refresh')).toHaveLength(1);
  expect(f.writes()).toHaveLength(2);
  expect(f.writes()[1].headers['idempotency-key']).toBe(f.writes()[0].headers['idempotency-key']);
  expect(f.events.size).toBe(1);
});

test('跨午夜重试原key显示原归属日毫秒回执，随后真实新点击才归新日', async ({ page }) => {
  const f = await backend(page);
  f.state.schedule = 'NONE';
  f.state.serverTime = '2026-11-04 23:59:59';
  f.state.milliseconds = '999';
  f.state.failures = ['NETWORK_COMMITTED'];
  await openWorkspace(page);
  await clickClock(page);
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  f.state.serverTime = '2026-11-05 00:00:01';
  f.state.milliseconds = '001';
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  await widget(page).getByRole('button', { name: '重试上次打卡', exact: true }).click();
  await expectRecorded(page, '上班', '2026-11-04 23:59:59.999');
  expect(f.writes()[1].headers['idempotency-key']).toBe(f.writes()[0].headers['idempotency-key']);
  expect(f.events.size).toBe(1);
  await expect(clockButton(page)).toBeEnabled();
  await clickClock(page);
  await expectRecorded(page, '上班', '2026-11-05 00:00:01.001');
  expect(f.writes()[2].headers['idempotency-key']).not.toBe(
    f.writes()[0].headers['idempotency-key'],
  );
  expect(f.events.size).toBe(2);
});

test('成功但上下文回读失败保留回执并暂停新打卡，恢复按钮只发GET', async ({ page }) => {
  const f = await backend(page);
  f.state.postReadFailure = true;
  await openWorkspace(page);
  await clickClock(page);
  await expectRecorded(page, '上班');
  await expect(
    widget(page).getByText('打卡状态读取暂不可用', { exact: true }).first(),
  ).toBeVisible();
  await expect(widget(page).getByRole('button', { name: '重试上次打卡', exact: true })).toHaveCount(
    0,
  );
  await expect(
    widget(page).getByRole('button', { name: '暂不可打卡', exact: true }),
  ).toBeDisabled();
  f.state.readStatus = 200;
  f.state.postReadFailure = false;
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  await expect(clockButton(page)).toBeEnabled();
  expect(f.writes()).toHaveLength(1);
  expect(f.events.size).toBe(1);
});

test('已知400拒绝后显式刷新上下文和身份才恢复新点击，拒绝key不当成功', async ({ page }) => {
  const f = await backend(page);
  f.state.failures = [400];
  await openWorkspace(page);
  await clickClock(page);
  await expect(widget(page).getByText('打卡请求暂未成功', { exact: true })).toBeVisible();
  const usersBefore = f.requests.filter((item) => item.path === '/api/v1/users/me').length;
  await expect(clockButton(page)).toBeDisabled();
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  await expect(clockButton(page)).toBeEnabled();
  expect(f.requests.filter((item) => item.path === '/api/v1/users/me').length).toBeGreaterThan(
    usersBefore,
  );
  await clickClock(page);
  await expectRecorded(page, '上班');
  expect(f.writes()[1].headers['idempotency-key']).not.toBe(
    f.writes()[0].headers['idempotency-key'],
  );
  expect(f.events.size).toBe(1);
});

test('组织离组后403不借旧事件越权，也不自动省org退为个人打卡', async ({ page }) => {
  const f = await backend(page);
  f.state.user.organization = organization();
  f.state.user.organizations = [organization()];
  f.state.failures = ['NETWORK_COMMITTED'];
  await openWorkspace(page);
  await clickClock(page);
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  f.state.user.organization.joinStatus = 'LEFT';
  f.state.user.organizations[0].joinStatus = 'LEFT';
  await widget(page).getByRole('button', { name: '重试上次打卡', exact: true }).click();
  await expect(widget(page).getByText('当前用户不是该组织有效成员', { exact: true })).toBeVisible();
  await widget(page).getByRole('button', { name: '刷新打卡状态', exact: true }).click();
  expect(f.writes()).toHaveLength(2);
  for (const request of [...f.writes(), ...f.reads()])
    expect(request.path === clockPath ? request.body?.orgId : request.query.orgId).toBe(uuid(2));
  expect(f.events.size).toBe(1);
});

test('组织列表有效但服务端没有默认组织时禁止猜第一项或个人回退', async ({ page }) => {
  const f = await backend(page);
  f.state.user.organizations = [organization(3)];
  await openWorkspace(page);
  await expect(clockButton(page)).toHaveCount(0);
  expect(f.reads()).toHaveLength(0);
  expect(f.writes()).toHaveLength(0);
});

test('默认组织与当前有效关系矛盾时不切其他组织，不按个人请求', async ({ page }) => {
  const f = await backend(page);
  f.state.user.organization = { ...organization(), joinStatus: 'LEFT' };
  f.state.user.organizations = [organization(3)];
  await openWorkspace(page);
  await expect(clockButton(page)).toHaveCount(0);
  expect(f.reads()).toHaveLength(0);
  expect(f.writes()).toHaveLength(0);
});

test('未知打卡切策略官隐藏入口，返回专家仍用原scope原key显式重试', async ({ page }) => {
  const f = await backend(page);
  f.state.user.organization = organization();
  f.state.user.organizations = [organization()];
  f.state.failures = ['503_COMMITTED'];
  await openWorkspace(page);
  await clickClock(page);
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  await chooseRole(page, '策略官');
  await expect(widget(page)).toHaveCount(0);
  expect(f.writes()).toHaveLength(1);
  await chooseRole(page, '执行专家');
  await expect(
    widget(page).getByRole('button', { name: '重试上次打卡', exact: true }),
  ).toBeEnabled();
  expect(f.writes()).toHaveLength(1);
  await widget(page).getByRole('button', { name: '重试上次打卡', exact: true }).click();
  await expectRecorded(page, '上班');
  expect(f.writes()[1].body).toEqual(f.writes()[0].body);
  expect(f.writes()[1].headers['idempotency-key']).toBe(f.writes()[0].headers['idempotency-key']);
  expect(f.events.size).toBe(1);
});

test('375px个人考勤与工作台显示相同服务器首卡，无横向溢出且时间完整可读', async ({ page }) => {
  const f = await backend(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/#/`);
  await expect(clockButton(page)).toBeEnabled();
  await clickClock(page);
  await expectRecorded(page, '上班', '2026-11-04 09:00:00.123');
  await openProfile(page);
  await expect(widget(page)).toContainText('2026-11-04 09:00:00.123');
  await expect(clockButton(page)).toHaveText('下班打卡');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => widget(page).evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: 'artifacts/attendance-clock/clock-375.png', fullPage: true });
  expect(f.writes()).toHaveLength(1);
});
