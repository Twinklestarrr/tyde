import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  AuthUser,
  OrganizationDetail,
  OrganizationMember,
} from '../../packages/shared/src/index';

const require = createRequire(resolve('apps/electron/package.json'));
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const orgId = uuid(100);
const time = '2026-01-02T01:00:00.000Z';
const phone = '13812345678';
const password = 'FixturePass123!';
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};

/** 原生沙箱窗口使用真实 HTTP/Cookie；此替身不连接业务数据库。 */
test('Electron 本地资源组织管理通过页面 HTTP 保存、刷新和 multipart 导入', async () => {
  const organization: OrganizationDetail = {
    id: orgId,
    name: '桌面组织联调组',
    unifiedCreditCode: null,
    description: '组织初始简介',
    businessLicenseUrl: null,
    logoUrl: null,
    expertiseTags: ['数据标注'],
    verifyStatus: 'APPROVED',
    status: 'ACTIVE',
    position: 'OWNER',
    createdAt: time,
  };
  const user: AuthUser = {
    id: uuid(1),
    uid: 'ORG10001',
    accountType: 'ORGANIZATION',
    phone: '138****5678',
    nickname: '桌面联调主管',
    realName: '测试主管',
    idCardNo: null,
    idVerified: 0,
    avatarUrl: null,
    bio: null,
    role: 'EXPERT',
    roles: ['NAVIGATOR', 'PM', 'EXPERT'],
    selectedRole: 'EXPERT',
    hasExpertManagementRole: true,
    status: 'ACTIVE',
    creditScore: 100,
    lastLoginAt: null,
    lastLoginIp: null,
    organization: { ...organization, joinStatus: 'ACTIVE' },
    createdAt: time,
    updatedAt: time,
  };
  const member: OrganizationMember = {
    memberId: uuid(101),
    userId: user.id,
    uid: user.uid,
    realName: user.realName,
    nickname: user.nickname,
    phoneMasked: user.phone,
    avatarUrl: null,
    userStatus: 'ACTIVE',
    employmentType: 'FULL_TIME',
    position: 'OWNER',
    joinStatus: 'ACTIVE',
    joinedAt: time,
    plannedLeaveDate: null,
    leftAt: null,
    activeProjectCount: 0,
    versionNo: 1,
  };
  const members = [member];
  const requests: Array<{
    path: string;
    method: string;
    cookie: boolean;
    client?: string;
    authorization?: string;
    body: Record<string, unknown> | null;
    raw: string;
    contentType: string;
    key?: string;
  }> = [];
  const preflights: string[] = [];
  let signedIn = false;
  const origin = 'tyde-app://app';
  const cookie =
    'organization_session=active; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=1800';
  const server = createServer((request, response) => {
    if (request.headers.origin !== origin) return void response.writeHead(403).end();
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type, X-Tyde-Client, Idempotency-Key',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      preflights.push(request.url ?? '');
      return void response.writeHead(204, headers).end();
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = request.headers['content-type'] ?? '';
      const body =
        contentType.includes('application/json') && raw
          ? (JSON.parse(raw) as Record<string, unknown>)
          : null;
      const record = {
        path,
        method: request.method ?? '',
        cookie: Boolean(
          signedIn && request.headers.cookie?.includes('organization_session=active'),
        ),
        client: request.headers['x-tyde-client'] as string | undefined,
        authorization: request.headers.authorization,
        body,
        raw,
        contentType,
        key: request.headers['idempotency-key'] as string | undefined,
      };
      requests.push(record);
      const reply = (data: unknown, status = 200, extra = {}) =>
        response.writeHead(status, { ...headers, ...extra }).end(
          JSON.stringify({
            code: status,
            message: status === 200 ? '操作成功' : '请求被拒绝',
            data,
          }),
        );
      if (request.method !== 'GET' && record.client !== 'web') return void reply(null, 403);
      if (record.authorization) return void reply(null, 403);
      if (path === '/api/v1/auth/login') {
        if (body?.account !== phone || body.password !== password) return void reply(null, 401);
        signedIn = true;
        return void reply(tokens, 200, { 'Set-Cookie': cookie });
      }
      if (!record.cookie) return void reply(null, 401);
      if (path === '/api/v1/users/me') return void reply(user);
      if (path === '/api/v1/auth/switch-role') {
        const role = body?.role as AuthUser['role'];
        if (!user.roles.includes(role)) return void reply(null, 403);
        user.role = role;
        user.selectedRole = role;
        return void reply({ selectedRole: role, roles: [...user.roles] });
      }
      if (path === '/api/v1/auth/refresh') return void reply(tokens, 200, { 'Set-Cookie': cookie });
      if (path === '/api/v1/organizations') return void reply(organization);
      if (path === '/api/v1/organizations/members')
        return void reply({
          total: members.length,
          pages: 1,
          current: 1,
          size: 20,
          records: members,
        });
      if (path === '/api/v1/organizations/update') {
        if (body?.orgId !== orgId || typeof body.description !== 'string')
          return void reply(null, 400);
        organization.description = body.description;
        user.organization = { ...organization, joinStatus: 'ACTIVE' };
        return void reply({
          id: orgId,
          description: organization.description,
          logoUrl: organization.logoUrl,
          updatedAt: time,
        });
      }
      if (path === '/api/v1/organizations/member-imports/generate') {
        if (
          !record.key ||
          !contentType.startsWith('multipart/form-data; boundary=') ||
          !raw.includes('name="orgId"') ||
          !raw.includes(orgId) ||
          !raw.includes('name="memberText"') ||
          !raw.includes('桌面导入成员,13800000002,全职,成员')
        )
          return void reply(null, 400);
        members.push({
          ...member,
          memberId: uuid(102),
          userId: uuid(2),
          uid: 'ORG10002',
          realName: '桌面导入成员',
          nickname: null,
          position: 'MEMBER',
          joinStatus: 'PENDING_ACTIVATION',
          phoneMasked: '138****0002',
        });
        return void reply({
          sourceType: 'TEXT',
          textIgnored: false,
          totalCount: 1,
          validCount: 1,
          invalidCount: 0,
          createdCount: 1,
          rowErrors: [],
          members: [
            {
              memberId: uuid(102),
              userId: uuid(2),
              uid: 'ORG10002',
              accountType: 'INDIVIDUAL',
              phoneMasked: '138****0002',
              realName: '桌面导入成员',
              position: 'MEMBER',
              employmentType: 'FULL_TIME',
              joinedAt: time,
              joinStatus: 'PENDING_ACTIVATION',
            },
          ],
          createdAt: time,
        });
      }
      if (path === '/api/v1/auth/logout') {
        signedIn = false;
        return void reply(null, 200, {
          'Set-Cookie': 'organization_session=; Max-Age=0; HttpOnly; SameSite=None; Secure; Path=/',
        });
      }
      return void reply(null, 404);
    });
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('未分配测试端口');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(resolve(tmpdir(), 'tyde-organization-electron-'));
  const env = {
    ...process.env,
    TYDE_WEB_URL: 'tyde-app://app/index.html',
    TYDE_API_BASE_URL: apiUrl,
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
    expect(await page.evaluate(() => Object.keys(window.tydeDesktop!))).toEqual([
      'getRuntimeConfig',
    ]);
    await page.getByRole('tab', { name: '密码登录', exact: true }).click();
    await page.getByLabel(/^手机号/).fill(phone);
    await page.getByLabel(/^密码\s*\*?\s*$/).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: `欢迎，${user.nickname}`, exact: true }),
    ).toBeVisible();
    await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
    await page.getByRole('option', { name: '策略官', exact: true }).click();
    await expect(page.getByRole('heading', { name: '策略官工作台', exact: true })).toBeVisible();
    await expect(page.getByText('工作台功能尚未接入', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '组织管理', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
    await page.getByRole('option', { name: '执行专家', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
      '执行专家',
    );
    expect(
      requests.filter(({ path }) => path === '/api/v1/auth/switch-role').map(({ body }) => body),
    ).toEqual([{ role: 'PM' }, { role: 'EXPERT' }]);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '组织管理', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '组织管理', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: user.uid })).toBeVisible();
    await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑组织资料', exact: true });
    await edit.getByLabel('组织简介', { exact: true }).fill('桌面保存到 HTTP 替身的简介');
    const save = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/api/v1/organizations/update` &&
        response.request().method() === 'POST',
    );
    await edit.getByRole('button', { name: '保存组织资料', exact: true }).click();
    const saved = await save;
    expect(saved.request().resourceType()).toBe('fetch');
    expect(saved.status()).toBe(200);
    await expect(edit).not.toBeVisible();
    await expect(
      page.getByLabel('组织基本信息').getByText('桌面保存到 HTTP 替身的简介', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByLabel('组织基本信息').getByText('桌面保存到 HTTP 替身的简介', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
    const importing = page.getByRole('dialog', { name: '批量导入成员', exact: true });
    await importing.getByLabel('第 1 行 姓名', { exact: true }).fill('桌面导入成员');
    await importing.getByLabel('第 1 行 手机号', { exact: true }).fill('13800000002');
    await importing.getByLabel('第 1 行 人员属性', { exact: true }).click();
    await importing.getByRole('option', { name: '全职', exact: true }).click();
    await importing.getByLabel('第 1 行 组织角色', { exact: true }).click();
    await importing.getByRole('option', { name: '管理员', exact: true }).click();
    await importing.getByLabel('第 1 行 组织角色', { exact: true }).click();
    await importing.getByRole('option', { name: '成员', exact: true }).click();
    await importing.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(importing.getByText(/已成功导入 1 位成员/)).toBeVisible();
    await importing.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'ORG10002' })).toBeVisible();
    const cookies = await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({ url }),
      apiUrl,
    );
    expect(cookies.find(({ name }) => name === 'organization_session')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction',
    });
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/auth$/);
    expect(signedIn).toBe(false);
    const organizationCalls = requests.filter(({ path }) =>
      path.startsWith('/api/v1/organizations'),
    );
    expect(
      organizationCalls.every(
        (request) =>
          request.cookie &&
          !request.authorization &&
          (request.method === 'GET' ? request.client === undefined : request.client === 'web'),
      ),
    ).toBe(true);
    expect(
      organizationCalls
        .filter(({ path }) => path === '/api/v1/organizations/update')
        .map(({ body }) => body),
    ).toEqual([{ orgId, description: '桌面保存到 HTTP 替身的简介' }]);
    expect(organizationCalls.filter(({ path }) => path.endsWith('/generate'))).toHaveLength(1);
    expect(preflights).toContain('/api/v1/organizations/member-imports/generate');
    expect(preflights).not.toContain(`/api/v1/organizations?orgId=${orgId}`);
  } finally {
    await app?.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
    await rm(profile, { recursive: true, force: true });
  }
});
