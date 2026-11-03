import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { OrganizationService } from '../src/modules/organizations/organization.service.js';
import { OrganizationApprovalService } from '../src/modules/organizations/organization-approval.service.js';
import { MemberImportService } from '../src/modules/organizations/member-import.service.js';
import { organizationUpdateResponse } from '../src/modules/organizations/organization.schema.js';
import { exitResponse } from '../src/modules/organizations/approval.schema.js';
import { importExample } from '../src/modules/organizations/import.schema.js';
import { ProjectManagerService } from '../src/modules/projects/project-manager.service.js';
import { managerRecruitResult } from '../src/modules/projects/project-manager.schema.js';

const environment = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:3001',
  DESKTOP_ORIGINS: 'tyde-app://app,http://127.0.0.1:5174',
  LOG_LEVEL: 'silent',
};
const config = readConfig(environment);
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer' as const,
  expiresIn: 2592000,
};
afterEach(() => vi.restoreAllMocks());

test('desktop Cookie project recruitment reaches its service while unknown sources are rejected', async () => {
  const identity = {
    userId: '00000000-0000-4000-8000-000000000001',
    uid: 'test-user',
    sessionId: 'session',
    role: 'NAVIGATOR' as const,
    clientType: 'web' as const,
  };
  const authenticate = vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(identity);
  const recruit = vi
    .spyOn(ProjectManagerService.prototype, 'recruit')
    .mockResolvedValue(managerRecruitResult.examples[0] as never);
  const app = await createApp(config, new PrismaClient());
  const payload = {
    projectId: 3001,
    candidateUserId: '00000000-0000-4000-8000-000000000002',
  };
  try {
    for (const origin of config.desktopOrigins) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/manager-recruitments',
        headers: {
          origin,
          'x-tyde-client': 'web',
          cookie: `tyde_session=${tokens.accessToken}`,
        },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(recruit).toHaveBeenLastCalledWith(payload, identity);
      expect(authenticate).toHaveBeenLastCalledWith(tokens.accessToken, 'web');
    }
    recruit.mockClear();
    authenticate.mockClear();
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/manager-recruitments',
      headers: {
        origin: 'https://untrusted.example',
        'x-tyde-client': 'web',
        cookie: `tyde_session=${tokens.accessToken}`,
      },
      payload,
    });
    expect(blocked.statusCode).toBe(403);
    expect(recruit).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('desktop origin configuration is exact and restricted to the app or loopback development', () => {
  expect(readConfig({ ...environment, DESKTOP_ORIGINS: undefined }).desktopOrigins).toEqual([
    'tyde-app://app',
  ]);
  expect(
    readConfig({ ...environment, DESKTOP_ORIGINS: 'https://localhost:5174,http://[::1]:5174' })
      .desktopOrigins,
  ).toEqual(['https://localhost:5174', 'http://[::1]:5174']);
  for (const origin of [
    '',
    '*',
    'null',
    'https://remote.example',
    'https://localhost:5174/',
    'http://localhost:5174/path',
    'http://localhost:5174?query=1',
    'tyde-app://other',
    'tyde-app://app/',
    'http://localhost.evil.test:5174',
  ])
    expect(() => readConfig({ ...environment, DESKTOP_ORIGINS: origin }), origin).toThrow(
      'DESKTOP_ORIGINS',
    );
});

test('credential CORS preflights allow only exact sources, supported methods and browser headers', async () => {
  const app = await createApp(config, new PrismaClient());
  try {
    for (const origin of [...config.webOrigins, ...config.desktopOrigins]) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/login',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Content-Type, X-Tyde-Client, Idempotency-Key',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-headers']).toBe(
        'Content-Type, X-Tyde-Client, Idempotency-Key',
      );
      expect(response.headers['access-control-expose-headers']).toBe(
        'Retry-After, Content-Disposition',
      );
      expect(response.headers.vary).toContain('Origin');
    }
    for (const headers of [
      { origin: 'null' },
      { origin: 'tyde-app://app.evil.test' },
      { origin: 'http://127.0.0.1:5175' },
      { 'access-control-request-method': 'PUT' },
      { 'access-control-request-headers': 'Authorization' },
      { 'access-control-request-headers': 'X-Untrusted-Header' },
    ]) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/files/upload',
        headers: {
          origin: 'tyde-app://app',
          'access-control-request-method': 'POST',
          ...headers,
        },
      });
      expect(response.statusCode).toBe(403);
      if (headers.origin && !config.desktopOrigins.includes(headers.origin))
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    const page = await app.inject({ url: '/outside-api', headers: { origin: 'tyde-app://app' } });
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await app.close();
  }
});

test('renderer login, refresh, recovery and logout use cookies with source-specific attributes', async () => {
  vi.spyOn(AuthService.prototype, 'login').mockResolvedValue(tokens);
  vi.spyOn(AuthService.prototype, 'refresh').mockResolvedValue(tokens);
  const me = vi.spyOn(AuthService.prototype, 'me').mockResolvedValue({ id: 'user' } as never);
  const logout = vi.spyOn(AuthService.prototype, 'logout').mockResolvedValue(undefined);
  vi.spyOn(AuthService.prototype, 'updateCurrentUser').mockResolvedValue({ id: 'user' } as never);
  const app = await createApp(config, new PrismaClient());
  try {
    for (const origin of [...config.webOrigins, ...config.desktopOrigins]) {
      const desktop = config.desktopOrigins.includes(origin);
      const headers = { origin, 'x-tyde-client': 'web' };
      for (const [path, payload] of [
        ['/auth/login', { account: '13812345678', password: 'Password123' }],
        ['/auth/refresh', { refreshToken: tokens.refreshToken }],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1${path}`,
          headers,
          payload,
        });
        expect(response.statusCode).toBe(200);
        expect(response.cookies[0]).toMatchObject({
          name: 'tyde_session',
          value: tokens.accessToken,
          httpOnly: true,
          sameSite: desktop ? 'None' : 'Lax',
        });
        expect(Boolean(response.cookies[0]!.secure)).toBe(desktop);
      }
      const recovered = await app.inject({
        url: '/api/v1/users/me',
        headers: { origin, cookie: `tyde_session=${tokens.accessToken}` },
      });
      expect(recovered.statusCode).toBe(200);
      expect(me).toHaveBeenLastCalledWith(tokens.accessToken, 'web');
      const loggedOut = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { ...headers, cookie: `tyde_session=${tokens.accessToken}` },
      });
      expect(loggedOut.statusCode).toBe(200);
      expect(logout).toHaveBeenLastCalledWith(tokens.accessToken);
      expect(loggedOut.cookies[0]).toMatchObject({
        value: '',
        sameSite: desktop ? 'None' : 'Lax',
      });
      expect(Boolean(loggedOut.cookies[0]!.secure)).toBe(desktop);
      const changed = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/update',
        headers: { ...headers, cookie: `tyde_session=${tokens.accessToken}` },
        payload: { newPassword: 'Changed123!', confirmNewPassword: 'Changed123!' },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.cookies[0]).toMatchObject({
        value: '',
        sameSite: desktop ? 'None' : 'Lax',
      });
      expect(Boolean(changed.cookies[0]!.secure)).toBe(desktop);
    }
  } finally {
    await app.close();
  }
});

test('browser cookie file authentication and Retry-After work while Bearer restrictions remain', async () => {
  const me = vi.spyOn(AuthService.prototype, 'me').mockResolvedValue({ id: 'user' } as never);
  const authenticate = vi
    .spyOn(AuthService.prototype, 'authenticate')
    .mockRejectedValue(new AuthError(401, 'UNAUTHENTICATED', '请先登录'));
  vi.spyOn(AuthService.prototype, 'sendCode').mockRejectedValue(
    new AuthError(429, 'RATE_LIMITED', '请稍后重试', 60),
  );
  const app = await createApp(config, new PrismaClient());
  try {
    const files = await app.inject({
      url: '/api/v1/files/access-url?objectKey=avatar/test.png',
      headers: { origin: 'tyde-app://app', cookie: `tyde_session=${tokens.accessToken}` },
    });
    expect(files.statusCode).toBe(401);
    expect(authenticate).toHaveBeenCalledWith(tokens.accessToken, 'web');
    expect(files.headers['access-control-allow-origin']).toBe('tyde-app://app');
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/send',
      headers: { origin: 'tyde-app://app', 'x-tyde-client': 'web' },
      payload: { phone: '13812345678', scene: 'login' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers['access-control-expose-headers']).toContain('Retry-After');
    for (const headers of [
      { origin: 'https://untrusted.example', cookie: `tyde_session=${tokens.accessToken}` },
      { origin: 'tyde-app://app', authorization: `Bearer ${tokens.accessToken}` },
      { origin: 'tyde-app://app', 'x-tyde-client': 'desktop' },
      { 'sec-fetch-site': 'same-origin', 'x-tyde-client': 'desktop' },
      {
        cookie: `tyde_session=${tokens.accessToken}`,
        authorization: `Bearer ${tokens.accessToken}`,
      },
    ]) {
      const blocked = await app.inject({ url: '/api/v1/users/me', headers });
      expect(blocked.statusCode).toBe(403);
    }
    expect(me).not.toHaveBeenCalled();
    const apiClient = await app.inject({
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(apiClient.statusCode).toBe(200);
    expect(me).toHaveBeenLastCalledWith(tokens.accessToken, 'desktop');
  } finally {
    await app.close();
  }
});

test('desktop Cookie sources reach organization, approval and multipart import services', async () => {
  const identity = {
    userId: '00000000-0000-4000-8000-000000000001',
    uid: 'test-user',
    sessionId: 'session',
    role: 'EXPERT' as const,
    clientType: 'web' as const,
  };
  const authenticate = vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(identity);
  const update = vi
    .spyOn(OrganizationService.prototype, 'update')
    .mockResolvedValue(organizationUpdateResponse.examples[0]);
  const exit = vi
    .spyOn(OrganizationApprovalService.prototype, 'exit')
    .mockResolvedValue((exitResponse.examples as unknown[])[0] as never);
  const generate = vi
    .spyOn(MemberImportService.prototype, 'generate')
    .mockResolvedValue(importExample as never);
  const app = await createApp(config, new PrismaClient());
  const orgId = '00000000-0000-4000-8000-000000000002';
  try {
    for (const origin of config.desktopOrigins) {
      const headers = {
        origin,
        'x-tyde-client': 'web',
        cookie: `tyde_session=${tokens.accessToken}`,
        'idempotency-key': 'desktop-example',
      };
      const updated = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations/update',
        headers,
        payload: { orgId, description: '简介' },
      });
      expect(updated.statusCode).toBe(200);
      expect(update).toHaveBeenLastCalledWith({ orgId, description: '简介' }, identity);
      const exitBody = { orgId, reason: '个人原因', plannedLeaveDate: '2099-01-01' };
      const exited = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations/members/exit-requests',
        headers,
        payload: exitBody,
      });
      expect(exited.statusCode).toBe(200);
      expect(exit).toHaveBeenLastCalledWith('desktop-example', exitBody, identity);
      const memberText = '张三,13812345678,全职';
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations/member-imports/generate',
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=import-test' },
        payload: `--import-test\r\nContent-Disposition: form-data; name="orgId"\r\n\r\n${orgId}\r\n--import-test\r\nContent-Disposition: form-data; name="memberText"\r\n\r\n${memberText}\r\n--import-test--\r\n`,
      });
      expect(imported.statusCode).toBe(200);
      expect(generate).toHaveBeenLastCalledWith(
        'desktop-example',
        orgId,
        identity,
        undefined,
        memberText,
      );
      expect(authenticate).toHaveBeenLastCalledWith(tokens.accessToken, 'web');
      const template = await app.inject({
        url: '/api/v1/organizations/member-imports/template',
        headers: { origin, cookie: headers.cookie },
      });
      expect(template.statusCode).toBe(200);
      expect(template.headers['content-disposition']).toContain('member-import-template.xlsx');
      expect(template.headers['access-control-expose-headers']).toContain('Content-Disposition');
    }
  } finally {
    await app.close();
  }
});
