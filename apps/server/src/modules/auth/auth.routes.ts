import {
  API_PREFIX,
  loginSchema,
  nicknameCheckSchema,
  organizationCreateSchema,
  passwordResetSchema,
  refreshSchema,
  smsLoginSchema,
  smsRegisterSchema,
  smsSendSchema,
  switchRoleSchema,
  userProfileUpdateSchema,
  type BusinessRole,
  type LoginInput,
  type LoginResponse,
  type OrganizationCreateInput,
  type PasswordResetInput,
  type SmsLoginInput,
  type SmsRegisterInput,
  type SmsSendInput,
  type UserProfileUpdateInput,
} from '@tyde/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { Config } from '../../config/index.js';
import { organizationDetailResponse } from '../organizations/organization.schema.js';
import {
  authSchema,
  loginResponse,
  nicknameCheckResponse,
  resultSchema,
  smsLoginResponse,
  userResponse,
} from './auth.schema.js';
import { AuthService } from './auth.service.js';
import { type ClientType } from './auth.types.js';
import { SESSION_DAYS, validateTransport } from './security.js';
export async function authRoutes(app: FastifyInstance, service: AuthService, config: Config) {
  const cookieName = config.cookieSecure ? '__Host-tyde_session' : 'tyde_session';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
  };
  const browserOrigins = [...config.webOrigins, ...config.desktopOrigins];
  function sessionCookieOptions(req: FastifyRequest) {
    return req.headers.origin && config.desktopOrigins.includes(req.headers.origin)
      ? { ...cookieOptions, sameSite: 'none' as const, secure: true }
      : cookieOptions;
  }
  function client(req: FastifyRequest): ClientType {
    return req.headers['x-tyde-client'] === 'desktop' ? 'desktop' : 'web';
  }
  function token(req: FastifyRequest) {
    return client(req) === 'desktop'
      ? req.headers.authorization?.replace(/^Bearer /, '')
      : req.cookies[cookieName];
  }
  const success = <T>(data: T) => ({ code: 200, message: '操作成功', data });
  app.addHook('onRequest', async (req, reply) => {
    if (
      !req.url.startsWith(`${API_PREFIX}/auth/`) &&
      ![
        `${API_PREFIX}/users/me`,
        `${API_PREFIX}/users/me/update`,
        `${API_PREFIX}/organizations`,
      ].includes(req.url.split('?')[0]!)
    )
      return;
    reply.header('Cache-Control', 'no-store');
    // Ordinary API clients retain the legacy Bearer contract without a custom header.
    if (
      !req.headers['x-tyde-client'] &&
      !req.headers.origin &&
      !req.headers.cookie &&
      !Object.keys(req.headers).some((key) => key.startsWith('sec-fetch-'))
    )
      req.headers['x-tyde-client'] = 'desktop';
    try {
      validateTransport(req.headers, req.method, browserOrigins);
    } catch (error) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', (error as Error).message);
    }
  });
  function finish(result: LoginResponse, req: FastifyRequest, reply: FastifyReply) {
    if (client(req) === 'web')
      reply.setCookie(cookieName, result.accessToken, {
        ...sessionCookieOptions(req),
        maxAge: SESSION_DAYS * 86_400,
      });
    return success(result);
  }
  app.post<{ Body: SmsSendInput }>(
    `${API_PREFIX}/auth/sms/send`,
    {
      schema: {
        ...authSchema(
          'sendCode',
          '发送短信验证码',
          resultSchema({
            type: 'string',
            description: '验证码发送结果提示；开发/测试 mock 不实际发送短信。',
            examples: ['验证码已发送，请注意查收'],
          }),
        ),
        body: smsSendSchema,
      },
    },
    async (req) => success(await service.sendCode(req.body, req.ip)),
  );
  app.post<{ Body: SmsRegisterInput }>(
    `${API_PREFIX}/auth/register`,
    {
      schema: {
        ...authSchema('register', '统一注册（自带三种业务角色）', resultSchema(userResponse)),
        body: smsRegisterSchema,
      },
    },
    async (req) => success(await service.register(req.body, req.ip)),
  );
  app.post<{ Body: LoginInput }>(
    `${API_PREFIX}/auth/login`,
    {
      schema: {
        ...authSchema('login', '密码登录（默认执行专家）', resultSchema(loginResponse)),
        body: loginSchema,
      },
    },
    async (req, reply) => finish(await service.login(req.body, req.ip, client(req)), req, reply),
  );
  app.post<{ Body: SmsLoginInput }>(
    `${API_PREFIX}/auth/sms/login`,
    {
      schema: {
        ...authSchema(
          'loginBySms',
          '短信登录或进入注册（默认执行专家）',
          resultSchema(smsLoginResponse),
        ),
        body: smsLoginSchema,
      },
    },
    async (req, reply) => {
      const result = await service.loginBySms(req.body, req.ip, client(req));
      return 'status' in result ? success(result) : finish(result, req, reply);
    },
  );
  app.post<{ Body: { refreshToken: string } }>(
    `${API_PREFIX}/auth/refresh`,
    {
      schema: {
        ...authSchema('refresh', '刷新令牌（旧令牌对失效）', resultSchema(loginResponse)),
        body: refreshSchema,
      },
    },
    async (req, reply) =>
      finish(await service.refresh(req.body.refreshToken, client(req)), req, reply),
  );
  app.post<{ Body: PasswordResetInput }>(
    `${API_PREFIX}/auth/password/reset`,
    {
      schema: {
        ...authSchema(
          'resetPassword',
          '重置密码并撤销所有会话',
          resultSchema({
            type: 'null',
            description: '操作成功，无业务数据，固定为 null。',
            examples: [null],
          }),
        ),
        body: passwordResetSchema,
      },
    },
    async (req) => {
      await service.resetPassword(req.body, req.ip);
      return success(null);
    },
  );
  app.get(
    `${API_PREFIX}/users/me`,
    { schema: authSchema('getCurrentUser', '获取当前用户', resultSchema(userResponse), true) },
    async (req) => success(await service.me(token(req), client(req))),
  );
  app.get<{ Querystring: { nickname: string } }>(
    `${API_PREFIX}/users/nickname/check`,
    {
      schema: {
        ...authSchema('checkNickname', '昵称去重校验', resultSchema(nicknameCheckResponse)),
        tags: ['User'],
        querystring: nicknameCheckSchema,
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return success(await service.checkNickname(req.query.nickname));
    },
  );
  app.post<{ Body: UserProfileUpdateInput }>(
    `${API_PREFIX}/users/me/update`,
    {
      schema: {
        ...authSchema(
          'updateCurrentUser',
          '编辑当前登录用户信息',
          resultSchema(userResponse),
          true,
        ),
        tags: ['User'],
        body: userProfileUpdateSchema,
      },
    },
    async (req, reply) => {
      const user = await service.updateCurrentUser(token(req), client(req), req.body);
      if (req.body.newPassword != null && client(req) === 'web')
        reply.clearCookie(cookieName, sessionCookieOptions(req));
      return success(user);
    },
  );
  app.post<{ Body: { role: BusinessRole } }>(
    `${API_PREFIX}/auth/switch-role`,
    {
      schema: {
        ...authSchema(
          'switchRole',
          '切换当前会话角色',
          resultSchema({
            type: 'object',
            description: '当前角色和账号自带三角色；不更换令牌。',
            required: ['selectedRole', 'roles'],
            properties: {
              selectedRole: switchRoleSchema.properties.role,
              roles: userResponse.properties.roles,
            },
            examples: [{ selectedRole: 'EXPERT', roles: ['NAVIGATOR', 'PM', 'EXPERT'] }],
          }),
          true,
        ),
        body: switchRoleSchema,
      },
    },
    async (req) => success(await service.switchRole(token(req), client(req), req.body.role)),
  );
  app.post<{ Body: OrganizationCreateInput }>(
    `${API_PREFIX}/organizations`,
    {
      schema: {
        ...authSchema(
          'createOrganization',
          '执行专家创建组织',
          resultSchema(organizationDetailResponse),
          true,
        ),
        tags: ['Organization'],
        body: organizationCreateSchema,
      },
    },
    async (req) => success(await service.createOrganization(token(req), client(req), req.body)),
  );
  app.post(
    `${API_PREFIX}/auth/logout`,
    {
      schema: authSchema(
        'logout',
        '退出当前会话',
        resultSchema({
          type: 'null',
          description: '操作成功，无业务数据，固定为 null。',
          examples: [null],
        }),
      ),
    },
    async (req, reply) => {
      await service.logout(token(req));
      if (client(req) === 'web') reply.clearCookie(cookieName, sessionCookieOptions(req));
      return success(null);
    },
  );
}
