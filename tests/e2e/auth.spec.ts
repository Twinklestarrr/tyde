import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { MOCK_CODE } from '../../apps/server/src/modules/auth/security';
import type {
  AuthUser,
  RegistrationRequired,
  LoginResponse,
  Result,
} from '../../packages/shared/src/index';

const root = process.cwd();
const require = createRequire(resolve(root, 'apps/electron/package.json'));
const phone = () => `139${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
const password = 'Password123!';
const profile = {
  accountType: 'INDIVIDUAL' as const,
  password,
  confirmPassword: password,
  realName: '测试小明',
  nickname: '潮汐测试员',
};
const personalFields = (number: string) => ({
  ...profile,
  idCardNo: number.padStart(17, '0') + 'X',
  email: number + '@example.invalid',
});

/** 此套件只使用 playwright.config.ts 配置的3100专用测试服务。 */
async function registerWeb(page: Page, nickname = profile.nickname) {
  const number = phone();
  const headers = { 'X-Tyde-Client': 'web', Origin: new URL(page.url()).origin };
  const code = await page.request.post('/api/v1/auth/sms/send', {
    headers,
    data: { phone: number, scene: 'login' },
  });
  expect(code.ok()).toBe(true);
  expect(typeof ((await code.json()) as Result<string>).data).toBe('string');
  const verify = await page.request.post('/api/v1/auth/sms/login', {
    headers,
    data: { phone: number, code: MOCK_CODE },
  });
  expect(verify.ok()).toBe(true);
  const grant = ((await verify.json()) as Result<RegistrationRequired>).data;
  expect(grant.status).toBe('registration_required');
  const registered = await page.request.post('/api/v1/auth/register', {
    headers,
    data: {
      ...personalFields(number),
      nickname,
      phone: number,
      registrationToken: grant.registrationToken,
    },
  });
  expect(registered.ok()).toBe(true);
  const registration = (await registered.json()) as Result<AuthUser>;
  expect(registration.data.phone).toBe(number.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'));
  expect(registration.data.nickname).toBe(nickname);
  expect(registration.data.role).toBe('EXPERT');
  expect(JSON.stringify(registration)).not.toMatch(/accessToken|refreshToken/);
  expect((await page.request.get('/api/v1/users/me', { headers })).status()).toBe(401);
  const login = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { account: number, password },
  });
  expect(login.ok()).toBe(true);
  const tokens = ((await login.json()) as Result<LoginResponse>).data;
  expect(tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'tyde_session',
  );
  expect(sessionCookie?.httpOnly).toBe(true);
  return { headers, tokens };
}

test('Web真实API注册不登录、密码登录、Cookie恢复、令牌轮换与200退出', async ({ page }) => {
  await page.goto('/');
  const { headers, tokens } = await registerWeb(page);
  await page.reload();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
  const current = await page.request.get('/api/v1/users/me', { headers });
  expect(current.ok()).toBe(true);
  expect(((await current.json()) as Result<AuthUser>).data.nickname).toBe(profile.nickname);
  const refresh = await page.request.post('/api/v1/auth/refresh', {
    headers,
    data: { refreshToken: tokens.refreshToken },
  });
  expect(refresh.ok()).toBe(true);
  const rotated = ((await refresh.json()) as Result<LoginResponse>).data;
  expect(rotated.accessToken).not.toBe(tokens.accessToken);
  expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
  expect(
    (
      await page.request.post('/api/v1/auth/refresh', {
        headers,
        data: { refreshToken: tokens.refreshToken },
      })
    ).status(),
  ).toBe(401);
  expect((await page.request.get('/api/v1/users/me', { headers })).ok()).toBe(true);
  const logout = await page.request.post('/api/v1/auth/logout', { headers });
  expect(logout.status()).toBe(200);
  expect(await logout.json()).toEqual({ code: 200, message: '操作成功', data: null });
  expect((await page.request.get('/api/v1/users/me', { headers })).status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/#\/auth$/);
});

test('Web真实API三角色工作台空列表、角色切换和刷新恢复均无报错', async ({ page }) => {
  await page.goto('/');
  const { headers } = await registerWeb(page, `工作台联调${phone()}`);
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/v1/') && response.status() >= 400)
      failedRequests.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  const roles = [
    ['EXPERT', '执行专家', '/api/v1/expert-assignments/my-tasks', 'POST', '我负责的项目'],
    ['NAVIGATOR', '领航员', '/api/v1/projects/list', 'GET', '我创建的项目'],
    ['PM', '策略官', '/api/v1/projects/manager/list', 'GET', '我负责的项目'],
  ] as const;
  for (const [role, label, path, method, title] of roles) {
    const list = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path && response.request().method() === method,
      );
    const loaded = list();
    if (role === 'EXPERT') {
      await page.reload();
      await page.goto('/#/');
    } else {
      await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
      await page.getByRole('option', { name: label, exact: true }).click();
    }
    const response = await loaded;
    expect(response.status()).toBe(200);
    expect(((await response.json()) as Result<unknown[]>).data).toEqual([]);
    if (role === 'EXPERT') expect(response.request().postDataJSON()).toEqual({});
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('暂无待办项目', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    const restored = list();
    await page.reload();
    const refreshed = await restored;
    expect(refreshed.status()).toBe(200);
    expect(((await refreshed.json()) as Result<unknown[]>).data).toEqual([]);
    await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
      label,
    );
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('暂无待办项目', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const current = await page.request.get('/api/v1/users/me', { headers });
    expect(current.status()).toBe(200);
    expect(((await current.json()) as Result<AuthUser>).data.selectedRole).toBe(role);
  }
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  const exited = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/logout' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  expect((await exited).status()).toBe(200);
  await expect(page).toHaveURL(/#\/auth$/);
  expect((await page.request.get('/api/v1/users/me', { headers })).status()).toBe(401);
});

async function registerDesktop(page: Page, requests: { path: string; method: string }[]) {
  const number = phone();
  const fields = personalFields(number);
  await expect(page.getByRole('heading', { name: '登录 / 注册', exact: true })).toBeVisible();
  const sessionReads = () => requests.filter(({ path }) => path === '/api/v1/users/me').length;
  const readsBeforeRegistration = sessionReads();
  await page.getByLabel(/^手机号/).fill(number);
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await expect(page.getByRole('status', { name: '操作提示' })).toContainText(MOCK_CODE);
  await page.getByRole('textbox', { name: '验证码', exact: true }).fill(MOCK_CODE);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page).toHaveURL(/#\/register$/);
  await page.getByLabel(/^登录密码/).fill(password);
  await page.getByLabel(/^确认密码/).fill(password);
  await page.getByLabel(/^姓名/).fill(fields.realName);
  await page.getByLabel(/^昵称/).fill(fields.nickname);
  await page.getByLabel(/^身份证号/).fill(fields.idCardNo);
  await page.getByLabel(/^邮箱/).fill(fields.email);
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByRole('status', { name: '操作提示' })).toHaveText(
    '注册成功，请使用密码登录。',
  );
  await expect(page.getByRole('tab', { name: '密码登录', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  );
  expect(sessionReads()).toBe(readsBeforeRegistration);
  await page.getByLabel(/^密码\s*\*?\s*$/).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
}

test('Electron真实页面注册登录、renderer Cookie请求、重启恢复与200退出', async () => {
  await mkdir('.local/e2e', { recursive: true });
  const userData = await mkdtemp(resolve(root, '.local/e2e/profile-'));
  const origin = 'http://127.0.0.1:5178';
  const apiOrigin = 'http://127.0.0.1:3100';
  const env = {
    ...process.env,
    TYDE_WEB_URL: origin + '/',
    TYDE_API_BASE_URL: apiOrigin,
    TYDE_TEST_USER_DATA: userData,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = {
    executablePath: require('electron') as string,
    args: [resolve(root, 'apps/electron/out/main/index.js')],
    env,
  };
  let app = await electron.launch(options);
  try {
    const first = await app.firstWindow();
    const requests: { path: string; method: string; hasAuthorization: boolean }[] = [];
    first.on('request', (request) => {
      if (request.url().startsWith(apiOrigin + '/api/v1/'))
        requests.push({
          path: new URL(request.url()).pathname,
          method: request.method(),
          hasAuthorization: Object.hasOwn(request.headers(), 'authorization'),
        });
    });
    const runtime = await first.evaluate(() => window.tydeDesktop!.getRuntimeConfig());
    expect(runtime).toEqual({ ok: true, data: { apiBaseUrl: apiOrigin } });
    expect(await first.evaluate(() => Object.keys(window.tydeDesktop!))).toEqual([
      'getRuntimeConfig',
    ]);
    await registerDesktop(first, requests);
    const cookieMetadata = await app.evaluate(async ({ BrowserWindow }, apiOrigin) => {
      const cookies = await BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({
        url: apiOrigin,
      });
      return cookies
        .filter(({ name }) => name === 'tyde_session')
        .map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite }));
    }, apiOrigin);
    expect(cookieMetadata).toEqual([
      { name: 'tyde_session', httpOnly: true, secure: true, sameSite: 'no_restriction' },
    ]);
    expect(
      requests.some(({ path, method }) => path === '/api/v1/auth/login' && method === 'POST'),
    ).toBe(true);
    expect(
      requests.some(({ path, method }) => path === '/api/v1/users/me' && method === 'GET'),
    ).toBe(true);
    expect(requests.every(({ hasAuthorization }) => !hasAuthorization)).toBe(true);
    await app.close();
    app = await electron.launch(options);
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
    const current = await page.evaluate(async () => {
      const runtime = await window.tydeDesktop!.getRuntimeConfig();
      if (!runtime.ok) throw new Error(runtime.error.message);
      const response = await fetch(runtime.data.apiBaseUrl + '/api/v1/users/me', {
        credentials: 'include',
      });
      const payload = await response.json();
      return { status: response.status, nickname: payload.data?.nickname };
    });
    expect(current).toEqual({ status: 200, nickname: profile.nickname });
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    const exited = page.waitForResponse(
      (response) =>
        response.url() === apiOrigin + '/api/v1/auth/logout' &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('navigation', { name: '账户选项', exact: true })
      .getByRole('button', { name: '退出登录', exact: true })
      .click();
    expect((await exited).status()).toBe(200);
    await expect(page).toHaveURL(/#\/auth$/);
    const cleared = await page.evaluate(async () => {
      const runtime = await window.tydeDesktop!.getRuntimeConfig();
      if (!runtime.ok) throw new Error(runtime.error.message);
      return (await fetch(runtime.data.apiBaseUrl + '/api/v1/users/me', { credentials: 'include' }))
        .status;
    });
    expect(cleared).toBe(401);
    await page.reload();
    await page.goto(origin + '/#/');
    await expect(page).toHaveURL(/#\/auth$/);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
