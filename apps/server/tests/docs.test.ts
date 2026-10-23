import { PrismaClient } from '@prisma/client';
import {
  smsSendSchema,
  smsLoginSchema,
  loginSchema,
  passwordResetSchema,
  refreshSchema,
  smsRegisterSchema,
  type AuthUser,
} from '@tyde/shared';
import { userResponse } from '../src/modules/auth/auth.schema.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
afterEach(() => vi.restoreAllMocks());
test('OpenAPI preserves legacy auth names, request fields, Result and token response', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    expect((await app.inject('/api/v1/docs/')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/docs/yaml')).statusCode).toBe(200);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/password/reset',
      '/api/v1/auth/refresh',
      '/api/v1/auth/register',
      '/api/v1/auth/sms/login',
      '/api/v1/auth/sms/send',
      '/api/v1/auth/switch-role',
      '/api/v1/entrance-exams/admissions',
      '/api/v1/entrance-exams/cancel',
      '/api/v1/entrance-exams/close',
      '/api/v1/entrance-exams/current',
      '/api/v1/entrance-exams/detail',
      '/api/v1/entrance-exams/edit',
      '/api/v1/entrance-exams/enter',
      '/api/v1/entrance-exams/grading/auto/compensate',
      '/api/v1/entrance-exams/grading/detail',
      '/api/v1/entrance-exams/grading/manual',
      '/api/v1/entrance-exams/grading/retry',
      '/api/v1/entrance-exams/import/parse',
      '/api/v1/entrance-exams/import/template',
      '/api/v1/entrance-exams/management',
      '/api/v1/entrance-exams/publish',
      '/api/v1/entrance-exams/reviewers',
      '/api/v1/entrance-exams/roster',
      '/api/v1/entrance-exams/submit',
      '/api/v1/expert-assignments/change-project-owner',
      '/api/v1/expert-assignments/detail',
      '/api/v1/expert-assignments/my-projects',
      '/api/v1/expert-assignments/my-tasks',
      '/api/v1/expert-assignments/project-owner-candidates',
      '/api/v1/expert-assignments/respond',
      '/api/v1/expert-assignments/set-project-owners',
      '/api/v1/files',
      '/api/v1/files/access-url',
      '/api/v1/files/upload',
      '/api/v1/files/upload/batch',
      '/api/v1/files/view',
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/api/v1/integrations/agents/entrance-exam-grading/callback',
      '/api/v1/organizations',
      '/api/v1/organizations/approvals/pending',
      '/api/v1/organizations/approvals/process',
      '/api/v1/organizations/approvals/records',
      '/api/v1/organizations/attendance',
      '/api/v1/organizations/attendance/apply',
      '/api/v1/organizations/attendance/update',
      '/api/v1/organizations/attendance/withdraw',
      '/api/v1/organizations/calendar/holidays',
      '/api/v1/organizations/member-imports/generate',
      '/api/v1/organizations/member-imports/template',
      '/api/v1/organizations/members',
      '/api/v1/organizations/members/exit-requests',
      '/api/v1/organizations/members/position',
      '/api/v1/organizations/members/update',
      '/api/v1/organizations/update',
      '/api/v1/project-categories',
      '/api/v1/project-requesters/{requesterType}/{requesterId}/backfill',
      '/api/v1/projects/create',
      '/api/v1/projects/draft/current',
      '/api/v1/projects/expert-recruitment-handler/change',
      '/api/v1/projects/expert-recruitments/candidates',
      '/api/v1/projects/expert-recruitments/detail',
      '/api/v1/projects/expert-recruitments/handler-candidates',
      '/api/v1/projects/expert-recruitments/submit',
      '/api/v1/projects/list',
      '/api/v1/projects/manager-candidates',
      '/api/v1/projects/manager-recruitments',
      '/api/v1/projects/manager/list',
      '/api/v1/projects/production-plan',
      '/api/v1/projects/production-plan/confirm',
      '/api/v1/projects/standard-materials/confirm-read',
      '/api/v1/projects/standard-materials/detail',
      '/api/v1/projects/standard-materials/update',
      '/api/v1/projects/{projectId}',
      '/api/v1/users/me',
      '/api/v1/users/me/applications',
      '/api/v1/users/me/schedules/batch',
      '/api/v1/users/me/update',
      '/api/v1/users/nickname/check',
    ]);
    const registration =
      spec.paths['/api/v1/auth/register'].post.requestBody.content['application/json'].schema;
    expect(Object.keys(registration.properties).sort()).toEqual(
      [
        'accountType',
        'roles',
        'password',
        'confirmPassword',
        'nickname',
        'realName',
        'idCardNo',
        'phone',
        'code',
        'registrationToken',
        'email',
      ].sort(),
    );
    expect(registration.required).not.toContain('roles');
    expect(registration.properties.accountType.enum).toEqual(['INDIVIDUAL']);
    expect(registration.properties.accountType.anyOf).toBeUndefined();
    expect(registration.properties.roles.items.enum).toEqual(['NAVIGATOR', 'PM', 'EXPERT', 'OPS']);
    const organization =
      spec.paths['/api/v1/organizations'].post.requestBody.content['application/json'].schema;
    expect(organization.properties.businessLicense.description).toContain('一次性 uploadToken');
    expect(registration.required).not.toContain('accountType');
    const documented = new Set<object>();
    function checkFields(schema: Record<string, unknown>, location: string) {
      if (documented.has(schema)) return;
      documented.add(schema);
      if (typeof schema.$ref === 'string') {
        const resolved = schema.$ref
          .split('/')
          .slice(1)
          .reduce((node, key) => node[key], spec);
        checkFields(resolved, location);
      }
      for (const [name, field] of Object.entries(schema.properties ?? {})) {
        const property = field as Record<string, unknown>;
        expect(property.description, `${location}.${name} 必须说明中文含义`).toMatch(
          /[\u3400-\u9fff]/u,
        );
        checkFields(property, `${location}.${name}`);
      }
      if (schema.items && typeof schema.items === 'object')
        checkFields(schema.items as Record<string, unknown>, `${location}[]`);
      for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
        for (const branch of (schema[keyword] ?? []) as Record<string, unknown>[])
          checkFields(branch, location);
      }
    }
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(
        methods as Record<
          string,
          {
            requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
            responses: Record<
              string,
              { content?: Record<string, { schema: Record<string, unknown> }> }
            >;
          }
        >,
      )) {
        for (const media of Object.values(operation.requestBody?.content ?? {}))
          checkFields(media.schema, `${method} ${path} body`);
        for (const [status, response] of Object.entries(operation.responses)) {
          for (const media of Object.values(response.content ?? {}))
            checkFields(media.schema, `${method} ${path} response ${status}`);
        }
      }
    }

    expect(
      spec.paths['/api/v1/auth/login'].post.requestBody.content['application/json'].schema.required,
    ).toEqual(['account', 'password']);
    const tokens = {
      accessToken: 'a'.repeat(43),
      refreshToken: 'b'.repeat(43),
      tokenType: 'Bearer' as const,
      expiresIn: 2592000,
    };
    vi.spyOn(AuthService.prototype, 'login').mockResolvedValue(tokens);
    const login = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers,
        payload: { account: '13812345678', password: 'Password123' },
      });
    const web = await login({ origin: config.webOrigins[0]! });
    expect(web.json()).toEqual({ code: 200, message: '操作成功', data: tokens });
    expect(web.cookies[0]?.httpOnly).toBe(true);
    const api = await login({});
    expect(api.json().data).toEqual(tokens);
    expect(api.cookies).toHaveLength(0);
    expect((await login({ origin: 'https://evil.test' })).json()).toMatchObject({
      code: 403,
      data: null,
    });
    const pending = {
      status: 'registration_required' as const,
      registrationToken: 'g'.repeat(43),
      expiresAt: '2026-10-16T12:10:00.000Z',
    };
    const sms = vi.spyOn(AuthService.prototype, 'loginBySms').mockResolvedValue(pending);
    for (const headers of [{ origin: config.webOrigins[0]! }, { 'x-tyde-client': 'desktop' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sms/login',
        headers,
        payload: { phone: '13812345678', code: '095270' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(pending);
      expect(response.cookies).toHaveLength(0);
    }
    sms.mockResolvedValue(tokens);
    const smsLogged = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/login',
      headers: { origin: config.webOrigins[0]! },
      payload: { phone: '13812345678', code: '095270' },
    });
    expect(smsLogged.json().data).toEqual(tokens);
    expect(smsLogged.cookies[0]?.httpOnly).toBe(true);
    vi.spyOn(AuthService.prototype, 'logout').mockResolvedValue(undefined);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: { origin: config.webOrigins[0]! },
        })
      ).json(),
    ).toEqual({ code: 200, message: '操作成功', data: null });
    const user: AuthUser = {
      ...userResponse.examples[0],
      accountType: 'ORGANIZATION',
      role: 'EXPERT',
      roles: ['EXPERT'],
      selectedRole: 'EXPERT',
      organization: {
        id: '00000000-0000-4000-8000-000000000002',
        name: '示例组织',
        unifiedCreditCode: null,
        description: '测试简介',
        businessLicenseUrl: null,
        logoUrl: null,
        expertiseTags: ['图像标注'],
        verifyStatus: 'PENDING',
        status: 'ACTIVE',
        position: 'OWNER',
        joinStatus: 'ACTIVE',
        createdAt: '2026-10-16T08:00:00.000Z',
        extraPreserved: '兼容扩展字段',
      },
    };
    vi.spyOn(AuthService.prototype, 'me').mockResolvedValue(user);
    const currentUser = await app.inject({
      url: '/api/v1/users/me',
      headers: { 'x-tyde-client': 'desktop', authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(currentUser.statusCode).toBe(200);
    expect(currentUser.json().data).toEqual(user);
    const registeredUser: AuthUser = {
      ...user,
      accountType: 'INDIVIDUAL',
      organization: null,
      selectedRole: null,
    };
    vi.spyOn(AuthService.prototype, 'register').mockResolvedValue(registeredUser);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: smsRegisterSchema.examples![0],
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toEqual(registeredUser);

    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 400, data: null });
  } finally {
    await app.close();
  }
});

test('documented request examples pass actual Fastify validation; flat enums preserve accepted values', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    await app.ready();
    const compiler = app.validatorCompiler!;
    const validate = (schema: object, value: unknown) =>
      compiler({ schema, method: 'POST', url: '/docs-example', httpPart: 'body' })(value);
    for (const schema of [
      smsSendSchema,
      smsLoginSchema,
      loginSchema,
      passwordResetSchema,
      refreshSchema,
      smsRegisterSchema,
    ]) {
      for (const example of schema.examples ?? []) expect(validate(schema, example)).toBe(true);
    }
    for (const accountType of ['INDIVIDUAL'])
      expect(validate(smsRegisterSchema, { ...smsRegisterSchema.examples![0], accountType })).toBe(
        true,
      );
    expect(
      validate(smsRegisterSchema, { ...smsRegisterSchema.examples![0], accountType: 'INVALID' }),
    ).toBe(false);
    for (const role of ['NAVIGATOR', 'PM', 'EXPERT', 'OPS'])
      expect(validate(loginSchema, { account: '13812345678', password: 'Example123!', role })).toBe(
        true,
      );
    expect(
      validate(loginSchema, { account: '13812345678', password: 'Example123!', role: 'INVALID' }),
    ).toBe(false);
  } finally {
    await app.close();
  }
});

test('file OpenAPI documents multipart binary, query fields, proxy media and complete valid examples', async () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    const spec = (await app.inject('/api/v1/docs/json')).json();
    const upload = spec.paths['/api/v1/files/upload'].post;
    const body = upload.requestBody.content['multipart/form-data'].schema;
    expect(body.properties.file).toMatchObject({ type: 'string', format: 'binary' });
    expect(body.required).toEqual(['file']);
    const batch =
      spec.paths['/api/v1/files/upload/batch'].post.requestBody.content['multipart/form-data']
        .schema;
    expect(batch.properties.files.items.format).toBe('binary');
    expect(
      spec.paths['/api/v1/files/view'].get.responses['200'].content['application/octet-stream']
        .schema.format,
    ).toBe('binary');
    expect(
      spec.paths['/api/v1/files/view'].get.responses['200'].content['application/json'],
    ).toBeUndefined();
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (!path.startsWith('/api/v1/files')) continue;
      for (const operation of Object.values(
        methods as Record<
          string,
          { parameters?: { description?: string; schema: { description?: string } }[] }
        >,
      ))
        for (const parameter of operation.parameters ?? [])
          expect(parameter.description ?? parameter.schema.description).toMatch(/[\u3400-\u9fff]/u);
    }
    const compile = (schema: object) =>
      app.validatorCompiler!({ schema, method: 'POST', url: '/schema-example', httpPart: 'body' });
    const { uploadResponse, uploadExample, uploadBody } =
      await import('../src/modules/files/file.schema.js');
    for (const [schema, media] of [
      [uploadBody(false), upload.requestBody.content['multipart/form-data']],
      [
        uploadBody(true),
        spec.paths['/api/v1/files/upload/batch'].post.requestBody.content['multipart/form-data'],
      ],
    ]) {
      const examples =
        media.example !== undefined
          ? [media.example]
          : Object.values(media.examples ?? {}).map((entry) => (entry as { value: unknown }).value);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) expect(compile(schema)(example)).toBe(true);
    }
    // 生成文档中的响应有 $ref，使用原始交付 schema 验证完整示例，避免人为猜测引用结构。
    expect(compile(uploadResponse)(uploadExample)).toBe(true);
    expect(
      upload.responses['200'].content['application/json'].schema.properties.data.properties
        .uploadToken.description,
    ).toContain('一次性');
  } finally {
    await app.close();
  }
});
