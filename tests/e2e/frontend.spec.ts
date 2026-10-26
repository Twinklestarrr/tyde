import { test, expect, _electron as electron, type Page, type Request } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AuthUser } from '../../packages/shared/src/index';

const require = createRequire(resolve('apps/electron/package.json'));
const phone = '13812345678';
const verificationCode = '731846';
const password = 'Password123!';
const registrationToken = 'g'.repeat(43);
const serverMessage = '服务端已受理短信请求 A7';
const successNotice = `${serverMessage} 测试验证码：095270`;
const user: AuthUser = {
  id: 'fixture-user',
  uid: 'TYDE10001',
  accountType: 'INDIVIDUAL',
  phone,
  nickname: '潮汐测试员',
  realName: '测试小明',
  idCardNo: '110************01X',
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['EXPERT'],
  selectedRole: 'EXPERT',
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const loginTokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};
const grant = () => ({
  status: 'registration_required',
  registrationToken,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});
const success = (data: unknown) => ({ code: 200, message: '操作成功', data });
const failure = (status: number, message: string) => ({
  code: status === 429 ? 4292 : status,
  message,
  data: null,
});
interface RequestRecord {
  path: string;
  method: string;
  body: unknown;
  client?: string;
}

async function webBackend(page: Page) {
  const state = {
    signedIn: false,
    registered: false,
    sendStatus: 200,
    sendMessage: serverMessage,
    sendNetworkFailure: false,
    currentStatus: 200,
    currentNetworkFailure: false,
    currentInvalidResponse: false,
    smsStatus: 200,
  };
  const requests: RequestRecord[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({
      path,
      method: request.method(),
      body: request.postData() ? request.postDataJSON() : null,
      client: request.headers()['x-tyde-client'],
    });
    const reply = (data: unknown, headers?: Record<string, string>) =>
      route.fulfill({ json: success(data), headers });
    const reject = (status: number, message: string, headers?: Record<string, string>) =>
      route.fulfill({ status, json: failure(status, message), headers });
    switch (path) {
      case '/api/v1/users/me':
        if (state.currentNetworkFailure) return route.abort('failed');
        if (state.currentStatus !== 200) return reject(state.currentStatus, '会话服务暂不可用');
        if (state.currentInvalidResponse) return reply(null);
        return state.signedIn && request.headers().cookie?.includes('fixture_session=active')
          ? reply(user)
          : reject(401, '请先登录');
      case '/api/v1/auth/refresh':
        return state.signedIn ? reply(loginTokens) : reject(401, '登录已过期');
      case '/api/v1/auth/sms/send':
        if (state.sendNetworkFailure) return route.abort('failed');
        if (state.sendStatus === 429)
          return reject(429, '发送频繁，请稍后重试', { 'Retry-After': '60' });
        if (state.sendStatus !== 200) return reject(state.sendStatus, '短信服务暂不可用');
        return reply(state.sendMessage);
      case '/api/v1/auth/sms/login':
        if (state.smsStatus !== 200) return reject(state.smsStatus, '验证码校验失败');
        if (!state.registered) return reply(grant());
        state.signedIn = true;
        return reply(loginTokens, {
          'Set-Cookie': 'fixture_session=active; HttpOnly; SameSite=Lax; Path=/',
        });
      case '/api/v1/auth/register':
        state.registered = true;
        return reply(user);
      case '/api/v1/auth/login':
        state.signedIn = true;
        return reply(loginTokens, {
          'Set-Cookie': 'fixture_session=active; HttpOnly; SameSite=Lax; Path=/',
        });
      case '/api/v1/auth/logout':
        state.signedIn = false;
        return reply(null, { 'Set-Cookie': 'fixture_session=; Max-Age=0; HttpOnly; Path=/' });
      default:
        return reject(503, '调用了未约定的接口');
    }
  });
  return { state, requests };
}
const smsButton = (page: Page) =>
  page.getByRole('button', { name: /获取验证码|发送中|\d+s 后重发/ });
async function openAuth(page: Page, origin: string) {
  await page.goto(origin + '/#/auth');
  await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
}
async function smsLogin(page: Page) {
  await page.getByLabel(/^手机号/).fill(phone);
  await page.getByRole('textbox', { name: '验证码', exact: true }).fill(verificationCode);
  await page.getByRole('button', { name: '继续', exact: true }).click();
}
async function fillRegistration(page: Page) {
  await page.getByLabel(/^登录密码/).fill(password);
  await page.getByLabel(/^确认密码/).fill(password);
  await page.getByLabel(/^姓名/).fill(user.realName);
  await page.getByLabel(/^昵称/).fill(user.nickname);
  await page.getByLabel(/^身份证号/).fill('11010119900101001X');
  await page.getByLabel(/^邮箱/).fill('sample@example.com');
}
async function expectWelcome(page: Page) {
  await expect(
    page.getByRole('heading', { name: '欢迎，' + user.nickname, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '账户菜单', exact: true })).toBeVisible();
}
function expectNoLegacyRequests(requests: RequestRecord[]) {
  expect(requests.some(({ path }) => /\/health\/|\/auth\/(code|verify|me)$/.test(path))).toBe(
    false,
  );
  expect(
    requests.every(({ method, client }) =>
      method === 'GET' ? client === undefined : client === 'web',
    ),
  ).toBe(true);
}

async function pauseClock(page: Page) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
}
async function sessionRead(page: Page, action: () => Promise<unknown>, failed = false) {
  const matches = (request: Request) =>
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/users/me';
  const completed = failed
    ? page.waitForEvent('requestfailed', matches)
    : page.waitForEvent('requestfinished', matches);
  await action();
  await completed;
  // 网络 Promise 完成后，React Query 的通知仍需执行零延时定时器。
  await page.clock.runFor(50);
}
function expectSessionReads(requests: RequestRecord[]) {
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(({ method, path }) => method === 'GET' && path === '/api/v1/users/me'),
  ).toBe(true);
}

for (const [mode, origin] of [
  ['生产', 'http://127.0.0.1:5176'],
  ['DEV', 'http://127.0.0.1:5177'],
] as const) {
  test(`Web ${mode} 验证码真实发送，成功显示测试码并保留服务端提示且不重复`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    await openAuth(page, origin);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await smsButton(page).click();
    await expect(page.getByText('请输入手机号', { exact: true })).toBeVisible();
    await page.getByLabel(/^手机号/).fill('123');
    await smsButton(page).click();
    await expect(page.getByText('请输入 11 位大陆手机号码', { exact: true })).toBeVisible();
    expect(requests.filter(({ path }) => path.includes('/sms/'))).toEqual([]);
    await page.getByLabel(/^手机号/).fill(phone);
    await smsButton(page).click();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(successNotice);
    await expect(smsButton(page)).toBeEnabled();
    await expect(smsButton(page)).toHaveText('获取验证码');
    expect(requests.filter(({ path }) => path.endsWith('/sms/send'))).toEqual([
      {
        path: '/api/v1/auth/sms/send',
        method: 'POST',
        body: { phone, scene: 'login' },
        client: 'web',
      },
    ]);
    state.sendMessage = '本地测试验证码：095270（不会发送短信）。';
    await smsButton(page).click();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(state.sendMessage);
    await smsLogin(page);
    await expect(page).toHaveURL(/#\/register$/);
    expect(requests.find(({ path }) => path.endsWith('/sms/login'))?.body).toEqual({
      phone,
      code: verificationCode,
    });
    expectNoLegacyRequests(requests);
  });

  test(`Web ${mode} 429 遵守 Retry-After，503和网络失败不会本地成功`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    await page.clock.install();
    await openAuth(page, origin);
    await page.getByLabel(/^手机号/).fill(phone);
    await smsButton(page).click();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(successNotice);
    state.sendStatus = 429;
    await smsButton(page).click();
    await expect(page.getByText('发送频繁，请稍后重试', { exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveCount(0);
    await expect(smsButton(page)).toHaveText(/^(60|59)s 后重发$/);
    await expect(smsButton(page)).toBeDisabled();
    await page.getByLabel(/^手机号/).fill('13912345678');
    await expect(smsButton(page)).toBeDisabled();
    await page.clock.fastForward(61_000);
    state.sendStatus = 503;
    await smsButton(page).click();
    await expect(page.getByText('短信服务暂不可用', { exact: true })).toBeVisible();
    await expect(smsButton(page)).toBeEnabled();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveCount(0);
    state.sendNetworkFailure = true;
    await smsButton(page).click();
    await expect(page.getByText('连接服务失败，请检查网络后重试', { exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/auth$/);
    expect(requests.filter(({ path }) => path.endsWith('/sms/send'))).toHaveLength(4);
    expectNoLegacyRequests(requests);
  });

  test(`Web ${mode} 验证码由服务端验证，老用户登录后恢复会话并退出`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    state.registered = true;
    state.smsStatus = 400;
    await openAuth(page, origin);
    await smsLogin(page);
    await expect(page.getByText('验证码校验失败', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/auth$/);
    state.smsStatus = 200;
    await page.getByRole('textbox', { name: '验证码', exact: true }).fill('268519');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expectWelcome(page);
    expect(requests.filter(({ path }) => path.endsWith('/sms/send'))).toHaveLength(0);
    expect(
      requests.filter(({ path }) => path.endsWith('/sms/login')).map(({ body }) => body),
    ).toEqual([
      { phone, code: verificationCode },
      { phone, code: '268519' },
    ]);
    await page.reload();
    await expectWelcome(page);
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/auth$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
    expect(requests.filter(({ path }) => path.endsWith('/auth/logout'))).toHaveLength(1);
    expectNoLegacyRequests(requests);
  });

  test(`Web ${mode} 密码登录提交真实账号密码，验证码注册入口清空敏感字段`, async ({ page }) => {
    const { requests } = await webBackend(page);
    await openAuth(page, origin);
    await page.getByRole('tab', { name: '密码登录', exact: true }).click();
    await expect(page.getByText('还没有账号？')).toBeVisible();
    await expect(page.getByRole('button', { name: '验证码注册', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    expect(requests.filter(({ path }) => path.endsWith('/auth/login'))).toHaveLength(0);
    await page.getByLabel(/^手机号/).fill(phone);
    const input = page.getByLabel(/^密码\s*\*?\s*$/);
    await input.fill(password);
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await expect(input).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: '验证码注册', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '验证码', exact: true })).toBeFocused();
    await expect(page.getByLabel(/^手机号/)).toHaveValue(phone);
    await page.getByRole('tab', { name: '密码登录', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectWelcome(page);
    expect(requests.find(({ path }) => path.endsWith('/auth/login'))?.body).toEqual({
      account: phone,
      password,
    });
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain(loginTokens.accessToken);
    expect(storage).not.toContain(loginTokens.refreshToken);
    expectNoLegacyRequests(requests);
  });

  test(`Web ${mode} 注册携带服务端凭证和个人字段，成功后返回密码登录且不自动登录`, async ({
    page,
  }) => {
    const { requests } = await webBackend(page);
    await openAuth(page, origin);
    await smsLogin(page);
    await expect(page.getByRole('heading', { name: '完善个人资料', exact: true })).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByLabel(/^手机|^组织名称/)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '验证码', exact: true })).toHaveCount(0);
    await fillRegistration(page);
    const currentCalls = requests.filter(({ path }) => path.endsWith('/users/me')).length;
    await page.getByRole('button', { name: '提交', exact: true }).click();
    await expect(page).toHaveURL(/#\/auth$/);
    await expect(page.getByRole('tab', { name: '密码登录', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(
      '注册成功，请使用密码登录。',
    );
    await expect(page.getByLabel(/^手机号/)).toHaveValue(phone);
    expect(requests.find(({ path }) => path.endsWith('/auth/register'))?.body).toEqual({
      accountType: 'INDIVIDUAL',
      phone,
      registrationToken,
      password,
      confirmPassword: password,
      realName: user.realName,
      nickname: user.nickname,
      idCardNo: '11010119900101001X',
      email: 'sample@example.com',
    });
    expect(requests.filter(({ path }) => path.endsWith('/auth/login'))).toHaveLength(0);
    expect(requests.filter(({ path }) => path.endsWith('/users/me'))).toHaveLength(currentCalls);
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0);
    expectNoLegacyRequests(requests);
  });

  test(`Web ${mode} 注册凭证仅存在内存，直访、刷新和离开资料页均不能复用`, async ({ page }) => {
    const { requests } = await webBackend(page);
    await page.goto(origin + '/#/register');
    await expect(page).toHaveURL(/#\/auth$/);
    await smsLogin(page);
    await expect(page).toHaveURL(/#\/register$/);
    await fillRegistration(page);
    await page.reload();
    await expect(page).toHaveURL(/#\/auth$/);
    await expect(page.getByLabel(/^手机号/)).toHaveValue('');
    await smsLogin(page);
    await expect(page).toHaveURL(/#\/register$/);
    await page.getByRole('link', { name: '返回登录 / 注册', exact: true }).click();
    await page.goto(origin + '/#/register');
    await expect(page).toHaveURL(/#\/auth$/);
    expect(requests.filter(({ path }) => path.endsWith('/auth/register'))).toHaveLength(0);
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain(registrationToken);
  });

  test(`Web ${mode} 会话恢复503显示重试，恢复后进入欢迎页`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    await pauseClock(page);
    state.signedIn = true;
    state.currentStatus = 503;
    await page
      .context()
      .addCookies([
        { name: 'fixture_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
      ]);
    await sessionRead(page, () => page.goto(origin + '/'));
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(1);
    await sessionRead(page, () => page.getByRole('button', { name: '重试', exact: true }).click());
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(2);
    state.currentNetworkFailure = true;
    await sessionRead(
      page,
      () => page.getByRole('button', { name: '重试', exact: true }).click(),
      true,
    );
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(3);
    state.currentNetworkFailure = false;
    state.currentStatus = 200;
    await sessionRead(page, () => page.getByRole('button', { name: '重试', exact: true }).click());
    await expectWelcome(page);
    expect(requests).toHaveLength(4);
    expectSessionReads(requests);
  });

  test(`Web ${mode} 会话网络失败和503无需点击自动恢复，成功后停止轮询`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    await pauseClock(page);
    state.signedIn = true;
    state.currentNetworkFailure = true;
    await page
      .context()
      .addCookies([
        { name: 'fixture_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
      ]);
    await sessionRead(page, () => page.goto(origin + '/'), true);
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(1);

    state.currentNetworkFailure = false;
    state.currentStatus = 503;
    await sessionRead(page, () => page.clock.runFor(3_000));
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(2);

    state.currentStatus = 200;
    await sessionRead(page, () => page.clock.runFor(3_000));
    await expectWelcome(page);
    expect(requests).toHaveLength(3);
    await page.clock.runFor(9_000);
    expect(requests).toHaveLength(3);
    expectSessionReads(requests);
  });

  test(`Web ${mode} 会话503恢复为401自动进入登录页并停止轮询`, async ({ page }) => {
    const { state, requests } = await webBackend(page);
    await pauseClock(page);
    state.currentStatus = 503;
    await sessionRead(page, () => page.goto(origin + '/'));
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
    state.currentStatus = 401;
    await sessionRead(page, () => page.clock.runFor(3_000));
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/auth$/);
    expect(requests).toHaveLength(2);
    await page.clock.runFor(9_000);
    expect(requests).toHaveLength(2);
    expectSessionReads(requests);
  });

  for (const invalidResponse of [false, true]) {
    test(`Web ${mode} 会话${invalidResponse ? '响应格式异常' : '403'}保留手动重试且不自动轮询`, async ({
      page,
    }) => {
      const { state, requests } = await webBackend(page);
      await pauseClock(page);
      state.currentStatus = invalidResponse ? 200 : 403;
      state.currentInvalidResponse = invalidResponse;
      await sessionRead(page, () => page.goto(origin + '/'));
      await expect(
        page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
      expect(requests).toHaveLength(1);
      await page.clock.runFor(9_000);
      expect(requests).toHaveLength(1);
      expectSessionReads(requests);
    });
  }
}

test('个人资料在1280与375视口保留字段、键盘操作和完整单页布局', async ({ page }) => {
  await webBackend(page);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 812 });
    await openAuth(page, 'http://127.0.0.1:5176');
    await page.getByRole('tab', { name: '验证码登录', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '密码登录', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '验证码注册', exact: true }).focus();
    await page.keyboard.press('Enter');
    await smsLogin(page);
    await expect(page).toHaveURL(/#\/register$/);
    await page.getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('请输入密码', { exact: true })).toBeVisible();
    await expect(page.getByText('请输入姓名', { exact: true })).toBeVisible();
    for (const field of ['登录密码', '确认密码', '姓名', '昵称', '身份证号', '邮箱']) {
      await expect(page.getByLabel(new RegExp('^' + field))).toBeInViewport({ ratio: 1 });
    }
    await expect(page.getByRole('button', { name: '提交', exact: true })).toBeInViewport({
      ratio: 1,
    });
    expect(
      await page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth <= innerWidth,
        vertical:
          Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) <=
          innerHeight + 1,
      })),
    ).toEqual({ horizontal: true, vertical: true });
    await mkdir('artifacts/screenshots', { recursive: true });
    await page.screenshot({
      path: `artifacts/screenshots/frontend-register-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});

async function desktopBackend(origin = 'http://127.0.0.1:5177') {
  const requests: RequestRecord[] = [];
  const preflights: string[] = [];
  const state = { registered: false, signedIn: false, currentStatus: 200, user: { ...user } };
  const cookie = 'fixture_session=active; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=1800';
  const server = createServer((request, response) => {
    if (request.headers.origin !== origin) return void response.writeHead(403).end();
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type, X-Tyde-Client',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      preflights.push(request.url ?? '');
      return void response.writeHead(204, headers).end();
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '';
      requests.push({
        path,
        method: request.method ?? '',
        body: raw ? JSON.parse(raw) : null,
        client: request.headers['x-tyde-client'] as string | undefined,
      });
      const reply = (data: unknown, extra = {}) =>
        response.writeHead(200, { ...headers, ...extra }).end(JSON.stringify(success(data)));
      const reject = () =>
        response.writeHead(401, headers).end(JSON.stringify(failure(401, '请先登录')));
      switch (path) {
        case '/api/v1/auth/sms/send':
          return reply(serverMessage);
        case '/api/v1/auth/register':
          state.registered = true;
          return reply(user);
        case '/api/v1/auth/sms/login':
          if (!state.registered) return reply(grant());
          state.signedIn = true;
          return reply(loginTokens, { 'Set-Cookie': cookie });
        case '/api/v1/auth/login':
          state.signedIn = true;
          return reply(loginTokens, { 'Set-Cookie': cookie });
        case '/api/v1/users/me':
          if (state.currentStatus !== 200)
            return response
              .writeHead(state.currentStatus, headers)
              .end(JSON.stringify(failure(state.currentStatus, '会话服务暂不可用')));
          return state.signedIn && request.headers.cookie?.includes('fixture_session=active')
            ? reply(state.user)
            : reject();
        case '/api/v1/users/me/update': {
          if (!state.signedIn || !request.headers.cookie?.includes('fixture_session=active'))
            return reject();
          const input = JSON.parse(raw) as Record<string, unknown>;
          if (typeof input.newPassword === 'string') {
            state.signedIn = false;
            return reply(state.user, {
              'Set-Cookie': 'fixture_session=; Max-Age=0; HttpOnly; SameSite=None; Secure; Path=/',
            });
          }
          if (typeof input.bio === 'string') state.user.bio = input.bio.trim() || null;
          if (typeof input.avatarUrl === 'string')
            state.user.avatarUrl = input.avatarUrl.trim() || null;
          return reply(state.user);
        }
        case '/api/v1/auth/refresh':
          return state.signedIn ? reply(loginTokens, { 'Set-Cookie': cookie }) : reject();
        case '/api/v1/auth/logout':
          state.signedIn = false;
          return reply(null, {
            'Set-Cookie': 'fixture_session=; Max-Age=0; HttpOnly; SameSite=None; Secure; Path=/',
          });
        default:
          return response
            .writeHead(503, headers)
            .end(JSON.stringify(failure(503, '调用了未约定的接口')));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('未分配测试端口');
  return {
    state,
    requests,
    preflights,
    url: 'http://127.0.0.1:' + address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

for (const [mode, origin] of [
  ['本地资源', 'tyde-app://app/index.html'],
  ['DEV', 'http://127.0.0.1:5177/'],
] as const) {
  test(`Electron ${mode} 页面HTTP注册登录、资料真实写入、Cookie恢复与改密退出`, async () => {
    const backend = await desktopBackend(
      origin.startsWith('tyde-app:') ? 'tyde-app://app' : new URL(origin).origin,
    );
    await mkdir('.local/frontend', { recursive: true });
    const profile = await mkdtemp(resolve('.local/frontend/session-'));
    const env = {
      ...process.env,
      TYDE_WEB_URL: origin,
      TYDE_API_BASE_URL: backend.url,
      TYDE_TEST_USER_DATA: profile,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () =>
      electron.launch({
        executablePath: require('electron') as string,
        args: [resolve('apps/electron/out/main/index.js')],
        env,
      });
    let app: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      app = await launch();
      let page = await app.firstWindow();
      await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
      expect(await page.evaluate(() => Object.keys(window.tydeDesktop!))).toEqual([
        'getRuntimeConfig',
      ]);
      expect(await page.evaluate(() => window.tydeDesktop!.getRuntimeConfig())).toEqual({
        ok: true,
        data: { apiBaseUrl: backend.url },
      });
      await page.getByLabel(/^手机号/).fill(phone);
      const sending = page.waitForResponse(
        (response) =>
          response.url() === `${backend.url}/api/v1/auth/sms/send` &&
          response.request().method() === 'POST',
      );
      await smsButton(page).click();
      const sent = await sending;
      expect(sent.request().resourceType()).toBe('fetch');
      expect(sent.request().headers()['x-tyde-client']).toBe('web');
      expect(sent.request().headers().authorization).toBeUndefined();
      expect(sent.request().postDataJSON()).toEqual({ phone, scene: 'login' });
      await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(successNotice);
      await smsLogin(page);
      await expect(page).toHaveURL(/#\/register$/);
      await fillRegistration(page);
      await page.getByRole('button', { name: '提交', exact: true }).click();
      await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(
        '注册成功，请使用密码登录。',
      );
      expect(backend.requests.filter(({ path }) => path.endsWith('/auth/login'))).toHaveLength(0);
      await page.getByLabel(/^密码\s*\*?\s*$/).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expectWelcome(page);
      const cookies = await app.evaluate(
        ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({ url }),
        backend.url,
      );
      expect(cookies.find(({ name }) => name === 'fixture_session')).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
        session: false,
      });
      const storage = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          cookie: document.cookie,
        }),
      );
      expect(storage).not.toContain(loginTokens.accessToken);
      expect(storage).not.toContain(loginTokens.refreshToken);
      expect(storage).not.toContain('fixture_session');
      const preferences = await app.evaluate(({ BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences();
        return {
          contextIsolation: p.contextIsolation,
          sandbox: p.sandbox,
          nodeIntegration: p.nodeIntegration,
        };
      });
      expect(preferences).toEqual({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      });
      await page.getByRole('link', { name: '个人中心', exact: true }).click();
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      await page.getByLabel('个人简介', { exact: true }).fill('桌面真实资料');
      const writesBefore = backend.requests.filter(({ method }) => method === 'POST').length;
      await page.getByRole('button', { name: '保存修改', exact: true }).click();
      await expect(
        page
          .getByRole('tabpanel', { name: '个人资料', exact: true })
          .getByText('桌面真实资料', { exact: true }),
      ).toBeVisible();
      expect(backend.requests.filter(({ method }) => method === 'POST')).toHaveLength(
        writesBefore + 1,
      );
      expect(
        backend.requests.findLast(({ path }) => path === '/api/v1/users/me/update')?.body,
      ).toEqual({ bio: '桌面真实资料' });
      await page.reload();
      await expect(page.getByRole('tablist', { name: '个人中心设置', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '个人资料', exact: true }).click();
      await expect(
        page
          .getByRole('tabpanel', { name: '个人资料', exact: true })
          .getByText('桌面真实资料', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '账户菜单', exact: true }).click();
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page).toHaveURL(/#\/auth$/);
      await smsLogin(page);
      await expectWelcome(page);
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await expectWelcome(page);
      await page.getByRole('link', { name: '个人中心', exact: true }).click();
      await page.getByRole('tab', { name: '账户安全', exact: true }).click();
      await page.getByLabel(/^新密码\s*\*?\s*$/).fill('Changed123!');
      await page.getByLabel(/^确认新密码\s*\*?\s*$/).fill('Changed123!');
      await page.getByRole('button', { name: '更新密码', exact: true }).click();
      await expect(page).toHaveURL(/#\/auth$/);
      await expect(
        page.getByText('密码修改成功，全部设备需重新登录。', { exact: true }),
      ).toBeVisible();
      const cleared = await page.evaluate(async () => {
        const runtime = await window.tydeDesktop!.getRuntimeConfig();
        if (!runtime.ok) throw new Error(runtime.error.message);
        return (
          await fetch(`${runtime.data.apiBaseUrl}/api/v1/users/me`, { credentials: 'include' })
        ).status;
      });
      expect(cleared).toBe(401);
      expect(
        backend.requests.filter(({ path }) => path.endsWith('/sms/send')).map(({ body }) => body),
      ).toEqual([{ phone, scene: 'login' }]);
      expectNoLegacyRequests(backend.requests);
      expect(backend.preflights).toContain('/api/v1/auth/sms/send');
      expect(backend.preflights).not.toContain('/api/v1/users/me');
    } finally {
      await app?.close();
      await backend.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}

test('Electron DEV 会话503自动恢复为401，进入登录页后停止轮询', async () => {
  const backend = await desktopBackend();
  backend.state.currentStatus = 503;
  await mkdir('.local/frontend', { recursive: true });
  const profile = await mkdtemp(resolve('.local/frontend/recovery-'));
  const env = {
    ...process.env,
    TYDE_WEB_URL: 'http://127.0.0.1:5177/',
    TYDE_API_BASE_URL: backend.url,
    TYDE_TEST_USER_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [resolve('apps/electron/out/main/index.js')],
      env,
    });
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    expect(backend.requests).toHaveLength(1);
    backend.state.currentStatus = 200;
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
    await page.waitForTimeout(3500);
    expect(backend.requests).toHaveLength(2);
    expectSessionReads(backend.requests);
    expect(backend.preflights).toEqual([]);
  } finally {
    try {
      await app?.close();
    } finally {
      await backend.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

test('Electron DEV 已登录会话503自动恢复为200，成功后停止轮询且不重放写请求', async () => {
  const backend = await desktopBackend();
  await mkdir('.local/frontend', { recursive: true });
  const profile = await mkdtemp(resolve('.local/frontend/authenticated-recovery-'));
  const env = {
    ...process.env,
    TYDE_WEB_URL: 'http://127.0.0.1:5177/',
    TYDE_API_BASE_URL: backend.url,
    TYDE_TEST_USER_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [resolve('apps/electron/out/main/index.js')],
      env,
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '密码登录', exact: true }).click();
    await page.getByLabel(/^手机号/).fill(phone);
    await page.getByLabel(/^密码\s*\*?\s*$/).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expectWelcome(page);
    backend.state.currentStatus = 503;
    const beforeRecovery = backend.requests.length;
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '暂时无法加载账户资料', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    expect(backend.requests.slice(beforeRecovery)).toHaveLength(1);
    backend.state.currentStatus = 200;
    await expectWelcome(page);
    await expect(page).toHaveURL(/#\/$/);
    expect(backend.requests.slice(beforeRecovery)).toHaveLength(2);
    await page.waitForTimeout(3500);
    await expect(page).toHaveURL(/#\/$/);
    const recoveryRequests = backend.requests.slice(beforeRecovery);
    expect(recoveryRequests).toHaveLength(2);
    expectSessionReads(recoveryRequests);
    expect(recoveryRequests.every(({ client }) => client === undefined)).toBe(true);
    expect(backend.preflights).not.toContain('/api/v1/users/me');
  } finally {
    try {
      await app?.close();
    } finally {
      await backend.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

test('Electron macOS 真实重复启动重开或恢复窗口，激活事件不创建重复窗口', async () => {
  test.skip(process.platform !== 'darwin', '关闭全部窗口后保留应用是 macOS 生命周期行为');
  const backend = await desktopBackend();
  await mkdir('.local/frontend', { recursive: true });
  const profile = await mkdtemp(resolve('.local/frontend/lifecycle-'));
  const executablePath = require('electron') as string;
  const args = [resolve('apps/electron/out/main/index.js')];
  const env = {
    ...process.env,
    TYDE_WEB_URL: 'http://127.0.0.1:5177/',
    TYDE_API_BASE_URL: backend.url,
    TYDE_TEST_USER_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const secondaryProcesses = new Set<ReturnType<typeof spawn>>();
  const startAgain = async () => {
    const child = spawn(executablePath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(10_000),
    });
    secondaryProcesses.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (accept, reject) => {
        child.once('error', (error) => {
          if (!child.pid) secondaryProcesses.delete(child);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          secondaryProcesses.delete(child);
          accept({ code, signal });
        });
      },
    );
    expect(result, output).toEqual({ code: 0, signal: null });
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath, args, env });
    const desktop = app;
    const windowState = () =>
      desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          minimized: window.isMinimized(),
        })),
      );
    const closeWindows = async () => {
      await desktop.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.close();
      });
      await expect.poll(windowState).toEqual([]);
      expect(desktop.process().exitCode).toBeNull();
    };
    const expectLogin = (page: Page) =>
      expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
    await expectLogin(await desktop.firstWindow());
    await closeWindows();

    const [page] = await Promise.all([desktop.waitForEvent('window'), startAgain()]);
    await expectLogin(page);
    await expect.poll(windowState).toEqual([{ visible: true, minimized: false }]);
    for (const state of ['hide', 'minimize'] as const) {
      await desktop.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()[0]![state]();
      }, state);
      await expect
        .poll(async () => {
          const [window] = await windowState();
          return state === 'hide' ? !window?.visible : window?.minimized;
        })
        .toBe(true);
      await startAgain();
      await expect.poll(windowState).toEqual([{ visible: true, minimized: false }]);
      await expectLogin(page);
    }

    await closeWindows();
    const [activated] = await Promise.all([
      desktop.waitForEvent('window'),
      desktop.evaluate(({ app }) => {
        for (let index = 0; index < 5; index++) {
          app.emit('activate');
          app.emit('second-instance');
        }
      }),
    ]);
    await expectLogin(activated);
    await expect.poll(windowState).toEqual([{ visible: true, minimized: false }]);
  } finally {
    try {
      await Promise.all(
        [...secondaryProcesses].map(
          (child) =>
            new Promise<void>((accept) => {
              child.once('exit', () => accept());
              if (child.exitCode !== null || child.signalCode !== null) accept();
              else child.kill('SIGKILL');
            }),
        ),
      );
      await app?.close();
    } finally {
      await backend.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

const internalRenderFailure = 'INTERNAL_RENDER_FIXTURE 当前角色必须在登录后的工作台中使用';

/** 只修改隔离 DEV 页面的模块响应，触发真正的 React/路由错误边界。 */
async function interceptRenderFailure(page: Page, sourcePath: string, functionStart: string) {
  let failing = true;
  await page.route(`**/src/${sourcePath}*`, async (route) => {
    const response = await route.fetch();
    if (!failing) return route.fulfill({ response });
    const source = await response.text();
    const injected = source.replace(
      functionStart,
      `${functionStart}\nthrow new Error(${JSON.stringify(internalRenderFailure)});`,
    );
    expect(injected).not.toBe(source);
    await route.fulfill({ response, body: injected });
  });
  return () => {
    failing = false;
  };
}

for (const [mode, width, action] of [
  ['桌面', 1280, '返回首页'],
  ['手机', 375, '重试'],
] as const) {
  test(`页面错误恢复 DEV ${mode} 业务渲染异常隐藏内部错误并支持${action}`, async ({ page }) => {
    const origin = 'http://127.0.0.1:5177';
    const { state, requests } = await webBackend(page);
    state.signedIn = true;
    await page
      .context()
      .addCookies([
        { name: 'fixture_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
      ]);
    const recover = await interceptRenderFailure(
      page,
      'modules/profile/ProfilePage.tsx',
      'export function ProfilePage({ user }) {',
    );
    if (width === 375)
      await page.route('**/src/app/App.tsx*', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        // 只在隔离响应延迟认证匹配，覆盖旧工作台页面尚未卸载的导航窗口。
        const delayed = source.replace(
          'path: "/auth",',
          'path: "/auth", beforeLoad: () => new Promise((resolve) => setTimeout(resolve, 1500)),',
        );
        expect(delayed).not.toBe(source);
        await route.fulfill({ response, body: delayed });
      });
    await page.setViewportSize({ width, height: 812 });
    await page.goto(origin + '/index.html?context=recovery#/profile');
    await expect(
      page.getByRole('heading', { name: '页面暂时无法显示', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '账户菜单', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '返回首页', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(internalRenderFailure);
    await expect(page.locator('body')).not.toContainText('当前角色必须在登录后的工作台中使用');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    if (width === 375)
      await page.screenshot({ path: 'artifacts/page-recovery-profile-mobile.png' });
    recover();
    const loaded = page.waitForEvent('domcontentloaded');
    await page.getByRole('button', { name: action, exact: true }).click();
    await loaded;
    if (action === '返回首页') {
      await expect(page).toHaveURL(/#\/$/);
      await expectWelcome(page);
    } else {
      await expect(page).toHaveURL(/#\/profile$/);
      await expect(page.getByRole('tablist', { name: '个人中心设置', exact: true })).toBeVisible();
      await page.evaluate(() => {
        window.location.hash = '/auth';
      });
      await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('tablist', { name: '个人中心设置', exact: true })).toBeVisible();
    }
    expect(new URL(page.url()).pathname).toBe('/index.html');
    expect(new URL(page.url()).searchParams.get('context')).toBe('recovery');
    expect(state.signedIn).toBe(true);
    expect(
      (await page.context().cookies(origin)).some(
        (cookie) => cookie.name === 'fixture_session' && cookie.value === 'active',
      ),
    ).toBe(true);
    expect(
      requests.filter(({ path }) => ['/api/v1/auth/logout', '/api/v1/auth/login'].includes(path)),
    ).toHaveLength(0);
    await expect(page.getByRole('heading', { name: '页面暂时无法显示', exact: true })).toHaveCount(
      0,
    );
  });
}

test('页面错误恢复 DEV 工作台角色上下文异常展示独立恢复页，返回首页保留会话', async ({ page }) => {
  const origin = 'http://127.0.0.1:5177';
  const { state, requests } = await webBackend(page);
  state.signedIn = true;
  await page
    .context()
    .addCookies([
      { name: 'fixture_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const recover = await interceptRenderFailure(
    page,
    'layouts/WorkspaceView.tsx',
    'export function useWorkspaceView() {',
  );
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto(origin + '/#/profile');
  await expect(page.getByRole('heading', { name: '页面暂时无法显示', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '账户菜单', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(internalRenderFailure);
  await expect(page.locator('body')).not.toContainText('当前角色必须在登录后的工作台中使用');
  await page.screenshot({ path: 'artifacts/page-recovery-workspace-desktop.png' });
  recover();
  const loaded = page.waitForEvent('domcontentloaded');
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await loaded;
  await expect(page).toHaveURL(/#\/$/);
  await expectWelcome(page);
  expect(state.signedIn).toBe(true);
  expect(
    requests.filter(({ path }) => ['/api/v1/auth/logout', '/api/v1/auth/login'].includes(path)),
  ).toHaveLength(0);
});
