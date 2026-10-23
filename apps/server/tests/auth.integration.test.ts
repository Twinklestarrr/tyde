import { ExamCandidateCommandService } from '../src/modules/entrance-exams/exam-candidate-command.service.js';
import { ProjectMaterialsService } from '../src/modules/projects/project-materials.service.js';
import { ExamAutoService } from '../src/modules/entrance-exams/exam-auto.service.js';
import {
  autoCallbackPath,
  signAutoCallback,
} from '../src/modules/entrance-exams/exam-auto-signature.js';
import type { AutoCallbackInput } from '../src/modules/entrance-exams/exam-auto.types.js';
import { examConfigExample } from '../src/modules/entrance-exams/exam-config.schema.js';
import { ExamGradingCommandService } from '../src/modules/entrance-exams/exam-grading-command.service.js';
import {
  ProjectProductionPlanService,
  type ProductionPlanInput,
} from '../src/modules/projects/project-production-plan.service.js';
import { productionPlanExample } from '../src/modules/projects/project-production-plan.schema.js';
import * as XLSX from 'xlsx';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { MemberImportService } from '../src/modules/organizations/member-import.service.js';
import { ApprovalService } from '../src/modules/approval/approval.service.js';
import { DepartureService, shanghaiDay } from '../src/modules/organizations/departure.service.js';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import { Readable } from 'node:stream';
import type { ObjectStorage } from '../src/modules/files/object-storage.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { digest } from '../src/modules/auth/security.js';
import { ProjectManagerService } from '../src/modules/projects/project-manager.service.js';
import { ProjectCreationService } from '../src/modules/projects/project-creation.service.js';
const testEnv = parseEnv(readFileSync(new URL('../.env.test', import.meta.url), 'utf8'));
const autoTestSecret = 'auto-integration-dedicated-secret-32';
const config = readConfig({ ...testEnv, AUTO_GRADING_HMAC_SECRET: autoTestSecret });
if (
  config.env !== 'test' ||
  !new URL(config.databaseUrl).pathname.endsWith('_test') ||
  testEnv.TEST_DATABASE_RESET !== 'true'
)
  throw new Error('集成测试只能连接允许清空的专用 _test 数据库');
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const objects = new Map<string, Buffer>();
const storage: ObjectStorage = {
  async put(key, content) {
    objects.set(key, content);
  },
  async head(key) {
    const content = objects.get(key);
    return content ? { size: content.length } : null;
  },
  async open(key) {
    const content = objects.get(key);
    if (!content) throw new Error('missing');
    return { stream: Readable.from(content), size: content.length, contentType: 'image/png' };
  },
  async delete(key) {
    objects.delete(key);
  },
  accessUrl(key) {
    return `https://storage.example/${key}`;
  },
};
const registry = new FileRegistryService(db, storage, config.files);
const app = await createApp(config, db, undefined, storage);
const web = { origin: config.webOrigins[0]!, 'x-tyde-client': 'web' };
const desktop = { 'x-tyde-client': 'desktop' };
beforeEach(async () => {
  objects.clear();
  await db.$executeRawUnsafe(
    'TRUNCATE "EntranceExamGradingRound", "ProjectCategory", "MemberImportReceipt", "ApprovalActionLog", "ApprovalNode", "ApprovalFlow", "OrganizationDeparture", "UploadedFile", "AuthRateLimit", "Session", "RegistrationGrant", "VerificationChallenge", "User", "Organization" CASCADE',
  );
});
afterAll(async () => app.close());
const phone = '13812345678';
const registration = {
  accountType: 'INDIVIDUAL',
  phone,
  code: '095270',
  password: 'Password123',
  confirmPassword: 'Password123',
  realName: '小明',
  email: 'test@example.com',
};
async function post(path: string, payload?: unknown, headers: Record<string, string> = web) {
  return app.inject({ method: 'POST', url: `/api/v1${path}`, payload, headers });
}
async function send(scene: string, value = phone) {
  await db.verificationChallenge.updateMany({
    where: { phoneE164: `+86${value}` },
    data: { createdAt: new Date(Date.now() - 61_000) },
  });
  const response = await post('/auth/sms/send', { phone: value, scene });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toBe('验证码已发送，请注意查收');
}
async function register(
  extra: {
    accountType?: string;
    organization?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  await send('register');
  const { organization, accountType: _accountType, ...fields } = extra;
  void _accountType;
  const result = await post('/auth/register', { ...registration, ...fields });
  expect(result.statusCode, result.body).toBe(200);
  if (!organization) return result;
  const logged = await login(desktop);
  const headers = bearer(logged.json().data.accessToken);
  const created = await post('/organizations', organization, headers);
  expect(created.statusCode, created.body).toBe(200);
  return app.inject({ url: '/api/v1/users/me', headers });
}
// Existing business fixtures select a session role; they no longer provision role grants.
async function selectFixtureRole(input: {
  uid: string;
  role: 'PM' | 'NAVIGATOR';
  action: 'GRANT' | 'REVOKE';
  actor: string;
  reason: string;
}) {
  await db.session.updateMany({
    where: { user: { uid: input.uid }, revokedAt: null },
    data: { selectedRole: input.action === 'GRANT' ? input.role : 'EXPERT' },
  });
}

async function login(headers = web, extra = {}) {
  const result = await post(
    '/auth/login',
    { account: phone, password: 'Password123', ...extra },
    headers,
  );
  expect(result.statusCode).toBe(200);
  return result;
}
const bearer = (token: string) => ({ ...desktop, authorization: `Bearer ${token}` });
test('legacy registration fields, fixed EXPERT, password login by phone/email/uid and cookie recovery', async () => {
  const created = await register({ roles: ['OPS', 'NAVIGATOR'] });
  expect(created.json().data).toMatchObject({
    role: 'EXPERT',
    roles: ['NAVIGATOR', 'PM', 'EXPERT'],
    nickname: '小明',
    realName: '小明',
    phone: '138****5678',
  });
  expect(created.cookies).toHaveLength(0);
  const row = await db.user.findFirstOrThrow();
  expect(row.passwordHash).not.toContain('Password123');
  expect(row.role).toBe('EXPERT');
  for (const account of [phone, 'TEST@example.com', row.uid]) {
    const logged = await login(web, { account });
    expect(Object.keys(logged.json().data).sort()).toEqual(
      ['accessToken', 'refreshToken', 'tokenType', 'expiresIn'].sort(),
    );
    const cookie = logged.cookies[0]!;
    const me = await app.inject({
      url: '/api/v1/users/me',
      headers: { ...web, cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(me.json().data.selectedRole).toBe('EXPERT');
    expect(cookie.httpOnly).toBe(true);
  }
});
test('SMS scenes are isolated; successful login consumes code and unknown phones do not auto-register', async () => {
  await register();
  await send('register');
  expect((await post('/auth/sms/login', { phone, code: '095270' })).statusCode).toBe(400);
  await send('login');
  const result = await post('/auth/sms/login', { phone, code: '095270' }, desktop);
  expect(result.statusCode).toBe(200);
  expect((await post('/auth/sms/login', { phone, code: '095270' })).statusCode).toBe(400);
  await send('login', '13912345678');
  expect((await post('/auth/sms/login', { phone: '13912345678', code: '095270' })).statusCode).toBe(
    200,
  );
  expect(await db.user.count()).toBe(1);
});
test('wrong attempts persist, expired code and concurrent registration replay fail', async () => {
  await send('login');
  for (let i = 0; i < 5; i++)
    expect((await post('/auth/sms/login', { phone, code: '000000' })).statusCode).toBe(400);
  expect((await post('/auth/sms/login', { phone, code: '095270' })).statusCode).toBe(429);
  expect((await db.verificationChallenge.findFirstOrThrow()).failedAttempts).toBe(5);
  await send('register');
  const results = await Promise.all([
    post('/auth/register', registration),
    post('/auth/register', registration),
  ]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  expect(await db.user.count()).toBe(1);
  await send('login');
  await db.verificationChallenge.updateMany({ data: { expiresAt: new Date(0) } });
  expect((await post('/auth/sms/login', { phone, code: '095270' })).statusCode).toBe(400);
});
test('refresh rotates once; logout revokes access and refresh for current client only', async () => {
  await register();
  const webLogin = await login();
  const logged = await login(desktop);
  const tokens = logged.json().data;
  const responses = await Promise.all([
    post('/auth/refresh', { refreshToken: tokens.refreshToken }, desktop),
    post('/auth/refresh', { refreshToken: tokens.refreshToken }, desktop),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  const rotated = responses.find((response) => response.statusCode === 200)!.json().data;
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: bearer(tokens.accessToken) })).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: bearer(rotated.accessToken) }))
      .statusCode,
  ).toBe(200);
  await post('/auth/logout', undefined, bearer(rotated.accessToken));
  expect(
    (await post('/auth/refresh', { refreshToken: rotated.refreshToken }, desktop)).statusCode,
  ).toBe(401);
  const cookie = webLogin.cookies[0]!;
  expect(
    (
      await app.inject({
        url: '/api/v1/users/me',
        headers: { ...web, cookie: `${cookie.name}=${cookie.value}` },
      })
    ).statusCode,
  ).toBe(200);
});
test('password reset revokes all clients and old password, including refresh tokens', async () => {
  await register();
  const a = (await login()).json().data;
  const b = (await login(desktop)).json().data;
  await send('reset_password');
  expect(
    (await post('/auth/password/reset', { phone, code: '095270', newPassword: 'Changed123' }))
      .statusCode,
  ).toBe(200);
  expect((await post('/auth/login', { account: phone, password: 'Password123' })).statusCode).toBe(
    401,
  );
  expect((await post('/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
  expect((await post('/auth/refresh', { refreshToken: b.refreshToken }, desktop)).statusCode).toBe(
    401,
  );
  expect(
    (await db.session.findUniqueOrThrow({ where: { tokenDigest: digest(b.accessToken) } }))
      .revokedAt,
  ).not.toBeNull();
  await login(web, { password: 'Changed123' });
});
test('registration rejects organization identity and create persists an enabled organization separately', async () => {
  await send('register');
  expect(
    (await post('/auth/register', { ...registration, confirmPassword: 'Wrong123' })).statusCode,
  ).toBe(400);
  expect(
    (await post('/auth/register', { ...registration, accountType: 'ORGANIZATION' })).statusCode,
  ).toBe(400);
  const org = await register({ organization: { name: '测试组织', expertiseTags: ['标注'] } });
  expect(org.json().data.organization).toMatchObject({
    name: '测试组织',
    position: 'OWNER',
    verifyStatus: 'APPROVED',
    status: 'ACTIVE',
  });
  await send('register');
  expect((await post('/auth/register', registration)).statusCode).toBe(409);
  expect(await db.user.count()).toBe(1);
  expect(await db.organization.count()).toBe(1);
});
test('cooldown spans scenes, transport spoofing and client-bound token use are rejected', async () => {
  await send('register');
  const limited = await post('/auth/sms/send', { phone, scene: 'login' });
  expect(limited.statusCode).toBe(429);
  expect(limited.json().code).toBe(4292);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect(
    (await post('/auth/sms/send', { phone, scene: 'login' }, { ...desktop, origin: web.origin }))
      .statusCode,
  ).toBe(403);
  expect((await app.inject({ url: '/api/v1/users/me', headers: web })).statusCode).toBe(401);
});

test('concurrent SMS login consumes the challenge only once and tokens stay bound to the client', async () => {
  await register();
  await send('login');
  const results = await Promise.all([
    post('/auth/sms/login', { phone, code: '095270' }, desktop),
    post('/auth/sms/login', { phone, code: '095270' }, desktop),
  ]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  expect(await db.session.count()).toBe(1);
  const tokens = results.find((result) => result.statusCode === 200)!.json().data;
  expect((await post('/auth/refresh', { refreshToken: tokens.refreshToken }, web)).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        url: '/api/v1/users/me',
        headers: { ...web, cookie: `tyde_session=${tokens.accessToken}` },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: bearer(tokens.accessToken) })).statusCode,
  ).toBe(200);
});

test('organization creation and code consumption roll back when user uniqueness fails', async () => {
  await register();
  const otherPhone = '13912345678';
  await send('register', otherPhone);
  const result = await post('/auth/register', {
    ...registration,
    phone: otherPhone,
  });
  expect(result.statusCode).toBe(409);
  expect(await db.organization.count()).toBe(0);
  expect(await db.user.count()).toBe(1);
  expect(
    (
      await db.verificationChallenge.findFirstOrThrow({
        where: { phoneE164: `+86${otherPhone}`, purpose: 'register' },
      })
    ).consumedAt,
  ).toBeNull();
  expect(
    (
      await post('/auth/register', {
        ...registration,
        phone: otherPhone,
        email: 'other@example.com',
        nickname: '其他用户',
      })
    ).statusCode,
  ).toBe(200);
});

test('disabled users cannot log in, access profiles or refresh existing sessions', async () => {
  await register();
  const tokens = (await login(desktop)).json().data;
  await db.user.updateMany({ data: { status: 'BANNED' } });
  expect(
    (await post('/auth/login', { account: phone, password: 'Password123' }, desktop)).statusCode,
  ).toBe(403);
  await send('login');
  expect((await post('/auth/sms/login', { phone, code: '095270' }, desktop)).statusCode).toBe(403);
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: bearer(tokens.accessToken) })).statusCode,
  ).toBe(401);
  expect(
    (await post('/auth/refresh', { refreshToken: tokens.refreshToken }, desktop)).statusCode,
  ).toBe(403);
  expect(await db.session.count()).toBe(1);
});

async function uploaded(
  bizType:
    'BUSINESS_LICENSE' | 'PROJECT_ATTACHMENT' | 'ENTRANCE_EXAM_ATTACHMENT' = 'BUSINESS_LICENSE',
  ownerUid: string | null = null,
) {
  const key = `${bizType === 'BUSINESS_LICENSE' ? 'business-license' : bizType === 'PROJECT_ATTACHMENT' ? 'project-attachment' : 'entrance-exam-attachment'}/2026/10/16/test.png`;
  const content = Buffer.from('test-image');
  await storage.put(key, content, 'image/png');
  return registry.register(
    {
      objectKey: key,
      fileName: 'test.png',
      extension: 'png',
      contentType: 'image/png',
      fileSize: content.length,
      fileHash: 'a'.repeat(64),
    },
    bizType,
    'IMAGE',
    ownerUid,
  );
}
test('organization registration claims anonymous license atomically and returns key without exposing URL/token', async () => {
  const { record, uploadToken } = await uploaded();
  expect(record.claimTokenHash).not.toBe(uploadToken);
  const result = await register({
    accountType: 'ORGANIZATION',
    organization: { name: '组织一', businessLicense: { objectKey: record.objectKey, uploadToken } },
  });
  const user = result.json().data;
  expect(user.organization.businessLicenseUrl).toBe(record.objectKey);
  expect(JSON.stringify(user)).not.toContain(uploadToken);
  expect(await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
    status: 'CLAIMED',
    claimedBizId: user.organization.id,
    expiresAt: null,
  });
  await expect(
    db.$transaction((tx) =>
      registry.claimForOrganizationRegistration(
        tx,
        record.objectKey,
        uploadToken,
        user.organization.id,
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
test.each(['token', 'expired', 'missing-object', 'size', 'wrong-biz'])(
  'license %s failure rolls back new organization and file claim while preserving the registered account',
  async (mode) => {
    const { record, uploadToken } = await uploaded(
      mode === 'wrong-biz' ? 'PROJECT_ATTACHMENT' : 'BUSINESS_LICENSE',
    );
    if (mode === 'expired')
      await db.uploadedFile.update({ where: { id: record.id }, data: { expiresAt: new Date(0) } });
    if (mode === 'missing-object') objects.clear();
    if (mode === 'size') {
      const mismatchedContent = Buffer.alloc(record.fileSize + 1);
      objects.set(record.objectKey, mismatchedContent);
    }
    await register();
    const headers = bearer((await login(desktop)).json().data.accessToken);
    const response = await post(
      '/organizations',
      {
        name: '回滚组织',
        businessLicense: {
          objectKey: record.objectKey,
          uploadToken: mode === 'token' ? 'wrong' : uploadToken,
        },
      },
      headers,
    );
    expect(response.statusCode).toBe(mode === 'token' ? 403 : mode === 'expired' ? 409 : 400);
    expect(await db.organization.count()).toBe(0);
    expect(await db.userOrgRel.count()).toBe(0);
    expect(await db.user.count({ where: { phoneE164: '+86' + phone } })).toBe(1);
    expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
      'UPLOADED',
    );
  },
);
test('concurrent license replay has exactly one winner', async () => {
  const { record, uploadToken } = await uploaded();
  const org = await db.organization.create({ data: { name: '并发组织', expertiseTags: [] } });
  const result = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      db.$transaction((tx) =>
        registry.claimForOrganizationRegistration(tx, record.objectKey, uploadToken, org.id),
      ),
    ),
  );
  expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  for (const item of result)
    if (item.status === 'rejected') expect(item.reason).toMatchObject({ status: 409 });
});
test('business claim requires owner, rejects common type and prevents deletion after claim', async () => {
  const { record, uploadToken } = await uploaded('PROJECT_ATTACHMENT', 'owner');
  const id = '00000000-0000-4000-8000-000000000001';
  await expect(
    db.$transaction((tx) =>
      registry.claimForProject(tx, record.objectKey, uploadToken, 'other', id),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(registry.deleteOwnedUnclaimed(record.objectKey, 'other')).rejects.toMatchObject({
    status: 403,
  });
  await db.$transaction((tx) =>
    registry.claimForProject(tx, record.objectKey, uploadToken, 'owner', id),
  );
  await expect(registry.deleteOwnedUnclaimed(record.objectKey, 'owner')).rejects.toMatchObject({
    status: 403,
  });
  await db.$transaction((tx) => registry.releaseProjectAttachment(tx, record.objectKey, id));
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
    'RELEASED',
  );
});
test('cleanup removes expired objects but preserves active and claimed files', async () => {
  const { record } = await uploaded();
  expect(await registry.cleanupExpired()).toEqual({ deleted: 0, failed: 0 });
  await db.uploadedFile.update({ where: { id: record.id }, data: { expiresAt: new Date(0) } });
  expect(await registry.cleanupExpired()).toEqual({ deleted: 1, failed: 0 });
  expect(objects.size).toBe(0);
  expect(await db.uploadedFile.count()).toBe(0);
});
test('delete and claim share row locks so claimed object cannot be deleted', async () => {
  const { record, uploadToken } = await uploaded('PROJECT_ATTACHMENT', 'owner');
  const id = '00000000-0000-4000-8000-000000000001';
  const result = await Promise.allSettled([
    db.$transaction((tx) =>
      registry.claimForProject(tx, record.objectKey, uploadToken, 'owner', id),
    ),
    registry.deleteOwnedUnclaimed(record.objectKey, 'owner'),
  ]);
  expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const file = await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } });
  expect(objects.has(record.objectKey)).toBe(file.status === 'CLAIMED');
});

function multipartPayload(
  parts: { name: string; fileName?: string; contentType?: string; content: Buffer | string }[],
) {
  const boundary = 'tyde-file-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.fileName ? `; filename="${part.fileName}"` : '';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n${part.contentType ? `Content-Type: ${part.contentType}\r\n` : ''}\r\n`,
      ),
      Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const imagePart = (name = 'file') => ({
  name,
  fileName: 'test.png',
  contentType: 'image/png',
  content: png,
});
async function uploadHttp(parts = [imagePart()], headers = {}, batch = false) {
  const form = multipartPayload(parts);
  return app.inject({
    method: 'POST',
    url: `/api/v1/files/upload${batch ? '/batch' : ''}`,
    payload: form.payload,
    headers: { ...form.headers, ...headers },
  });
}
test('HTTP anonymous license upload -> organization registration -> authorized proxy view without a signed URL', async () => {
  const uploaded = await uploadHttp([
    imagePart(),
    { name: 'bizType', content: 'business_license' },
  ]);
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const file = uploaded.json().data;
  expect(file).toMatchObject({
    url: null,
    sensitive: true,
    extension: 'png',
    contentType: 'image/png',
    size: png.length,
  });
  expect(file.fileHash).toMatch(/^[a-f0-9]{64}$/);
  expect(file.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await app.inject(`/api/v1/files/view?objectKey=${file.objectKey}`)).statusCode).toBe(403);
  await register({
    accountType: 'ORGANIZATION',
    organization: {
      name: '上传闭环组织',
      businessLicense: { objectKey: file.objectKey, uploadToken: file.uploadToken },
    },
  });
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const viewed = await app.inject({
    url: `/api/v1/files/view?objectKey=${file.objectKey}`,
    headers,
  });
  expect(viewed.statusCode).toBe(200);
  expect(viewed.rawPayload.equals(png)).toBe(true);
  expect(viewed.headers).toMatchObject({
    'content-type': 'image/png',
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store, private',
  });
  expect(
    (await app.inject({ url: `/api/v1/files/access-url?objectKey=${file.objectKey}`, headers }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/files?objectKey=${file.objectKey}`,
        headers,
      })
    ).statusCode,
  ).toBe(403);
});
test('HTTP owned sensitive file denies other user and deletion is once-only', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const response = await uploadHttp(
    [imagePart(), { name: 'bizType', content: 'ID_CARD' }],
    headers,
  );
  expect(response.statusCode, response.body).toBe(200);
  const key = response.json().data.objectKey;
  await send('register', '13912345678');
  expect(
    (
      await post(
        '/auth/register',
        { ...registration, phone: '13912345678', email: 'other@example.com', nickname: '其他用户' },
        desktop,
      )
    ).statusCode,
  ).toBe(200);
  const otherLogin = await post(
    '/auth/login',
    { account: '13912345678', password: registration.password },
    desktop,
  );
  const other = bearer(otherLogin.json().data.accessToken);
  expect(
    (await app.inject({ url: `/api/v1/files/view?objectKey=${key}`, headers: other })).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/v1/files?objectKey=${key}`, headers: other }))
      .statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: `/api/v1/files/view?objectKey=${key}`, headers })).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/v1/files?objectKey=${key}`, headers })).json()
      .data,
  ).toBe(true);
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/v1/files?objectKey=${key}`, headers }))
      .statusCode,
  ).toBe(403);
  expect(objects.has(key)).toBe(false);
});
test('HTTP non-sensitive URL preserves image expiry semantics and rejects sensitive paths', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const response = await uploadHttp([imagePart()], headers);
  expect(response.statusCode, response.body).toBe(200);
  const key = response.json().data.objectKey;
  expect(response.json().data.url).toContain('https://');
  const access = await app.inject({
    url: `/api/v1/files/access-url?objectKey=${key}&expireSeconds=3600`,
    headers,
  });
  expect(access.statusCode, access.body).toBe(200);
  expect(access.json().data).toBe(`https://storage.example/${key}`);
  for (const seconds of ['abc', '2147483648', '1.5'])
    expect(
      (
        await app.inject({
          url: `/api/v1/files/access-url?objectKey=${key}&expireSeconds=${seconds}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await app.inject({
        url: '/api/v1/files/access-url?objectKey=business-license/unknown.png',
        headers,
      })
    ).statusCode,
  ).toBe(403);
});
test('HTTP authenticated attachments require owner and claimed business access is explicitly blocked', async () => {
  expect(
    (await uploadHttp([imagePart(), { name: 'bizType', content: 'PROJECT_ATTACHMENT' }]))
      .statusCode,
  ).toBe(401);
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const response = await uploadHttp(
    [imagePart(), { name: 'bizType', content: 'PROJECT_ATTACHMENT' }],
    headers,
  );
  expect(response.statusCode, response.body).toBe(200);
  const { objectKey, uploadToken } = response.json().data;
  expect(
    (await app.inject({ url: `/api/v1/files/view?objectKey=${objectKey}`, headers })).statusCode,
  ).toBe(200);
  const user = await db.user.findFirstOrThrow();
  await db.$transaction((tx) =>
    registry.claimForProject(tx, objectKey, uploadToken, user.uid, user.id),
  );
  expect(
    (await app.inject({ url: `/api/v1/files/view?objectKey=${objectKey}`, headers })).statusCode,
  ).toBe(403);
});
test('HTTP batch uses files field, rejects empty/malformed/duplicate fields and does not ignore bad authorization', async () => {
  const response = await uploadHttp([imagePart('files'), imagePart('files')], {}, true);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toHaveLength(2);
  for (const parts of [
    [],
    [imagePart('files')],
    [imagePart(), imagePart()],
    [imagePart(), { name: 'bizType', content: '' }, { name: 'bizType', content: 'COMMON' }],
  ])
    expect((await uploadHttp(parts)).statusCode).toBe(400);
  expect((await uploadHttp([imagePart()], { authorization: 'Bearer invalid' })).statusCode).toBe(
    401,
  );
  expect((await uploadHttp([imagePart()], { origin: 'https://evil.example' })).statusCode).toBe(
    403,
  );
  const broken = await app.inject({
    method: 'POST',
    url: '/api/v1/files/upload',
    headers: { 'content-type': 'multipart/form-data; boundary=broken' },
    payload: '--broken\r\nunfinished',
  });
  expect(broken.statusCode).toBe(400);
});
test('HTTP fixed business policy rejects category bypass, spoofed content and SVG with no stored object', async () => {
  for (const parts of [
    [{ name: 'file', fileName: 'fake.png', contentType: 'image/png', content: 'fake' }],
    [{ name: 'file', fileName: 'a.svg', contentType: 'image/svg+xml', content: '<svg/>' }],
    [
      { name: 'file', fileName: 'a.txt', contentType: 'text/plain', content: 'hello' },
      { name: 'bizType', content: 'BUSINESS_LICENSE' },
      { name: 'category', content: 'ANY' },
    ],
    [imagePart(), { name: 'bizType', content: 'UNKNOWN' }],
  ])
    expect((await uploadHttp(parts)).statusCode).toBe(400);
  expect(objects.size).toBe(0);
  expect(await db.uploadedFile.count()).toBe(0);
});
test('HTTP document proxy forces download and nosniff', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const response = await uploadHttp(
    [
      { name: 'file', fileName: 'a.txt', contentType: 'text/plain', content: 'hello' },
      { name: 'bizType', content: 'DOCUMENT' },
    ],
    headers,
  );
  expect(response.statusCode, response.body).toBe(200);
  // 模拟存储返回任意客户端元数据，代理仍不允许 SVG/HTML 内联。
  const original = storage.open;
  storage.open = async (key) => ({ ...(await original(key)), contentType: 'text/html' });
  try {
    const viewed = await app.inject({
      url: `/api/v1/files/view?objectKey=${response.json().data.objectKey}`,
      headers,
    });
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.headers['content-type']).toBe('application/octet-stream');
    expect(viewed.headers['content-disposition']).toBe('attachment');
    expect(viewed.body).toBe('hello');
  } finally {
    storage.open = original;
  }
});
test('HTTP single file, batch count and complete multipart body limits are enforced', async () => {
  const limitedConfig = {
    ...config,
    files: { ...config.files, maxSize: 16, maxRequestSize: 512, maxBatchCount: 2 },
  };
  const limited = await createApp(limitedConfig, db, undefined, storage);
  try {
    const inject = (parts: Parameters<typeof multipartPayload>[0], batch = false) =>
      limited.inject({
        method: 'POST',
        url: `/api/v1/files/upload${batch ? '/batch' : ''}`,
        ...multipartPayload(parts),
      });
    expect(
      (
        await inject([
          { name: 'file', fileName: 'a.txt', contentType: 'text/plain', content: 'a'.repeat(17) },
        ])
      ).statusCode,
    ).toBe(413);
    expect(
      (await inject([imagePart('files'), imagePart('files'), imagePart('files')], true)).statusCode,
    ).toBe(413);
    const form = multipartPayload([imagePart()]);
    const tooLarge = await limited.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: form.headers,
      payload: Buffer.concat([form.payload, Buffer.alloc(513)]),
    });
    expect(tooLarge.statusCode).toBe(413);
  } finally {
    await limited.close();
  }
});

async function registrationGrant(headers = web) {
  await send('login');
  const result = await post('/auth/sms/login', { phone, code: '095270' }, headers);
  expect(result.statusCode).toBe(200);
  expect(result.json().data.status).toBe('registration_required');
  expect(result.cookies).toHaveLength(0);
  expect(result.json().data.accessToken).toBeUndefined();
  expect(await db.user.count()).toBe(0);
  expect(await db.session.count()).toBe(0);
  return result.json().data.registrationToken as string;
}
function registrationForm(registrationToken: string) {
  const { code: _code, ...form } = registration;
  void _code;
  return { ...form, registrationToken };
}
test('abandoned registration repeats the form; newest grant completes registration without another SMS', async () => {
  const first = await registrationGrant();
  expect((await post('/auth/sms/login', { phone, code: '095270' })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/v1/users/me', headers: bearer(first) })).statusCode).toBe(
    401,
  );
  const latest = await registrationGrant(desktop);
  expect(latest).not.toBe(first);
  const row = await db.registrationGrant.findUniqueOrThrow({
    where: { tokenDigest: digest(`sms-registration:${latest}`) },
  });
  expect(row.tokenDigest).not.toBe(latest);
  expect((await post('/auth/register', registrationForm(first))).statusCode).toBe(400);
  const created = await post('/auth/register', registrationForm(latest));
  expect(created.statusCode).toBe(200);
  expect(created.json().data.role).toBe('EXPERT');
  expect(created.cookies).toHaveLength(0);
  expect(await db.session.count()).toBe(0);
  expect((await post('/auth/register', registrationForm(latest))).statusCode).toBe(400);
  await send('login');
  const logged = await post('/auth/sms/login', { phone, code: '095270' });
  expect(logged.statusCode).toBe(200);
  expect(logged.json().data.accessToken).toBeTruthy();
  expect(logged.cookies[0]?.httpOnly).toBe(true);
});
test('registration grants reject missing, mixed, forged, mismatched and expired credentials', async () => {
  const token = await registrationGrant();
  const form = registrationForm(token);
  const { registrationToken: _token, ...missing } = form;
  void _token;
  for (const input of [
    missing,
    { ...form, code: '095270' },
    { ...form, registrationToken: 'x'.repeat(43) },
    { ...form, phone: '13912345678' },
  ])
    expect((await post('/auth/register', input)).statusCode).toBe(400);
  await db.registrationGrant.updateMany({ data: { expiresAt: new Date(0) } });
  expect((await post('/auth/register', form)).statusCode).toBe(400);
  expect(await db.user.count()).toBe(0);
});
test('grant registration validates the form and rolls back credential consumption on conflicts', async () => {
  const token = await registrationGrant();
  const form = registrationForm(token);
  expect((await post('/auth/register', { ...form, confirmPassword: 'Wrong123' })).statusCode).toBe(
    400,
  );
  const org = { name: '已存在昵称' };
  await db.user.create({
    data: {
      phoneE164: '+8613900000000',
      phoneRegion: 'CN',
      username: 'taken_nickname',
      displayName: org.name,
    },
  });
  expect(
    (
      await post('/auth/register', {
        ...form,
        nickname: org.name,
      })
    ).statusCode,
  ).toBe(409);
  expect((await db.registrationGrant.findFirstOrThrow()).consumedAt).toBeNull();
  expect(await db.user.count()).toBe(1);
  expect((await post('/auth/register', form)).statusCode).toBe(200);
});
test('concurrent new-phone SMS consumption issues only one grant', async () => {
  await send('login');
  const results = await Promise.all([
    post('/auth/sms/login', { phone, code: '095270' }),
    post('/auth/sms/login', { phone, code: '095270' }),
  ]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  expect(await db.registrationGrant.count()).toBe(1);
  expect(await db.user.count()).toBe(0);
  expect(await db.session.count()).toBe(0);
});
test('concurrent registration with one grant creates exactly one account', async () => {
  const form = registrationForm(await registrationGrant());
  const results = await Promise.all([post('/auth/register', form), post('/auth/register', form)]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  expect(await db.user.count()).toBe(1);
});

test('anonymous nickname check trims, rejects blanks and recommends the first available suffix', async () => {
  await register();
  await db.user.create({
    data: {
      phoneE164: '+8613912345678',
      phoneRegion: 'CN',
      username: 'other',
      displayName: '小明1',
    },
  });
  const check = async (value: string) =>
    app.inject(`/api/v1/users/nickname/check?nickname=${encodeURIComponent(value)}`);
  expect((await check(' 小明 ')).json()).toEqual({
    code: 200,
    message: '操作成功',
    data: {
      nickname: '小明',
      available: false,
      suggestion: '小明2',
      message: '昵称已存在，可使用推荐昵称「小明2」',
    },
  });
  expect((await check(' 新名字 ')).json().data).toMatchObject({
    nickname: '新名字',
    available: true,
    suggestion: '新名字',
  });
  for (const value of ['', '   ', 'a'.repeat(65)])
    expect((await check(value)).statusCode).toBe(400);
  expect((await app.inject('/api/v1/users/nickname/check')).statusCode).toBe(400);
});

test('concurrent registrations with one nickname have one winner and roll back the loser credential', async () => {
  await send('register');
  await send('register', '13912345678');
  const results = await Promise.all([
    post('/auth/register', { ...registration, nickname: '同名' }),
    post('/auth/register', {
      ...registration,
      nickname: '同名',
      phone: '13912345678',
      email: 'other@example.com',
    }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await db.user.count()).toBe(1);
  expect(await db.verificationChallenge.count({ where: { consumedAt: null } })).toBe(1);
});

test('profile persists only own fields, trims values, ignores known roles and supports null/clearing', async () => {
  await register();
  const other = await db.user.create({
    data: {
      phoneE164: '+8613912345678',
      phoneRegion: 'CN',
      username: 'other',
      displayName: '另一人',
      bio: '其他用户原简介',
    },
  });
  const tokens = (await login(desktop)).json().data;
  const headers = bearer(tokens.accessToken);
  const updated = await post(
    '/users/me/update',
    {
      avatarUrl: ' common/avatar.png ',
      bio: ' 专家简介 ',
      idCardNo: '11010119900101001x',
      roles: ['OPS', 'PM'],
    },
    headers,
  );
  expect(updated.statusCode).toBe(200);
  expect(updated.json().data).toMatchObject({
    avatarUrl: 'common/avatar.png',
    bio: '专家简介',
    idCardNo: '110***********001X',
    role: 'EXPERT',
    roles: ['NAVIGATOR', 'PM', 'EXPERT'],
    selectedRole: 'EXPERT',
    hasExpertManagementRole: false,
  });
  expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).bio).toBe('其他用户原简介');
  const saved = await db.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } });
  expect(saved.updatedBy).toBe(saved.uid);
  expect(saved.role).toBe('EXPERT');
  expect(saved.idCardNo).toBe('11010119900101001X');
  expect(
    (
      await post(
        '/users/me/update',
        {
          avatarUrl: null,
          bio: null,
          idCardNo: null,
          newPassword: null,
          confirmNewPassword: null,
          roles: null,
        },
        headers,
      )
    ).statusCode,
  ).toBe(200);
  const me = await app.inject({ url: '/api/v1/users/me', headers });
  expect(me.json().data).toMatchObject({
    avatarUrl: 'common/avatar.png',
    bio: '专家简介',
    selectedRole: 'EXPERT',
  });
  const cleared = await post(
    '/users/me/update',
    { avatarUrl: ' ', bio: '', idCardNo: '' },
    headers,
  );
  expect(cleared.json().data).toMatchObject({ avatarUrl: null, bio: null, idCardNo: null });
});

test('profile rejects anonymous, other-user targets, unsupported fields, invalid values and browser origin spoofing', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  expect((await post('/users/me/update', {}, {})).json()).toMatchObject({ code: 401, data: null });
  for (const payload of [
    { userId: 'other' },
    { nickname: '改名' },
    { realName: '改名' },
    { email: 'other@example.com' },
    { idVerified: 1 },
    { idCardNo: 'bad' },
    { bio: 'a'.repeat(1001) },
    { avatarUrl: 'a'.repeat(513) },
    { roles: [] },
    { roles: ['INVALID'] },
    { newPassword: 'onlyletters', confirmNewPassword: 'onlyletters' },
    { newPassword: 'Changed123!' },
    { confirmNewPassword: 'Changed123!' },
    { newPassword: 'Changed123!', confirmNewPassword: 'Wrong123!' },
  ]) {
    const response = await post('/users/me/update', payload, headers);
    expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    expect(response.json()).toMatchObject({ code: 400, data: null });
  }
  const cookie = (await login(web)).cookies[0]!;
  expect(
    (
      await post(
        '/users/me/update',
        { bio: '非法' },
        { origin: 'https://evil.test', cookie: `${cookie.name}=${cookie.value}` },
      )
    ).statusCode,
  ).toBe(403);
  expect((await db.user.findFirstOrThrow()).bio).toBeNull();
});

test('verified identity is immutable and duplicate identity rolls back all profile changes', async () => {
  await register({ idCardNo: '11010119900101001X' });
  const headers = bearer((await login(desktop)).json().data.accessToken);
  await db.user.updateMany({ data: { idVerified: 1 } });
  expect(
    (await post('/users/me/update', { idCardNo: '11010119900101001x' }, headers)).statusCode,
  ).toBe(200);
  for (const idCardNo of ['', '11010119900101002X'])
    expect((await post('/users/me/update', { idCardNo }, headers)).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/v1/users/me', headers })).json().data.idVerified).toBe(1);
  await db.user.updateMany({ data: { idVerified: 0 } });
  await db.user.create({
    data: {
      phoneE164: '+8613912345678',
      phoneRegion: 'CN',
      username: 'other',
      displayName: '其他人',
      idCardNo: '11010119900101002X',
    },
  });
  const conflict = await post(
    '/users/me/update',
    {
      idCardNo: '11010119900101002x',
      bio: '应回滚',
      newPassword: 'Changed123!',
      confirmNewPassword: 'Changed123!',
    },
    headers,
  );
  expect(conflict.statusCode).toBe(409);
  expect((await db.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } })).bio).toBeNull();
  expect((await app.inject({ url: '/api/v1/users/me', headers })).statusCode).toBe(200);
  expect((await login(desktop)).statusCode).toBe(200);
});

test('profile password change clears web cookie and revokes access and refresh tokens on all clients', async () => {
  await register();
  const browser = await login(web);
  const cookie = browser.cookies[0]!;
  const tokens = (await login(desktop)).json().data;
  const changed = await post(
    '/users/me/update',
    { newPassword: 'Changed123!', confirmNewPassword: 'Changed123!' },
    { ...web, cookie: `${cookie.name}=${cookie.value}` },
  );
  expect(changed.statusCode).toBe(200);
  expect(changed.cookies[0]?.value).toBe('');
  expect(await db.session.count({ where: { revokedAt: null } })).toBe(0);
  for (const accessToken of [browser.json().data.accessToken, tokens.accessToken])
    expect(
      (await app.inject({ url: '/api/v1/users/me', headers: bearer(accessToken) })).statusCode,
    ).toBe(401);
  expect(
    (await post('/auth/refresh', { refreshToken: browser.json().data.refreshToken }, web))
      .statusCode,
  ).toBe(401);
  expect(
    (await post('/auth/refresh', { refreshToken: tokens.refreshToken }, desktop)).statusCode,
  ).toBe(401);
  expect(
    (await post('/users/me/update', { bio: 'stale' }, bearer(tokens.accessToken))).statusCode,
  ).toBe(401);
  expect(
    (await post('/auth/login', { account: phone, password: 'Password123' }, desktop)).statusCode,
  ).toBe(401);
  expect((await login(desktop, { password: 'Changed123!' })).statusCode).toBe(200);
});

test('concurrent profile password changes cannot both succeed with a revoked session', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const results = await Promise.all(
    ['Changed123!', 'Changed456!'].map((newPassword) =>
      post('/users/me/update', { newPassword, confirmNewPassword: newPassword }, headers),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  expect(await db.session.count({ where: { revokedAt: null } })).toBe(0);
});

test('organization registration creates authoritative membership atomically with default owner role', async () => {
  const result = await register({
    accountType: 'ORGANIZATION',
    organization: { name: '主管组织', expertiseTags: ['图像标注'] },
  });
  const user = result.json().data;
  expect(
    await db.userOrgRel.findUniqueOrThrow({
      where: { userId_orgId: { userId: user.id, orgId: user.organization.id } },
    }),
  ).toMatchObject({
    uid: user.uid,
    position: 'OWNER',
    joinStatus: 'ACTIVE',
    versionNo: 0,
    createdBy: user.uid,
  });
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const response = await app.inject({
    url: `/api/v1/organizations?orgId=${user.organization.id}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({
    id: user.organization.id,
    position: 'OWNER',
    verifyStatus: 'APPROVED',
    status: 'ACTIVE',
    expertiseTags: ['图像标注'],
  });
});

test('organization permissions use independent memberships across organizations rather than legacy profile pointers', async () => {
  const user = (await register()).json().data;
  const org = await db.organization.create({ data: { name: '组织A', expertiseTags: [] } });
  const other = await db.organization.create({ data: { name: '组织B', expertiseTags: [] } });
  const rel = await db.userOrgRel.create({
    data: { userId: user.id, uid: user.uid, orgId: org.id, position: 'ADMIN' },
  });
  await db.userOrgRel.create({
    data: { userId: user.id, uid: user.uid, orgId: other.id, position: 'MEMBER' },
  });
  // 兼容字段中的主管身份不能授予组织B权限。
  await db.user.update({
    where: { id: user.id },
    data: { organizationId: other.id, orgPosition: 'OWNER' },
  });
  const headers = bearer((await login(desktop)).json().data.accessToken);
  expect(
    (await app.inject({ url: `/api/v1/organizations?orgId=${org.id}`, headers })).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: `/api/v1/organizations?orgId=${other.id}`, headers })).statusCode,
  ).toBe(403);
  expect(
    (await post('/organizations/update', { orgId: org.id, description: 'denied' }, headers))
      .statusCode,
  ).toBe(403);
  for (const joinStatus of [
    'EXIT_APPROVING',
    'PENDING_LEAVE',
    'LEFT',
    'REMOVED',
    'PENDING',
    'PENDING_ACTIVATION',
  ]) {
    await db.userOrgRel.update({ where: { id: rel.id }, data: { joinStatus } });
    expect(
      (await app.inject({ url: `/api/v1/organizations?orgId=${org.id}`, headers })).statusCode,
    ).toBe(['EXIT_APPROVING', 'PENDING_LEAVE'].includes(joinStatus) ? 200 : 403);
  }
});

test('organization partial updates serialize concurrent writers and preserve null, clearing, audit and deleted scope', async () => {
  const user = (
    await register({
      accountType: 'ORGANIZATION',
      organization: { name: '并发资料组织', description: '初始', logoUrl: 'initial.png' },
    })
  ).json().data;
  const orgId = user.organization.id;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const responses = await Promise.all([
    post('/organizations/update', { orgId, description: ' 新简介 ' }, headers),
    post('/organizations/update', { orgId, logoUrl: ' new.png ' }, headers),
  ]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(await db.organization.findUniqueOrThrow({ where: { id: orgId } })).toMatchObject({
    description: '新简介',
    logoUrl: 'new.png',
    updatedBy: user.uid,
  });
  const cleared = await post(
    '/organizations/update',
    { orgId, description: null, logoUrl: '  ' },
    headers,
  );
  expect(cleared.json().data).toMatchObject({ id: orgId, description: '新简介', logoUrl: '' });
  expect(cleared.json().data.updatedAt).toMatch(/Z$/);
  await db.organization.update({ where: { id: orgId }, data: { deleted: true } });
  expect(
    (await app.inject({ url: `/api/v1/organizations?orgId=${orgId}`, headers })).statusCode,
  ).toBe(404);
  expect((await post('/organizations/update', { orgId }, headers)).statusCode).toBe(404);
});

test('organization migration backfill retains existing roles without granting missing roles manager access', async () => {
  await register();
  const user = await db.user.findFirstOrThrow();
  const org = await db.organization.create({ data: { name: '回填组织', expertiseTags: [] } });
  await db.user.update({
    where: { id: user.id },
    data: { organizationId: org.id, orgPosition: 'ADMIN' },
  });
  const sql = readFileSync(
    new URL(
      '../prisma/migrations/20261019020000_organization_memberships/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const backfill = sql.slice(sql.indexOf('INSERT INTO "UserOrgRel"'));
  await db.$executeRawUnsafe(backfill);
  expect(await db.userOrgRel.findFirstOrThrow()).toMatchObject({
    userId: user.id,
    uid: user.uid,
    orgId: org.id,
    position: 'ADMIN',
    joinStatus: 'ACTIVE',
    versionNo: 0,
    joinedAt: user.createdAt,
  });
  await db.userOrgRel.deleteMany();
  await db.user.update({ where: { id: user.id }, data: { orgPosition: null } });
  await db.$executeRawUnsafe(backfill);
  expect((await db.userOrgRel.findFirstOrThrow()).position).toBe('MEMBER');
  await expect(
    db.userOrgRel.create({ data: { userId: user.id, uid: user.uid, orgId: org.id } }),
  ).rejects.toMatchObject({ code: 'P2002' });
  await expect(db.userOrgRel.updateMany({ data: { joinStatus: 'UNKNOWN' } })).rejects.toThrow();
  await expect(db.userOrgRel.updateMany({ data: { versionNo: -1 } })).rejects.toThrow();
});

// 本批成员集成沿用同一串行文件及专用库守卫，避免多个测试文件并发TRUNCATE。
async function memberFixture() {
  const owner = (
    await register({ accountType: 'ORGANIZATION', organization: { name: '成员集成组织' } })
  ).json().data;
  const orgId: string = owner.organization.id;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const ownerRel = await db.userOrgRel.findUniqueOrThrow({
    where: { userId_orgId: { userId: owner.id, orgId } },
  });
  let sequence = 0;
  async function add(position = 'MEMBER', joinStatus = 'ACTIVE') {
    sequence++;
    const user = await db.user.create({
      data: {
        phoneE164: `+861390000${String(sequence).padStart(4, '0')}`,
        phoneRegion: 'CN',
        username: `member${sequence}`,
        displayName: `昵称${sequence}`,
        realName: `真实姓名${sequence}`,
      },
    });
    const rel = await db.userOrgRel.create({
      data: { userId: user.id, uid: user.uid, orgId, position, joinStatus },
    });
    const accessToken = `m${String(sequence).padStart(42, '0')}`;
    await db.session.create({
      data: {
        userId: user.id,
        tokenDigest: digest(accessToken),
        clientType: 'desktop',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, rel, headers: bearer(accessToken) };
  }
  return { owner, ownerRel, orgId, headers, add };
}
test('member pagination, full-phone search, enum filters and Shanghai date boundaries never expose full phone', async () => {
  const f = await memberFixture();
  const first = await f.add();
  const last = await f.add('MEMBER', 'LEFT');
  await db.userOrgRel.update({
    where: { id: first.rel.id },
    data: { joinedAt: new Date('2026-09-30T16:00:00Z'), employmentType: 'FULL_TIME' },
  });
  await db.userOrgRel.update({
    where: { id: last.rel.id },
    data: {
      joinedAt: new Date('2026-10-01T15:59:59Z'),
      leftAt: new Date('2026-10-02T00:00:00Z'),
      employmentType: 'PART_TIME',
    },
  });
  const list = await post(
    '/organizations/members',
    { orgId: f.orgId, joinedStartDate: '2026-10-01', joinedEndDate: '2026-10-01', size: 1 },
    f.headers,
  );
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().data).toMatchObject({ total: 2, pages: 2, current: 1, size: 1 });
  expect(list.json().data.records[0]).toMatchObject({
    memberId: last.rel.id,
    joinStatus: 'LEFT',
    activeProjectCount: 0,
    phoneMasked: '139****0002',
    versionNo: 0,
  });
  expect(list.payload).not.toContain('13900000002');
  const second = await post(
    '/organizations/members',
    {
      orgId: f.orgId,
      joinedStartDate: '2026-10-01',
      joinedEndDate: '2026-10-01',
      current: 2,
      size: 1,
    },
    f.headers,
  );
  expect(second.json().data.records[0].memberId).toBe(first.rel.id);
  for (const keyword of ['真实姓名1', first.user.uid, first.user.phoneE164.slice(3)]) {
    const result = await post('/organizations/members', { orgId: f.orgId, keyword }, f.headers);
    expect(result.json().data.records.map((x: { memberId: string }) => x.memberId)).toEqual([
      first.rel.id,
    ]);
  }
  const partialPhone = await post(
    '/organizations/members',
    { orgId: f.orgId, keyword: '1390000' },
    f.headers,
  );
  expect(partialPhone.json().data.total).toBe(0);
  expect(
    (
      await post(
        '/organizations/members',
        {
          orgId: f.orgId,
          employmentType: 'PART_TIME',
          position: 'MEMBER',
          joinStatus: 'LEFT',
          leftStartDate: '2026-10-02',
          leftEndDate: '2026-10-02',
        },
        f.headers,
      )
    ).json().data.total,
  ).toBe(1);
  expect(
    (await post('/organizations/members', { orgId: f.orgId, projectId: f.orgId }, f.headers))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await post(
        '/organizations/members',
        { orgId: f.orgId, joinedStartDate: '2026-02-30' },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (await post('/organizations/members', { orgId: f.orgId, current: 1000 }, f.headers)).json().data
      .records,
  ).toEqual([]);
});
test('member edit uses conditional versions, concurrent writes have one winner, and scope never crosses organization', async () => {
  const f = await memberFixture();
  const member = await f.add();
  const body = {
    orgId: f.orgId,
    memberId: member.rel.id,
    versionNo: 0,
    employmentType: 'FULL_TIME',
  };
  const results = await Promise.all([
    post('/organizations/members/update', body, f.headers),
    post('/organizations/members/update', { ...body, employmentType: 'PART_TIME' }, f.headers),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const latest = await db.userOrgRel.findUniqueOrThrow({ where: { id: member.rel.id } });
  expect(latest).toMatchObject({ versionNo: 1, updatedBy: f.owner.uid });
  const changed = await post(
    '/organizations/members/update',
    { ...body, versionNo: 1, employmentType: null, joinedAt: '2026-10-01 09:00:00' },
    f.headers,
  );
  expect(changed.json().data).toMatchObject({
    versionNo: 2,
    employmentType: latest.employmentType,
    joinedAt: '2026-10-01T01:00:00.000Z',
  });
  const org = await db.organization.create({ data: { name: '另一组织', expertiseTags: [] } });
  const foreign = await db.userOrgRel.create({
    data: { userId: member.user.id, uid: member.user.uid, orgId: org.id },
  });
  expect(
    (await post('/organizations/members/update', { ...body, memberId: foreign.id }, f.headers))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await post(
        '/organizations/members/update',
        { ...body, versionNo: 2, employmentType: null },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  expect((await post('/organizations/members/update', body, member.headers)).statusCode).toBe(403);
});
test('admin can edit and promote normal members or demote self, while other managers are protected', async () => {
  const f = await memberFixture();
  const admin = await f.add('ADMIN');
  const peer = await f.add('ADMIN');
  const member = await f.add();
  const edit = (memberId: string) =>
    post(
      '/organizations/members/update',
      { orgId: f.orgId, memberId, versionNo: 0, employmentType: 'PART_TIME' },
      admin.headers,
    );
  expect((await edit(member.rel.id)).statusCode).toBe(200);
  expect((await edit(admin.rel.id)).statusCode).toBe(200);
  expect((await edit(peer.rel.id)).statusCode).toBe(403);
  expect((await edit(f.ownerRel.id)).statusCode).toBe(403);
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: member.rel.id, position: 'OWNER' },
        admin.headers,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: member.rel.id, position: 'ADMIN' },
        admin.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: admin.rel.id, position: 'MEMBER' },
        admin.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect((await post('/organizations/members', { orgId: f.orgId }, admin.headers)).statusCode).toBe(
    403,
  );
});
test('concurrent admin promotions serialize the five-admin cap including pending memberships', async () => {
  const f = await memberFixture();
  for (const status of ['ACTIVE', 'PENDING', 'PENDING_ACTIVATION', 'PENDING_LEAVE'])
    await f.add('ADMIN', status);
  const left = await f.add();
  const right = await f.add();
  const results = await Promise.all(
    [left, right].map((member) =>
      post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: member.rel.id, position: 'ADMIN' },
        f.headers,
      ),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.userOrgRel.count({ where: { orgId: f.orgId, position: 'ADMIN' } })).toBe(5);
  const promoted = await db.userOrgRel.findFirstOrThrow({
    where: { id: { in: [left.rel.id, right.rel.id] }, position: 'ADMIN' },
  });
  const version = promoted.versionNo;
  const noop = await post(
    '/organizations/members/position',
    { orgId: f.orgId, memberId: promoted.id, position: 'ADMIN' },
    f.headers,
  );
  expect(noop.statusCode).toBe(200);
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: promoted.id } })).versionNo).toBe(
    version,
  );
  const remaining = promoted.id === left.rel.id ? right : left;
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: remaining.rel.id, position: 'OWNER' },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: promoted.id, position: 'OWNER' },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect(await db.userOrgRel.count({ where: { orgId: f.orgId, position: 'OWNER' } })).toBe(1);
  expect(await db.userOrgRel.count({ where: { orgId: f.orgId, position: 'ADMIN' } })).toBe(5);
});
test('concurrent owner transfers preserve a single owner, and stale owner cannot perform another transfer', async () => {
  const f = await memberFixture();
  const first = await f.add();
  const second = await f.add();
  const results = await Promise.all(
    [first, second].map((member) =>
      post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: member.rel.id, position: 'OWNER' },
        f.headers,
      ),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
  const owner = await db.userOrgRel.findFirstOrThrow({
    where: { orgId: f.orgId, position: 'OWNER' },
  });
  expect(await db.userOrgRel.count({ where: { orgId: f.orgId, position: 'OWNER' } })).toBe(1);
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: f.ownerRel.id } })).position).toBe(
    'ADMIN',
  );
  const profile = await app.inject({ url: '/api/v1/users/me', headers: f.headers });
  expect(profile.json().data).toMatchObject({
    hasExpertManagementRole: false,
    organization: { id: f.orgId, position: 'ADMIN' },
  });
  const target = owner.id === first.rel.id ? first : second;
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: target.headers })).json().data,
  ).toMatchObject({
    hasExpertManagementRole: true,
    organization: { id: f.orgId, position: 'OWNER' },
  });
  // User.orgPosition保留旧OWNER，不能继续授权更新组织资料。
  expect(
    (await post('/organizations/update', { orgId: f.orgId, description: 'stale' }, f.headers))
      .statusCode,
  ).toBe(403);
});
test('profile selects owner then earliest participating membership and ignores legacy pointer and deleted organizations', async () => {
  const f = await memberFixture();
  const other = await db.organization.create({
    data: { name: '第二组织', expertiseTags: [], verifyStatus: 'APPROVED', status: 'FROZEN' },
  });
  await db.userOrgRel.update({
    where: { id: f.ownerRel.id },
    data: { position: 'ADMIN', joinedAt: new Date('2026-01-02T00:00:00Z') },
  });
  const relation = await db.userOrgRel.create({
    data: {
      orgId: other.id,
      userId: f.owner.id,
      uid: f.owner.uid,
      position: 'MEMBER',
      joinStatus: 'EXIT_APPROVING',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const me = async () =>
    (await app.inject({ url: '/api/v1/users/me', headers: f.headers })).json().data;
  expect((await me()).organization).toMatchObject({
    id: other.id,
    position: 'MEMBER',
    joinStatus: 'EXIT_APPROVING',
    verifyStatus: 'APPROVED',
    status: 'FROZEN',
  });
  await db.userOrgRel.update({ where: { id: f.ownerRel.id }, data: { position: 'OWNER' } });
  expect((await me()).organization.id).toBe(f.orgId);
  await db.userOrgRel.update({ where: { id: f.ownerRel.id }, data: { joinStatus: 'LEFT' } });
  expect((await me()).organization.id).toBe(other.id);
  await db.organization.update({ where: { id: other.id }, data: { deleted: true } });
  expect(await me()).toMatchObject({ organization: null, hasExpertManagementRole: false });
  // 更新资料响应也必须使用实际关系，不能重新读兼容指针。
  expect(
    (await post('/users/me/update', { bio: 'new bio' }, f.headers)).json().data.organization,
  ).toBeNull();
  expect(relation.position).toBe('MEMBER');
});
test('license access follows membership across organizations, demotion and departure instead of legacy pointer', async () => {
  const f = await memberFixture();
  const reader = await f.add('ADMIN');
  const { record, uploadToken } = await uploaded();
  await db.$transaction((tx) =>
    registry.claimForOrganizationRegistration(tx, record.objectKey, uploadToken, f.orgId),
  );
  const read = () =>
    app.inject({
      url: `/api/v1/files/view?objectKey=${record.objectKey}`,
      headers: reader.headers,
    });
  expect(reader.user.organizationId).toBeNull();
  expect((await read()).statusCode).toBe(200);
  await db.userOrgRel.update({
    where: { id: reader.rel.id },
    data: { joinStatus: 'EXIT_APPROVING' },
  });
  expect((await read()).statusCode).toBe(200);
  await db.userOrgRel.update({
    where: { id: reader.rel.id },
    data: { joinStatus: 'PENDING_LEAVE' },
  });
  expect((await read()).statusCode).toBe(200);
  await db.user.update({
    where: { id: reader.user.id },
    data: { organizationId: f.orgId, orgPosition: 'OWNER' },
  });
  await db.userOrgRel.update({ where: { id: reader.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await read()).statusCode).toBe(403);
  await db.userOrgRel.update({
    where: { id: reader.rel.id },
    data: { joinStatus: 'ACTIVE', position: 'MEMBER' },
  });
  expect((await read()).statusCode).toBe(403);
  await db.userOrgRel.update({ where: { id: reader.rel.id }, data: { position: 'ADMIN' } });
  await db.organization.update({ where: { id: f.orgId }, data: { deleted: true } });
  expect((await read()).statusCode).toBe(403);
});

async function requestSelfExit(
  f: Awaited<ReturnType<typeof memberFixture>>,
  member: Awaited<ReturnType<Awaited<ReturnType<typeof memberFixture>>['add']>>,
  key = 'self-exit',
  day = '2099-01-01',
) {
  return post(
    '/organizations/members/exit-requests',
    { orgId: f.orgId, reason: '个人安排', plannedLeaveDate: day },
    { ...member.headers, 'idempotency-key': key },
  );
}
async function pendingExit(f: Awaited<ReturnType<typeof memberFixture>>) {
  const response = await post('/organizations/approvals/pending', { orgId: f.orgId }, f.headers);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.total).toBe(1);
  return response.json().data.records[0];
}
function processing(
  orgId: string,
  node: { flowNo: string; nodeId: string; nodeVersionNo: number; flowVersionNo: number },
  action = 'APPROVE',
) {
  return {
    orgId,
    flowNo: node.flowNo,
    nodeId: node.nodeId,
    nodeVersionNo: node.nodeVersionNo,
    flowVersionNo: node.flowVersionNo,
    action,
    actionComment: action === 'REJECT' ? '  补充说明  ' : null,
  };
}
test('exit request writes one flow, owner node, action and member transition; concurrent replays and payload changes reuse it', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const results = await Promise.all([requestSelfExit(f, member), requestSelfExit(f, member)]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  const data = results[0]!.json().data;
  expect(data).toMatchObject({
    flowStatus: 'PENDING',
    memberId: member.rel.id,
    joinStatus: 'EXIT_APPROVING',
  });
  expect(data.flowNo).toMatch(/^OMX[A-F0-9]{40}$/);
  expect(await db.approvalFlow.count()).toBe(1);
  expect(await db.approvalNode.count()).toBe(1);
  expect(await db.approvalActionLog.count()).toBe(1);
  expect(await db.userOrgRel.findUniqueOrThrow({ where: { id: member.rel.id } })).toMatchObject({
    joinStatus: 'EXIT_APPROVING',
    versionNo: 1,
    plannedLeaveDate: null,
  });
  const replay = await post(
    '/organizations/members/exit-requests',
    {
      orgId: f.orgId,
      memberId: f.ownerRel.id,
      reason: '不同payload',
      plannedLeaveDate: '2099-02-01',
    },
    { ...member.headers, 'idempotency-key': 'self-exit' },
  );
  expect(replay.json().data).toEqual(data);
  expect((await requestSelfExit(f, member, 'another-key')).statusCode).toBe(409);
  const admin = await f.add('ADMIN');
  const pending = await post('/organizations/approvals/pending', { orgId: f.orgId }, admin.headers);
  expect(pending.json().data.total).toBe(0);
  expect(
    (await post('/organizations/approvals/pending', { orgId: f.orgId }, member.headers)).statusCode,
  ).toBe(403);
});
test('missing active owner rolls back flow/node/action/member writes and preserves original state', async () => {
  const f = await memberFixture(),
    member = await f.add();
  await db.userOrgRel.update({ where: { id: f.ownerRel.id }, data: { position: 'ADMIN' } });
  expect((await requestSelfExit(f, member)).statusCode).toBe(500);
  expect(await db.approvalFlow.count()).toBe(0);
  expect(await db.approvalActionLog.count()).toBe(0);
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: member.rel.id } })).joinStatus).toBe(
    'ACTIVE',
  );
});
test('direct exits enforce organization roles, today records durable cleanup, and pending departure remains participating', async () => {
  const f = await memberFixture(),
    admin = await f.add('ADMIN'),
    peer = await f.add('ADMIN'),
    member = await f.add(),
    future = await f.add();
  const exit = (
    targetId: string,
    headers = admin.headers,
    key = 'direct',
    plannedLeaveDate = shanghaiDay(new Date()),
  ) =>
    post(
      '/organizations/members/exit-requests',
      { orgId: f.orgId, memberId: targetId, reason: '人员调整', plannedLeaveDate },
      { ...headers, 'idempotency-key': key },
    );
  expect((await exit(f.ownerRel.id)).statusCode).toBe(400);
  expect((await exit(peer.rel.id)).statusCode).toBe(403);
  expect((await exit(member.rel.id, member.headers, 'not-used', '2000-01-01')).statusCode).toBe(
    400,
  );
  const immediate = await exit(member.rel.id);
  expect(immediate.statusCode, immediate.body).toBe(200);
  expect(immediate.json().data).toMatchObject({ flowStatus: 'APPROVED', joinStatus: 'LEFT' });
  expect(await db.approvalNode.count()).toBe(0);
  expect(
    await db.organizationDeparture.findUniqueOrThrow({
      where: { memberId_memberVersion: { memberId: member.rel.id, memberVersion: 1 } },
    }),
  ).toMatchObject({ status: 'PENDING', orgId: f.orgId, userId: member.user.id });
  expect((await exit(member.rel.id)).json()).toEqual(immediate.json());
  expect(
    (await exit(future.rel.id, f.headers, 'future', '2099-01-01')).json().data.joinStatus,
  ).toBe('PENDING_LEAVE');
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: future.headers })).json().data
      .organization.joinStatus,
  ).toBe('PENDING_LEAVE');
  expect(
    (await post('/organizations/approvals/records', { orgId: f.orgId }, f.headers)).json().data
      .total,
  ).toBe(0);
});
test('approval validates both versions and rejection comment; concurrent decisions have one winner and rollback the loser', async () => {
  const f = await memberFixture(),
    member = await f.add();
  expect((await requestSelfExit(f, member)).statusCode).toBe(200);
  const node = await pendingExit(f),
    input = processing(f.orgId, node);
  for (const change of [{ flowVersionNo: 99 }, { nodeVersionNo: 99 }])
    expect(
      (await post('/organizations/approvals/process', { ...input, ...change }, f.headers))
        .statusCode,
    ).toBe(409);
  expect(
    (
      await post(
        '/organizations/approvals/process',
        { ...input, action: 'REJECT', actionComment: ' ' },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  const decisions = await Promise.all([
    post('/organizations/approvals/process', input, f.headers),
    post('/organizations/approvals/process', input, f.headers),
  ]);
  expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(decisions.find((r) => r.statusCode === 200)!.json().data).toMatchObject({
    nodeStatus: 'APPROVED',
    flowStatus: 'APPROVED',
    currentNode: null,
    joinStatus: 'PENDING_LEAVE',
    plannedLeaveDate: '2099-01-01',
  });
  expect(await db.approvalActionLog.count()).toBe(2);
  expect(await db.approvalFlow.findUniqueOrThrow({ where: { flowNo: node.flowNo } })).toMatchObject(
    { status: 'APPROVED', versionNo: 1, currentNode: null },
  );
  expect((await db.approvalNode.findUniqueOrThrow({ where: { id: node.nodeId } })).versionNo).toBe(
    1,
  );
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: member.rel.id } })).versionNo).toBe(
    2,
  );
  expect(
    (await post('/organizations/approvals/pending', { orgId: f.orgId }, f.headers)).json().data
      .total,
  ).toBe(0);
});
test('rejection restores member and permits a fresh exit; missing or mismatched node/organization cannot advance flow', async () => {
  const f = await memberFixture(),
    member = await f.add(),
    other = await f.add();
  await requestSelfExit(f, member);
  const node = await pendingExit(f);
  await requestSelfExit(f, other, 'other');
  const otherFlow = await db.approvalFlow.findFirstOrThrow({ where: { businessId: other.rel.id } });
  const wrongNode = await db.approvalNode.findFirstOrThrow({ where: { flowId: otherFlow.id } });
  const input = processing(f.orgId, node, 'REJECT');
  expect(
    (await post('/organizations/approvals/process', { ...input, nodeId: wrongNode.id }, f.headers))
      .statusCode,
  ).toBe(400);
  const wrongOrg = await db.organization.create({ data: { name: '隔离组织', expertiseTags: [] } });
  await db.userOrgRel.create({
    data: { orgId: wrongOrg.id, userId: f.owner.id, uid: f.owner.uid, position: 'OWNER' },
  });
  expect(
    (await post('/organizations/approvals/process', { ...input, orgId: wrongOrg.id }, f.headers))
      .statusCode,
  ).toBe(403);
  expect(
    (await post('/organizations/approvals/pending', { orgId: wrongOrg.id }, f.headers)).json().data
      .total,
  ).toBe(0);
  const rejected = await post('/organizations/approvals/process', input, f.headers);
  expect(rejected.json().data).toMatchObject({
    flowStatus: 'REJECTED',
    nodeStatus: 'REJECTED',
    joinStatus: 'ACTIVE',
    plannedLeaveDate: null,
  });
  expect(await db.userOrgRel.findUniqueOrThrow({ where: { id: member.rel.id } })).toMatchObject({
    joinStatus: 'ACTIVE',
    plannedLeaveDate: null,
  });
  expect((await requestSelfExit(f, member, 'fresh')).statusCode).toBe(200);
});
test('malformed approval snapshots and conflicting member state roll back all attempted decision writes', async () => {
  const f = await memberFixture(),
    member = await f.add();
  await requestSelfExit(f, member);
  const node = await pendingExit(f),
    input = processing(f.orgId, node);
  const flow = await db.approvalFlow.findUniqueOrThrow({ where: { flowNo: node.flowNo } });
  await db.approvalFlow.update({
    where: { id: flow.id },
    data: { formData: { targetMemberId: member.rel.id, plannedLeaveDate: 'bad-date' } },
  });
  expect((await post('/organizations/approvals/process', input, f.headers)).statusCode).toBe(500);
  await db.approvalFlow.update({ where: { id: flow.id }, data: { formData: flow.formData! } });
  await db.userOrgRel.update({ where: { id: member.rel.id }, data: { joinStatus: 'ACTIVE' } });
  expect((await post('/organizations/approvals/process', input, f.headers)).statusCode).toBe(409);
  expect(await db.approvalFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({
    status: 'PENDING',
    versionNo: 0,
  });
  expect(await db.approvalNode.findUniqueOrThrow({ where: { id: node.nodeId } })).toMatchObject({
    nodeStatus: 'PENDING',
    versionNo: 0,
    approvedAt: null,
  });
  expect(await db.approvalActionLog.count()).toBe(1);
});
test('approval after planned day finalizes organization departure and records pending project compensation exactly once', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const today = shanghaiDay(new Date());
  await requestSelfExit(f, member, 'today', today);
  const node = await pendingExit(f);
  const result = await post(
    '/organizations/approvals/process',
    processing(f.orgId, node),
    f.headers,
  );
  expect(result.json().data.joinStatus).toBe('LEFT');
  expect(await db.organizationDeparture.count()).toBe(1);
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: member.headers })).json().data
      .organization,
  ).toBeNull();
  const replay = await requestSelfExit(f, member, 'today', today);
  expect(replay.statusCode).toBe(200);
  // 沿旧Service：流程为当前APPROVED，joinStatus仍为创建时EXIT_APPROVING快照。
  expect(replay.json().data).toMatchObject({
    flowStatus: 'APPROVED',
    joinStatus: 'EXIT_APPROVING',
  });
  expect(await db.organizationDeparture.count()).toBe(1);
});
test('owner transfer does not silently reassign historical approval and requires both current role and node assignee', async () => {
  const f = await memberFixture(),
    member = await f.add(),
    successor = await f.add();
  await requestSelfExit(f, member);
  const node = await pendingExit(f);
  expect(
    (
      await post(
        '/organizations/members/position',
        { orgId: f.orgId, memberId: successor.rel.id, position: 'OWNER' },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await post('/organizations/approvals/process', processing(f.orgId, node), f.headers))
      .statusCode,
  ).toBe(403);
  expect(
    (await post('/organizations/approvals/process', processing(f.orgId, node), successor.headers))
      .statusCode,
  ).toBe(403);
  expect((await db.approvalNode.findUniqueOrThrow({ where: { id: node.nodeId } })).approverId).toBe(
    f.owner.id,
  );
});
test('approval history pages by nodes, uses live names and last node action, and filters inclusive Shanghai times', async () => {
  const f = await memberFixture(),
    member = await f.add();
  await requestSelfExit(f, member);
  const pending = await pendingExit(f);
  await post('/organizations/approvals/process', processing(f.orgId, pending), f.headers);
  const original = await db.approvalNode.findUniqueOrThrow({ where: { id: pending.nodeId } });
  const second = await db.approvalNode.create({
    data: {
      flowId: original.flowId,
      flowNo: original.flowNo,
      nodeSeq: 2,
      nodeCode: 'EXTRA',
      nodeName: '历史第二节点',
      approverId: f.owner.id,
      approverUid: f.owner.uid,
      approverName: '旧快照',
      approverType: 'USER',
      nodeStatus: 'APPROVED',
      approvedAt: new Date('2026-10-19T01:00:00Z'),
    },
  });
  await db.approvalActionLog.create({
    data: {
      flowId: original.flowId,
      nodeId: second.id,
      actionType: 'APPROVE',
      operatorId: f.owner.id,
      operatorName: '旧快照',
      actionComment: 'first',
    },
  });
  await db.approvalActionLog.create({
    data: {
      flowId: original.flowId,
      nodeId: second.id,
      actionType: 'AUTO_PASS',
      operatorId: null,
      operatorName: 'SYSTEM',
      actionComment: 'latest',
    },
  });
  await db.user.update({
    where: { id: member.user.id },
    data: { displayName: '新昵称', realName: '新姓名' },
  });
  const all = await post(
    '/organizations/approvals/records',
    { orgId: f.orgId, size: 1 },
    f.headers,
  );
  expect(all.json().data).toMatchObject({ total: 2, pages: 2, size: 1 });
  const byTime = await post(
    '/organizations/approvals/records',
    {
      orgId: f.orgId,
      startAt: '2026-10-19 09:00:00',
      endAt: '2026-10-19 09:00:00',
      status: 'APPROVED',
      businessType: ' ORG_MEMBER_EXIT ',
    },
    f.headers,
  );
  expect(byTime.json().data).toMatchObject({
    total: 1,
    records: [
      {
        nodeId: second.id,
        actionType: 'AUTO_PASS',
        operatorName: 'SYSTEM',
        actionComment: 'latest',
        applicantName: '新昵称(新姓名)',
        targetMemberName: '新昵称(新姓名)',
      },
    ],
  });
  expect(
    (
      await post(
        '/organizations/approvals/records',
        { orgId: f.orgId, startAt: '2026-10-20 00:00:00', endAt: '2026-10-19 00:00:00' },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
});
test('due departure worker handles Shanghai midnight per member and retries idempotently', async () => {
  const f = await memberFixture(),
    due = await f.add('MEMBER', 'PENDING_LEAVE'),
    later = await f.add('MEMBER', 'PENDING_LEAVE');
  await db.userOrgRel.update({
    where: { id: due.rel.id },
    data: { plannedLeaveDate: new Date('2099-01-01T00:00:00Z') },
  });
  await db.userOrgRel.update({
    where: { id: later.rel.id },
    data: { plannedLeaveDate: new Date('2099-01-02T00:00:00Z') },
  });
  const service = new DepartureService(db);
  expect(await service.processDue(new Date('2098-12-31T15:59:59Z'), 1)).toMatchObject({
    processed: 0,
    failed: 0,
  });
  const result = await service.processDue(new Date('2098-12-31T16:00:00Z'), 1);
  expect(result).toEqual({ processed: 1, failed: 0, pendingProjectCleanup: 1 });
  expect(await db.userOrgRel.findUniqueOrThrow({ where: { id: due.rel.id } })).toMatchObject({
    joinStatus: 'LEFT',
    versionNo: 1,
    leftAt: new Date('2098-12-31T16:00:00Z'),
  });
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: later.rel.id } })).joinStatus).toBe(
    'PENDING_LEAVE',
  );
  expect(await service.processDue(new Date('2098-12-31T16:00:00Z'), 1)).toEqual({
    processed: 0,
    failed: 0,
    pendingProjectCleanup: 1,
  });
});
test('approval kernel discovers legacy seed configuration and queries flows, nodes and ordered actions', async () => {
  const kernel = new ApprovalService(db);
  const process = await kernel.enabledProcess(' ORG_MEMBER_EXIT ');
  expect(process).toMatchObject({ status: 'ENABLED', version: 1 });
  expect(await kernel.configs(process!.id)).toMatchObject([
    {
      nodeCode: 'EXIT_APPROVAL',
      approverType: 'ROLE',
      approverConfig: { roleCodes: ['OWNER', 'ADMIN'] },
    },
  ]);
  const f = await memberFixture(),
    member = await f.add();
  const result = await requestSelfExit(f, member);
  const flow = await kernel.flow(result.json().data.flowNo);
  expect(await kernel.activeBusiness('ORG_MEMBER_EXIT', member.rel.id)).toMatchObject({
    id: flow!.id,
  });
  expect(await kernel.pendingNodes(f.owner.id)).toHaveLength(1);
  expect(await kernel.nodes(flow!.id, 1)).toMatchObject([
    { approverType: 'ORG_LEADER', approverId: f.owner.id, configId: null },
  ]);
  expect(await kernel.actions(flow!.id)).toMatchObject([{ actionType: 'SUBMIT' }]);
});

async function importHttp(
  orgId: string,
  headers: Record<string, string>,
  text: string,
  key = 'import-key',
) {
  const boundary = 'member-integration-import';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="orgId"\r\n\r\n${orgId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="memberText"\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  );
  return app.inject({
    method: 'POST',
    url: '/api/v1/organizations/member-imports/generate',
    headers: {
      ...headers,
      'idempotency-key': key,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}
test('member import creates passwordless EXPERT users and pending memberships atomically, then SMS activates before issuing a session', async () => {
  const f = await memberFixture();
  const imported = await importHttp(f.orgId, f.headers, '张三,13712345678,全职,管理员,2026-10-01');
  expect(imported.statusCode, imported.body).toBe(200);
  expect(imported.json().data).toMatchObject({
    createdCount: 1,
    sourceType: 'TEXT',
    members: [{ joinStatus: 'PENDING_ACTIVATION', position: 'ADMIN', phoneMasked: '137****5678' }],
  });
  const user = await db.user.findUniqueOrThrow({ where: { phoneE164: '+8613712345678' } });
  expect(user).toMatchObject({
    passwordHash: null,
    role: 'EXPERT',
    accountType: 'INDIVIDUAL',
    organizationId: null,
  });
  expect(
    (await post('/auth/login', { account: '13712345678', password: '095270' }, desktop)).statusCode,
  ).toBe(401);
  const before = await db.userOrgRel.findUniqueOrThrow({
    where: { userId_orgId: { userId: user.id, orgId: f.orgId } },
  });
  expect(before.joinedAt).toEqual(new Date('2026-09-30T16:00:00Z'));
  await send('login', '13712345678');
  const logged = await post('/auth/sms/login', { phone: '13712345678', code: '095270' }, desktop);
  expect(logged.statusCode, logged.body).toBe(200);
  expect(await db.userOrgRel.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
    joinStatus: 'ACTIVE',
    versionNo: 1,
    updatedBy: user.uid,
  });
  expect(
    (
      await app.inject({ url: '/api/v1/users/me', headers: bearer(logged.json().data.accessToken) })
    ).json().data.organization,
  ).toMatchObject({ id: f.orgId, position: 'ADMIN', joinStatus: 'ACTIVE' });
  await send('login', '13712345678');
  expect(
    (await post('/auth/sms/login', { phone: '13712345678', code: '095270' }, desktop)).statusCode,
  ).toBe(200);
  expect((await db.userOrgRel.findUniqueOrThrow({ where: { id: before.id } })).versionNo).toBe(1);
});
test('invalid import reports every bad row without creating users or memberships and caches the validation result', async () => {
  const f = await memberFixture();
  const body =
    '张三,13712345678,全职\n李四,13712345678,兼职,主管,2026-02-30\n坏姓名1,wrong,错误属性';
  const result = await importHttp(f.orgId, f.headers, body);
  expect(result.statusCode, result.body).toBe(400);
  expect(result.json().data).toMatchObject({
    totalCount: 3,
    validCount: 0,
    invalidCount: 3,
    createdCount: 0,
    members: [],
    createdAt: null,
  });
  expect(result.json().data.rowErrors.length).toBeGreaterThan(4);
  expect(result.body).not.toContain('13712345678');
  expect(await db.user.count()).toBe(1);
  expect(await db.userOrgRel.count()).toBe(1);
  expect(await db.memberImportReceipt.count()).toBe(1);
  expect((await importHttp(f.orgId, f.headers, body)).json()).toEqual(result.json());
  expect((await importHttp(f.orgId, f.headers, '张三,13712345678,全职')).statusCode).toBe(409);
});
test('import reuses an unbound existing account and historical membership without overwriting profile, password or version', async () => {
  const f = await memberFixture(),
    existing = await f.add();
  await db.user.update({
    where: { id: existing.user.id },
    data: { bio: 'keep', passwordHash: 'keep-password', accountType: 'ORGANIZATION' },
  });
  await db.userOrgRel.update({
    where: { id: existing.rel.id },
    data: {
      joinStatus: 'LEFT',
      leftAt: new Date(),
      plannedLeaveDate: new Date('2026-10-01T00:00:00Z'),
      versionNo: 7,
    },
  });
  const original = await db.user.findUniqueOrThrow({ where: { id: existing.user.id } });
  const result = await importHttp(
    f.orgId,
    f.headers,
    `另名,${original.phoneE164.slice(3)},兼职,管理员`,
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.members[0]).toMatchObject({
    memberId: existing.rel.id,
    userId: original.id,
    accountType: 'INDIVIDUAL',
    joinStatus: 'ACTIVE',
    position: 'ADMIN',
  });
  expect(await db.user.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  expect(await db.userOrgRel.findUniqueOrThrow({ where: { id: existing.rel.id } })).toMatchObject({
    versionNo: 8,
    leftAt: null,
    plannedLeaveDate: null,
    employmentType: 'PART_TIME',
  });
});
test('import rejects effective duplicate membership only in the target organization and allows cross-organization membership', async () => {
  const f = await memberFixture(),
    joined = await f.add();
  const other = await db.organization.create({ data: { name: '其他组织', expertiseTags: [] } });
  const foreign = await f.add();
  await db.userOrgRel.update({
    where: { id: foreign.rel.id },
    data: { orgId: other.id, joinStatus: 'PENDING_ACTIVATION' },
  });
  const unbound = await f.add();
  await db.userOrgRel.delete({ where: { id: unbound.rel.id } });
  const invalid = await importHttp(
    f.orgId,
    f.headers,
    `张三,${joined.user.phoneE164.slice(3)},全职\n李四,${foreign.user.phoneE164.slice(3)},兼职\n王五,${unbound.user.phoneE164.slice(3)},全职`,
  );
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().data).toMatchObject({ validCount: 2, invalidCount: 1, createdCount: 0 });
  expect(invalid.json().data.rowErrors.map((e: { errorCode: string }) => e.errorCode)).toEqual([
    'ACCOUNT_REGISTERED',
  ]);
  expect(await db.userOrgRel.count({ where: { userId: unbound.user.id } })).toBe(0);
  const valid = await importHttp(
    f.orgId,
    f.headers,
    `王五,${unbound.user.phoneE164.slice(3)},全职`,
    'unbound',
  );
  expect(valid.json().data.members[0]).toMatchObject({
    userId: unbound.user.id,
    joinStatus: 'ACTIVE',
  });
});
test('import scopes idempotency by operator and org, rejects concurrent replay or changed payload, expires after 24 hours', async () => {
  const f = await memberFixture();
  const body = '张三,13712345678,全职';
  const results = await Promise.all([
    importHttp(f.orgId, f.headers, body),
    importHttp(f.orgId, f.headers, body),
  ]);
  expect(results.some((r) => r.statusCode === 200)).toBe(true);
  expect(results.every((r) => [200, 409].includes(r.statusCode))).toBe(true);
  expect(await db.user.count()).toBe(2);
  expect(await db.memberImportReceipt.count()).toBe(1);
  const first = results.find((r) => r.statusCode === 200)!;
  expect((await importHttp(f.orgId.toUpperCase(), f.headers, body)).json()).toEqual(first.json());
  expect((await importHttp(f.orgId, f.headers, body)).json()).toEqual(first.json());
  expect((await importHttp(f.orgId, f.headers, '李四,13712345679,兼职')).statusCode).toBe(409);
  const receipt = await db.memberImportReceipt.findFirstOrThrow();
  expect(receipt.expiresAt.getTime() - receipt.createdAt.getTime()).toBeGreaterThanOrEqual(
    86_399_000,
  );
  await db.memberImportReceipt.updateMany({ data: { expiresAt: new Date(0) } });
  const afterExpiry = await importHttp(f.orgId, f.headers, body);
  expect(afterExpiry.statusCode).toBe(400);
  expect(afterExpiry.json().data.rowErrors[0].errorCode).toBe('ACCOUNT_REGISTERED');
});
test('cross-organization concurrent import of one phone creates two memberships for one account', async () => {
  const f = await memberFixture();
  const other = await db.organization.create({ data: { name: '并发导入组织', expertiseTags: [] } });
  await db.userOrgRel.create({
    data: { orgId: other.id, userId: f.owner.id, uid: f.owner.uid, position: 'OWNER' },
  });
  const results = await Promise.all([
    importHttp(f.orgId, f.headers, '张三,13712345678,全职', 'shared'),
    importHttp(other.id, f.headers, '张三,13712345678,全职', 'shared'),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200]);
  const user = await db.user.findUniqueOrThrow({ where: { phoneE164: '+8613712345678' } });
  expect(await db.userOrgRel.count({ where: { userId: user.id } })).toBe(2);
});
test('concurrent imports and role promotions share administrator capacity and count pending activation slots', async () => {
  const f = await memberFixture();
  for (let i = 0; i < 4; i++) await f.add('ADMIN');
  const target = await f.add();
  const results = await Promise.all([
    importHttp(f.orgId, f.headers, '张三,13712345678,全职,管理员'),
    post(
      '/organizations/members/position',
      { orgId: f.orgId, memberId: target.rel.id, position: 'ADMIN' },
      f.headers,
    ),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.userOrgRel.count({ where: { orgId: f.orgId, position: 'ADMIN' } })).toBe(5);
  if (results[0]!.statusCode === 400)
    expect(await db.user.findUnique({ where: { phoneE164: '+8613712345678' } })).toBeNull();
});
test('XLS/XLSX template files and CSV upload prioritize nonempty file and retain full validation results', async () => {
  const f = await memberFixture();
  for (const [index, bookType] of (['xls', 'xlsx'] as const).entries()) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '手机号', '人员属性', '组织内角色', '入组时间'],
        ['张三', `1371234567${index}`, '全职', '成员', '2026-10-01'],
      ]),
      'members',
    );
    const boundary = 'excel-import-' + bookType;
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType }));
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="csvFile"; filename="members.${bookType}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="memberText"\r\n\r\ninvalid ignored text\r\n--${boundary}--\r\n`,
      ),
    ]);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/member-imports/generate?orgId=${f.orgId}`,
      headers: {
        ...f.headers,
        'idempotency-key': bookType,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({
      sourceType: 'EXCEL',
      textIgnored: true,
      createdCount: 1,
    });
  }
  const member = await f.add();
  expect((await importHttp(f.orgId, member.headers, '张三,13712345678,全职')).statusCode).toBe(403);
});
test('password login activates pending memberships in the token transaction after reset, refresh does not increment again', async () => {
  const f = await memberFixture();
  await importHttp(f.orgId, f.headers, '张三,13712345678,全职');
  await send('reset_password', '13712345678');
  expect(
    (
      await post(
        '/auth/password/reset',
        {
          phone: '13712345678',
          code: '095270',
          newPassword: 'Changed123!',
        },
        desktop,
      )
    ).statusCode,
  ).toBe(200);
  const user = await db.user.findUniqueOrThrow({ where: { phoneE164: '+8613712345678' } });
  expect((await db.userOrgRel.findFirstOrThrow({ where: { userId: user.id } })).joinStatus).toBe(
    'PENDING_ACTIVATION',
  );
  const logged = await post(
    '/auth/login',
    { account: '13712345678', password: 'Changed123!' },
    desktop,
  );
  expect(logged.statusCode, logged.body).toBe(200);
  expect((await db.userOrgRel.findFirstOrThrow({ where: { userId: user.id } })).versionNo).toBe(1);
  expect(
    (await post('/auth/refresh', { refreshToken: logged.json().data.refreshToken }, desktop))
      .statusCode,
  ).toBe(200);
  expect((await db.userOrgRel.findFirstOrThrow({ where: { userId: user.id } })).versionNo).toBe(1);
});
test('injected activation failure rolls back code consumption and relation update and creates no session', async () => {
  const f = await memberFixture();
  await importHttp(f.orgId, f.headers, '张三,13712345678,全职');
  await send('login', '13712345678');
  const before = await db.session.count();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'userOrgRel')
                    return {
                      ...transaction.userOrgRel,
                      updateMany: async (args: Prisma.UserOrgRelUpdateManyArgs) => {
                        await transaction.userOrgRel.updateMany(args);
                        throw new Error('injected activation failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new AuthService(failing, config).loginBySms(
      { phone: '13712345678', code: '095270' },
      '127.0.0.1',
      'desktop',
    ),
  ).rejects.toThrow('injected activation failure');
  expect(await db.session.count()).toBe(before);
  const user = await db.user.findUniqueOrThrow({ where: { phoneE164: '+8613712345678' } });
  expect(await db.userOrgRel.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
    joinStatus: 'PENDING_ACTIVATION',
    versionNo: 0,
  });
  expect(
    (
      await db.verificationChallenge.findFirstOrThrow({
        where: { phoneE164: '+8613712345678', purpose: 'login' },
      })
    ).consumedAt,
  ).toBeNull();
});
test('failure after first account creation rolls back the whole batch and its idempotency receipt', async () => {
  const f = await memberFixture();
  let creates = 0;
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'user')
                    return {
                      ...transaction.user,
                      create: async (args: Prisma.UserCreateArgs) => {
                        creates++;
                        if (creates === 2) throw new Error('injected batch failure');
                        return transaction.user.create(args);
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const principal = {
    userId: f.owner.id,
    uid: f.owner.uid,
    role: 'EXPERT' as const,
    sessionId: 'test',
    clientType: 'desktop' as const,
  };
  const body = '张三,13712345678,全职\n李四,13712345679,兼职';
  await expect(
    new MemberImportService(failing).generate('rollback', f.orgId, principal, undefined, body),
  ).rejects.toThrow('injected batch failure');
  expect(await db.user.count()).toBe(1);
  expect(await db.userOrgRel.count()).toBe(1);
  expect(await db.memberImportReceipt.count()).toBe(0);
  expect((await importHttp(f.orgId, f.headers, body, 'rollback')).statusCode).toBe(200);
});

test('three roles are immediately available, switch is session local, refresh preserves selected role and OPS is refused', async () => {
  const created = (await register()).json().data;
  const a = (await login(desktop)).json().data,
    b = (await login(desktop)).json().data;
  const headers = bearer(a.accessToken);
  expect(created.roles).toEqual(['NAVIGATOR', 'PM', 'EXPERT']);
  expect((await post('/auth/switch-role', { role: 'NAVIGATOR' }, headers)).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v1/project-categories', headers })).statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/v1/users/me', headers: bearer(b.accessToken) })).json().data
      .selectedRole,
  ).toBe('EXPERT');
  const refreshed = await post('/auth/refresh', { refreshToken: a.refreshToken }, desktop);
  expect(refreshed.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        url: '/api/v1/users/me',
        headers: bearer(refreshed.json().data.accessToken),
      })
    ).json().data.selectedRole,
  ).toBe('NAVIGATOR');
  const denied = await post(
    '/auth/switch-role',
    { role: 'OPS' },
    bearer(refreshed.json().data.accessToken),
  );
  expect(denied.statusCode).toBe(400);
});

test('project category dictionary filters enabled levels and aliases with deterministic sorting', async () => {
  const user = (await register()).json().data;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  await selectFixtureRole({
    uid: user.uid,
    role: 'NAVIGATOR',
    action: 'GRANT',
    actor: 'integration-operator',
    reason: '分类查询验证',
  });
  const base = {
    categoryLevel: 1,
    sortNo: 10,
    createdBy: 'integration-operator',
    updatedBy: 'integration-operator',
  };
  const first = await db.projectCategory.create({
    data: { ...base, categoryCode: 'IMAGE', categoryName: '图片分类', searchKeywords: 'tupian' },
  });
  const second = await db.projectCategory.create({
    data: { ...base, categoryCode: 'TEXT', categoryName: '文本分类' },
  });
  const level2 = await db.projectCategory.create({
    data: { ...base, categoryLevel: 2, categoryCode: 'AUDIO', categoryName: '音频分类' },
  });
  await db.projectCategory.create({
    data: { ...base, categoryCode: 'DISABLED', categoryName: '停用分类', status: 'DISABLED' },
  });
  const get = async (query = '') =>
    (await app.inject({ url: `/api/v1/project-categories${query}`, headers })).json().data;
  expect((await get()).map((row: { id: number }) => row.id)).toEqual([
    first.id,
    second.id,
    level2.id,
  ]);
  expect((await get('?categoryLevel=2')).map((row: { id: number }) => row.id)).toEqual([level2.id]);
  expect(await get('?keyword=%20tupian%20')).toEqual([
    { id: first.id, categoryCode: 'IMAGE', categoryName: '图片分类', categoryLevel: 1, sortNo: 10 },
  ]);
  expect(await get('?keyword=missing')).toEqual([]);
});

test('requester backfill enforces NAVIGATOR, self ownership and actual account type', async () => {
  const user = (await register()).json().data;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const path = `/api/v1/project-requesters/INDIVIDUAL/${user.id}/backfill`;
  expect((await app.inject({ url: path, headers })).statusCode).toBe(403);
  await selectFixtureRole({
    uid: user.uid,
    role: 'NAVIGATOR',
    action: 'GRANT',
    actor: 'integration-operator',
    reason: '本人需求方验证',
  });
  expect((await app.inject({ url: path, headers })).json()).toEqual({
    code: 200,
    message: '操作成功',
    data: {
      requesterType: 'INDIVIDUAL',
      requesterId: user.id,
      requesterName: '小明(小明)',
      orgId: null,
      orgVerifyStatus: null,
    },
  });
  expect(
    (await app.inject({ url: path.replace('INDIVIDUAL', 'ORGANIZATION'), headers })).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        url: '/api/v1/project-requesters/INDIVIDUAL/00000000-0000-4000-8000-000000000099/backfill',
        headers,
      })
    ).statusCode,
  ).toBe(403);
});

test('organization ownership does not change unified requester type', async () => {
  const user = (await register({ organization: { name: '示例需求方团队' } })).json().data;
  const logged = await login(desktop, { role: 'NAVIGATOR' });
  const headers = bearer(logged.json().data.accessToken);
  const personal = await app.inject({
    url: `/api/v1/project-requesters/INDIVIDUAL/${user.id}/backfill`,
    headers,
  });
  expect(personal.json().data).toMatchObject({ requesterType: 'INDIVIDUAL', orgId: null });
  expect(
    (
      await app.inject({
        url: `/api/v1/project-requesters/ORGANIZATION/${user.id}/backfill`,
        headers,
      })
    ).statusCode,
  ).toBe(400);
});

async function projectTestAccount(phoneValue: string) {
  const user = await db.user.create({
    data: {
      phoneE164: `+86${phoneValue}`,
      phoneRegion: 'CN',
      username: `other${phoneValue}`,
      displayName: `其他${phoneValue}`,
    },
  });
  const token = 'p'.repeat(43);
  await db.session.create({
    data: {
      userId: user.id,
      tokenDigest: digest(token),
      clientType: 'desktop',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  return { user, headers: bearer(token) };
}

async function projectCreationFixture() {
  const user = (await register()).json().data;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const categories = [];
  for (const [index, level] of [1, 2, 3, 3].entries())
    categories.push(
      await db.projectCategory.create({
        data: {
          categoryCode: `PROJECT_${index}`,
          categoryName: `项目分类${index}`,
          categoryLevel: level,
          createdBy: 'test-operator',
          updatedBy: 'test-operator',
        },
      }),
    );
  const payload = {
    operation: 'CREATE_PROJECT',
    projectName: '图片分类项目',
    categoryLevel1Id: categories[0]!.id,
    categoryLevel2Id: categories[1]!.id,
    categoryLevel3Ids: [categories[3]!.id, categories[2]!.id],
    difficultyLevel: 'MEDIUM',
    projectQuantity: 10000.1234,
    quantityUnit: '张',
    deadline: '2099-12-31 18:00:00',
    requiredHeadcount: 20,
    employmentType: 'PART_TIME',
    standardContent: '按照商品主体分类',
    mandatoryRequirement: '遵守作业规范',
  };
  const save = (data: unknown) => post('/projects/create', data, headers);
  const draft = () => app.inject({ url: '/api/v1/projects/draft/current', headers });
  return { user, headers, payload, save, draft, categories };
}

test('EXPERT session saves one isolated draft, clears snapshot fields and preserves education default', async () => {
  expect(await db.project.count()).toBe(0);
  const f = await projectCreationFixture();
  expect((await f.draft()).json().data).toEqual({ hasDraft: false, draft: null });
  const first = await f.save({
    ...f.payload,
    operation: 'SAVE_DRAFT',
    educationRequirement: 'MASTER',
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().data).toMatchObject({
    operation: 'SAVE_DRAFT',
    status: 'DRAFT',
    versionNo: 0,
    currentNodeCode: null,
    publishedAt: null,
  });
  const data = (await f.draft()).json().data.draft;
  expect(data.categoryLevel3Ids).toEqual(f.payload.categoryLevel3Ids);
  expect(data.categoryLevel3Names).toEqual(['项目分类3', '项目分类2']);
  expect(data.projectQuantity).toBe(10000.1234);
  expect(data.attachments).toEqual([]);
  expect(data.creatorName).toBeNull();
  expect(data).not.toHaveProperty('productionRequirements');
  const cleared = await f.save({ operation: 'SAVE_DRAFT', versionNo: data.versionNo });
  expect(cleared.json().data.versionNo).toBe(1);
  const after = (await f.draft()).json().data.draft;
  expect(after).toMatchObject({
    projectName: null,
    projectDescription: null,
    educationRequirement: 'BACHELOR',
    deadline: null,
    categoryLevel1Id: null,
    categoryLevel1Name: null,
    categoryLevel3Ids: [],
    categoryLevel3Names: [],
  });
  expect(await db.project.count({ where: { createdBy: f.user.uid, status: 'DRAFT' } })).toBe(1);
  const outsider = await projectTestAccount('13900000009');
  expect(
    (await app.inject({ url: '/api/v1/projects/draft/current', headers: outsider.headers })).json()
      .data,
  ).toEqual({ hasDraft: false, draft: null });
});

test('concurrent draft creation and version updates have exactly one winner', async () => {
  const f = await projectCreationFixture();
  const created = await Promise.all([
    f.save({ operation: 'SAVE_DRAFT', projectName: '草稿一' }),
    f.save({ operation: 'SAVE_DRAFT', projectName: '草稿二' }),
  ]);
  expect(created.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.project.count()).toBe(1);
  const updated = await Promise.all([
    f.save({ operation: 'SAVE_DRAFT', versionNo: 0, projectName: '更新一' }),
    f.save({ operation: 'SAVE_DRAFT', versionNo: 0, projectName: '更新二' }),
  ]);
  expect(updated.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect((await f.draft()).json().data.draft.versionNo).toBe(1);
});

test('publish requires actual old service fields, advances the node and leaves the next draft independent', async () => {
  const f = await projectCreationFixture();
  expect(
    (
      await f.save({
        ...f.payload,
        standardContent: null,
        standardLink: 'https://example.com/standard',
      })
    ).statusCode,
  ).toBe(400);
  expect((await f.save({ ...f.payload, mandatoryRequirement: null })).statusCode).toBe(400);
  const saved = await f.save({ ...f.payload, operation: 'SAVE_DRAFT' });
  const result = await f.save({ ...f.payload, versionNo: saved.json().data.versionNo });
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({
    id: saved.json().data.id,
    status: 'PUBLISHED',
    currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
    versionNo: 1,
  });
  expect(result.json().data.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect((await f.draft()).json().data).toEqual({ hasDraft: false, draft: null });
  const next = await f.save({ operation: 'SAVE_DRAFT' });
  expect(next.statusCode).toBe(200);
  expect(next.json().data.id).not.toBe(result.json().data.id);
  expect(next.json().data.versionNo).toBe(0);
});

test('concurrent publishing prevents duplicate names and a failed publication preserves its prior draft', async () => {
  const f = await projectCreationFixture();
  const results = await Promise.all([f.save(f.payload), f.save(f.payload)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await db.project.count({ where: { status: 'PUBLISHED' } })).toBe(1);
  const saved = await f.save({ operation: 'SAVE_DRAFT', projectName: '原草稿' });
  const conflict = await f.save({ ...f.payload, versionNo: saved.json().data.versionNo });
  expect(conflict.statusCode).toBe(409);
  expect((await f.draft()).json().data.draft).toMatchObject({
    projectName: '原草稿',
    versionNo: 0,
  });
});

test('category level and status validation preserves original snapshots and selection order', async () => {
  const f = await projectCreationFixture();
  expect((await f.save({ ...f.payload, categoryLevel1Id: f.categories[1]!.id })).statusCode).toBe(
    400,
  );
  expect(
    (await f.save({ ...f.payload, categoryLevel3Ids: [f.categories[2]!.id, f.categories[2]!.id] }))
      .statusCode,
  ).toBe(400);
  await db.projectCategory.update({
    where: { id: f.categories[0]!.id },
    data: { status: 'DISABLED' },
  });
  expect((await f.save(f.payload)).statusCode).toBe(400);
  await db.projectCategory.update({
    where: { id: f.categories[0]!.id },
    data: { status: 'ENABLED' },
  });
  expect((await f.save({ ...f.payload, operation: 'SAVE_DRAFT' })).statusCode).toBe(200);
  await db.projectCategory.update({
    where: { id: f.categories[0]!.id },
    data: { categoryName: '改名分类' },
  });
  expect((await f.draft()).json().data.draft.categoryLevel1Name).toBe('项目分类0');
});

test('draft ownership, invalid dates and nonpositive values cannot write projects', async () => {
  const f = await projectCreationFixture();
  const other = await projectTestAccount('13900000009');
  expect((await f.save({ operation: 'SAVE_DRAFT', requesterId: other.user.id })).statusCode).toBe(
    403,
  );
  for (const extra of [
    { requesterType: 'ORGANIZATION' },
    { projectQuantity: 0 },
    { projectQuantity: -1 },
    { requiredHeadcount: 0 },
    { deadline: '2026-02-30 18:00:00' },
    { deadline: '2000-01-01 00:00:00' },
  ])
    expect((await f.save({ operation: 'SAVE_DRAFT', ...extra })).statusCode).toBe(400);
  expect(await db.project.count()).toBe(0);
});

test('project attachment claim, retain, release and creator grant access share actual business relationships', async () => {
  const f = await projectCreationFixture();
  const upload = await uploaded('PROJECT_ATTACHMENT', f.user.uid);
  const attached = await f.save({
    operation: 'SAVE_DRAFT',
    attachments: [
      {
        attachmentType: 'STANDARD_REFERENCE',
        objectKey: upload.record.objectKey,
        uploadToken: upload.uploadToken,
      },
    ],
  });
  expect(attached.statusCode).toBe(200);
  const version = attached.json().data.versionNo;
  const detail = (await f.draft()).json().data.draft;
  expect(detail.attachments).toHaveLength(1);
  expect(detail.attachments[0]).toMatchObject({
    fileName: 'test.png',
    objectKey: upload.record.objectKey,
    fileSize: 10,
    status: 'ACTIVE',
  });
  expect(JSON.stringify(detail)).not.toContain(upload.uploadToken);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).claimedBizId,
  ).toBe(String(detail.id));
  const url = `/api/v1/files/view?objectKey=${encodeURIComponent(upload.record.objectKey)}`;
  // EXPERT上传者身份不替代旧NAVIGATOR创建人授权。
  expect((await app.inject({ url, headers: f.headers })).statusCode).toBe(403);
  const grants = { change: selectFixtureRole };
  const grant = {
    uid: f.user.uid,
    role: 'NAVIGATOR' as const,
    action: 'GRANT' as const,
    actor: 'test-operator',
    reason: '创建人附件权限验证',
  };
  await grants.change(grant);
  expect((await app.inject({ url, headers: f.headers })).statusCode).toBe(200);
  const other = await projectTestAccount('13900000009');
  await grants.change({ ...grant, uid: other.user.uid });
  expect((await app.inject({ url, headers: other.headers })).statusCode).toBe(403);
  await grants.change({ ...grant, action: 'REVOKE' });
  expect((await app.inject({ url, headers: f.headers })).statusCode).toBe(403);
  const keep = await f.save({
    operation: 'SAVE_DRAFT',
    versionNo: version,
    attachments: [{ id: detail.attachments[0].id, sortNo: 2 }],
  });
  expect(keep.statusCode).toBe(200);
  expect((await f.draft()).json().data.draft.attachments[0].sortNo).toBe(2);
  expect(
    (
      await f.save({
        operation: 'SAVE_DRAFT',
        versionNo: keep.json().data.versionNo,
        attachments: [],
      })
    ).statusCode,
  ).toBe(200);
  expect((await f.draft()).json().data.draft.attachments).toEqual([]);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).status,
  ).toBe('RELEASED');
  expect(
    await db.projectAttachment.findUniqueOrThrow({ where: { id: detail.attachments[0].id } }),
  ).toMatchObject({ status: 'DELETED' });
});

test('invalid attachment token rolls back the new project, category snapshots and claim', async () => {
  const f = await projectCreationFixture();
  const upload = await uploaded('PROJECT_ATTACHMENT', f.user.uid);
  const failed = await f.save({
    ...f.payload,
    attachments: [
      { attachmentType: 'CASE', objectKey: upload.record.objectKey, uploadToken: 'wrong-token' },
    ],
  });
  expect(failed.statusCode).toBe(403);
  expect(await db.project.count()).toBe(0);
  expect(await db.projectCategoryRelation.count()).toBe(0);
  expect(await db.projectAttachment.count()).toBe(0);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).status,
  ).toBe('UPLOADED');
});

test('foreign upload ownership, duplicate attachments and invalid retained IDs cannot partially mutate a draft', async () => {
  const f = await projectCreationFixture();
  const upload = await uploaded('PROJECT_ATTACHMENT', 'other-uid');
  expect(
    (
      await f.save({
        operation: 'SAVE_DRAFT',
        attachments: [
          {
            attachmentType: 'CASE',
            objectKey: upload.record.objectKey,
            uploadToken: upload.uploadToken,
          },
        ],
      })
    ).statusCode,
  ).toBe(403);
  await db.uploadedFile.update({ where: { id: upload.record.id }, data: { ownerUid: f.user.uid } });
  const attachment = {
    attachmentType: 'CASE',
    objectKey: upload.record.objectKey,
    uploadToken: upload.uploadToken,
  };
  expect(
    (await f.save({ operation: 'SAVE_DRAFT', attachments: [attachment, attachment] })).statusCode,
  ).toBe(400);
  expect(await db.project.count()).toBe(0);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).status,
  ).toBe('UPLOADED');
  const saved = await f.save({
    operation: 'SAVE_DRAFT',
    projectName: '原草稿',
    attachments: [attachment],
  });
  expect(saved.statusCode).toBe(200);
  const old = (await f.draft()).json().data.draft;
  const failed = await f.save({
    operation: 'SAVE_DRAFT',
    projectName: '新名称',
    versionNo: 0,
    attachments: [{ id: old.attachments[0].id }, { id: 2147483647 }],
  });
  expect(failed.statusCode).toBe(400);
  expect((await f.draft()).json().data.draft).toMatchObject({
    projectName: '原草稿',
    versionNo: 0,
  });
  expect(await db.projectAttachment.count({ where: { status: 'ACTIVE' } })).toBe(1);
});

test('attachment release failure rolls back project version, attachment removal and file release together', async () => {
  const f = await projectCreationFixture();
  const upload = await uploaded('PROJECT_ATTACHMENT', f.user.uid);
  const saved = await f.save({
    operation: 'SAVE_DRAFT',
    projectName: '原草稿',
    attachments: [
      {
        attachmentType: 'CASE',
        objectKey: upload.record.objectKey,
        uploadToken: upload.uploadToken,
      },
    ],
  });
  expect(saved.statusCode).toBe(200);
  class FailingRegistry extends FileRegistryService {
    override async releaseProjectAttachment(
      tx: Prisma.TransactionClient,
      key: string,
      projectId: string,
    ) {
      await super.releaseProjectAttachment(tx, key, projectId);
      throw new Error('injected project release failure');
    }
  }
  const files = new FailingRegistry(db, storage, config.files);
  await expect(
    new ProjectCreationService(db, files).save(
      { operation: 'SAVE_DRAFT', versionNo: 0, projectName: '新名称', attachments: [] },
      {
        userId: f.user.id,
        uid: f.user.uid,
        sessionId: 'test',
        role: 'EXPERT',
        clientType: 'desktop',
      },
    ),
  ).rejects.toThrow('injected project release failure');
  expect((await f.draft()).json().data.draft).toMatchObject({
    projectName: '原草稿',
    versionNo: 0,
  });
  expect(await db.projectAttachment.count({ where: { status: 'ACTIVE' } })).toBe(1);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).status,
  ).toBe('CLAIMED');
});

test('unified account with an organization still saves a personal requester snapshot', async () => {
  const user = (await register({ organization: { name: '项目需求方组织' } })).json().data;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  expect(
    (
      await post(
        '/projects/create',
        { operation: 'SAVE_DRAFT', requesterType: 'ORGANIZATION' },
        headers,
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post(
        '/projects/create',
        { operation: 'SAVE_DRAFT', requesterType: 'INDIVIDUAL', requesterId: user.id },
        headers,
      )
    ).statusCode,
  ).toBe(200);
  const draft = (await app.inject({ url: '/api/v1/projects/draft/current', headers })).json().data
    .draft;
  expect(draft).toMatchObject({
    requesterType: 'INDIVIDUAL',
    requesterId: user.id,
    requesterName: '小明(小明)',
  });
});

test('business identifier migration preserves UUID claims and supports numeric project claim and release without persisting preview DDL', async () => {
  const license = await uploaded('BUSINESS_LICENSE');
  const project = await uploaded('PROJECT_ATTACHMENT', 'test-owner');
  const organizationId = '00000000-0000-4000-8000-000000000002';
  const columnType = () => db.$queryRaw<{ data_type: string }[]>`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UploadedFile' AND column_name = 'claimedBizId'`;
  const before = await columnType();
  const migration = readFileSync(
    new URL(
      '../prisma/migrations/20261019070000_file_business_identifiers/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  // 使用新连接执行DDL预演，避免复用主客户端已缓存的UUID返回类型计划。
  const previewDb = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  try {
    await expect(
      previewDb.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "UploadedFile" SET "claimedBizId" = ${organizationId}::uuid, "claimedBizType" = 'ORGANIZATION_BUSINESS_LICENSE', "status" = 'CLAIMED' WHERE "id" = ${license.record.id}::uuid`;
        await tx.$executeRawUnsafe(migration);
        expect(
          (await tx.uploadedFile.findUniqueOrThrow({ where: { id: license.record.id } }))
            .claimedBizId,
        ).toBe(organizationId);
        await registry.claimForProject(
          tx,
          project.record.objectKey,
          project.uploadToken,
          'test-owner',
          '3001',
        );
        expect(
          (await tx.uploadedFile.findUniqueOrThrow({ where: { id: project.record.id } }))
            .claimedBizId,
        ).toBe('3001');
        expect(
          (await registry.releaseProjectAttachment(tx, project.record.objectKey, '3001')).count,
        ).toBe(1);
        expect(
          (await tx.uploadedFile.findUniqueOrThrow({ where: { id: project.record.id } })).status,
        ).toBe('RELEASED');
        throw new Error('rollback migration preview');
      }),
    ).rejects.toThrow('rollback migration preview');
  } finally {
    await previewDb.$disconnect();
  }
  expect(await columnType()).toEqual(before);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: license.record.id } })).claimedBizId,
  ).toBeNull();
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: project.record.id } })).status,
  ).toBe('UPLOADED');
});

async function projectManagerAccount(
  sequence: number,
  creditScore: number | null = 100,
  grant = true,
) {
  const user = await db.user.create({
    data: {
      phoneE164: `+86137${String(sequence).padStart(8, '0')}`,
      phoneRegion: 'CN',
      username: `manager${sequence}`,
      displayName: `策略官${sequence}`,
      realName: `姓名${sequence}`,
      creditScore,
    },
  });
  const token = `z${String(sequence).padStart(42, '0')}`;
  await db.session.create({
    data: {
      userId: user.id,
      tokenDigest: digest(token),
      clientType: 'desktop',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  if (grant)
    await selectFixtureRole({
      uid: user.uid,
      role: 'PM',
      action: 'GRANT',
      actor: 'integration-operator',
      reason: '策略官集成验证',
    });
  return { user, headers: bearer(token) };
}
async function projectManagerFixture() {
  const f = await projectCreationFixture();
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'GRANT',
    actor: 'integration-operator',
    reason: '项目管理集成验证',
  });
  const published = await f.save(f.payload);
  expect(published.statusCode).toBe(200);
  const projectId: number = published.json().data.id;
  const recruit = (candidateUserId: string) =>
    post('/projects/manager-recruitments', { projectId, candidateUserId }, f.headers);
  const candidates = (keyword = '') =>
    app.inject({
      url: `/api/v1/projects/manager-candidates?projectId=${projectId}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`,
      headers: f.headers,
    });
  return { ...f, projectId, recruit, candidates };
}

test('manager candidate order uses real assigned load then credit and includes ACTIVE accounts regardless of grants', async () => {
  const f = await projectManagerFixture();
  const low = await projectManagerAccount(1, 50),
    high = await projectManagerAccount(2, 90),
    unknown = await projectManagerAccount(3, null);
  const legacy = await projectManagerAccount(4, 100, false);
  await db.user.update({ where: { id: legacy.user.id }, data: { role: 'PM' } });
  expect(
    (await f.candidates())
      .json()
      .data.filter((r: { userId: string }) => r.userId !== f.user.id)
      .map((r: { userId: string }) => r.userId),
  ).toEqual([legacy.user.id, high.user.id, low.user.id, unknown.user.id]);
  expect((await f.recruit(low.user.id)).statusCode).toBe(200);
  const nextProject = await f.save({ ...f.payload, projectName: '另一个项目' });
  expect(nextProject.statusCode).toBe(200);
  expect(
    (
      await post(
        '/projects/manager-recruitments',
        { projectId: nextProject.json().data.id, candidateUserId: high.user.id },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  const rows = (await f.candidates())
    .json()
    .data.filter((r: { userId: string }) => r.userId !== f.user.id);
  expect(rows.map((r: { userId: string }) => r.userId)).toEqual([
    low.user.id,
    legacy.user.id,
    unknown.user.id,
    high.user.id,
  ]);
  expect(rows[0]).toMatchObject({
    status: 'CURRENT',
    currentProjectCount: 1,
    name: '策略官1(姓名1)',
  });
  expect(rows[3].currentProjectCount).toBe(1);
  expect(
    (await f.candidates('策略官2')).json().data.map((r: { userId: string }) => r.userId),
  ).toEqual([high.user.id]);
  expect((await f.candidates('no-match')).json().data).toEqual([]);
  expect(JSON.stringify(rows)).not.toContain('creditScore');
});

test('manager candidates and recruit enforce current NAVIGATOR session plus own published project', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  const outsider = await projectTestAccount('13900000009');
  await selectFixtureRole({
    uid: outsider.user.uid,
    role: 'NAVIGATOR',
    action: 'GRANT',
    actor: 'integration-operator',
    reason: '跨项目拒绝验证',
  });
  expect(
    (
      await post(
        '/projects/manager-recruitments',
        { projectId: f.projectId, candidateUserId: manager.user.id },
        outsider.headers,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `/api/v1/projects/manager-candidates?projectId=${f.projectId}`,
        headers: outsider.headers,
      })
    ).statusCode,
  ).toBe(403);
  const draft = await f.save({ operation: 'SAVE_DRAFT' });
  expect(
    (
      await post(
        '/projects/manager-recruitments',
        { projectId: draft.json().data.id, candidateUserId: manager.user.id },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '撤销管理授权',
  });
  expect((await f.candidates()).statusCode).toBe(403);
  expect((await f.recruit(manager.user.id)).statusCode).toBe(403);
  expect(await db.projectManagerRecruitment.count()).toBe(0);
  expect(await db.projectEventOutbox.count()).toBe(0);
});

test('initial manager assignment advances only the node and commits task rounds and pending event facts', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const result = await f.recruit(manager.user.id);
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({
    projectId: f.projectId,
    recruitmentType: 'INITIAL',
    status: 'ASSIGNED',
    assignmentMode: 'DIRECT',
    currentNodeCode: 'PRODUCTION_PLAN',
    primaryAction: 'CHANGE_PROJECT_MANAGER',
    manager: { userId: manager.user.id, status: 'CURRENT', currentProjectCount: 1 },
  });
  const after = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect(after).toMatchObject({
    projectName: before.projectName,
    standardContent: before.standardContent,
    requiredHeadcount: before.requiredHeadcount,
    versionNo: before.versionNo,
    currentNodeCode: 'PRODUCTION_PLAN',
  });
  expect(after.projectQuantity?.toString()).toBe(before.projectQuantity?.toString());
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId },
      select: { userId: true, role: true, taskType: true, status: true, participated: true },
    }),
  ).toEqual(
    expect.arrayContaining([
      {
        userId: f.user.id,
        role: 'NAVIGATOR',
        taskType: 'MAIN_RECRUIT_PROJECT_MANAGER',
        status: 'COMPLETED',
        participated: true,
      },
      {
        userId: manager.user.id,
        role: 'PM',
        taskType: 'MAIN_PRODUCTION_PLAN',
        status: 'OPEN',
        participated: false,
      },
    ]),
  );
  const event = await db.projectEventOutbox.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(event).toMatchObject({
    eventType: 'PROJECT_TASKS_RECONCILED',
    operation: 'project.manager.recruit',
    actorUserId: f.user.id,
    status: 'PENDING',
    attempts: 0,
    deliveredAt: null,
  });
  expect(event.payload).toMatchObject({
    schemaVersion: 1,
    projectId: f.projectId,
    actorUserId: f.user.id,
    projectAudience: expect.arrayContaining([
      { userId: manager.user.id, role: 'PM' },
      { userId: f.user.id, role: 'NAVIGATOR' },
    ]),
  });
});

test('manager replacement preserves later nodes and cancels lost tasks instead of completing the old manager work', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    second = await projectManagerAccount(2);
  expect((await f.recruit(first.user.id)).statusCode).toBe(200);
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'ENTRANCE_EXAM' },
  });
  const result = await f.recruit(second.user.id);
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({
    recruitmentType: 'REPLACEMENT',
    currentNodeCode: 'ENTRANCE_EXAM',
    nextStage: 'ENTRANCE_EXAM',
    manager: { userId: second.user.id },
  });
  expect(
    await db.projectManagerRecruitment.findFirstOrThrow({
      where: { candidateUserId: first.user.id },
    }),
  ).toMatchObject({ status: 'REPLACED', replacedAt: expect.any(Date) });
  expect(
    await db.projectManagerRecruitment.findFirstOrThrow({ where: { status: 'ASSIGNED' } }),
  ).toMatchObject({ candidateUserId: second.user.id, previousManagerUserId: first.user.id });
  expect(
    await db.projectTaskRound.count({ where: { userId: first.user.id, status: 'OPEN' } }),
  ).toBe(0);
  expect(
    await db.projectTaskRound.count({ where: { userId: first.user.id, status: 'COMPLETED' } }),
  ).toBe(0);
  expect(
    await db.projectTaskRound.count({
      where: { userId: second.user.id, taskType: 'MAIN_ENTRANCE_EXAM', status: 'OPEN' },
    }),
  ).toBe(1);
  const events = await db.projectEventOutbox.findMany({ orderBy: { createdAt: 'asc' } });
  expect(events.at(-1)!.payload).toMatchObject({
    projectAudience: expect.arrayContaining([
      { userId: first.user.id, role: 'PM' },
      { userId: second.user.id, role: 'PM' },
    ]),
    taskChangedRecipients: expect.arrayContaining([
      { userId: first.user.id, role: 'PM' },
      { userId: second.user.id, role: 'PM' },
    ]),
  });
});

test('reselecting the same manager is rejected, distinct concurrent candidates serialize and keep one assigned manager', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    second = await projectManagerAccount(2);
  const parallel = await Promise.all([f.recruit(first.user.id), f.recruit(first.user.id)]);
  expect(parallel.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.projectManagerRecruitment.count()).toBe(1);
  const replacement = await Promise.all([f.recruit(second.user.id), f.recruit(first.user.id)]);
  expect(replacement.every((r) => [200, 400].includes(r.statusCode))).toBe(true);
  expect(
    await db.projectManagerRecruitment.count({
      where: { projectId: f.projectId, status: 'ASSIGNED' },
    }),
  ).toBe(1);
  const assigned = await db.projectManagerRecruitment.findFirstOrThrow({
    where: { projectId: f.projectId, status: 'ASSIGNED' },
  });
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId, role: 'PM', status: 'OPEN' },
      select: { userId: true },
    }),
  ).toEqual([{ userId: assigned.candidateUserId }]);
});

test('disabled recommended manager is rejected but current manager remains visible under old query semantics', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    second = await projectManagerAccount(2);
  expect((await f.recruit(first.user.id)).statusCode).toBe(200);
  await db.user.update({ where: { id: first.user.id }, data: { status: 'FROZEN' } });
  expect((await f.candidates()).json().data[0]).toMatchObject({
    userId: first.user.id,
    status: 'CURRENT',
  });
  await selectFixtureRole({
    uid: second.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '候选切换角色不撤销资格',
  });
  await db.user.update({ where: { id: second.user.id }, data: { status: 'FROZEN' } });
  expect((await f.recruit(second.user.id)).statusCode).toBe(400);
  expect(await db.projectManagerRecruitment.count()).toBe(1);
});

test('first manager assignment with a later node rolls back the new relation and never moves backwards', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'STANDARD_TRAINING' },
  });
  expect((await f.recruit(manager.user.id)).statusCode).toBe(409);
  expect(await db.projectManagerRecruitment.count()).toBe(0);
  expect(await db.projectTaskRound.count()).toBe(0);
  expect(await db.projectEventOutbox.count()).toBe(0);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'STANDARD_TRAINING',
  );
});

test('pending event write failure rolls back manager assignment, project node, task rounds and the event itself', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'projectEventOutbox')
                    return {
                      ...transaction.projectEventOutbox,
                      create: async (args: Prisma.ProjectEventOutboxCreateArgs) => {
                        await transaction.projectEventOutbox.create(args);
                        throw new Error('injected manager event failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new ProjectManagerService(failing).recruit(
      { projectId: f.projectId, candidateUserId: manager.user.id },
      await new AuthService(db, config).authenticate(
        f.headers.authorization!.replace(/^Bearer /, ''),
        'desktop',
      ),
    ),
  ).rejects.toThrow('injected manager event failure');
  expect(await db.projectManagerRecruitment.count()).toBe(0);
  expect(await db.projectTaskRound.count()).toBe(0);
  expect(await db.projectEventOutbox.count()).toBe(0);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'RECRUIT_PROJECT_MANAGER',
  );
});

test('manager replacement leaves uncaptured branch rounds untouched and never reports an event as delivered', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    second = await projectManagerAccount(2);
  expect((await f.recruit(first.user.id)).statusCode).toBe(200);
  const branch = await db.projectTaskRound.create({
    data: {
      projectId: f.projectId,
      userId: first.user.id,
      role: 'PM',
      taskType: 'SUBTASK_ACCEPTANCE',
      status: 'OPEN',
    },
  });
  expect((await f.recruit(second.user.id)).statusCode).toBe(200);
  expect((await db.projectTaskRound.findUniqueOrThrow({ where: { id: branch.id } })).status).toBe(
    'OPEN',
  );
  expect(await db.projectEventOutbox.count({ where: { status: 'DELIVERED' } })).toBe(0);
});

test('project attachment PM and handler access follows current assigned relationship and current session roles', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    second = await projectManagerAccount(2),
    handler = await projectManagerAccount(3);
  const upload = await uploaded('PROJECT_ATTACHMENT', f.user.uid);
  // 第三方材料编辑入口不在本批，测试通过既有草稿/发布事务准备真实附件。
  const next = await f.save({
    ...f.payload,
    projectName: '含附件项目',
    attachments: [
      {
        attachmentType: 'CASE',
        objectKey: upload.record.objectKey,
        uploadToken: upload.uploadToken,
      },
    ],
  });
  expect(next.statusCode).toBe(200);
  const projectId = next.json().data.id;
  const assign = (candidateUserId: string) =>
    post('/projects/manager-recruitments', { projectId, candidateUserId }, f.headers);
  expect((await assign(first.user.id)).statusCode).toBe(200);
  const url = `/api/v1/files/view?objectKey=${encodeURIComponent(upload.record.objectKey)}`;
  expect((await app.inject({ url, headers: first.headers })).statusCode).toBe(200);
  expect((await app.inject({ url, headers: second.headers })).statusCode).toBe(403);
  await db.projectManagerRecruitment.updateMany({
    where: { projectId, status: 'ASSIGNED' },
    data: { expertRecruitmentHandlerUserId: handler.user.id },
  });
  expect((await app.inject({ url, headers: handler.headers })).statusCode).toBe(200);
  expect((await assign(second.user.id)).statusCode).toBe(200);
  expect((await app.inject({ url, headers: first.headers })).statusCode).toBe(403);
  expect((await app.inject({ url, headers: handler.headers })).statusCode).toBe(403);
  expect((await app.inject({ url, headers: second.headers })).statusCode).toBe(200);
  await selectFixtureRole({
    uid: second.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '读取权限撤销',
  });
  expect((await app.inject({ url, headers: second.headers })).statusCode).toBe(403);
});

async function productionPlanFixture() {
  const f = await projectManagerFixture();
  const manager = await projectManagerAccount(1),
    handler = await projectManagerAccount(2);
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  await db.projectManagerRecruitment.updateMany({
    where: { projectId: f.projectId, status: 'ASSIGNED' },
    data: { expertRecruitmentHandlerUserId: handler.user.id },
  });
  const query = (headers = manager.headers) =>
    app.inject({ url: `/api/v1/projects/production-plan?projectId=${f.projectId}`, headers });
  const confirm = (payload: unknown = productionPlanExample, headers = manager.headers) =>
    post(`/projects/production-plan/confirm?projectId=${f.projectId}`, payload, headers);
  return { ...f, manager, handler, query, confirm };
}
test('production plan initial defaults, primary editability, handler read-only and live project references', async () => {
  const f = await productionPlanFixture();
  const initial = await f.query();
  expect(initial.statusCode).toBe(200);
  expect(initial.json().data).toMatchObject({
    hasPlan: false,
    editable: true,
    id: null,
    operatorCpd: null,
    needWrittenExam: true,
    maxActiveExamCount: 1,
    needInterview: false,
    crowds: [{ id: null, sequenceNo: 1, crowdName: null, profileRequirement: null }],
    stages: [
      { sequenceNo: 1, stageName: '爬坡期', workdayCountSource: 'AUTO' },
      { sequenceNo: 2, stageName: '稳定生产期', workdayCountSource: 'AUTO' },
    ],
  });
  expect((await f.query(f.handler.headers)).json().data.editable).toBe(false);
  await db.project.update({ where: { id: f.projectId }, data: { workSummary: '实时新内容' } });
  expect((await f.query()).json().data.projectReference.workSummary).toBe('实时新内容');
  expect(await db.projectProductionPlan.count()).toBe(0);
});
test('production plan confirmation persists ordered details, decimal output and completed main round atomically without a realtime event', async () => {
  const f = await productionPlanFixture();
  const previous = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const events = await db.projectEventOutbox.count();
  const body = {
    ...productionPlanExample,
    operatorCpd: 0.1,
    stages: [
      { stageName: ' 自动 ', startDate: '2099-01-05', endDate: '2099-01-11', operatorHeadcount: 3 },
      {
        stageName: ' 手工 ',
        startDate: '2099-01-05',
        endDate: '2099-01-05',
        operatorHeadcount: 2,
        operatorCpd: 0.2,
        workdayCountSource: 'MANUAL',
        workdayCount: 10,
      },
    ],
  };
  const result = await f.confirm(body);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({
    hasPlan: true,
    editable: false,
    operatorCpd: 0.1,
    totalExpectedOutput: 5.5,
    currentNodeCode: 'ENTRANCE_EXAM',
    nextStage: 'ENTRANCE_EXAM',
    confirmedBy: f.manager.user.uid,
    stages: [
      {
        sequenceNo: 1,
        stageName: '自动',
        naturalDayCount: 7,
        workdayCount: 5,
        operatorCpd: 0.1,
        expectedOutput: 1.5,
      },
      { sequenceNo: 2, stageName: '手工', naturalDayCount: 1, workdayCount: 10, expectedOutput: 4 },
    ],
  });
  const plan = await db.projectProductionPlan.findUniqueOrThrow({
    where: { projectId: f.projectId },
    include: { stages: true, crowds: true },
  });
  expect(plan.totalExpectedOutput.toString()).toBe('5.5');
  expect(plan.crowds).toHaveLength(1);
  expect(plan.stages).toHaveLength(2);
  expect(
    await db.projectTaskRound.findFirst({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'MAIN_PRODUCTION_PLAN',
        status: 'COMPLETED',
      },
    }),
  ).toMatchObject({ participated: true });
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'MAIN_ENTRANCE_EXAM', status: 'OPEN' },
    }),
  ).toBe(1);
  expect(await db.projectEventOutbox.count()).toBe(events);
  const after = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect(after.projectName).toBe(previous.projectName);
  expect(after.versionNo).toBe(previous.versionNo);
  expect(after.mandatoryRequirement).toBe(previous.mandatoryRequirement);
  expect((await f.query()).json().data).toEqual(result.json().data);
  expect((await f.confirm()).statusCode).toBe(400);
});
test('production plan enforces current PM session role and current primary relationship on every call', async () => {
  const f = await productionPlanFixture();
  const other = await projectManagerAccount(3);
  for (const headers of [f.headers, other.headers]) {
    expect((await f.query(headers)).statusCode).toBe(403);
    expect((await f.confirm(productionPlanExample, headers)).statusCode).toBe(403);
  }
  expect((await f.confirm(productionPlanExample, f.handler.headers)).statusCode).toBe(403);
  await selectFixtureRole({
    uid: f.manager.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '撤销验证',
  });
  expect((await f.query()).statusCode).toBe(403);
  expect((await f.confirm()).statusCode).toBe(403);
  expect(await db.projectProductionPlan.count()).toBe(0);
});
test('production plan rejects invalid numbers, incomplete crowds, dates and supplied output without persisting partial data', async () => {
  const f = await productionPlanFixture();
  for (const patch of [
    { inspectorCpd: null },
    { operatorCpd: 0.00001 },
    { crowds: [] },
    { crowds: [null] },
    { crowds: [{ crowdName: ' ', profileRequirement: '要求' }] },
    { stages: [null] },
    { stages: [{ ...productionPlanExample.stages[0], startDate: '2099-02-30' }] },
    { stages: [{ ...productionPlanExample.stages[0], startDate: '2020-01-01' }] },
    {
      stages: [
        { ...productionPlanExample.stages[0], workdayCountSource: 'MANUAL', workdayCount: null },
      ],
    },
    { stages: [{ ...productionPlanExample.stages[0], accuracyRate: 101 }] },
    { totalExpectedOutput: 1 },
  ]) {
    const result = await f.confirm({ ...productionPlanExample, ...patch });
    expect(result.statusCode, result.body).toBe(400);
    expect(await db.projectProductionPlan.count()).toBe(0);
    expect(await db.projectProductionCrowd.count()).toBe(0);
    expect(await db.projectProductionStage.count()).toBe(0);
  }
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'PRODUCTION_PLAN',
  );
});
test('concurrent production plan confirmations have one winner and never overwrite confirmed data', async () => {
  const f = await productionPlanFixture();
  const results = await Promise.all([
    f.confirm(),
    f.confirm({ ...productionPlanExample, operatorHeadcount: 99 }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.projectProductionPlan.count()).toBe(1);
  expect(await db.projectProductionStage.count()).toBe(1);
  expect((await f.query()).json().data.operatorHeadcount).toBe(
    results.find((r) => r.statusCode === 200)!.json().data.operatorHeadcount,
  );
});
test('late production plan backfill preserves later project node and records source-less completion, while no-written plan advances to training', async () => {
  const f = await productionPlanFixture();
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'PRODUCTION_TASK' },
  });
  const result = await f.confirm({ ...productionPlanExample, needWrittenExam: false });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({
    currentNodeCode: 'PRODUCTION_TASK',
    nextStage: 'STANDARD_TRAINING',
  });
  expect(
    await db.projectTaskRound.findFirst({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'MAIN_PRODUCTION_PLAN',
        status: 'COMPLETED',
      },
    }),
  ).toMatchObject({ participated: true });
  const second = await f.save({ ...f.payload, projectName: '免笔试项目' });
  const projectId = second.json().data.id;
  expect(
    (
      await post(
        '/projects/manager-recruitments',
        { projectId, candidateUserId: f.manager.user.id },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  const response = await post(
    `/projects/production-plan/confirm?projectId=${projectId}`,
    { ...productionPlanExample, needWrittenExam: false },
    f.manager.headers,
  );
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.currentNodeCode).toBe('STANDARD_TRAINING');
});
test('task round failure after nested plan writes rolls back plan, crowds, stages and project node together', async () => {
  const f = await productionPlanFixture();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'projectTaskRound')
                    return {
                      ...transaction.projectTaskRound,
                      update: async (args: Prisma.ProjectTaskRoundUpdateArgs) => {
                        await transaction.projectTaskRound.update(args);
                        throw new Error('injected plan round failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new ProjectProductionPlanService(failing).confirm(
      f.projectId,
      productionPlanExample as ProductionPlanInput,
      await new AuthService(db, config).authenticate(
        f.manager.headers.authorization!.replace(/^Bearer /, ''),
        'desktop',
      ),
    ),
  ).rejects.toThrow('injected plan round failure');
  expect(await db.projectProductionPlan.count()).toBe(0);
  expect(await db.projectProductionCrowd.count()).toBe(0);
  expect(await db.projectProductionStage.count()).toBe(0);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'PRODUCTION_PLAN',
  );
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'MAIN_PRODUCTION_PLAN', status: 'OPEN' },
    }),
  ).toBe(1);
});
test('production plan access follows manager replacement and rejects missing, draft and deleted projects', async () => {
  const f = await productionPlanFixture();
  const replacement = await projectManagerAccount(3);
  expect((await f.recruit(replacement.user.id)).statusCode).toBe(200);
  expect((await f.query()).statusCode).toBe(403);
  expect((await f.query(f.handler.headers)).statusCode).toBe(403);
  expect((await f.query(replacement.headers)).statusCode).toBe(200);
  await db.project.update({ where: { id: f.projectId }, data: { status: 'DRAFT' } });
  expect((await f.query(replacement.headers)).statusCode).toBe(404);
  expect((await f.confirm(productionPlanExample, replacement.headers)).statusCode).toBe(400);
  await db.project.update({ where: { id: f.projectId }, data: { deleted: true } });
  expect((await f.query(replacement.headers)).statusCode).toBe(404);
  expect((await f.confirm(productionPlanExample, replacement.headers)).statusCode).toBe(404);
  expect(
    (
      await app.inject({
        url: '/api/v1/projects/production-plan?projectId=2147483647',
        headers: replacement.headers,
      })
    ).statusCode,
  ).toBe(404);
});

const projectDetailHttp = (projectId: number, headers: Record<string, string>) =>
  app.inject({ url: `/api/v1/projects/${projectId}`, headers });
test('published detail preserves category snapshots and live personal names while management responses omit production requirements', async () => {
  const f = await projectManagerFixture();
  await db.user.update({
    where: { id: f.user.id },
    data: { displayName: '新昵称', realName: '新姓名' },
  });
  await db.projectCategory.update({
    where: { id: f.categories[0]!.id },
    data: { categoryName: '字典新名' },
  });
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const result = await projectDetailHttp(f.projectId, f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({
    id: f.projectId,
    status: 'PUBLISHED',
    requesterName: '新昵称(新姓名)',
    creatorName: '新昵称(新姓名)',
    categoryLevel1Name: '项目分类0',
    currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  });
  expect(result.json().data).not.toHaveProperty('productionRequirements');
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(before);
  expect(await db.projectTaskRound.count()).toBe(0);
  expect(await db.projectEventOutbox.count()).toBe(0);
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '撤销详情权限',
  });
  expect((await projectDetailHttp(f.projectId, f.headers)).statusCode).toBe(403);
});
test('project detail PM and handler access follows current session role, active assignment and replacement', async () => {
  const f = await productionPlanFixture();
  for (const headers of [f.manager.headers, f.handler.headers]) {
    const response = await projectDetailHttp(f.projectId, headers);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).not.toHaveProperty('productionRequirements');
  }
  const other = await projectManagerAccount(3);
  expect((await projectDetailHttp(f.projectId, other.headers)).statusCode).toBe(403);
  expect((await f.recruit(other.user.id)).statusCode).toBe(200);
  expect((await projectDetailHttp(f.projectId, f.manager.headers)).statusCode).toBe(403);
  expect((await projectDetailHttp(f.projectId, f.handler.headers)).statusCode).toBe(403);
  expect((await projectDetailHttp(f.projectId, other.headers)).statusCode).toBe(200);
  await selectFixtureRole({
    uid: other.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '撤销详情PM',
  });
  expect((await projectDetailHttp(f.projectId, other.headers)).statusCode).toBe(403);
});
test('only real ACTIVE MEMBER grants expert project detail access, never organization membership or other project roles and statuses', async () => {
  const f = await projectManagerFixture();
  const expert = await projectManagerAccount(1, 100, false);
  expect((await projectDetailHttp(f.projectId, expert.headers)).statusCode).toBe(403);
  const member = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: expert.user.id,
      projectRole: 'MEMBER',
      status: 'PENDING_CONFIRM',
      createdBy: f.user.uid,
    },
  });
  for (const status of [
    'PENDING_CONFIRM',
    'PENDING_ENTRY',
    'ENTRY_DECLINED',
    'PENDING_EXIT',
    'PENDING_TRANSFER',
    'LEFT',
    'REMOVED',
  ]) {
    await db.projectMember.update({ where: { id: member.id }, data: { status } });
    expect((await projectDetailHttp(f.projectId, expert.headers)).statusCode).toBe(403);
  }
  await db.projectMember.update({
    where: { id: member.id },
    data: { status: 'ACTIVE', projectRole: 'PROJECT_MANAGER' },
  });
  expect((await projectDetailHttp(f.projectId, expert.headers)).statusCode).toBe(403);
  await db.projectMember.update({ where: { id: member.id }, data: { projectRole: 'MEMBER' } });
  const result = await projectDetailHttp(f.projectId, expert.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.productionRequirements).toEqual({
    hasPlan: false,
    planId: null,
    operatorHeadcount: null,
    operatorCpd: null,
    inspectorHeadcount: null,
    inspectorCpd: null,
    totalExpectedOutput: null,
    crowds: null,
    stages: [],
  });
  expect(
    (
      await app.inject({
        url: `/api/v1/projects/production-plan?projectId=${f.projectId}`,
        headers: expert.headers,
      })
    ).statusCode,
  ).toBe(403);
});
test('expert project details return confirmed totals and ordered stages without administrative fields or assignment-detail crowds', async () => {
  const f = await productionPlanFixture();
  expect((await f.confirm()).statusCode).toBe(200);
  const expert = await projectManagerAccount(3, 100, false);
  await db.projectMember.create({
    data: { projectId: f.projectId, userId: expert.user.id, createdBy: f.user.uid },
  });
  const result = await projectDetailHttp(f.projectId, expert.headers);
  expect(result.statusCode, result.body).toBe(200);
  const requirements = result.json().data.productionRequirements;
  expect(requirements).toMatchObject({
    hasPlan: true,
    operatorHeadcount: 20,
    operatorCpd: 500.25,
    totalExpectedOutput: 50025,
    crowds: null,
    stages: [
      {
        sequenceNo: 1,
        operatorCpd: 500.25,
        expectedOutput: 50025,
        startDate: '2099-01-05',
        endDate: '2099-01-09',
      },
    ],
  });
  for (const key of [
    'extJson',
    'confirmedBy',
    'confirmedAt',
    'needWrittenExam',
    'needInterview',
    'maxActiveExamCount',
  ])
    expect(requirements).not.toHaveProperty(key);
  expect((await projectDetailHttp(f.projectId, f.headers)).json().data).not.toHaveProperty(
    'productionRequirements',
  );
});
test('detail uses management scope first for a NAVIGATOR user with active membership, then switches to expert scope after role change', async () => {
  const f = await projectManagerFixture();
  await db.projectMember.create({
    data: { projectId: f.projectId, userId: f.user.id, createdBy: f.user.uid },
  });
  expect((await projectDetailHttp(f.projectId, f.headers)).json().data).not.toHaveProperty(
    'productionRequirements',
  );
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '管理与成员范围验证',
  });
  const result = await projectDetailHttp(f.projectId, f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toHaveProperty('productionRequirements');
});
test('published detail rejects missing, draft and deleted projects and validates path IDs with existing transport isolation', async () => {
  const f = await projectCreationFixture();
  const draft = await f.save({ operation: 'SAVE_DRAFT' });
  const id = draft.json().data.id;
  expect((await projectDetailHttp(id, f.headers)).statusCode).toBe(404);
  expect((await projectDetailHttp(2147483647, f.headers)).statusCode).toBe(404);
  const published = await f.save({ ...f.payload, versionNo: 0 });
  expect(published.statusCode).toBe(200);
  await db.project.update({ where: { id }, data: { deleted: true } });
  expect((await projectDetailHttp(id, f.headers)).statusCode).toBe(404);
  for (const value of ['0', '-1', '1.5', '2147483648', 'abc'])
    expect(
      (await app.inject({ url: `/api/v1/projects/${value}`, headers: f.headers })).statusCode,
    ).toBe(400);
  expect((await app.inject({ url: `/api/v1/projects/${id}` })).statusCode).toBe(401);
});
test('expert project attachments require real acceptance and admission while ACTIVE project membership alone never grants access', async () => {
  const f = await projectCreationFixture();
  const expert = await projectManagerAccount(1, 100, false);
  const upload = await uploaded('PROJECT_ATTACHMENT', f.user.uid);
  const published = await f.save({
    ...f.payload,
    attachments: [
      {
        attachmentType: 'STANDARD_REFERENCE',
        objectKey: upload.record.objectKey,
        uploadToken: upload.uploadToken,
      },
    ],
  });
  expect(published.statusCode, published.body).toBe(200);
  const projectId = published.json().data.id;
  await db.projectMember.create({
    data: { projectId, userId: expert.user.id, createdBy: f.user.uid },
  });
  const detail = await projectDetailHttp(projectId, expert.headers);
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json().data.attachments).toHaveLength(1);
  const file = await app.inject({
    url: `/api/v1/files/view?objectKey=${encodeURIComponent(upload.record.objectKey)}`,
    headers: expert.headers,
  });
  expect(file.statusCode).toBe(403);
  const getFile = () =>
    app.inject({
      url: `/api/v1/files/view?objectKey=${encodeURIComponent(upload.record.objectKey)}`,
      headers: expert.headers,
    });
  await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'ATTACHMENT-ACCEPTED',
      projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: expert.user.id,
      status: 'ACCEPTED',
      createdBy: f.user.uid,
    },
  });
  expect((await getFile()).statusCode).toBe(200); // 无计划免试，已接单即可读。
  await db.projectProductionPlan.create({
    data: {
      projectId,
      operatorHeadcount: 1,
      operatorCpd: 1,
      totalExpectedOutput: 1,
      needWrittenExam: true,
      confirmedBy: f.user.uid,
      confirmedAt: new Date(),
      createdBy: f.user.uid,
      updatedBy: f.user.uid,
    },
  });
  expect((await getFile()).statusCode).toBe(403);
  const exam = await db.projectEntranceExam.create({
    data: { examNo: 'FILE-EXAM', projectId, examName: '附件准入', createdBy: f.user.uid },
  });
  await db.entranceExamAttempt.create({
    data: {
      attemptNo: 'FILE-ATTEMPT',
      examId: exam.id,
      candidateUserId: expert.user.id,
      candidateUid: expert.user.uid,
      candidateName: expert.user.displayName,
      finalResult: 'ADMITTED',
      createdBy: f.user.uid,
    },
  });
  expect((await getFile()).statusCode).toBe(200);
  await db.projectEntranceExam.update({ where: { id: exam.id }, data: { deleted: true } });
  expect((await getFile()).statusCode).toBe(403);
});
test('member foundations preserve history and source idempotency without creating memberships from an authenticated detail query', async () => {
  const f = await projectManagerFixture();
  const expert = await projectManagerAccount(1, 100, false);
  const exam = await db.projectEntranceExam.create({
    data: {
      examNo: 'MEMBER-SOURCE-EXAM',
      projectId: f.projectId,
      examName: '来源考试',
      createdBy: f.user.uid,
    },
  });
  const attempt = await db.entranceExamAttempt.create({
    data: {
      attemptNo: 'MEMBER-SOURCE-ATTEMPT',
      examId: exam.id,
      candidateUserId: expert.user.id,
      candidateUid: expert.user.uid,
      candidateName: expert.user.displayName,
      createdBy: f.user.uid,
    },
  });
  const original = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: expert.user.id,
      admissionAttemptId: attempt.id,
      status: 'LEFT',
      createdBy: f.user.uid,
    },
  });
  const another = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: expert.user.id,
      status: 'ACTIVE',
      createdBy: f.user.uid,
    },
  });
  expect(original.id).not.toBe(another.id);
  await expect(
    db.projectMember.create({
      data: {
        projectId: f.projectId,
        userId: expert.user.id,
        admissionAttemptId: attempt.id,
        createdBy: f.user.uid,
      },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
  const count = await db.projectMember.count();
  const result = await projectDetailHttp(f.projectId, expert.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(await db.projectMember.count()).toBe(count);
  expect((await db.user.findUniqueOrThrow({ where: { id: expert.user.id } })).role).toBe('EXPERT');
});

async function memberCountProject(
  owner: { id: string; uid: string },
  projectNo: string,
  status = 'PUBLISHED',
  deleted = false,
) {
  return db.project.create({
    data: {
      projectNo,
      requesterType: 'ORGANIZATION',
      requesterId: owner.id,
      requesterName: '统计组织快照',
      createdBy: owner.uid,
      updatedBy: owner.uid,
      status,
      deleted,
    },
  });
}
test('organization project counts use exact membership relations, ACTIVE row counts and legacy project/role inclusion', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const first = await memberCountProject(f.owner, 'COUNT_A'),
    second = await memberCountProject(f.owner, 'COUNT_B', 'DRAFT', true);
  const data = {
    projectId: first.id,
    userId: member.user.id,
    userOrgRelId: member.rel.id,
    organizationId: f.orgId,
    createdBy: f.owner.uid,
  };
  await db.projectMember.createMany({
    data: [
      data,
      { ...data, projectRole: 'PROJECT_MANAGER' },
      { ...data, projectId: second.id },
      ...[
        'PENDING_CONFIRM',
        'PENDING_ENTRY',
        'ENTRY_DECLINED',
        'PENDING_EXIT',
        'PENDING_TRANSFER',
        'LEFT',
        'REMOVED',
      ].map((status) => ({ ...data, status })),
    ],
  });
  const foreignOrg = await db.organization.create({
    data: { name: '统计其他组织', expertiseTags: [] },
  });
  const foreign = await db.userOrgRel.create({
    data: { orgId: foreignOrg.id, userId: member.user.id, uid: member.user.uid },
  });
  await db.projectMember.createMany({
    data: [
      { ...data, userOrgRelId: foreign.id, organizationId: foreignOrg.id },
      { ...data, userOrgRelId: null, organizationId: null },
    ],
  });
  const response = await post('/organizations/members', { orgId: f.orgId }, f.headers);
  expect(response.statusCode, response.body).toBe(200);
  expect(
    response.json().data.records.find((r: { memberId: string }) => r.memberId === member.rel.id),
  ).toMatchObject({ activeProjectCount: 3 });
  expect(
    response.json().data.records.find((r: { memberId: string }) => r.memberId === f.ownerRel.id),
  ).toMatchObject({ activeProjectCount: 0 });
  const filtered = await post(
    '/organizations/members',
    { orgId: f.orgId, projectId: first.id },
    f.headers,
  );
  expect(filtered.statusCode, filtered.body).toBe(200);
  expect(filtered.json().data).toMatchObject({
    total: 1,
    pages: 1,
    records: [{ memberId: member.rel.id, activeProjectCount: 3 }],
  });
});
test('project membership filters apply before pagination without row duplication and combine with organization status and keyword filters', async () => {
  const f = await memberFixture(),
    first = await f.add(),
    second = await f.add('MEMBER', 'LEFT'),
    excluded = await f.add();
  const project = await memberCountProject(f.owner, 'FILTER_A'),
    other = await memberCountProject(f.owner, 'FILTER_B');
  for (const [i, member] of [first, second, excluded].entries())
    await db.userOrgRel.update({
      where: { id: member.rel.id },
      data: { joinedAt: new Date(`2026-10-0${i + 1}T00:00:00Z`) },
    });
  const data = { projectId: project.id, createdBy: f.owner.uid };
  await db.projectMember.createMany({
    data: [
      { ...data, userId: first.user.id, userOrgRelId: first.rel.id },
      { ...data, userId: first.user.id, userOrgRelId: first.rel.id },
      { ...data, userId: second.user.id, userOrgRelId: second.rel.id },
      { ...data, projectId: other.id, userId: excluded.user.id, userOrgRelId: excluded.rel.id },
    ],
  });
  const page = await post(
    '/organizations/members',
    { orgId: f.orgId, projectId: project.id, current: 1, size: 1 },
    f.headers,
  );
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().data).toMatchObject({
    total: 2,
    pages: 2,
    records: [{ memberId: second.rel.id, activeProjectCount: 1 }],
  });
  const next = await post(
    '/organizations/members',
    { orgId: f.orgId, projectId: project.id, current: 2, size: 1 },
    f.headers,
  );
  expect(next.json().data).toMatchObject({
    total: 2,
    records: [{ memberId: first.rel.id, activeProjectCount: 2 }],
  });
  const combined = await post(
    '/organizations/members',
    { orgId: f.orgId, projectId: project.id, joinStatus: 'ACTIVE', keyword: first.user.uid },
    f.headers,
  );
  expect(combined.json().data).toMatchObject({
    total: 1,
    records: [{ memberId: first.rel.id, activeProjectCount: 2 }],
  });
  expect(
    (
      await post(
        '/organizations/members',
        { orgId: f.orgId, projectId: project.id, current: 3, size: 1 },
        f.headers,
      )
    ).json().data.records,
  ).toEqual([]);
});
test('project filtering preserves organization manager scope and ignores the same user personal or other-organization project associations', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const project = await memberCountProject(f.owner, 'SCOPE_A');
  await db.projectMember.create({
    data: { projectId: project.id, userId: member.user.id, createdBy: f.owner.uid },
  });
  const query = { orgId: f.orgId, projectId: project.id };
  expect((await post('/organizations/members', query, f.headers)).json().data.total).toBe(0);
  expect((await post('/organizations/members', query, member.headers)).statusCode).toBe(403);
  const foreignOrg = await db.organization.create({
    data: { name: '筛选其他组织', expertiseTags: [] },
  });
  expect(
    (await post('/organizations/members', { ...query, orgId: foreignOrg.id }, f.headers))
      .statusCode,
  ).toBe(403);
  const rel = await db.userOrgRel.create({
    data: { orgId: foreignOrg.id, userId: member.user.id, uid: member.user.uid },
  });
  await db.projectMember.create({
    data: {
      projectId: project.id,
      userId: member.user.id,
      userOrgRelId: rel.id,
      createdBy: f.owner.uid,
    },
  });
  expect((await post('/organizations/members', query, f.headers)).json().data.total).toBe(0);
});
test('project filter null and missing are equivalent, nonexistent integer IDs return empty pages and invalid encodings reject', async () => {
  const f = await memberFixture();
  await f.add();
  const list = (extra: Record<string, unknown>) =>
    post('/organizations/members', { orgId: f.orgId, ...extra }, f.headers);
  expect((await list({ projectId: null })).json().data).toEqual((await list({})).json().data);
  for (const projectId of [0, -1, 2147483647]) {
    const response = await list({ projectId });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ total: 0, pages: 0, records: [] });
  }
  for (const projectId of [f.orgId, '1', 1.1, 2147483648, -2147483649])
    expect((await list({ projectId })).statusCode).toBe(400);
});

const projectCardsHttp = (headers: Record<string, string>, manager = false) =>
  app.inject({ url: manager ? '/api/v1/projects/manager/list' : '/api/v1/projects/list', headers });
async function cardSnapshot(
  projectId: number,
  userId: string,
  perspective: string,
  branchNodeCode = 'SUBTASK_ACCEPTANCE',
) {
  return db.projectRoleNodeSnapshot.create({
    data: {
      projectId,
      userId,
      perspective,
      branchNodeCode,
      branchPriority: 80,
      sourceBizType: 'SUBTASK',
      sourceBizId: 1,
      sourceEventAt: new Date(),
      calculatedAt: new Date(),
    },
  });
}
test('navigator cards follow own recruitment or own perspective branch and hide completed, deleted and draft projects', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  let result = await projectCardsHttp(f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject([
    {
      id: f.projectId,
      currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
      branchNodeCode: null,
      currentAction: 'RECRUIT_PROJECT_MANAGER',
    },
  ]);
  expect(result.json().data[0]).not.toHaveProperty('primaryProjectManager');
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  expect((await projectCardsHttp(f.headers)).json().data).toEqual([]);
  const own = await cardSnapshot(f.projectId, f.user.id, 'NAVIGATOR');
  result = await projectCardsHttp(f.headers);
  expect(result.json().data).toMatchObject([
    { id: f.projectId, currentNodeCode: 'PRODUCTION_PLAN', branchNodeCode: 'SUBTASK_ACCEPTANCE' },
  ]);
  for (const patch of [
    { currentNodeCode: 'COMPLETED' },
    { currentNodeCode: 'PRODUCTION_PLAN', deleted: true },
    { deleted: false, status: 'DRAFT' },
  ]) {
    await db.project.update({ where: { id: f.projectId }, data: patch });
    expect((await projectCardsHttp(f.headers)).json().data).toEqual([]);
  }
  await db.projectRoleNodeSnapshot.delete({ where: { id: own.id } });
});
test('manager cards distinguish primary and handler perspectives, recruitment retry and dual-role primary precedence', async () => {
  const f = await productionPlanFixture();
  expect((await projectCardsHttp(f.manager.headers, true)).json().data).toMatchObject([
    {
      id: f.projectId,
      primaryProjectManager: true,
      expertRecruitmentHandler: false,
      currentNodeCode: 'PRODUCTION_PLAN',
    },
  ]);
  expect((await projectCardsHttp(f.handler.headers, true)).json().data).toEqual([]);
  const ignored = await cardSnapshot(
    f.projectId,
    f.handler.user.id,
    'PROJECT_MANAGER',
    'EXPERT_RECRUITMENT_RETRY',
  );
  expect((await projectCardsHttp(f.handler.headers, true)).json().data).toEqual([]);
  const handler = await cardSnapshot(
    f.projectId,
    f.handler.user.id,
    'EXPERT_RECRUITMENT_HANDLER',
    'EXPERT_RECRUITMENT_RETRY',
  );
  expect((await projectCardsHttp(f.handler.headers, true)).json().data).toMatchObject([
    {
      primaryProjectManager: false,
      expertRecruitmentHandler: true,
      currentAction: 'VIEW_DETAIL',
      branchNodeCode: 'EXPERT_RECRUITMENT_RETRY',
    },
  ]);
  await db.projectManagerRecruitment.updateMany({
    where: { projectId: f.projectId, status: 'ASSIGNED' },
    data: { expertRecruitmentHandlerUserId: f.manager.user.id },
  });
  await cardSnapshot(
    f.projectId,
    f.manager.user.id,
    'EXPERT_RECRUITMENT_HANDLER',
    'EXPERT_RECRUITMENT_RETRY',
  );
  const result = await projectCardsHttp(f.manager.headers, true);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data[0]).toMatchObject({
    primaryProjectManager: true,
    expertRecruitmentHandler: true,
    branchNodeCode: null,
  });
  await db.projectRoleNodeSnapshot.deleteMany({ where: { id: { in: [ignored.id, handler.id] } } });
});
test('manager card main visibility and late branch do not replace the shared node, and stale completed snapshots never push', async () => {
  const f = await productionPlanFixture();
  for (const currentNodeCode of [
    'PRODUCTION_PLAN',
    'ENTRANCE_EXAM',
    'STANDARD_TRAINING',
    'RECRUIT_EXECUTION_EXPERT',
  ]) {
    await db.project.update({ where: { id: f.projectId }, data: { currentNodeCode } });
    expect((await projectCardsHttp(f.manager.headers, true)).json().data).toHaveLength(1);
  }
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'PRODUCTION_TASK' },
  });
  expect((await projectCardsHttp(f.manager.headers, true)).json().data).toEqual([]);
  await cardSnapshot(f.projectId, f.manager.user.id, 'PROJECT_MANAGER', 'OUTPUT_DATA_REVIEW');
  expect((await projectCardsHttp(f.manager.headers, true)).json().data).toMatchObject([
    { currentNodeCode: 'PRODUCTION_TASK', branchNodeCode: 'OUTPUT_DATA_REVIEW' },
  ]);
  await db.project.update({ where: { id: f.projectId }, data: { currentNodeCode: 'COMPLETED' } });
  expect((await projectCardsHttp(f.manager.headers, true)).json().data).toEqual([]);
});
test('list counts all ACTIVE membership rows, preserves category snapshots and live names, and sorts update time then numeric ID', async () => {
  const f = await projectManagerFixture();
  const second = await f.save({ ...f.payload, projectName: '第二项目' });
  const secondId = second.json().data.id;
  const now = new Date('2026-10-21T02:00:00Z');
  await db.project.updateMany({
    where: { id: { in: [f.projectId, secondId] } },
    data: { updatedAt: now },
  });
  await db.user.update({
    where: { id: f.user.id },
    data: { displayName: '实时昵称', realName: '实时姓名' },
  });
  await db.projectCategory.update({
    where: { id: f.categories[0]!.id },
    data: { categoryName: '改名字典' },
  });
  await db.projectMember.createMany({
    data: [
      { projectId: f.projectId, userId: f.user.id, createdBy: f.user.uid },
      {
        projectId: f.projectId,
        userId: f.user.id,
        projectRole: 'PROJECT_MANAGER',
        createdBy: f.user.uid,
      },
      { projectId: f.projectId, userId: f.user.id, status: 'LEFT', createdBy: f.user.uid },
    ],
  });
  const result = await projectCardsHttp(f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.map((r: { id: number }) => r.id)).toEqual([secondId, f.projectId]);
  expect(result.json().data[1]).toMatchObject({
    activeExpertCount: 2,
    requesterName: '实时昵称(实时姓名)',
    creatorName: '实时昵称(实时姓名)',
    categoryLevel1Name: '项目分类0',
  });
});
test('list organization owners read accepted assignment relations and only fall back when no owner relation of any status exists', async () => {
  const f = await projectManagerFixture(),
    first = await projectManagerAccount(1),
    legacy = await projectManagerAccount(2);
  const org = await db.organization.create({ data: { name: '卡片负责人组织', expertiseTags: [] } });
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'CARD_OWNER_A',
      projectId: f.projectId,
      subjectType: 'ORGANIZATION',
      organizationId: org.id,
      status: 'ACCEPTED',
      projectOwnerUserId: legacy.user.id,
      createdBy: f.user.uid,
    },
  });
  let result = await projectCardsHttp(f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data[0].projectOwners.map((o: { userId: string }) => o.userId)).toEqual([
    legacy.user.id,
  ]);
  const relation = await db.projectExpertAssignmentOwner.create({
    data: { assignmentId: assignment.id, userId: first.user.id, createdBy: f.user.uid },
  });
  result = await projectCardsHttp(f.headers);
  expect(result.json().data[0].projectOwners.map((o: { userId: string }) => o.userId)).toEqual([
    first.user.id,
  ]);
  expect(result.json().data[0].projectOwners[0]).not.toHaveProperty('assignmentId');
  await db.projectExpertAssignmentOwner.update({
    where: { id: relation.id },
    data: { status: 'REMOVED' },
  });
  expect((await projectCardsHttp(f.headers)).json().data[0].projectOwners).toEqual([]);
  await db.projectExpertAssignmentOwner.delete({ where: { id: relation.id } });
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'PENDING_ACCEPTANCE' },
  });
  expect((await projectCardsHttp(f.headers)).json().data[0].projectOwners).toEqual([]);
});
test('assist grading uses only ACTIVE undeleted exam current-version MANUAL reviewers and never becomes a card visibility grant', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1);
  const exam = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'CARD_EXAM',
      examName: '卡片考试',
      createdBy: f.user.uid,
    },
  });
  const createVersion = (versionNo: number) =>
    db.entranceExamVersion.create({
      data: {
        examId: exam.id,
        versionNo,
        examNameSnapshot: exam.examName,
        registrationDeadline: new Date('2099-01-01T00:00:00Z'),
        fullScore: 20,
        passScore: 12,
        publishedBy: f.user.uid,
        publishedAt: new Date(),
        createdBy: f.user.uid,
      },
    });
  const v1 = await createVersion(1),
    v2 = await createVersion(2);
  await db.projectEntranceExam.update({
    where: { id: exam.id },
    data: { currentVersionId: v1.id },
  });
  const round = await db.entranceExamGradingRound.create({
    data: {
      examVersionId: v1.id,
      roundNo: 1,
      gradingMode: 'MANUAL',
      reviewersJson: [{ userId: f.user.id, uid: f.user.uid, name: '阅卷人' }],
      createdBy: f.user.uid,
    },
  });
  const result = await projectCardsHttp(f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data[0].needAssistGrading).toBe(true);
  for (const patch of [
    { status: 'CLOSED' },
    { status: 'ACTIVE', deleted: true },
    { deleted: false, currentVersionId: v2.id },
  ]) {
    await db.projectEntranceExam.update({ where: { id: exam.id }, data: patch });
    expect((await projectCardsHttp(f.headers)).json().data[0].needAssistGrading).toBe(false);
  }
  await db.projectEntranceExam.update({
    where: { id: exam.id },
    data: { currentVersionId: v1.id },
  });
  await db.entranceExamGradingRound.update({
    where: { id: round.id },
    data: { gradingMode: 'AUTO' },
  });
  expect((await projectCardsHttp(f.headers)).json().data[0].needAssistGrading).toBe(false);
  await db.entranceExamGradingRound.update({
    where: { id: round.id },
    data: { gradingMode: 'MANUAL' },
  });
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  expect((await projectCardsHttp(f.headers)).json().data).toEqual([]);
});
test('lists require live current session roles and current relationships, not stale snapshots or fixed EXPERT sessions', async () => {
  const f = await projectManagerFixture(),
    manager = await projectManagerAccount(1),
    other = await projectManagerAccount(2);
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  await cardSnapshot(f.projectId, manager.user.id, 'PROJECT_MANAGER');
  expect((await projectCardsHttp(other.headers, true)).json().data).toEqual([]);
  expect((await f.recruit(other.user.id)).statusCode).toBe(200);
  expect((await projectCardsHttp(manager.headers, true)).json().data).toEqual([]);
  await selectFixtureRole({
    uid: other.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '卡片授权撤销',
  });
  expect((await projectCardsHttp(other.headers, true)).statusCode).toBe(403);
  expect((await projectCardsHttp(other.headers)).statusCode).toBe(403);
  expect((await app.inject('/api/v1/projects/list')).statusCode).toBe(401);
});
test('historical null card nodes fall back without writes, and cross-role snapshots are not selected', async () => {
  const f = await projectManagerFixture();
  await db.project.update({ where: { id: f.projectId }, data: { currentNodeCode: null } });
  let result = await projectCardsHttp(f.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data[0].currentNodeCode).toBe('RECRUIT_PROJECT_MANAGER');
  expect(
    (await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode,
  ).toBeNull();
  const manager = await projectManagerAccount(1);
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  await db.project.update({ where: { id: f.projectId }, data: { currentNodeCode: null } });
  await cardSnapshot(f.projectId, f.user.id, 'EXPERT_MEMBER', 'PRODUCTION_TASK');
  expect((await projectCardsHttp(f.headers)).json().data).toEqual([]);
  result = await projectCardsHttp(manager.headers, true);
  expect(result.json().data[0].currentNodeCode).toBe('PRODUCTION_PLAN');
  expect(
    (await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode,
  ).toBeNull();
});

test('avatar upload requires login and profile claim enforces ownership, rollback, replacement and cleanup', async () => {
  const anonymous = await uploadHttp([imagePart(), { name: 'bizType', content: 'AVATAR' }]);
  expect(anonymous.statusCode).toBe(401);
  const f = await memberFixture(),
    member = await f.add();
  const upload = async () => {
    const result = await uploadHttp(
      [imagePart(), { name: 'bizType', content: 'AVATAR' }],
      f.headers,
    );
    expect(result.statusCode, result.body).toBe(200);
    return result.json().data;
  };
  const first = await upload();
  expect(
    (
      await post(
        '/users/me/update',
        { avatarUrl: first.objectKey, avatarUploadToken: first.uploadToken },
        member.headers,
      )
    ).statusCode,
  ).toBe(403);
  // 头像先认领、后证件校验失败，整个事务仍必须回滚。
  expect(
    (
      await post(
        '/users/me/update',
        { avatarUrl: first.objectKey, avatarUploadToken: first.uploadToken, idCardNo: 'invalid' },
        f.headers,
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { objectKey: first.objectKey } })).status,
  ).toBe('UPLOADED');
  const saved = await post(
    '/users/me/update',
    { avatarUrl: first.objectKey, avatarUploadToken: first.uploadToken },
    f.headers,
  );
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().data.avatarUrl).toBe(first.url);
  expect(
    await db.uploadedFile.findUniqueOrThrow({ where: { objectKey: first.objectKey } }),
  ).toMatchObject({
    status: 'CLAIMED',
    claimedBizType: 'USER_AVATAR',
    claimedBizId: f.owner.id,
    expiresAt: null,
  });
  expect((await post('/users/me/update', { avatarUrl: first.url }, f.headers)).statusCode).toBe(
    200,
  );
  expect(
    (await post('/users/me/update', { avatarUrl: first.url }, member.headers)).statusCode,
  ).toBe(409);
  const second = await upload();
  expect(
    (
      await post(
        '/users/me/update',
        { avatarUrl: second.objectKey, avatarUploadToken: second.uploadToken },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { objectKey: first.objectKey } })).status,
  ).toBe('RELEASED');
  expect(
    (await post('/users/me/update', { avatarUrl: '' }, f.headers)).json().data.avatarUrl,
  ).toBeNull();
  await db.uploadedFile.updateMany({
    where: { claimedBizType: 'USER_AVATAR', status: 'RELEASED' },
    data: { expiresAt: new Date(0) },
  });
  expect(await registry.cleanupExpired()).toMatchObject({ deleted: 2, failed: 0 });
  expect(objects.has(first.objectKey)).toBe(false);
  expect(objects.has(second.objectKey)).toBe(false);
});

test('personal applications list only authenticated applicant with default/all types, states and Shanghai inclusive boundaries', async () => {
  const f = await memberFixture(),
    member = await f.add(),
    other = await f.add();
  const data = {
    processCode: 'TEST',
    processVersion: 1,
    businessType: 'ORG_MEMBER_EXIT',
    businessId: member.rel.id,
    title: '退出申请',
    applicantId: member.user.id,
    applicantName: '成员',
    applicantOrgId: f.orgId,
    applicantOrgName: '组织',
    appliedAt: new Date('2026-09-30T16:00:00Z'),
  };
  await db.approvalFlow.createMany({
    data: [
      {
        ...data,
        flowNo: 'PERSONAL-1',
        formData: {
          targetMemberId: member.rel.id,
          targetMemberName: '历史名字',
          plannedLeaveDate: '2026-11-01',
        },
      },
      {
        ...data,
        flowNo: 'PERSONAL-2',
        businessType: 'ATTENDANCE_LEAVE',
        status: 'REJECTED',
        appliedAt: new Date('2026-10-01T01:00:00Z'),
      },
      { ...data, flowNo: 'OTHER', applicantId: other.user.id },
    ],
  });
  const own = await post('/users/me/applications', {}, member.headers);
  expect(own.statusCode, own.body).toBe(200);
  expect(own.json().data.total).toBe(1);
  expect(own.json().data.records[0]).toMatchObject({
    flowNo: 'PERSONAL-1',
    targetMemberName: `${member.user.displayName}(${member.user.realName})`,
    appliedAt: '2026-10-01 00:00:00',
    flowVersionNo: 0,
  });
  const all = await post(
    '/users/me/applications',
    { businessType: null, current: 1, size: 1 },
    member.headers,
  );
  expect(all.json().data).toMatchObject({
    total: 2,
    pages: 2,
    records: [{ flowNo: 'PERSONAL-2' }],
  });
  const boundary = await post(
    '/users/me/applications',
    { startAt: '2026-10-01 00:00:00', endAt: '2026-10-01 00:00:00' },
    member.headers,
  );
  expect(boundary.json().data.total).toBe(1);
  expect(
    (await post('/users/me/applications', { applicantId: other.user.id }, member.headers))
      .statusCode,
  ).toBe(400);
  expect((await post('/users/me/applications', {}, f.headers)).json().data.total).toBe(0);
});

test('independent batch schedule is atomic, canonical-idempotent under concurrency, versioned and disallowed after joining organization', async () => {
  await register();
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const input = {
    schedules: [
      { scheduleDate: '2020-01-01', dayType: 'WORK', startTime: '09:00', endTime: '18:00' },
    ],
    overwrite: false,
  };
  const put = (body = input, key = 'schedule-one') =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/schedules/batch',
      payload: body,
      headers: { ...headers, 'idempotency-key': key },
    });
  const results = await Promise.all([put(), put()]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json().data).toEqual(results[1]!.json().data);
  expect(await db.orgMemberSchedule.count()).toBe(1);
  expect(await db.personalScheduleReceipt.count()).toBe(1);
  expect((await put({ ...input, overwrite: true })).statusCode).toBe(409);
  const skipped = await put(input, 'schedule-two');
  expect(skipped.json().data).toMatchObject({
    createdCount: 0,
    skippedCount: 1,
    conflicts: [{ versionNo: 0 }],
  });
  const replaced = await put({ ...input, overwrite: true }, 'schedule-three');
  expect(replaced.json().data.updatedCount).toBe(1);
  expect((await db.orgMemberSchedule.findFirstOrThrow()).versionNo).toBe(1);
  expect(
    (
      await put(
        {
          ...input,
          schedules: [...input.schedules, { ...input.schedules[0]!, scheduleDate: '2020-02-30' }],
        },
        'bad-date',
      )
    ).statusCode,
  ).toBe(400);
  expect(await db.personalScheduleReceipt.count()).toBe(3);
  const org = await db.organization.create({ data: { name: '新组织', expertiseTags: [] } });
  const user = await db.user.findFirstOrThrow();
  await db.userOrgRel.create({ data: { userId: user.id, uid: user.uid, orgId: org.id } });
  expect((await put(input, 'now-in-org')).statusCode).toBe(403);
  expect(
    (await app.inject({ url: '/api/v1/organizations/attendance?month=2020-01', headers }))
      .statusCode,
  ).toBe(403);
});

test('monthly attendance joins own scope, fills full month and only displays historical absences without creating daily rows', async () => {
  const f = await memberFixture(),
    member = await f.add(),
    other = await f.add();
  await db.orgMemberSchedule.createMany({
    data: [
      {
        scopeKey: f.orgId,
        orgId: f.orgId,
        userOrgRelId: member.rel.id,
        userId: member.user.id,
        scheduleDate: new Date('2020-01-01'),
        dayType: 'WORK',
        shiftStartAt: new Date('2020-01-01T09:00:00Z'),
        shiftEndAt: new Date('2020-01-01T18:00:00Z'),
        createdBy: f.owner.uid,
        updatedBy: f.owner.uid,
      },
      {
        scopeKey: f.orgId,
        orgId: f.orgId,
        userOrgRelId: other.rel.id,
        userId: other.user.id,
        scheduleDate: new Date('2020-01-02'),
        dayType: 'REST',
        createdBy: f.owner.uid,
        updatedBy: f.owner.uid,
      },
    ],
  });
  const response = await app.inject({
    url: `/api/v1/organizations/attendance?month=2020-01&orgId=${f.orgId}`,
    headers: member.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({
    memberId: member.rel.id,
    summary: { absentCount: 1 },
    permissions: { canBatchSchedule: false, canDirectUpdate: false },
  });
  expect(response.json().data.days).toHaveLength(31);
  expect(response.json().data.days[0]).toMatchObject({
    calendarStatus: 'ABSENT',
    dailyId: null,
    shiftStartAt: '2020-01-01 09:00:00',
  });
  expect(response.json().data.days[1].calendarStatus).toBe('UNSCHEDULED');
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  expect(
    (
      await app.inject({
        url: `/api/v1/organizations/attendance?month=2020-01&orgId=${f.orgId}&userId=${other.user.id}`,
        headers: member.headers,
      })
    ).statusCode,
  ).toBe(400);
});

test('direct attendance correction denies members and future dates, serializes versions and appends a single audit', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const daily = await db.orgAttendanceDaily.create({
    data: {
      scopeKey: f.orgId,
      orgId: f.orgId,
      userOrgRelId: member.rel.id,
      userId: member.user.id,
      attendanceDate: new Date('2020-01-01'),
      autoStatus: 'ABSENT',
      finalStatus: 'ABSENT',
      createdBy: f.owner.uid,
      updatedBy: f.owner.uid,
    },
  });
  const input = {
    orgId: f.orgId,
    dailyId: daily.id,
    finalStatus: 'PRESENT',
    manualRemark: '核实正常',
    versionNo: 0,
  };
  expect((await post('/organizations/attendance/update', input, member.headers)).statusCode).toBe(
    403,
  );
  const concurrent = await Promise.all([
    post('/organizations/attendance/update', input, f.headers),
    post('/organizations/attendance/update', input, f.headers),
  ]);
  expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await db.orgAttendanceAdjustment.count()).toBe(1);
  expect(await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: daily.id } })).toMatchObject({
    autoStatus: 'ABSENT',
    finalStatus: 'PRESENT',
    manualOverride: true,
    versionNo: 1,
  });
  await db.orgAttendanceDaily.update({
    where: { id: daily.id },
    data: { attendanceDate: new Date('2099-01-01') },
  });
  expect(
    (await post('/organizations/attendance/update', { ...input, versionNo: 1 }, f.headers))
      .statusCode,
  ).toBe(400);
  expect(await db.orgAttendanceAdjustment.count()).toBe(1);
});

test('my projects require own acceptance, honor organization preference and use actual admission/membership progress', async () => {
  const f = await memberFixture(),
    member = await f.add();
  const project = await memberCountProject(f.owner, 'MY-PROJECT');
  const personal = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MY-PERSONAL',
      projectId: project.id,
      subjectType: 'INDIVIDUAL',
      expertUserId: member.user.id,
      status: 'ACCEPTED',
      createdBy: f.owner.uid,
    },
  });
  const get = () =>
    app.inject({ url: '/api/v1/expert-assignments/my-projects', headers: member.headers });
  const result = await get();
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject([
    {
      assignmentId: personal.id,
      admissionStatus: 'NOT_EXAMINED',
      currentNodeCode: 'STANDARD_TRAINING',
    },
  ]);
  const org = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MY-ORG',
      projectId: project.id,
      subjectType: 'ORGANIZATION',
      organizationId: f.orgId,
      status: 'ACCEPTED',
      createdBy: f.owner.uid,
    },
  });
  expect((await get()).json().data).toEqual([]); // 有效组织成员尚未响应，个人身份暂不列出。
  await db.projectExpertAssignmentMember.create({
    data: {
      assignmentId: org.id,
      userId: member.user.id,
      userOrgRelId: member.rel.id,
      status: 'ACCEPTED',
      createdBy: member.user.uid,
    },
  });
  expect((await get()).json().data[0].assignmentId).toBe(org.id);
  await db.projectMember.create({
    data: {
      projectId: project.id,
      userId: member.user.id,
      userOrgRelId: member.rel.id,
      organizationId: f.orgId,
      expertAssignmentId: org.id,
      joinedAt: new Date(),
      standardTrainingConfirmedAt: new Date(),
      createdBy: f.owner.uid,
    },
  });
  expect((await get()).json().data[0].currentNodeCode).toBe('PRODUCTION_TASK');
  await db.projectExpertAssignmentOwner.create({
    data: { assignmentId: org.id, userId: member.user.id, createdBy: f.owner.uid },
  });
  expect((await get()).json().data).toEqual([]); // 负责人不是普通成员口径。
  await db.userOrgRel.update({ where: { id: member.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await get()).json().data[0].assignmentId).toBe(personal.id);
});

test('expert detail preserves readonly project/production shape and prevents unrelated/ordinary pre-acceptance access', async () => {
  const f = await memberFixture(),
    member = await f.add(),
    other = await f.add();
  const project = await memberCountProject(f.owner, 'ASSIGNMENT-DETAIL');
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'DETAIL-ORG',
      projectId: project.id,
      subjectType: 'ORGANIZATION',
      organizationId: f.orgId,
      productionRequirement: 123.5,
      operatorHeadcount: 2,
      inspectorHeadcount: 1,
      createdBy: f.owner.uid,
    },
  });
  const get = (headers: Record<string, string>) =>
    app.inject({ url: `/api/v1/expert-assignments/detail?assignmentId=${assignment.id}`, headers });
  expect((await get(member.headers)).statusCode).toBe(403);
  const ownerDetail = await get(f.headers);
  expect(ownerDetail.statusCode, ownerDetail.body).toBe(200);
  expect(ownerDetail.json().data).toMatchObject({
    assignmentId: assignment.id,
    availableOperations: ['VIEW_DETAIL'],
    productionPlan: {
      hasPlan: false,
      operatorHeadcount: 2,
      inspectorHeadcount: 1,
      totalExpectedOutput: 123.5,
      crowds: [],
      stages: [],
    },
  });
  expect(ownerDetail.json().data.productionPlan).not.toHaveProperty('confirmedBy');
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'ACCEPTED' },
  });
  expect((await get(member.headers)).statusCode).toBe(200);
  await db.userOrgRel.update({ where: { id: other.rel.id }, data: { joinStatus: 'REMOVED' } });
  expect((await get(other.headers)).statusCode).toBe(403);
});

async function attendanceApplicationFixture(date = '2020-01-01', existingDaily = false) {
  const columns = await db.$queryRaw<
    { column_name: string; is_nullable: string }[]
  >`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='OrgAttendanceDaily' AND column_name IN ('autoStatus','finalStatus')`;
  if (columns.length !== 2 || columns.some((column) => column.is_nullable !== 'YES'))
    throw new Error(
      '专用测试库尚未应用第16迁移20261021020000_attendance_applications，请先migrate deploy再运行新增考勤申请集成',
    );
  const f = await memberFixture(),
    member = await f.add();
  const schedule = await db.orgMemberSchedule.create({
    data: {
      scopeKey: f.orgId,
      orgId: f.orgId,
      userOrgRelId: member.rel.id,
      userId: member.user.id,
      scheduleDate: new Date(date),
      dayType: 'WORK',
      shiftStartAt: new Date(`${date}T09:00:00Z`),
      shiftEndAt: new Date(`${date}T18:00:00Z`),
      createdBy: f.owner.uid,
      updatedBy: f.owner.uid,
    },
  });
  const daily = existingDaily
    ? await db.orgAttendanceDaily.create({
        data: {
          scopeKey: f.orgId,
          orgId: f.orgId,
          userOrgRelId: member.rel.id,
          userId: member.user.id,
          attendanceDate: new Date(date),
          scheduleId: schedule.id,
          autoStatus: 'ABSENT',
          finalStatus: 'ABSENT',
          createdBy: f.owner.uid,
          updatedBy: f.owner.uid,
        },
      })
    : null;
  const input = {
    orgId: f.orgId,
    attendanceDate: date,
    applicationType: 'CORRECTION',
    finalStatus: 'PRESENT',
    reason: '补充出勤记录',
    versionNo: daily?.versionNo ?? null,
  };
  const apply = (payload: unknown = input, headers = member.headers) =>
    post('/organizations/attendance/apply', payload, headers);
  const leave = {
    ...input,
    applicationType: 'LEAVE',
    finalStatus: 'LEAVE',
    reason: '个人事务请假',
    leaveStartAt: `${date} 09:00:00`,
    leaveEndAt: `${date} 12:00:00`,
  };
  const processInput = async (applicationId: string, action = 'APPROVE') => {
    const flow = await db.approvalFlow.findUniqueOrThrow({ where: { id: applicationId } });
    const node = await db.approvalNode.findFirstOrThrow({ where: { flowId: flow.id } });
    return {
      orgId: f.orgId,
      flowNo: flow.flowNo,
      nodeId: node.id,
      flowVersionNo: flow.versionNo,
      nodeVersionNo: node.versionNo,
      action,
      actionComment: action === 'REJECT' ? '说明不充分' : '核实通过',
    };
  };
  const month = () =>
    app.inject({
      url: `/api/v1/organizations/attendance?month=${date.slice(0, 7)}&orgId=${f.orgId}`,
      headers: member.headers,
    });
  return { ...f, member, schedule, daily, input, leave, apply, processInput, month };
}
test('attendance correction creates pending owner flow without attendance mutations; approval creates daily and audit atomically', async () => {
  const f = await attendanceApplicationFixture();
  const submitted = await f.apply();
  expect(submitted.statusCode, submitted.body).toBe(200);
  const result = submitted.json().data;
  expect(result).toMatchObject({
    status: 'PENDING',
    businessType: 'ATTENDANCE_CORRECTION',
    versionNo: null,
    flowVersionNo: 0,
  });
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  const list = await post(
    '/users/me/applications',
    { businessType: 'ATTENDANCE_CORRECTION' },
    f.member.headers,
  );
  expect(list.json().data.records).toMatchObject([
    { applicationId: result.applicationId, status: 'PENDING', flowVersionNo: 0 },
  ]);
  const pending = await post(
    '/organizations/approvals/pending',
    { orgId: f.orgId, businessType: 'ATTENDANCE_CORRECTION' },
    f.headers,
  );
  expect(pending.statusCode, pending.body).toBe(200);
  expect(pending.json().data.total).toBe(1);
  expect(pending.json().data.records[0].formData.attendanceDate).toBe('2020-01-01');
  const processed = await post(
    '/organizations/approvals/process',
    await f.processInput(result.applicationId),
    f.headers,
  );
  expect(processed.statusCode, processed.body).toBe(200);
  expect(processed.json().data).toMatchObject({
    applicationId: result.applicationId,
    flowStatus: 'APPROVED',
    flowVersionNo: 1,
    dailyVersionNo: 0,
    finalStatus: 'PRESENT',
    joinStatus: null,
    plannedLeaveDate: null,
  });
  const daily = await db.orgAttendanceDaily.findFirstOrThrow();
  expect(daily).toMatchObject({
    userId: f.member.user.id,
    autoStatus: 'ABSENT',
    finalStatus: 'PRESENT',
    manualOverride: true,
  });
  expect(await db.orgAttendanceAdjustment.count()).toBe(1);
  const flow = await db.approvalFlow.findUniqueOrThrow({ where: { id: result.applicationId } });
  expect(flow).toMatchObject({
    status: 'APPROVED',
    versionNo: 1,
    afterData: { dailyId: daily.id, finalStatus: 'PRESENT' },
  });
  expect((await f.month()).json().data.summary.presentCount).toBe(1);
  const records = await post(
    '/organizations/approvals/records',
    { orgId: f.orgId, businessType: 'ATTENDANCE_CORRECTION' },
    f.headers,
  );
  expect(records.json().data.total).toBe(1);
});
test('future leave requires valid shift period and stays pending until approval; no fabricated auto attendance', async () => {
  const f = await attendanceApplicationFixture('2099-01-01');
  expect((await f.apply()).statusCode).toBe(400); // future CORRECTION
  for (const extra of [
    { leaveStartAt: '2099-01-01 08:00:00' },
    { leaveEndAt: '2099-01-02 12:00:00' },
    { finalStatus: 'PRESENT' },
  ])
    expect((await f.apply({ ...f.leave, ...extra })).statusCode).toBe(400);
  const submitted = await f.apply(f.leave);
  expect(submitted.statusCode, submitted.body).toBe(200);
  const id = submitted.json().data.applicationId;
  let month = (await f.month()).json().data;
  expect(month.days[0]).toMatchObject({
    calendarStatus: 'PENDING_ATTENDANCE',
    application: { applicationId: id, canWithdraw: true },
    permissions: { canApplyLeave: false, canWithdraw: true },
  });
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  const processed = await post(
    '/organizations/approvals/process',
    await f.processInput(id),
    f.headers,
  );
  expect(processed.statusCode, processed.body).toBe(200);
  expect(await db.orgAttendanceDaily.findFirstOrThrow()).toMatchObject({
    finalStatus: 'LEAVE',
    autoStatus: null,
    firstClockInAt: null,
    lastClockOutAt: null,
  });
  expect(await db.orgAttendanceAdjustment.findFirstOrThrow()).toMatchObject({
    beforeStatus: null,
    afterStatus: 'LEAVE',
  });
  month = (await f.month()).json().data;
  expect(month.summary.leaveCount).toBe(1);
  expect(month.days[0]).toMatchObject({
    calendarStatus: 'LEAVE',
    autoStatus: null,
    application: { status: 'APPROVED', canWithdraw: false },
    permissions: { canApplyLeave: false },
  });
  expect((await f.apply({ ...f.leave, versionNo: 0 })).statusCode).toBe(409);
});
test('same-day leave/correction pending applications are mutually exclusive under concurrent submission', async () => {
  const f = await attendanceApplicationFixture();
  const results = await Promise.all([f.apply(), f.apply(f.leave)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await db.approvalFlow.count()).toBe(1);
  expect(await db.approvalNode.count()).toBe(1);
  expect(await db.orgAttendanceDaily.count()).toBe(0);
});
test('withdraw enforces applicant/version/business and cancels node without writing attendance; ended flows reject reuse', async () => {
  const f = await attendanceApplicationFixture();
  const other = await f.add();
  const submitted = await f.apply();
  const { applicationId, flowVersionNo } = submitted.json().data;
  const body = { applicationId, flowVersionNo };
  expect((await post('/organizations/attendance/withdraw', body, other.headers)).statusCode).toBe(
    403,
  );
  expect(
    (
      await post(
        '/organizations/attendance/withdraw',
        { ...body, flowVersionNo: 99 },
        f.member.headers,
      )
    ).statusCode,
  ).toBe(409);
  const response = await post('/organizations/attendance/withdraw', body, f.member.headers);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: 'WITHDRAWN', flowVersionNo: 1 });
  expect(await db.approvalNode.findFirstOrThrow()).toMatchObject({
    nodeStatus: 'CANCELED',
    versionNo: 1,
    approvedAt: null,
  });
  expect(await db.approvalActionLog.count({ where: { actionType: 'WITHDRAW' } })).toBe(1);
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  expect(
    (await post('/organizations/attendance/withdraw', body, f.member.headers)).statusCode,
  ).toBe(409);
  expect((await f.month()).json().data.days[0].permissions.canApplyCorrection).toBe(true);
  expect((await f.apply()).statusCode).toBe(200); // resubmit after withdrawal allowed
});
test('withdraw and owner approval serialize to exactly one outcome with no partial state or double audit', async () => {
  const f = await attendanceApplicationFixture();
  const submitted = await f.apply();
  const { applicationId, flowVersionNo } = submitted.json().data;
  const processInput = await f.processInput(applicationId);
  const results = await Promise.all([
    post('/organizations/approvals/process', processInput, f.headers),
    post('/organizations/attendance/withdraw', { applicationId, flowVersionNo }, f.member.headers),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const flow = await db.approvalFlow.findUniqueOrThrow({ where: { id: applicationId } });
  expect(flow.versionNo).toBe(1);
  expect(await db.orgAttendanceDaily.count()).toBe(flow.status === 'APPROVED' ? 1 : 0);
  expect(await db.orgAttendanceAdjustment.count()).toBe(flow.status === 'APPROVED' ? 1 : 0);
  expect(await db.approvalActionLog.count({ where: { flowId: applicationId } })).toBe(2);
});
test('approval refuses stale day/shift snapshots while rejection remains possible and never writes target attendance', async () => {
  const f = await attendanceApplicationFixture('2020-01-01', true);
  const submitted = await f.apply();
  const id = submitted.json().data.applicationId;
  expect(
    (
      await post(
        '/organizations/attendance/update',
        { orgId: f.orgId, dailyId: f.daily!.id, finalStatus: 'REST', versionNo: 0 },
        f.headers,
      )
    ).statusCode,
  ).toBe(200);
  const processInput = await f.processInput(id);
  expect((await post('/organizations/approvals/process', processInput, f.headers)).statusCode).toBe(
    409,
  );
  expect(await db.approvalFlow.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: 'PENDING',
    versionNo: 0,
  });
  expect(await db.approvalNode.findFirstOrThrow({ where: { flowId: id } })).toMatchObject({
    nodeStatus: 'PENDING',
    versionNo: 0,
  });
  expect(await db.orgAttendanceAdjustment.count()).toBe(1); // only direct correction, no failed approval audit
  const rejected = await post(
    '/organizations/approvals/process',
    { ...processInput, action: 'REJECT', actionComment: '重新提交当前版本' },
    f.headers,
  );
  expect(rejected.statusCode, rejected.body).toBe(200);
  expect(rejected.json().data).toMatchObject({
    flowStatus: 'REJECTED',
    dailyId: null,
    finalStatus: null,
  });
  expect(
    (await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: f.daily!.id } })).finalStatus,
  ).toBe('REST');
  const next = await f.apply({ ...f.input, versionNo: 1 });
  expect(next.statusCode).toBe(200);
  await db.orgMemberSchedule.update({
    where: { id: f.schedule.id },
    data: { versionNo: { increment: 1 } },
  });
  expect(
    (
      await post(
        '/organizations/approvals/process',
        await f.processInput(next.json().data.applicationId),
        f.headers,
      )
    ).statusCode,
  ).toBe(409);
});
test('attendance application permission cannot be replaced by target IDs, admin reviewer status, organization exit or another business flow', async () => {
  const f = await attendanceApplicationFixture();
  const admin = await f.add('ADMIN');
  expect((await f.apply(f.input, f.headers)).statusCode).toBe(403); // supervisor self
  expect((await f.apply({ ...f.input, userId: admin.user.id })).statusCode).toBe(400);
  const submitted = await f.apply();
  const id = submitted.json().data.applicationId;
  expect(
    (await post('/organizations/approvals/process', await f.processInput(id), admin.headers))
      .statusCode,
  ).toBe(403);
  await db.userOrgRel.update({ where: { id: f.member.rel.id }, data: { joinStatus: 'LEFT' } });
  expect(
    (await post('/organizations/approvals/process', await f.processInput(id), f.headers))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await post(
        '/organizations/attendance/withdraw',
        { applicationId: id, flowVersionNo: 0 },
        f.member.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await db.userOrgRel.findUniqueOrThrow({ where: { id: f.member.rel.id } })).joinStatus,
  ).toBe('LEFT');
  const other = await f.add();
  const exit = await post(
    '/organizations/members/exit-requests',
    { orgId: f.orgId, reason: '个人发展', plannedLeaveDate: '2099-01-01' },
    { ...other.headers, 'idempotency-key': 'exit-not-attendance' },
  );
  expect(exit.statusCode).toBe(200);
  const flow = await db.approvalFlow.findUniqueOrThrow({
    where: { flowNo: exit.json().data.flowNo },
  });
  expect(
    (
      await post(
        '/organizations/attendance/withdraw',
        { applicationId: flow.id, flowVersionNo: 0 },
        other.headers,
      )
    ).statusCode,
  ).toBe(400);
});
test('approved existing-day correction increments its version, keeps raw auto status and blocks old workflow snapshots', async () => {
  const f = await attendanceApplicationFixture('2020-01-01', true);
  const response = await f.apply();
  const id = response.json().data.applicationId;
  const processInput = await f.processInput(id);
  const approved = await post('/organizations/approvals/process', processInput, f.headers);
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().data).toMatchObject({
    dailyId: f.daily!.id,
    dailyVersionNo: 1,
    finalStatus: 'PRESENT',
  });
  expect(
    await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: f.daily!.id } }),
  ).toMatchObject({
    autoStatus: 'ABSENT',
    finalStatus: 'PRESENT',
    versionNo: 1,
    manualOverride: true,
  });
  expect(await db.orgAttendanceAdjustment.count()).toBe(1);
  expect((await post('/organizations/approvals/process', processInput, f.headers)).statusCode).toBe(
    409,
  );
  expect(await db.orgAttendanceAdjustment.count()).toBe(1);
});

async function examConfigFixture() {
  const f = await projectManagerFixture();
  const manager = await projectManagerAccount(1),
    other = await projectManagerAccount(2);
  expect((await f.recruit(manager.user.id)).statusCode).toBe(200);
  const exam = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'VERSION_EXAM_A',
      examName: '版本考试A',
      createdBy: f.user.uid,
    },
  });
  const version = await db.entranceExamVersion.create({
    data: {
      examId: exam.id,
      versionNo: 1,
      examNameSnapshot: exam.examName,
      durationMinutes: 60,
      registrationDeadline: new Date('2099-01-01T00:00:00Z'),
      fullScore: 20,
      passScore: 12,
      publishedBy: manager.user.uid,
      publishedAt: new Date(),
      createdBy: manager.user.uid,
    },
  });
  const paper = await db.entranceExamPaper.create({
    data: {
      examVersionId: version.id,
      sequenceNo: 1,
      totalScore: 20,
      createdBy: manager.user.uid,
    },
  });
  return { ...f, manager, other, exam, version, paper };
}
test('exam templates require current PM session role and candidates follow assigned manager replacement and active-account scope', async () => {
  const f = await examConfigFixture();
  const template = (headers: Record<string, string>) =>
    app.inject({ url: '/api/v1/entrance-exams/import/template?type=EXCEL', headers });
  const candidates = (headers: Record<string, string>, keyword = '') =>
    app.inject({
      url: `/api/v1/entrance-exams/reviewers?projectId=${f.projectId}&keyword=${encodeURIComponent(keyword)}`,
      headers,
    });
  expect((await template(f.headers)).statusCode).toBe(403);
  const excel = await template(f.manager.headers);
  expect(excel.statusCode, excel.body).toBe(200);
  expect(XLSX.read(excel.rawPayload).SheetNames).toEqual(['考试配置', '题目']);
  const result = await candidates(f.manager.headers);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.map((u: { userId: string }) => u.userId)).toEqual([
    f.user.id,
    f.manager.user.id,
  ]);
  expect(result.json().data[0]).not.toHaveProperty('phone');
  expect((await candidates(f.other.headers)).statusCode).toBe(403);
  expect(
    (await candidates(f.manager.headers, f.manager.user.uid.toUpperCase())).json().data,
  ).toHaveLength(1);
  await db.user.update({ where: { id: f.user.id }, data: { status: 'DISABLED' } });
  expect(
    (await candidates(f.manager.headers)).json().data.map((u: { userId: string }) => u.userId),
  ).toEqual([f.manager.user.id]);
  await db.user.update({ where: { id: f.user.id }, data: { status: 'ACTIVE' } });
  expect((await f.recruit(f.other.user.id)).statusCode).toBe(200);
  expect((await candidates(f.manager.headers)).statusCode).toBe(403);
  expect((await candidates(f.other.headers)).statusCode).toBe(200);
  await selectFixtureRole({
    uid: f.other.user.uid,
    role: 'PM',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '验证考试查询授权撤销',
  });
  expect((await candidates(f.other.headers)).statusCode).toBe(403);
  expect((await template(f.other.headers)).statusCode).toBe(403);
});
test('exam configuration round-trip keeps decimal values and question snapshots, enforcing version and sequence uniqueness', async () => {
  const f = await examConfigFixture();
  await db.projectEntranceExam.update({
    where: { id: f.exam.id },
    data: { currentVersionId: f.version.id },
  });
  const question = await db.entranceExamQuestion.create({
    data: {
      paperId: f.paper.id,
      sequenceNo: 1,
      questionContent: '测试题目',
      score: '20.00',
      scoreSource: 'MANUAL',
      referenceAnswer: '参考答案',
      questionFilesJson: [],
      referenceFilesJson: [],
      createdBy: f.manager.user.uid,
    },
  });
  expect(question.score.toFixed(2)).toBe('20.00');
  expect(question.requiredFlag).toBe(true);
  const read = await db.projectEntranceExam.findUniqueOrThrow({
    where: { id: f.exam.id },
    include: { currentVersion: { include: { papers: { include: { questions: true } } } } },
  });
  expect(read.currentVersion?.papers[0]?.questions[0]?.id).toBe(question.id);
  const versionData = { ...f.version, id: undefined };
  await expect(db.entranceExamVersion.create({ data: versionData })).rejects.toMatchObject({
    code: 'P2002',
  });
  await expect(
    db.entranceExamPaper.create({
      data: { examVersionId: f.version.id, sequenceNo: 1, totalScore: 20, createdBy: f.user.uid },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
  await expect(
    db.entranceExamQuestion.create({
      data: { paperId: f.paper.id, sequenceNo: 1, score: 20, createdBy: f.user.uid },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
  await db.entranceExamGradingRound.create({
    data: {
      examVersionId: f.version.id,
      roundNo: 1,
      gradingMode: 'MANUAL',
      reviewersJson: [{ userId: f.manager.user.id }],
      createdBy: f.user.uid,
    },
  });
  await expect(
    db.entranceExamGradingRound.create({
      data: { examVersionId: f.version.id, roundNo: 1, gradingMode: 'AUTO', createdBy: f.user.uid },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });
});
test('exam current version and attempt version/paper reject foreign exam and version sources without rewriting facts', async () => {
  const f = await examConfigFixture();
  const second = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'VERSION_EXAM_B',
      examName: '版本考试B',
      createdBy: f.user.uid,
    },
  });
  await expect(
    db.projectEntranceExam.update({
      where: { id: second.id },
      data: { currentVersionId: f.version.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  const data = {
    attemptNo: 'ATTEMPT_FOREIGN_VERSION',
    examId: second.id,
    examVersionId: f.version.id,
    candidateUserId: f.manager.user.id,
    candidateUid: f.manager.user.uid,
    candidateName: '应试者',
    createdBy: f.manager.user.uid,
  };
  await expect(db.entranceExamAttempt.create({ data })).rejects.toMatchObject({ code: 'P2003' });
  const baseVersion = { ...f.version, id: undefined };
  const v2 = await db.entranceExamVersion.create({ data: { ...baseVersion, versionNo: 2 } });
  await expect(
    db.entranceExamAttempt.create({
      data: { ...data, examId: f.exam.id, examVersionId: v2.id, paperId: f.paper.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  const attempt = await db.entranceExamAttempt.create({
    data: { ...data, examId: f.exam.id, paperId: f.paper.id },
  });
  expect(attempt.examVersionId).toBe(f.version.id);
  // PostgreSQL RESTRICT的23001在当前Prisma连接器中未映射为P2003；核对具体外键及拒绝后的完整事实。
  await expect(
    db.entranceExamVersion.delete({ where: { id: f.version.id } }),
  ).rejects.toMatchObject({
    message: expect.stringContaining('EntranceExamAttempt_examVersionId_examId_fkey'),
  });
  expect(await db.entranceExamVersion.findUniqueOrThrow({ where: { id: f.version.id } })).toEqual(
    f.version,
  );
  expect(await db.entranceExamPaper.findUniqueOrThrow({ where: { id: f.paper.id } })).toEqual(
    f.paper,
  );
  expect(await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(
    attempt,
  );
});
test('exam schema checks reject invalid score/rule/sequence and paper-without-version while preserving unentered attempts', async () => {
  const f = await examConfigFixture();
  await expect(
    db.$executeRaw`UPDATE "EntranceExamVersion" SET "passScore" = 21 WHERE "id" = ${f.version.id}`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "EntranceExamVersion" SET "decisionRule" = 'UNKNOWN' WHERE "id" = ${f.version.id}`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "EntranceExamPaper" SET "sequenceNo" = 0 WHERE "id" = ${f.paper.id}`,
  ).rejects.toThrow();
  const data = {
    attemptNo: 'ATTEMPT_UNENTERED',
    examId: f.exam.id,
    candidateUserId: f.manager.user.id,
    candidateUid: f.manager.user.uid,
    candidateName: '应试者',
    createdBy: f.manager.user.uid,
  };
  const attempt = await db.entranceExamAttempt.create({ data });
  expect(attempt.examVersionId).toBe(null);
  await expect(
    db.$executeRaw`UPDATE "EntranceExamAttempt" SET "paperId" = ${f.paper.id} WHERE "id" = ${attempt.id}`,
  ).rejects.toThrow();
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).paperId,
  ).toBe(null);
});

async function examPublishFixture() {
  const f = await productionPlanFixture();
  expect((await f.confirm({ ...productionPlanExample, maxActiveExamCount: 2 })).statusCode).toBe(
    200,
  );
  const payload = {
    ...structuredClone(examConfigExample),
    projectId: f.projectId,
    gradingRounds: [{ gradingMode: 'MANUAL', reviewerUserIds: [f.user.id, f.manager.user.id] }],
  };
  const publish = (body: unknown = payload, headers = f.manager.headers) =>
    post('/entrance-exams/publish', body, headers);
  const edit = (examId: number, expectedCurrentVersionId: number, patch = {}) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/entrance-exams/edit',
      headers: f.manager.headers,
      payload: { ...payload, examId, expectedCurrentVersionId, ...patch },
    });
  return { ...f, payload, publish, edit };
}
test('exam file parse is readonly, validates owner/token/state, and rejects unsupported remote source without creating business data', async () => {
  const f = await productionPlanFixture();
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.manager.user.uid);
  const parse = (token = uploadToken, headers = f.manager.headers) => {
    const form = multipartPayload([
      {
        name: 'file',
        fileName: 'import.txt',
        content: '题目\t答案\t题干附件\n题干\t参考答案\t说明',
      },
      {
        name: 'attachmentRefs',
        contentType: 'application/json',
        content: JSON.stringify([
          { name: '说明', objectKey: record.objectKey, uploadToken: token },
        ]),
      },
    ]);
    return app.inject({
      method: 'POST',
      url: `/api/v1/entrance-exams/import/parse?projectId=${f.projectId}`,
      payload: form.payload,
      headers: { ...form.headers, ...headers },
    });
  };
  const result = await parse();
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.config.papers[0].questions[0].questionFiles[0]).toMatchObject({
    objectKey: record.objectKey,
    uploadToken,
    sensitive: true,
  });
  expect(await db.projectEntranceExam.count()).toBe(0);
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
    'UPLOADED',
  );
  expect((await parse('invalid-token')).statusCode).toBe(403);
  expect((await parse(uploadToken, f.handler.headers)).statusCode).toBe(403);
  await db.uploadedFile.update({
    where: { id: record.id },
    data: { ownerUid: f.handler.user.uid },
  });
  expect((await parse()).statusCode).toBe(403);
  await db.uploadedFile.update({
    where: { id: record.id },
    data: { ownerUid: f.manager.user.uid, expiresAt: new Date(0) },
  });
  expect((await parse()).statusCode).toBe(409);
  const form = multipartPayload([
    { name: 'projectId', content: String(f.projectId) },
    { name: 'redocUrl', content: 'https://documents.example/doc/source' },
  ]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/entrance-exams/import/parse',
        payload: form.payload,
        headers: { ...form.headers, ...f.manager.headers },
      })
    ).statusCode,
  ).toBe(503);
});
test('exam publish persists V1 snapshots, trusted file metadata, reviewers and main task transition atomically', async () => {
  const f = await examPublishFixture();
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.manager.user.uid);
  f.payload.papers[0]!.questions[0]!.questionFiles = [
    { objectKey: record.objectKey, uploadToken, fileName: 'forged.txt', size: 999 } as never,
  ];
  const result = await f.publish();
  expect(result.statusCode, result.body).toBe(200);
  const data = result.json().data;
  expect(data).toMatchObject({ projectId: f.projectId, status: 'ACTIVE', versionNo: 1 });
  const version = await db.entranceExamVersion.findUniqueOrThrow({
    where: { id: data.currentVersionId },
    include: { papers: { include: { questions: true } }, gradingRounds: true },
  });
  expect(version.papers[0]!.questions[0]!.questionFilesJson).toEqual([
    {
      uploadedFileId: record.id,
      objectKey: record.objectKey,
      fileName: record.fileName,
      extension: record.extension,
      contentType: record.contentType,
      fileSize: record.fileSize,
      fileHash: record.fileHash,
    },
  ]);
  expect(JSON.stringify(version)).not.toContain(uploadToken);
  expect(version.gradingRounds[0]!.reviewersJson).toMatchObject([
    { userId: f.user.id },
    { userId: f.manager.user.id },
  ]);
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).claimedBizId).toBe(
    String(data.examId),
  );
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'STANDARD_TRAINING',
  );
  expect(
    await db.projectTaskRound.findFirst({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'MAIN_ENTRANCE_EXAM',
        status: 'COMPLETED',
      },
    }),
  ).toMatchObject({ participated: true });
  for (const headers of [f.headers, f.manager.headers, f.handler.headers])
    expect(
      (
        await app.inject({
          url: `/api/v1/files/view?objectKey=${encodeURIComponent(record.objectKey)}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  const outsider = await projectManagerAccount(3);
  expect(
    (
      await app.inject({
        url: `/api/v1/files/view?objectKey=${encodeURIComponent(record.objectKey)}`,
        headers: outsider.headers,
      })
    ).statusCode,
  ).toBe(403);
});
test('exam edit creates immutable version, retains old attempt/paper and reused files, rejects stale edits and never regresses later node', async () => {
  const f = await examPublishFixture();
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.manager.user.uid);
  const question = f.payload.papers[0]!.questions[0]!;
  question.questionFiles = [{ objectKey: record.objectKey, uploadToken } as never];
  const first = await f.publish();
  expect(first.statusCode, first.body).toBe(200);
  const data = first.json().data;
  const old = await db.entranceExamVersion.findUniqueOrThrow({
    where: { id: data.currentVersionId },
    include: { papers: { include: { questions: true } }, gradingRounds: true },
  });
  const attempt = await db.entranceExamAttempt.create({
    data: {
      attemptNo: 'IMMUTABLE_ENTERED',
      examId: data.examId,
      examVersionId: old.id,
      paperId: old.papers[0]!.id,
      candidateUserId: f.manager.user.id,
      candidateUid: f.manager.user.uid,
      candidateName: '应试者',
      createdBy: f.manager.user.uid,
    },
  });
  question.questionFiles = [{ objectKey: record.objectKey, uploadedFileId: record.id } as never];
  question.referenceAnswer = '编辑后的答案';
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'PRODUCTION_TASK' },
  });
  const outcomes = await Promise.all([f.edit(data.examId, old.id), f.edit(data.examId, old.id)]);
  expect(outcomes.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(outcomes.find((r) => r.statusCode === 200)!.json().data.versionNo).toBe(2);
  expect(
    await db.entranceExamVersion.findUniqueOrThrow({
      where: { id: old.id },
      include: { papers: { include: { questions: true } }, gradingRounds: true },
    }),
  ).toEqual(old);
  expect(await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(
    attempt,
  );
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'PRODUCTION_TASK',
  );
  expect(await db.entranceExamVersion.count({ where: { examId: data.examId } })).toBe(2);
});
test('concurrent exam publishes enforce dynamic active cap and project name uniqueness across edits', async () => {
  const f = await examPublishFixture();
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { maxActiveExamCount: 1 },
  });
  const results = await Promise.all([
    f.publish(),
    f.publish({ ...f.payload, examName: '另一考试' }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.projectEntranceExam.count()).toBe(1);
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { maxActiveExamCount: 3 },
  });
  const first = results.find((r) => r.statusCode === 200)!.json().data;
  const same = await f.publish({ ...f.payload, examName: first.examName });
  expect(same.statusCode, same.body).toBe(409);
  const second = await f.publish({ ...f.payload, examName: '独立考试' });
  expect(second.statusCode, second.body).toBe(200);
  expect(
    (await f.edit(first.examId, first.currentVersionId, { examName: '独立考试' })).statusCode,
  ).toBe(409);
  expect(await db.entranceExamVersion.count()).toBe(2);
});
test('failed exam publish rolls back claimed files, config rows and node on duplicate attachment or invalid reviewer', async () => {
  const f = await examPublishFixture();
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.manager.user.uid);
  const question = f.payload.papers[0]!.questions[0]!;
  const attachment = { objectKey: record.objectKey, uploadToken };
  question.questionFiles = [attachment as never];
  question.referenceFiles = [attachment as never];
  const result = await f.publish();
  expect(result.statusCode, result.body).toBe(400);
  expect(await db.projectEntranceExam.count()).toBe(0);
  expect(await db.entranceExamVersion.count()).toBe(0);
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
    'UPLOADED',
  );
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).currentNodeCode).toBe(
    'ENTRANCE_EXAM',
  );
  question.referenceFiles = [];
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '切换当前视角不撤销阅卷资格',
  });
  await db.user.update({ where: { id: f.user.id }, data: { status: 'FROZEN' } });
  expect((await f.publish()).statusCode).toBe(400);
  expect(await db.projectEntranceExam.count()).toBe(0);
});
test('exam saves enforce production-plan, manager/handler separation, closed state, secret rejection and token ownership', async () => {
  const f = await examPublishFixture();
  expect((await f.publish(f.payload, f.handler.headers)).statusCode).toBe(403);
  expect((await f.publish(f.payload, f.headers)).statusCode).toBe(403);
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.handler.user.uid);
  const invalidFiles = structuredClone(f.payload);
  invalidFiles.papers[0]!.questions[0]!.questionFiles = [
    { objectKey: record.objectKey, uploadToken } as never,
  ];
  expect((await f.publish(invalidFiles)).statusCode).toBe(403);
  const secrets = await f.publish({
    ...f.payload,
    gradingRounds: [
      {
        gradingMode: 'AUTO',
        toolCode: 'test-agent',
        toolName: '测试工具',
        toolConfig: { nested: { token: 'forbidden' } },
      },
    ],
  });
  expect(secrets.statusCode).toBe(400);
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { needWrittenExam: false },
  });
  expect((await f.publish()).statusCode).toBe(400);
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { needWrittenExam: true },
  });
  const ok = await f.publish();
  expect(ok.statusCode, ok.body).toBe(200);
  const data = ok.json().data;
  await db.projectEntranceExam.update({ where: { id: data.examId }, data: { status: 'CLOSED' } });
  expect((await f.edit(data.examId, data.currentVersionId)).statusCode).toBe(400);
});
test('exam AUTO config and mixed-source decimals preserve old rounding and tool attachment snapshots without dispatch', async () => {
  const f = await examPublishFixture();
  const { record, uploadToken } = await uploaded('ENTRANCE_EXAM_ATTACHMENT', f.manager.user.uid);
  const body = {
    ...f.payload,
    fullScore: 1,
    passScore: 0.8,
    papers: [
      {
        questions: Array.from({ length: 3 }, () => ({
          questionContent: '题干',
          scoreSource: 'AUTO',
        })),
      },
    ],
    gradingRounds: [
      {
        gradingMode: 'AUTO',
        toolCode: 'agent-tool',
        toolName: '工具',
        toolConfig: ['非敏感参数'],
        toolFiles: [{ objectKey: record.objectKey, uploadToken }],
      },
    ],
  };
  const result = await f.publish(body);
  expect(result.statusCode, result.body).toBe(200);
  const version = await db.entranceExamVersion.findUniqueOrThrow({
    where: { id: result.json().data.currentVersionId },
    include: {
      papers: { include: { questions: { orderBy: { sequenceNo: 'asc' } } } },
      gradingRounds: true,
    },
  });
  expect(version.papers[0]!.questions.map((q) => q.score.toFixed(2))).toEqual([
    '0.33',
    '0.33',
    '0.34',
  ]);
  expect(version.gradingRounds[0]!.toolConfigJson).toMatchObject({
    config: ['非敏感参数'],
    files: [{ uploadedFileId: record.id, fileSize: record.fileSize }],
  });
  expect(version.gradingRounds[0]!.reviewersJson).toBeNull();
});

async function examReadFixture() {
  const f = await examPublishFixture();
  const published = await f.publish();
  expect(published.statusCode, published.body).toBe(200);
  const exam = published.json().data;
  const detail = (headers = f.manager.headers, examId = exam.examId) =>
    post('/entrance-exams/detail', { projectId: f.projectId, examId }, headers);
  const management = (headers = f.manager.headers) =>
    app.inject({ url: `/api/v1/entrance-exams/management?projectId=${f.projectId}`, headers });
  const roster = (body = {}, headers = f.manager.headers) =>
    post(
      '/entrance-exams/roster',
      { projectId: f.projectId, examId: exam.examId, ...body },
      headers,
    );
  const close = (closeReason: string | null = null, headers = f.manager.headers) =>
    post(
      '/entrance-exams/close',
      { projectId: f.projectId, examId: exam.examId, closeReason },
      headers,
    );
  return { ...f, exam, detail, management, roster, close };
}
async function readAttempt(
  f: Awaited<ReturnType<typeof examReadFixture>>,
  name: string,
  patch: Record<string, unknown> = {},
) {
  const paper = await db.entranceExamPaper.findFirstOrThrow({
    where: { examVersionId: f.exam.currentVersionId },
  });
  return db.entranceExamAttempt.create({
    data: {
      attemptNo: `READ_${name}`,
      examId: f.exam.examId,
      examVersionId: f.exam.currentVersionId,
      paperId: paper.id,
      candidateUserId: f.manager.user.id,
      candidateUid: f.manager.user.uid,
      candidateName: `快照${name}`,
      createdBy: f.manager.user.uid,
      enteredAt: new Date('2026-10-21T00:00:00Z'),
      ...patch,
    },
  });
}
test('exam read scope distinguishes primary PM, handler and configured navigator, retains historic review scope and rejects creator-only/revoked access', async () => {
  const f = await examReadFixture();
  for (const headers of [f.manager.headers, f.handler.headers, f.headers]) {
    expect((await f.detail(headers)).statusCode).toBe(200);
    expect((await f.management(headers)).statusCode).toBe(200);
    expect((await f.roster({}, headers)).statusCode).toBe(200);
  }
  expect((await f.management(f.handler.headers)).json().data).toMatchObject({
    canCreateExam: false,
    createDisabledReason: '阅卷人仅可查看考试信息',
  });
  const outsider = await projectManagerAccount(3);
  await selectFixtureRole({
    uid: outsider.user.uid,
    role: 'NAVIGATOR',
    action: 'GRANT',
    actor: 'integration-operator',
    reason: '验证双管理授权不替代阅卷指派',
  });
  expect((await f.detail(outsider.headers)).statusCode).toBe(403);
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId, {
    gradingRounds: [{ gradingMode: 'MANUAL', reviewerUserIds: [f.manager.user.id] }],
  });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await f.detail(f.headers)).statusCode).toBe(200);
  expect((await f.close()).statusCode).toBe(200);
  expect((await f.management(f.headers)).statusCode).toBe(200);
  await selectFixtureRole({
    uid: f.user.uid,
    role: 'NAVIGATOR',
    action: 'REVOKE',
    actor: 'integration-operator',
    reason: '验证只读授权撤销',
  });
  expect((await f.management(f.headers)).statusCode).toBe(403);
  await db.projectEntranceExam.update({ where: { id: f.exam.examId }, data: { deleted: true } });
  expect((await f.detail()).statusCode).toBe(404);
});
test('exam detail returns latest version, stable nested file snapshots and live reviewer name without mutating historical configuration', async () => {
  const f = await examReadFixture();
  const first = await f.detail();
  expect(first.statusCode, first.body).toBe(200);
  const oldRound = await db.entranceExamGradingRound.findFirstOrThrow({
    where: { examVersionId: f.exam.currentVersionId },
  });
  await db.user.update({
    where: { id: f.manager.user.id },
    data: { displayName: '详情实时昵称', realName: '详情实时姓名' },
  });
  const refreshed = await f.detail();
  expect(
    refreshed
      .json()
      .data.gradingRounds[0].reviewers.find(
        (r: { userId: string }) => r.userId === f.manager.user.id,
      ).name,
  ).toBe('详情实时昵称(详情实时姓名)');
  expect(
    (await db.entranceExamGradingRound.findUniqueOrThrow({ where: { id: oldRound.id } }))
      .reviewersJson,
  ).toEqual(oldRound.reviewersJson);
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId, { examName: '新版本详情' });
  expect(edited.statusCode, edited.body).toBe(200);
  const latest = await f.detail();
  expect(latest.json().data).toMatchObject({
    currentVersionId: edited.json().data.currentVersionId,
    versionNo: 2,
    examName: '新版本详情',
    durationMinutes: 60,
    fullScore: 20,
  });
  expect(latest.json().data.papers[0].paperId).not.toBe(first.json().data.papers[0].paperId);
  expect(latest.json().data.papers[0].questions[0].questionFiles).toBeNull();
  expect((await f.detail(f.manager.headers, 2147483647)).statusCode).toBe(404);
});
test('exam management counts submitted attempts only, rounds percentages and separates closed/deleted cards from ACTIVE capacity', async () => {
  const f = await examReadFixture();
  const submittedAt = new Date('2026-10-21T01:00:00Z');
  await readAttempt(f, 'PASS', { finalResult: 'ADMITTED', submittedAt });
  await readAttempt(f, 'FAIL', { finalResult: 'ELIMINATED', submittedAt });
  await readAttempt(f, 'PENDING', { finalResult: 'PENDING', submittedAt });
  await readAttempt(f, 'NOT_SUBMITTED', { finalResult: 'ADMITTED' });
  const initial = await f.management();
  expect(initial.statusCode, initial.body).toBe(200);
  expect(initial.json().data).toMatchObject({
    canCreateExam: true,
    exams: [{ examineeCount: 3, admittedCount: 1, admissionRate: 33.33 }],
  });
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { maxActiveExamCount: 1 },
  });
  expect((await f.management()).json().data).toMatchObject({
    canCreateExam: false,
    createDisabledReason: '进行中考试数量已达项目配置上限',
  });
  expect((await f.close()).statusCode).toBe(200);
  expect((await f.management()).json().data).toMatchObject({
    activeExamCount: 0,
    canCreateExam: true,
    exams: [{ status: 'CLOSED', examineeCount: 3 }],
  });
  await db.projectEntranceExam.update({ where: { id: f.exam.examId }, data: { deleted: true } });
  expect((await f.management()).json().data.exams).toEqual([]);
});
test('concurrent exam close has one winner, persists audit and preserves versions/attempts/files/project node; read-only users cannot close', async () => {
  const f = await examReadFixture();
  const attempt = await readAttempt(f, 'CLOSE_UNSUBMITTED');
  const before = await db.entranceExamVersion.findUniqueOrThrow({
    where: { id: f.exam.currentVersionId },
    include: { papers: { include: { questions: true } }, gradingRounds: true },
  });
  const project = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect((await f.close('拒绝协作负责人', f.handler.headers)).statusCode).toBe(403);
  expect((await f.close('拒绝NAV阅卷人', f.headers)).statusCode).toBe(403);
  const results = await Promise.all([f.close('  原因A  '), f.close('原因B')]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const stored = await db.projectEntranceExam.findUniqueOrThrow({ where: { id: f.exam.examId } });
  expect(['原因A', '原因B']).toContain(stored.closeReason);
  expect(stored.closedBy).toBe(f.manager.user.uid);
  expect(stored.closedAt).not.toBeNull();
  expect((await f.close()).statusCode).toBe(409);
  expect((await f.detail()).statusCode).toBe(400);
  expect((await f.edit(f.exam.examId, f.exam.currentVersionId)).statusCode).toBe(400);
  expect(
    await db.entranceExamVersion.findUniqueOrThrow({
      where: { id: before.id },
      include: { papers: { include: { questions: true } }, gradingRounds: true },
    }),
  ).toEqual(before);
  expect(await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(
    attempt,
  );
  expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
});
test('exam roster returns actual old-version scores and real-time names while filtering only submitted final results by snapshots', async () => {
  const f = await examReadFixture();
  const submittedAt = new Date('2026-10-21T01:00:00Z');
  const passed = await readAttempt(f, 'ROSTER_PASS', { finalResult: 'ADMITTED', submittedAt });
  await readAttempt(f, 'ROSTER_PENDING', { finalResult: 'PENDING', submittedAt });
  await readAttempt(f, 'ROSTER_UNSUBMITTED', { finalResult: 'PENDING' });
  const round = await db.entranceExamGradingRound.findFirstOrThrow({
    where: { examVersionId: passed.examVersionId! },
  });
  await db.entranceExamGradingRecord.create({
    data: {
      attemptId: passed.id,
      gradingRoundId: round.id,
      examVersionId: passed.examVersionId!,
      status: 'COMPLETED',
      score: 0,
      roundResult: 'ELIMINATED',
      reviewerUserId: f.manager.user.id,
      completedAt: submittedAt,
      createdBy: f.manager.user.uid,
    },
  });
  await db.user.update({
    where: { id: f.manager.user.id },
    data: { displayName: '花名册实时名', realName: '实时姓名' },
  });
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId);
  expect(edited.statusCode, edited.body).toBe(200);
  const all = await f.roster();
  expect(all.statusCode, all.body).toBe(200);
  expect(all.json().data.total).toBe(3);
  const record = all
    .json()
    .data.records.find((r: { attemptId: number }) => r.attemptId === passed.id);
  expect(record).toMatchObject({
    candidateName: '花名册实时名(实时姓名)',
    finalResult: 'ADMITTED',
    roundScores: [{ roundNo: 1, gradingMode: 'MANUAL', score: 0, roundResult: 'ELIMINATED' }],
  });
  expect(
    all.json().data.records.find((r: { submittedAt: string | null }) => !r.submittedAt).finalResult,
  ).toBeNull();
  expect((await f.roster({ finalResult: 'PENDING' })).json().data.total).toBe(1);
  expect((await f.roster({ keyword: '快照ROSTER_PASS' })).json().data.total).toBe(1);
  expect((await f.roster({ keyword: '花名册实时名' })).json().data.total).toBe(0);
  expect((await f.roster({ current: -1, size: 500 })).json().data).toMatchObject({
    current: 1,
    size: 100,
    total: 3,
  });
  expect((await f.roster({ current: 2147483648 })).json().data).toMatchObject({
    total: 3,
    records: [],
  });
  expect((await f.close()).statusCode).toBe(200);
  expect((await f.roster({}, f.handler.headers)).statusCode).toBe(200);
});
test('grading record source constraints reject foreign-version rounds, unentered attempts and duplicate records while retaining zero scores', async () => {
  const f = await examReadFixture();
  const attempt = await readAttempt(f, 'GRADE_SOURCE');
  const round = await db.entranceExamGradingRound.findFirstOrThrow({
    where: { examVersionId: attempt.examVersionId! },
  });
  const data = {
    attemptId: attempt.id,
    gradingRoundId: round.id,
    examVersionId: attempt.examVersionId!,
    createdBy: f.manager.user.uid,
  };
  const record = await db.entranceExamGradingRecord.create({ data: { ...data, score: 0 } });
  expect(record.score?.toNumber()).toBe(0);
  await expect(db.entranceExamGradingRecord.create({ data })).rejects.toMatchObject({
    code: 'P2002',
  });
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId);
  const newRound = await db.entranceExamGradingRound.findFirstOrThrow({
    where: { examVersionId: edited.json().data.currentVersionId },
  });
  await expect(
    db.entranceExamGradingRecord.create({ data: { ...data, gradingRoundId: newRound.id } }),
  ).rejects.toMatchObject({ code: 'P2003' });
  const unentered = await readAttempt(f, 'GRADE_UNENTERED', {
    examVersionId: null,
    paperId: null,
    enteredAt: null,
  });
  await expect(
    db.entranceExamGradingRecord.create({ data: { ...data, attemptId: unentered.id } }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.$executeRaw`UPDATE "EntranceExamGradingRecord" SET "score" = -1 WHERE "id" = ${record.id}`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "EntranceExamGradingRecord" SET "status" = 'UNKNOWN' WHERE "id" = ${record.id}`,
  ).rejects.toThrow();
});

test('unified expert creates multiple enabled organizations while belonging to another; duplicate concurrent create has one winner', async () => {
  const user = (await register()).json().data;
  const headers = bearer((await login(desktop)).json().data.accessToken);
  const foreign = await db.organization.create({ data: { name: '已加入组织', expertiseTags: [] } });
  await db.userOrgRel.create({
    data: { userId: user.id, uid: user.uid, orgId: foreign.id, position: 'MEMBER' },
  });
  for (const name of ['新组织甲', '新组织乙']) {
    const created = await post('/organizations', { name }, headers);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data).toMatchObject({
      verifyStatus: 'APPROVED',
      status: 'ACTIVE',
      position: 'OWNER',
    });
  }
  const race = await Promise.all([
    post('/organizations', { name: '并发新组织' }, headers),
    post('/organizations', { name: '并发新组织' }, headers),
  ]);
  expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(
    await db.userOrgRel.count({
      where: { userId: user.id, position: 'OWNER', joinStatus: 'ACTIVE' },
    }),
  ).toBe(3);
  const me = (await app.inject({ url: '/api/v1/users/me', headers })).json().data;
  expect(me.organizations).toHaveLength(4);
  expect(me.roles).toEqual(['NAVIGATOR', 'PM', 'EXPERT']);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).accountType).toBe(
    'INDIVIDUAL',
  );
});
test('membership persistence failure rolls back newly created organization and its license claim without deleting account', async () => {
  const user = (await register()).json().data;
  const tokens = (await login(desktop)).json().data;
  const upload = await uploaded();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'userOrgRel')
                    return {
                      ...transaction.userOrgRel,
                      create: async () => {
                        throw new Error('injected membership failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new AuthService(failing, config, undefined, registry).createOrganization(
      tokens.accessToken,
      'desktop',
      {
        name: '回滚组织',
        businessLicense: { objectKey: upload.record.objectKey, uploadToken: upload.uploadToken },
      },
    ),
  ).rejects.toThrow('injected membership failure');
  expect(await db.organization.count({ where: { name: '回滚组织' } })).toBe(0);
  expect(await db.userOrgRel.count({ where: { userId: user.id } })).toBe(0);
  expect(
    (await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } })).status,
  ).toBe('UPLOADED');
  expect(await db.user.count({ where: { id: user.id } })).toBe(1);
});

const admissionPage = (
  projectId: number,
  headers: Record<string, string>,
  query: Record<string, string | number> = {},
) =>
  app.inject({
    url: `/api/v1/entrance-exams/admissions?${new URLSearchParams({ projectId: String(projectId), ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`,
    headers,
  });

test('admissions database pagination distinguishes all five states, history names, snapshot search, unsubmitted and deleted exams', async () => {
  const f = await examReadFixture();
  const submittedAt = new Date('2026-10-22T01:00:00Z');
  const pending = await readAttempt(f, 'ADMISSION_PENDING', { submittedAt });
  const failed = await readAttempt(f, 'ADMISSION_FAILED', {
    finalResult: 'ELIMINATED',
    submittedAt,
  });
  const waiting = await readAttempt(f, 'ADMISSION_WAITING', {
    finalResult: 'ADMITTED',
    submittedAt,
  });
  const joined = await readAttempt(f, 'ADMISSION_JOINED', { finalResult: 'ADMITTED', submittedAt });
  const declined = await readAttempt(f, 'ADMISSION_DECLINED', {
    finalResult: 'ADMITTED',
    submittedAt,
  });
  await readAttempt(f, 'ADMISSION_UNSUBMITTED');
  for (const [attempt, status, joinedAt] of [
    [pending, 'ENTRY_DECLINED', submittedAt],
    [failed, 'ACTIVE', submittedAt],
    [joined, 'LEFT', submittedAt],
    [declined, 'ENTRY_DECLINED', submittedAt],
  ] as const)
    await db.projectMember.create({
      data: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        admissionAttemptId: attempt.id,
        status,
        joinedAt,
        createdBy: f.manager.user.uid,
      },
    });
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId, { examName: '改名后的考试' });
  expect(edited.statusCode, edited.body).toBe(200);
  const historical = await db.entranceExamVersion.findUniqueOrThrow({
    where: { id: f.exam.currentVersionId },
  });
  await db.user.update({
    where: { id: f.manager.user.id },
    data: { displayName: '实时准入姓名', realName: '真实姓名' },
  });
  const expected = {
    PENDING: pending.id,
    ELIMINATED: failed.id,
    PENDING_ENTRY: waiting.id,
    ADMITTED: joined.id,
    ENTRY_DECLINED: declined.id,
  };
  for (const [admissionStatus, attemptId] of Object.entries(expected)) {
    const result = await admissionPage(f.projectId, f.manager.headers, { admissionStatus });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({
      total: 1,
      records: [
        {
          attemptId,
          admissionStatus,
          examName: historical.examNameSnapshot,
          candidateName: '实时准入姓名(真实姓名)',
          organizationId: null,
          employmentType: null,
        },
      ],
    });
  }
  const first = await admissionPage(f.projectId, f.handler.headers, { size: 2 });
  expect(first.json().data).toMatchObject({
    total: 5,
    pages: 3,
    records: [{ attemptId: declined.id }, { attemptId: joined.id }],
  });
  expect(
    (await admissionPage(f.projectId, f.headers, { current: 4, size: 2 })).json().data.records,
  ).toEqual([]);
  expect(
    (
      await admissionPage(f.projectId, f.manager.headers, { keyword: '  快照ADMISSION_WAITING  ' })
    ).json().data.total,
  ).toBe(1);
  expect(
    (await admissionPage(f.projectId, f.manager.headers, { keyword: '实时准入姓名' })).json().data
      .total,
  ).toBe(0);
  const second = await f.publish({ ...f.payload, examName: '第二场考试' });
  expect(second.statusCode, second.body).toBe(200);
  await readAttempt({ ...f, exam: second.json().data }, 'ADMISSION_SECOND', { submittedAt });
  expect((await f.close()).statusCode).toBe(200);
  expect((await admissionPage(f.projectId, f.headers)).json().data.total).toBe(6);
  await db.projectEntranceExam.update({ where: { id: f.exam.examId }, data: { deleted: true } });
  expect((await admissionPage(f.projectId, f.manager.headers)).json().data).toMatchObject({
    total: 1,
    records: [{ examId: second.json().data.examId }],
  });
});

test('admissions restrict EXPERT to accepted managed organizations and revoke legacy owner fallback as soon as owner history exists', async () => {
  const f = await examReadFixture();
  const owner = await projectTestAccount('13610000001');
  const organization = await db.organization.create({
    data: { name: '准入隔离组织', expertiseTags: [] },
  });
  const org = { owner: owner.user, headers: owner.headers, orgId: organization.id };
  await db.userOrgRel.create({
    data: { userId: owner.user.id, uid: owner.user.uid, orgId: org.orgId, position: 'OWNER' },
  });
  const account = await projectManagerAccount(4, 100, false);
  const rel = await db.userOrgRel.create({
    data: { userId: account.user.id, uid: account.user.uid, orgId: org.orgId },
  });
  const other = { ...account, rel };
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'ADMISSION-ORG',
      projectId: f.projectId,
      subjectType: 'ORGANIZATION',
      organizationId: org.orgId,
      projectOwnerUserId: other.user.id,
      status: 'ACCEPTED',
      createdBy: org.owner.uid,
    },
  });
  await db.userOrgRel.update({
    where: { id: other.rel.id },
    data: { employmentType: 'PART_TIME' },
  });
  const orgAttempt = await readAttempt(f, 'ADMISSION_ORG', {
    submittedAt: new Date(),
    candidateUserId: other.user.id,
    candidateUid: other.user.uid,
    organizationId: org.orgId,
    organizationName: '组织快照',
    userOrgRelId: other.rel.id,
  });
  await readAttempt(f, 'ADMISSION_PERSONAL', { submittedAt: new Date() });
  for (const headers of [org.headers, other.headers]) {
    const result = await admissionPage(f.projectId, headers);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({
      total: 1,
      records: [
        { attemptId: orgAttempt.id, organizationId: org.orgId, employmentType: 'PART_TIME' },
      ],
    });
  }
  const secondOrg = await db.organization.create({
    data: { name: '另一个已接单组织', expertiseTags: [] },
  });
  const secondRel = await db.userOrgRel.create({
    data: {
      userId: owner.user.id,
      uid: owner.user.uid,
      orgId: secondOrg.id,
      position: 'OWNER',
      joinStatus: 'PENDING_LEAVE',
    },
  });
  await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'ADMISSION-ORG-SECOND',
      projectId: f.projectId,
      subjectType: 'ORGANIZATION',
      organizationId: secondOrg.id,
      status: 'ACCEPTED',
      createdBy: owner.user.uid,
    },
  });
  await readAttempt(f, 'ADMISSION_ORG_SECOND', {
    submittedAt: new Date(),
    candidateUserId: owner.user.id,
    candidateUid: owner.user.uid,
    organizationId: secondOrg.id,
    userOrgRelId: secondRel.id,
  });
  expect((await admissionPage(f.projectId, org.headers)).json().data.total).toBe(2);
  expect((await admissionPage(f.projectId, other.headers)).json().data.total).toBe(1);
  await db.userOrgRel.update({ where: { id: secondRel.id }, data: { joinStatus: 'LEFT' } });
  expect((await admissionPage(f.projectId, org.headers)).json().data.total).toBe(1);
  const history = await db.projectExpertAssignmentOwner.create({
    data: {
      assignmentId: assignment.id,
      userId: other.user.id,
      status: 'REMOVED',
      createdBy: org.owner.uid,
    },
  });
  expect((await admissionPage(f.projectId, other.headers)).statusCode).toBe(403);
  await db.projectExpertAssignmentOwner.update({
    where: { id: history.id },
    data: { status: 'ACTIVE' },
  });
  expect((await admissionPage(f.projectId, other.headers)).json().data.total).toBe(1);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'REJECTED' },
  });
  expect((await admissionPage(f.projectId, org.headers)).statusCode).toBe(403);
  expect((await admissionPage(f.projectId, other.headers)).statusCode).toBe(403);
  const outsider = await projectManagerAccount(3);
  expect((await admissionPage(f.projectId, outsider.headers)).statusCode).toBe(403);
});

async function gradingDetailFixture() {
  const f = await examReadFixture();
  const attempt = await readAttempt(f, 'GRADING_DETAIL', {
    submittedAt: new Date(),
    gradingStatus: 'IN_PROGRESS',
  });
  const question = await db.entranceExamQuestion.findFirstOrThrow({
    where: { paperId: attempt.paperId! },
  });
  await db.entranceExamQuestion.update({ where: { id: question.id }, data: { score: 10 } });
  const unanswered = await db.entranceExamQuestion.create({
    data: {
      paperId: attempt.paperId!,
      sequenceNo: 2,
      score: 10,
      questionContent: '尚未作答的题目',
      createdBy: f.manager.user.uid,
    },
  });
  const otherPaper = await db.entranceExamPaper.create({
    data: {
      examVersionId: attempt.examVersionId!,
      sequenceNo: 2,
      totalScore: 20,
      createdBy: f.manager.user.uid,
      questions: {
        create: {
          sequenceNo: 1,
          score: 20,
          questionContent: '不属于实际作答试卷',
          createdBy: f.manager.user.uid,
        },
      },
    },
    include: { questions: true },
  });
  const round = await db.entranceExamGradingRound.findFirstOrThrow({
    where: { examVersionId: attempt.examVersionId! },
  });
  const secondRound = await db.entranceExamGradingRound.create({
    data: {
      examVersionId: attempt.examVersionId!,
      roundNo: 2,
      gradingMode: 'AUTO',
      toolCode: 'example-tool',
      toolName: '示例工具',
      createdBy: f.manager.user.uid,
    },
  });
  await db.entranceExamVersion.update({
    where: { id: attempt.examVersionId! },
    data: { tieBreakRule: 'STRICT' },
  });
  const answer = await db.entranceExamAnswer.create({
    data: {
      attemptId: attempt.id,
      paperId: attempt.paperId!,
      questionId: question.id,
      answerContent: '真实答案',
      answerFilesJson: [
        {
          objectKey: 'entrance-exam-attachment/example.txt',
          fileName: 'answer.txt',
          custom: { kept: true },
        },
      ],
      answeredFlag: true,
      createdBy: f.manager.user.uid,
    },
  });
  const firstRecord = await db.entranceExamGradingRecord.create({
    data: {
      attemptId: attempt.id,
      examVersionId: attempt.examVersionId!,
      gradingRoundId: round.id,
      status: 'COMPLETED',
      score: 0,
      roundResult: 'ELIMINATED',
      conclusionSummary: '第一轮未通过',
      createdBy: f.manager.user.uid,
    },
  });
  const secondRecord = await db.entranceExamGradingRecord.create({
    data: {
      attemptId: attempt.id,
      examVersionId: attempt.examVersionId!,
      gradingRoundId: secondRound.id,
      status: 'FAILED',
      errorMessage: '示例工具失败',
      createdBy: f.manager.user.uid,
    },
  });
  await db.entranceExamGradingItem.create({
    data: {
      gradingRecordId: firstRecord.id,
      attemptId: attempt.id,
      questionId: question.id,
      answerId: answer.id,
      correctness: 'INCORRECT',
      gradingOpinion: '第一轮意见',
      createdBy: f.manager.user.uid,
    },
  });
  await db.entranceExamGradingItem.create({
    data: {
      gradingRecordId: secondRecord.id,
      attemptId: attempt.id,
      questionId: question.id,
      answerId: answer.id,
      correctness: 'CORRECT',
      gradingOpinion: '第二轮意见',
      createdBy: f.manager.user.uid,
    },
  });
  const gradingDetail = (patch = {}, headers = f.manager.headers) =>
    post(
      '/entrance-exams/grading/detail',
      { projectId: f.projectId, examId: f.exam.examId, attemptId: attempt.id, ...patch },
      headers,
    );
  return {
    ...f,
    attempt,
    question,
    unanswered,
    otherPaper,
    round,
    secondRound,
    answer,
    firstRecord,
    secondRecord,
    gradingDetail,
  };
}

test('grading detail retains historical paper/reference/pass-score and per-round answers after edit and close, with no read side effects', async () => {
  const f = await gradingDetailFixture();
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId, {
    passScore: 18,
    papers: [
      {
        questions: [
          {
            questionContent: '新版题干',
            score: 20,
            scoreSource: 'MANUAL',
            referenceAnswer: '新版参考答案',
          },
        ],
      },
    ],
    gradingRounds: [{ gradingMode: 'MANUAL', reviewerUserIds: [f.manager.user.id] }],
  });
  expect(edited.statusCode, edited.body).toBe(200);
  await db.user.update({
    where: { id: f.manager.user.id },
    data: { displayName: '阅卷详情实时名', realName: '实时姓名' },
  });
  expect((await f.close()).statusCode).toBe(200);
  const snapshot = async () => ({
    attempt: await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } }),
    answers: await db.entranceExamAnswer.findMany({ orderBy: { id: 'asc' } }),
    records: await db.entranceExamGradingRecord.findMany({ orderBy: { id: 'asc' } }),
    items: await db.entranceExamGradingItem.findMany({ orderBy: { id: 'asc' } }),
  });
  const before = await snapshot();
  for (const headers of [f.manager.headers, f.handler.headers, f.headers]) {
    const result = await f.gradingDetail({}, headers);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({
      candidateName: '阅卷详情实时名(实时姓名)',
      passScore: 12,
      gradingStatus: 'IN_PROGRESS',
      finalResult: 'PENDING',
      rounds: [{ score: 0, roundResult: 'ELIMINATED' }, { errorMessage: '示例工具失败' }],
      selectedRound: { gradingRoundId: f.round.id, gradingRecordId: f.firstRecord.id, score: 0 },
      questions: [
        {
          questionId: f.question.id,
          score: 10,
          referenceAnswer: f.question.referenceAnswer,
          answerId: f.answer.id,
          answerContent: '真实答案',
          answerFiles: f.answer.answerFilesJson,
          answeredFlag: true,
          correctness: 'INCORRECT',
          gradingOpinion: '第一轮意见',
        },
        { questionId: f.unanswered.id, answerId: null, answeredFlag: false, correctness: null },
      ],
    });
    expect(result.json().data.questions).toHaveLength(2);
  }
  expect((await f.gradingDetail({ roundNo: 2 })).json().data).toMatchObject({
    selectedRound: {
      gradingRecordId: f.secondRecord.id,
      status: 'FAILED',
      errorMessage: '示例工具失败',
    },
    questions: [{ correctness: 'CORRECT', gradingOpinion: '第二轮意见' }, { correctness: null }],
  });
  expect((await f.gradingDetail({ roundNo: null })).json().data.selectedRound.roundNo).toBe(1);
  expect(await snapshot()).toEqual(before);
});

test('grading detail returns truthful missing records before submission and rejects unbound, foreign, nonexistent or unauthorized sources', async () => {
  const f = await gradingDetailFixture();
  const empty = await readAttempt(f, 'GRADING_DETAIL_EMPTY');
  const result = await f.gradingDetail({ attemptId: empty.id });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({
    gradingStatus: 'NOT_STARTED',
    finalResult: 'PENDING',
    selectedRound: { gradingRecordId: null, status: null, score: null },
    questions: [
      { answerId: null, answeredFlag: false, correctness: null },
      { answerId: null, answeredFlag: false, correctness: null },
    ],
  });
  expect(await db.entranceExamGradingRecord.count()).toBe(2);
  const unbound = await readAttempt(f, 'GRADING_DETAIL_UNBOUND', {
    examVersionId: null,
    paperId: null,
    enteredAt: null,
  });
  expect((await f.gradingDetail({ attemptId: unbound.id })).statusCode).toBe(400);
  expect((await f.gradingDetail({ attemptId: 2147483647 })).statusCode).toBe(404);
  expect((await f.gradingDetail({ roundNo: 3 })).statusCode).toBe(400);
  const foreign = await f.publish({ ...f.payload, examName: '其他考试阅卷' });
  expect(foreign.statusCode, foreign.body).toBe(200);
  expect((await f.gradingDetail({ examId: foreign.json().data.examId })).statusCode).toBe(404);
  const outsider = await projectManagerAccount(3);
  expect((await f.gradingDetail({}, outsider.headers)).statusCode).toBe(403);
  const expert = await projectTestAccount('13610000002');
  expect((await f.gradingDetail({}, expert.headers)).statusCode).toBe(403);
  await db.entranceExamGradingRound.updateMany({
    where: { examVersionId: f.exam.currentVersionId },
    data: {
      reviewersJson: [{ userId: f.manager.user.id, uid: f.manager.user.uid, name: '策略官' }],
    },
  });
  // foreign考试仍配置了f.user，删除该考试后不能借其阅卷池读取本项目答案。
  await db.projectEntranceExam.update({
    where: { id: foreign.json().data.examId },
    data: { deleted: true },
  });
  expect((await f.gradingDetail({}, f.headers)).statusCode).toBe(403);
});

test('grading detail source constraints reject cross-paper answers, cross-attempt/question items, duplicates, invalid correctness and source deletion', async () => {
  const f = await gradingDetailFixture();
  const otherAttempt = await readAttempt(f, 'GRADING_DETAIL_OTHER', { submittedAt: new Date() });
  const otherAnswer = await db.entranceExamAnswer.create({
    data: {
      attemptId: otherAttempt.id,
      paperId: otherAttempt.paperId!,
      questionId: f.unanswered.id,
      answeredFlag: false,
      createdBy: f.manager.user.uid,
    },
  });
  const answerData = {
    attemptId: f.attempt.id,
    paperId: f.attempt.paperId!,
    questionId: f.unanswered.id,
    createdBy: f.manager.user.uid,
  };
  await expect(
    db.entranceExamAnswer.create({
      data: { ...answerData, questionId: f.otherPaper.questions[0]!.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.entranceExamAnswer.create({
      data: { ...answerData, paperId: f.otherPaper.id, questionId: f.otherPaper.questions[0]!.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.entranceExamAnswer.create({ data: { ...answerData, questionId: f.question.id } }),
  ).rejects.toMatchObject({ code: 'P2002' });
  const secondAnswer = await db.entranceExamAnswer.create({ data: answerData });
  const itemData = {
    gradingRecordId: f.firstRecord.id,
    attemptId: f.attempt.id,
    questionId: f.unanswered.id,
    answerId: secondAnswer.id,
    createdBy: f.manager.user.uid,
  };
  await expect(
    db.entranceExamGradingItem.create({ data: { ...itemData, answerId: otherAnswer.id } }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.entranceExamGradingItem.create({
      data: { ...itemData, attemptId: otherAttempt.id, answerId: otherAnswer.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.entranceExamGradingItem.create({ data: { ...itemData, answerId: f.answer.id } }),
  ).rejects.toMatchObject({ code: 'P2003' });
  const stored = await db.entranceExamGradingItem.create({ data: itemData });
  expect(stored.correctness).toBe('PENDING');
  await expect(db.entranceExamGradingItem.create({ data: itemData })).rejects.toMatchObject({
    code: 'P2002',
  });
  await expect(
    db.entranceExamGradingItem.update({
      where: { id: stored.id },
      data: { correctness: 'UNKNOWN' },
    }),
  ).rejects.toThrow();
  expect(
    (await db.entranceExamGradingItem.findUniqueOrThrow({ where: { id: stored.id } })).correctness,
  ).toBe('PENDING');
  const snapshot = async () => ({
    attempt: await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } }),
    answers: await db.entranceExamAnswer.findMany({
      where: { attemptId: f.attempt.id },
      orderBy: { id: 'asc' },
    }),
    records: await db.entranceExamGradingRecord.findMany({
      where: { attemptId: f.attempt.id },
      orderBy: { id: 'asc' },
    }),
    items: await db.entranceExamGradingItem.findMany({
      where: { attemptId: f.attempt.id },
      orderBy: { id: 'asc' },
    }),
  });
  const before = await snapshot();
  // RESTRICT的SQLSTATE 23001可能未映射为P2003；必须命中具体外键，其他删除错误仍然失败。
  await expect(db.entranceExamAnswer.delete({ where: { id: f.answer.id } })).rejects.toMatchObject({
    message: expect.stringContaining('EntranceExamGradingItem_answerId_attemptId_questionId_fkey'),
  });
  expect(await snapshot()).toEqual(before);
});

// 人工写链路专用准备；不复用真实HTTP读取夹具，也不代表08交卷入口已经实现。
async function manualGradingFixture() {
  const f = await gradingDetailFixture();
  await db.entranceExamGradingRecord.update({
    where: { id: f.firstRecord.id },
    data: { status: 'PENDING', score: null, roundResult: null },
  });
  await db.entranceExamGradingRecord.update({
    where: { id: f.secondRecord.id },
    data: { status: 'WAITING', errorMessage: null },
  });
  await db.entranceExamGradingItem.updateMany({
    where: { attemptId: f.attempt.id },
    data: { correctness: 'PENDING', gradingOpinion: null },
  });
  const secondAnswer = await db.entranceExamAnswer.create({
    data: {
      attemptId: f.attempt.id,
      paperId: f.attempt.paperId!,
      questionId: f.unanswered.id,
      answeredFlag: false,
      createdBy: f.manager.user.uid,
    },
  });
  for (const record of [f.firstRecord, f.secondRecord])
    await db.entranceExamGradingItem.create({
      data: {
        gradingRecordId: record.id,
        attemptId: f.attempt.id,
        questionId: f.unanswered.id,
        answerId: secondAnswer.id,
        createdBy: f.manager.user.uid,
      },
    });
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MANUAL-SOURCE',
      projectId: f.projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: f.manager.user.id,
      status: 'ACCEPTED',
      createdBy: f.manager.user.uid,
    },
  });
  await db.entranceExamAttempt.update({
    where: { id: f.attempt.id },
    data: { sourceBizId: assignment.id },
  });
  const body = {
    projectId: f.projectId,
    examId: f.exam.examId,
    attemptId: f.attempt.id,
    gradingRecordId: f.firstRecord.id,
    items: [
      { questionId: f.question.id, correctness: 'CORRECT' },
      { questionId: f.unanswered.id, correctness: 'CORRECT', gradingOpinion: '  完整  ' },
    ],
  };
  const manual = (patch = {}, headers = f.manager.headers) =>
    post('/entrance-exams/grading/manual', { ...body, ...patch }, headers);
  return { ...f, assignment, body, manual };
}
test('manual grading serializes competing reviewers, activates only the next manual round, preserves history and decides membership once', async () => {
  const f = await manualGradingFixture();
  await db.entranceExamGradingRound.update({
    where: { id: f.secondRound.id },
    data: { gradingMode: 'MANUAL', reviewersJson: [{ userId: f.user.id }] },
  });
  const edited = await f.edit(f.exam.examId, f.exam.currentVersionId, { passScore: 20 });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await f.close()).statusCode).toBe(200);
  const competing = await Promise.all([f.manual(), f.manual({}, f.headers)]);
  expect(competing.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const first = competing.find((r) => r.statusCode === 200)!;
  expect(first.json().data).toMatchObject({
    score: 20,
    roundResult: 'ADMITTED',
    gradingStatus: 'IN_PROGRESS',
    finalResult: 'PENDING',
  });
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .status,
  ).toBe('PENDING');
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(0);
  expect(
    await db.projectRoleNodeSnapshot.findFirst({
      where: {
        projectId: f.projectId,
        userId: f.user.id,
        sourceBizId: f.secondRecord.id,
        branchNodeCode: 'ENTRANCE_EXAM_GRADING',
      },
    }),
  ).not.toBeNull();
  expect((await f.manual({ gradingRecordId: f.secondRecord.id })).statusCode).toBe(403);
  const final = await f.manual(
    {
      gradingRecordId: f.secondRecord.id,
      items: f.body.items.map((i) => ({ ...i, correctness: 'INCORRECT' })),
    },
    f.headers,
  );
  expect(final.statusCode, final.body).toBe(200);
  expect(final.json().data).toMatchObject({
    score: 0,
    finalResult: 'ELIMINATED',
    gradingStatus: 'COMPLETED',
  });
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(0);
  expect(
    await db.projectRoleNodeSnapshot.count({
      where: { projectId: f.projectId, sourceBizType: 'GRADING_RECORD' },
    }),
  ).toBe(0);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, status: 'OPEN', taskType: 'ENTRANCE_EXAM_GRADING' },
    }),
  ).toBe(0);
  expect(
    await db.projectEventOutbox.count({
      where: { projectId: f.projectId, eventType: 'EXAM_RESULT_DECIDED' },
    }),
  ).toBe(1);
});
test('manual grading final admission creates a pending member with validated assignment and repeated submit cannot duplicate it', async () => {
  const f = await manualGradingFixture();
  await db.entranceExamGradingItem.deleteMany({ where: { gradingRecordId: f.secondRecord.id } });
  await db.entranceExamGradingRecord.delete({ where: { id: f.secondRecord.id } });
  await db.entranceExamGradingRound.delete({ where: { id: f.secondRound.id } });
  const response = await f.manual();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.finalResult).toBe('ADMITTED');
  expect(
    await db.projectMember.findUnique({ where: { admissionAttemptId: f.attempt.id } }),
  ).toMatchObject({
    projectId: f.projectId,
    userId: f.manager.user.id,
    expertAssignmentId: f.assignment.id,
    status: 'PENDING_CONFIRM',
    joinedAt: null,
  });
  expect((await f.manual()).statusCode).toBe(409);
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(1);
});
test('manual grading rejects wrong round/user/attempt, WAITING and incomplete or foreign question sets without writes', async () => {
  const f = await manualGradingFixture();
  expect((await f.manual({}, f.handler.headers)).statusCode).toBe(403);
  expect((await f.manual({ attemptId: 2147483647 })).statusCode).toBe(404);
  expect((await f.manual({ gradingRecordId: f.secondRecord.id })).statusCode).toBe(400);
  for (const items of [
    f.body.items.slice(0, 1),
    [f.body.items[0], f.body.items[0]],
    [{ questionId: f.otherPaper.questions[0]!.id, correctness: 'CORRECT' }, f.body.items[1]],
  ])
    expect((await f.manual({ items })).statusCode).toBe(400);
  await db.entranceExamAttempt.update({ where: { id: f.attempt.id }, data: { submittedAt: null } });
  expect((await f.manual()).statusCode).toBe(400);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.firstRecord.id } }))
      .status,
  ).toBe('PENDING');
  expect(
    await db.entranceExamGradingItem.count({
      where: { attemptId: f.attempt.id, correctness: { not: 'PENDING' } },
    }),
  ).toBe(0);
});
test('manual grading next AUTO only persists mock dispatch intent without pretending execution; later transaction failure rolls everything back', async () => {
  const f = await manualGradingFixture();
  const beforeEvents = await db.projectEventOutbox.count();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'projectEventOutbox')
                    return {
                      ...transaction.projectEventOutbox,
                      create: async () => {
                        throw new Error('injected grading outbox failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new ExamGradingCommandService(failing).manual(f.body as never, {
      userId: f.manager.user.id,
      uid: f.manager.user.uid,
      role: 'PM',
      sessionId: 'test',
      clientType: 'desktop',
    }),
  ).rejects.toThrow('injected grading outbox failure');
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.firstRecord.id } }))
      .status,
  ).toBe('PENDING');
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .status,
  ).toBe('WAITING');
  expect(
    await db.entranceExamGradingItem.count({
      where: { attemptId: f.attempt.id, correctness: { not: 'PENDING' } },
    }),
  ).toBe(0);
  expect(await db.projectEventOutbox.count()).toBe(beforeEvents);
  const ok = await f.manual();
  expect(ok.statusCode, ok.body).toBe(200);
  const dispatch = await db.projectEventOutbox.findFirstOrThrow({
    where: { projectId: f.projectId, eventType: 'EXAM_AUTO_DISPATCH_REQUESTED' },
  });
  expect(dispatch.payload).toMatchObject({
    gradingRecordId: f.secondRecord.id,
    provider: 'mock',
    executionStatus: 'NOT_EXECUTED',
  });
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .status,
  ).toBe('PENDING');
});
test('manual grading missing accepted admission source rolls back final result and item writes', async () => {
  const f = await manualGradingFixture();
  await db.entranceExamGradingItem.deleteMany({ where: { gradingRecordId: f.secondRecord.id } });
  await db.entranceExamGradingRecord.delete({ where: { id: f.secondRecord.id } });
  await db.entranceExamGradingRound.delete({ where: { id: f.secondRound.id } });
  await db.entranceExamAttempt.update({ where: { id: f.attempt.id }, data: { sourceBizId: null } });
  expect((await f.manual()).statusCode).toBe(500);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.firstRecord.id } }))
      .status,
  ).toBe('PENDING');
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalResult,
  ).toBe('PENDING');
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(0);
  expect(
    await db.entranceExamGradingItem.count({
      where: { attemptId: f.attempt.id, correctness: { not: 'PENDING' } },
    }),
  ).toBe(0);
});

async function autoGradingFixture() {
  const f = await manualGradingFixture();
  const submitted = await f.manual();
  expect(submitted.statusCode, submitted.body).toBe(200);
  const auto = new ExamAutoService(db);
  const locator = {
    projectId: f.projectId,
    examId: f.exam.examId,
    gradingRecordId: f.secondRecord.id,
  };
  const compensate = (patch = {}) =>
    post(
      '/entrance-exams/grading/auto/compensate',
      { ...locator, items: f.body.items, compensationReason: '模拟复核', ...patch },
      f.manager.headers,
    );
  return { ...f, auto, locator, compensate };
}
async function autoHttpCallback(input: AutoCallbackInput) {
  const raw = JSON.stringify(input),
    timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: 'POST',
    url: autoCallbackPath,
    headers: {
      'content-type': 'application/json',
      'x-agent-timestamp': timestamp,
      'x-agent-signature': signAutoCallback(autoTestSecret, timestamp, raw),
    },
    payload: raw,
  });
}
test('auto grading mock claims once under concurrency, signs HTTP callback, finalizes and accepts only identical replay', async () => {
  const f = await autoGradingFixture();
  const claims = await Promise.all([
    f.auto.claim(f.secondRecord.id),
    f.auto.claim(f.secondRecord.id),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const input = { ...claims.find(Boolean)!, items: f.body.items } as AutoCallbackInput;
  const completed = await autoHttpCallback(input);
  expect(completed.statusCode, completed.body).toBe(200);
  expect(completed.json().data).toMatchObject({
    score: 20,
    finalResult: 'ADMITTED',
    recordStatus: 'COMPLETED',
  });
  const events = await db.projectEventOutbox.count();
  expect((await autoHttpCallback(input)).statusCode).toBe(200);
  expect(await db.projectEventOutbox.count()).toBe(events);
  expect((await autoHttpCallback({ ...input, summary: '篡改' })).statusCode).toBe(409);
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(1);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .callbackDigest,
  ).toMatch(/^[0-9a-f]{64}$/);
});
test('auto grading mock failure stays blocked, retry resets all temporary state and rejects late prior execution', async () => {
  const f = await autoGradingFixture();
  let old: AutoCallbackInput | undefined;
  await f.auto.executeMock(f.secondRecord.id, 'failed', async (input) => {
    old = input;
    const result = await autoHttpCallback(input);
    expect(result.statusCode, result.body).toBe(200);
  });
  const failed = await db.entranceExamGradingRecord.findUniqueOrThrow({
    where: { id: f.secondRecord.id },
  });
  expect(failed.status).toBe('FAILED');
  expect((await autoHttpCallback(old!)).statusCode).toBe(200);
  expect((await autoHttpCallback({ ...old!, errorMessage: 'changed' })).statusCode).toBe(409);
  const retry = await post('/entrance-exams/grading/retry', f.locator, f.manager.headers);
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json().data).toMatchObject({
    recordStatus: 'PENDING',
    score: null,
    roundResult: null,
    gradingStatus: 'PENDING',
  });
  expect((await autoHttpCallback(old!)).statusCode).toBe(409);
  expect(
    await db.entranceExamGradingItem.count({
      where: { gradingRecordId: f.secondRecord.id, correctness: { not: 'PENDING' } },
    }),
  ).toBe(0);
  await f.auto.executeMock(f.secondRecord.id, 'correct', async (input) => {
    expect(input.toolTraceId).not.toBe(old!.toolTraceId);
    const result = await autoHttpCallback(input);
    expect(result.statusCode, result.body).toBe(200);
  });
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalResult,
  ).toBe('ADMITTED');
});
test('auto grading compensation invalidates trace, removes only pending member and rolls back irreversible reversals', async () => {
  const f = await autoGradingFixture();
  const input = await f.auto.claim(f.secondRecord.id);
  expect((await autoHttpCallback({ ...input!, items: f.body.items })).statusCode).toBe(200);
  const wrong = f.body.items.map((i) => ({ ...i, correctness: 'INCORRECT' }));
  let result = await f.compensate({ items: wrong });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.finalResult).toBe('ELIMINATED');
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(0);
  expect((await autoHttpCallback({ ...input!, items: f.body.items })).statusCode).toBe(409);
  expect((await f.compensate()).statusCode).toBe(200);
  const member = await db.projectMember.findUniqueOrThrow({
    where: { admissionAttemptId: f.attempt.id },
  });
  await db.projectMember.update({
    where: { id: member.id },
    data: { status: 'ACTIVE', joinedAt: new Date() },
  });
  const before = await db.entranceExamGradingRecord.findUniqueOrThrow({
    where: { id: f.secondRecord.id },
  });
  result = await f.compensate({ items: wrong });
  expect(result.statusCode, result.body).toBe(400);
  expect(
    await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: before.id } }),
  ).toEqual(before);
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalResult,
  ).toBe('ADMITTED');
});
test('auto grading retry and compensation retain strict manager scope and reject wrong sources and incomplete paper', async () => {
  const f = await autoGradingFixture();
  await db.entranceExamGradingRecord.update({
    where: { id: f.secondRecord.id },
    data: { status: 'FAILED' },
  });
  expect((await post('/auth/switch-role', { role: 'EXPERT' }, f.manager.headers)).statusCode).toBe(
    200,
  );
  const expert = f.manager.headers;
  for (const path of ['/entrance-exams/grading/retry', '/entrance-exams/grading/auto/compensate']) {
    const body = path.endsWith('retry') ? f.locator : { ...f.locator, items: f.body.items };
    expect((await post(path, body, expert)).statusCode).toBe(403);
  }
  expect((await post('/auth/switch-role', { role: 'PM' }, expert)).statusCode).toBe(200);
  const pm = f.manager.headers;
  expect(
    (
      await post(
        '/entrance-exams/grading/retry',
        { ...f.locator, gradingRecordId: f.firstRecord.id },
        pm,
      )
    ).statusCode,
  ).toBe(400);
  expect((await f.compensate({ items: f.body.items.slice(0, 1) })).statusCode).toBe(400);
  expect(
    (
      await f.compensate({
        items: [{ questionId: f.otherPaper.questions[0]!.id, correctness: 'CORRECT' }],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .status,
  ).toBe('FAILED');
});
test('auto grading mock timeout fails current trace and preserves a later successful execution from stale timeout', async () => {
  const f = await autoGradingFixture();
  await f.auto.executeMock(f.secondRecord.id, 'timeout', autoHttpCallback);
  await db.entranceExamGradingRecord.update({
    where: { id: f.secondRecord.id },
    data: { startedAt: new Date(Date.now() - 61 * 60000) },
  });
  expect(await f.auto.expireTimedOut()).toBe(1);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }))
      .status,
  ).toBe('FAILED');
  expect(
    (await post('/entrance-exams/grading/retry', f.locator, f.manager.headers)).statusCode,
  ).toBe(200);
  await f.auto.executeMock(f.secondRecord.id, 'correct', async (input) => {
    expect((await autoHttpCallback(input)).statusCode).toBe(200);
  });
  expect(await f.auto.expireTimedOut()).toBe(0);
});
test('auto grading callback outbox failure rolls back digest, items, final verdict and member atomically', async () => {
  const f = await autoGradingFixture();
  const input = await f.auto.claim(f.secondRecord.id);
  const before = await db.entranceExamGradingRecord.findUniqueOrThrow({
    where: { id: f.secondRecord.id },
  });
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, k) {
                  if (k === 'projectEventOutbox')
                    return {
                      ...t.projectEventOutbox,
                      create: async () => {
                        throw new Error('injected auto outbox failure');
                      },
                    };
                  return Reflect.get(t, k);
                },
              }),
            ),
          );
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await expect(
    new ExamGradingCommandService(failing).callback({
      ...input!,
      items: f.body.items,
    } as AutoCallbackInput),
  ).rejects.toThrow('injected auto outbox failure');
  expect(
    await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: f.secondRecord.id } }),
  ).toEqual(before);
  expect(
    await db.entranceExamGradingItem.count({
      where: { gradingRecordId: f.secondRecord.id, correctness: { not: 'PENDING' } },
    }),
  ).toBe(0);
  expect(await db.projectMember.count({ where: { admissionAttemptId: f.attempt.id } })).toBe(0);
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalResult,
  ).toBe('PENDING');
});

test('materials management HTTP preserves role boundaries, versions, task rounds and forward-only nodes', async () => {
  const f = await productionPlanFixture();
  const url = `/api/v1/projects/standard-materials/detail?projectId=${f.projectId}`;
  const update = (headers = f.manager.headers, extra = {}) =>
    post(
      '/projects/standard-materials/update',
      { projectId: f.projectId, standardContent: ' 新标准 ', ...extra },
      headers,
    );
  expect((await app.inject({ url, headers: f.handler.headers })).statusCode).toBe(200);
  expect((await update(f.handler.headers)).statusCode).toBe(403);
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const creatorEdit = await update(f.headers);
  expect(creatorEdit.statusCode, creatorEdit.body).toBe(200);
  expect(creatorEdit.json().data).toMatchObject({
    stateTransitioned: false,
    currentNodeCode: before.currentNodeCode,
    versionNo: before.versionNo + 1,
  });
  const result = await update();
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({
    standardContent: '新标准',
    currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
    stateTransitioned: true,
    versionNo: before.versionNo + 2,
  });
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'MAIN_STANDARD_TRAINING',
        status: 'COMPLETED',
        participated: true,
      },
    }),
  ).toBe(1);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'MAIN_RECRUIT_EXECUTION_EXPERT', status: 'OPEN' },
    }),
  ).toBe(2);
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'PRODUCTION_TASK' },
  });
  expect((await update()).json().data).toMatchObject({
    currentNodeCode: 'PRODUCTION_TASK',
    stateTransitioned: false,
  });
  const version = (await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).versionNo;
  const both = await Promise.all([update(), update()]);
  expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).versionNo).toBe(
    version + 2,
  );
  await db.projectManagerRecruitment.updateMany({
    where: { projectId: f.projectId, status: 'ASSIGNED' },
    data: { status: 'REPLACED' },
  });
  expect((await app.inject({ url, headers: f.manager.headers })).statusCode).toBe(403);
  expect((await update()).statusCode).toBe(403);
});

test('materials expert SQL requires accepted subject and exam admission or live organization owner, with joined confirmation metadata', async () => {
  const f = await productionPlanFixture();
  const expert = await projectManagerAccount(3, 100, false);
  const url = `/api/v1/projects/standard-materials/detail?projectId=${f.projectId}`;
  const read = () => app.inject({ url, headers: expert.headers });
  expect((await read()).statusCode).toBe(403);
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MATERIALS_PERSON',
      projectId: f.projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: expert.user.id,
      status: 'PENDING_ACCEPTANCE',
      createdBy: f.manager.user.uid,
    },
  });
  expect((await read()).statusCode).toBe(403);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });
  // 旧SQL：未配置生产计划视为不要求笔试。
  expect((await read()).statusCode).toBe(200);
  expect((await f.confirm()).statusCode).toBe(200);
  expect((await read()).statusCode).toBe(403);
  const exam = await db.projectEntranceExam.create({
    data: {
      examNo: 'MATERIALS_EXAM',
      projectId: f.projectId,
      examName: '历史准入',
      status: 'CLOSED',
      createdBy: f.manager.user.uid,
    },
  });
  const attempt = await db.entranceExamAttempt.create({
    data: {
      attemptNo: 'MATERIALS_ADMISSION',
      examId: exam.id,
      candidateUserId: expert.user.id,
      candidateUid: expert.user.uid,
      candidateName: '专家快照',
      finalResult: 'ADMITTED',
      createdBy: f.manager.user.uid,
    },
  });
  expect((await read()).statusCode).toBe(200);
  await db.projectEntranceExam.update({ where: { id: exam.id }, data: { deleted: true } });
  expect((await read()).statusCode).toBe(403);
  await db.entranceExamAttempt.update({
    where: { id: attempt.id },
    data: { finalResult: 'REJECTED' },
  });
  const org = await db.organization.create({ data: { name: '材料权限组织', expertiseTags: [] } });
  const membership = await db.userOrgRel.create({
    data: {
      userId: expert.user.id,
      uid: expert.user.uid,
      orgId: org.id,
      position: 'OWNER',
      joinStatus: 'ACTIVE',
    },
  });
  const orgAssignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MATERIALS_ORG',
      projectId: f.projectId,
      subjectType: 'ORGANIZATION',
      organizationId: org.id,
      status: 'ACCEPTED',
      createdBy: f.manager.user.uid,
    },
  });
  expect((await read()).statusCode).toBe(200);
  await db.userOrgRel.update({ where: { id: membership.id }, data: { position: 'MEMBER' } });
  expect((await read()).statusCode).toBe(403);
  await db.projectExpertAssignmentOwner.create({
    data: { assignmentId: orgAssignment.id, userId: expert.user.id, createdBy: f.manager.user.uid },
  });
  expect((await read()).statusCode).toBe(200);
  await db.userOrgRel.update({ where: { id: membership.id }, data: { joinStatus: 'LEFT' } });
  expect((await read()).statusCode).toBe(403);
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { needWrittenExam: false },
  });
  const member = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: expert.user.id,
      expertAssignmentId: assignment.id,
      joinedAt: new Date(),
      createdBy: f.manager.user.uid,
    },
  });
  expect((await read()).json().data).toMatchObject({ canConfirmRead: true, confirmedReadAt: null });
  await db.projectMember.update({
    where: { id: member.id },
    data: { standardTrainingConfirmedAt: new Date('2026-10-22T08:00:00Z') },
  });
  expect((await read()).json().data).toMatchObject({
    canConfirmRead: false,
    confirmedReadAt: '2026-10-22 16:00:00',
  });
});

test('materials attachment claim, removal and task-write failure are one database transaction', async () => {
  const f = await productionPlanFixture();
  const { record, uploadToken } = await uploaded('PROJECT_ATTACHMENT', f.manager.user.uid);
  const payload = {
    projectId: f.projectId,
    standardContent: '新材料',
    attachments: [{ attachmentType: 'CASE', objectKey: record.objectKey, uploadToken }],
  };
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const rounds = await db.projectTaskRound.findMany({
    where: { projectId: f.projectId },
    orderBy: { id: 'asc' },
  });
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'projectTaskRound')
                    return {
                      ...transaction.projectTaskRound,
                      create: async () => {
                        throw new Error('materials task write failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new ProjectMaterialsService(failing, registry).update(payload as never, {
      userId: f.manager.user.id,
      uid: f.manager.user.uid,
      role: 'PM',
      sessionId: 'test',
      clientType: 'desktop',
    }),
  ).rejects.toThrow('materials task write failure');
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(before);
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(rounds);
  expect(await db.projectAttachment.count({ where: { projectId: f.projectId } })).toBe(0);
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
    'UPLOADED',
  );
  const success = await post('/projects/standard-materials/update', payload, f.manager.headers);
  expect(success.statusCode, success.body).toBe(200);
  expect(success.json().data.attachments[0]).toMatchObject({
    attachmentType: 'CASE',
    objectKey: record.objectKey,
  });
  expect((await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
    'CLAIMED',
  );
  expect(
    (
      await post(
        '/projects/standard-materials/update',
        { projectId: f.projectId, standardContent: '保留附件' },
        f.manager.headers,
      )
    ).json().data.attachments,
  ).toHaveLength(1);
  const removedAt = new Date();
  const removed = await post(
    '/projects/standard-materials/update',
    { projectId: f.projectId, standardContent: '移除附件', attachments: [] },
    f.manager.headers,
  );
  expect(removed.statusCode, removed.body).toBe(200);
  expect(removed.json().data.attachments).toEqual([]);
  const released = await db.uploadedFile.findUniqueOrThrow({ where: { id: record.id } });
  // 移除先释放认领并设置回收时间；到期清理才删除对象，不存在PENDING_DELETE中间态。
  expect(released).toMatchObject({
    status: 'RELEASED',
    claimedBizType: 'PROJECT_ATTACHMENT',
    claimedBizId: String(f.projectId),
    deletedAt: null,
  });
  expect(released.expiresAt).not.toBeNull();
  expect(released.expiresAt!.getTime()).toBeGreaterThan(removedAt.getTime());
  expect(await db.projectAttachment.findMany({ where: { projectId: f.projectId } })).toMatchObject([
    { objectKey: record.objectKey, status: 'DELETED' },
  ]);
});

async function materialsConfirmationFixture() {
  const f = await productionPlanFixture();
  const expert = await projectManagerAccount(3, 100, false);
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'MATERIALS_CONFIRM_PERSON',
      projectId: f.projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: expert.user.id,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      createdBy: f.manager.user.uid,
    },
  });
  const member = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: expert.user.id,
      expertAssignmentId: assignment.id,
      joinedAt: new Date(),
      createdBy: f.manager.user.uid,
    },
  });
  const confirm = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/projects/standard-materials/confirm-read?projectId=${f.projectId}`,
      headers: expert.headers,
    });
  return { ...f, expert, assignment, member, confirmRead: confirm };
}

test('materials confirmation HTTP enforces ordinary joined role, concurrent idempotency and snapshot repair', async () => {
  const f = await materialsConfirmationFixture();
  const projectBefore = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  await db.projectMember.update({ where: { id: f.member.id }, data: { joinedAt: null } });
  expect((await f.confirmRead()).statusCode).toBe(400);
  await db.projectMember.update({
    where: { id: f.member.id },
    data: { joinedAt: f.member.joinedAt },
  });
  await db.projectExpertAssignment.update({
    where: { id: f.assignment.id },
    data: { projectOwnerUserId: f.expert.user.id },
  });
  expect((await f.confirmRead()).statusCode).toBe(403);
  await db.projectExpertAssignment.update({
    where: { id: f.assignment.id },
    data: { projectOwnerUserId: null, status: 'REJECTED' },
  });
  expect((await f.confirmRead()).statusCode).toBe(403);
  await db.projectExpertAssignment.update({
    where: { id: f.assignment.id },
    data: { status: 'ACCEPTED' },
  });
  const responses = await Promise.all([f.confirmRead(), f.confirmRead()]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(responses.map((r) => r.json().data.readConfirmationTransitioned).sort()).toEqual([
    false,
    true,
  ]);
  expect(responses[0].json().data.confirmedReadAt).toBe(responses[1].json().data.confirmedReadAt);
  const persisted = await db.projectMember.findUniqueOrThrow({ where: { id: f.member.id } });
  expect(persisted.standardTrainingConfirmedAt).not.toBeNull();
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId, userId: f.expert.user.id, taskType: 'STANDARD_TRAINING' },
    }),
  ).toMatchObject([{ status: 'COMPLETED', participated: true, role: 'EXPERT' }]);
  const key = {
    projectId: f.projectId,
    userId: f.expert.user.id,
    perspective: 'EXPERT_INDIVIDUAL',
  };
  expect(
    await db.projectRoleNodeSnapshot.findUniqueOrThrow({
      where: { projectId_userId_perspective: key },
    }),
  ).toMatchObject({ branchNodeCode: 'PRODUCTION_TASK', sourceBizId: f.member.id });
  await db.projectRoleNodeSnapshot.update({
    where: { projectId_userId_perspective: key },
    data: { branchNodeCode: 'STANDARD_TRAINING' },
  });
  expect((await f.confirmRead()).json().data.readConfirmationTransitioned).toBe(false);
  expect(await db.projectMember.findUniqueOrThrow({ where: { id: f.member.id } })).toEqual(
    persisted,
  );
  expect(
    (
      await db.projectRoleNodeSnapshot.findUniqueOrThrow({
        where: { projectId_userId_perspective: key },
      })
    ).branchNodeCode,
  ).toBe('PRODUCTION_TASK');
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(projectBefore);
  await db.projectMember.update({ where: { id: f.member.id }, data: { status: 'LEFT' } });
  expect((await f.confirmRead()).statusCode).toBe(400);
  const denied = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/standard-materials/confirm-read?projectId=${f.projectId}`,
    headers: f.manager.headers,
  });
  expect(denied.statusCode).toBe(403);
});

test('materials confirmation snapshot failure rolls back member timestamp and training completion together', async () => {
  const f = await materialsConfirmationFixture();
  const before = await db.projectMember.findUniqueOrThrow({ where: { id: f.member.id } });
  const round = await db.projectTaskRound.create({
    data: {
      projectId: f.projectId,
      userId: f.expert.user.id,
      role: 'EXPERT',
      taskType: 'STANDARD_TRAINING',
    },
  });
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property === 'projectRoleNodeSnapshot')
                    return {
                      ...transaction.projectRoleNodeSnapshot,
                      upsert: async () => {
                        throw new Error('confirmation snapshot failure');
                      },
                    };
                  return Reflect.get(transaction, property);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new ProjectMaterialsService(failing, registry).confirmRead(f.projectId, {
      userId: f.expert.user.id,
      uid: f.expert.user.uid,
      role: 'EXPERT',
      sessionId: 'test',
      clientType: 'desktop',
    }),
  ).rejects.toThrow('confirmation snapshot failure');
  expect(await db.projectMember.findUniqueOrThrow({ where: { id: f.member.id } })).toEqual(before);
  expect(await db.projectTaskRound.findUniqueOrThrow({ where: { id: round.id } })).toEqual(round);
  expect(
    await db.projectRoleNodeSnapshot.count({
      where: { projectId: f.projectId, userId: f.expert.user.id },
    }),
  ).toBe(0);
});

test('recruitment handler HTTP uses live primary PM, unified ACTIVE candidates and transfers rounds without project advancement', async () => {
  const f = await productionPlanFixture();
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'RECRUIT_EXECUTION_EXPERT' },
  });
  const query = (headers = f.manager.headers) =>
    app.inject({
      url: `/api/v1/projects/expert-recruitments/handler-candidates?projectId=${f.projectId}`,
      headers,
    });
  const change = (id: string, headers = f.manager.headers) =>
    post(
      '/projects/expert-recruitment-handler/change',
      { projectId: f.projectId, handlerUserId: id },
      headers,
    );
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect((await query(f.headers)).statusCode).toBe(403);
  expect((await query(f.handler.headers)).statusCode).toBe(403);
  expect((await change(f.manager.user.id, f.handler.headers)).statusCode).toBe(403);
  const list = await query();
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: f.manager.user.id, currentHandler: false }),
      expect.objectContaining({ userId: f.handler.user.id, currentHandler: true }),
    ]),
  );
  // 旧role为EXPERT的统一账号也可作为PM候选，不依赖组织账号或management grant。
  await db.user.update({ where: { id: f.handler.user.id }, data: { role: 'EXPERT' } });
  expect(
    (await query()).json().data.some((u: { userId: string }) => u.userId === f.handler.user.id),
  ).toBe(true);
  const results = await Promise.all([change(f.manager.user.id), change(f.manager.user.id)]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json().data).toBeNull();
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(before);
  expect(
    await db.projectManagerRecruitment.findFirst({
      where: { projectId: f.projectId, status: 'ASSIGNED' },
    }),
  ).toMatchObject({ expertRecruitmentHandlerUserId: f.manager.user.id });
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.handler.user.id,
        status: 'OPEN',
        taskType: 'MAIN_RECRUIT_EXECUTION_EXPERT',
      },
    }),
  ).toBe(0);
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        status: 'OPEN',
        taskType: 'MAIN_RECRUIT_EXECUTION_EXPERT',
      },
    }),
  ).toBe(1);
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        status: 'COMPLETED',
        taskType: 'MAIN_RECRUIT_EXECUTION_EXPERT',
      },
    }),
  ).toBe(0);
  expect(
    await db.projectEventOutbox.count({
      where: {
        projectId: f.projectId,
        operation: 'project.expert-recruitment-handler.change',
        status: 'PENDING',
      },
    }),
  ).toBe(2);
  await db.user.update({ where: { id: f.handler.user.id }, data: { status: 'DISABLED' } });
  expect(
    (await query()).json().data.some((u: { userId: string }) => u.userId === f.handler.user.id),
  ).toBe(false);
  expect((await change(f.handler.user.id)).statusCode).toBe(400);
  // 主策略官更换后，旧PM会话即时失权。
  const replacement = await projectManagerAccount(3);
  expect((await f.recruit(replacement.user.id)).statusCode).toBe(200);
  expect((await query()).statusCode).toBe(403);
  expect((await change(f.manager.user.id)).statusCode).toBe(403);
});

test('recruitment handler outbox failure rolls back relation and all task rounds in the same transaction', async () => {
  const f = await productionPlanFixture();
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'RECRUIT_EXECUTION_EXPERT' },
  });
  const previous = await db.projectManagerRecruitment.findFirstOrThrow({
    where: { projectId: f.projectId, status: 'ASSIGNED' },
  });
  const rounds = await db.projectTaskRound.findMany({
    where: { projectId: f.projectId },
    orderBy: { id: 'asc' },
  });
  const events = await db.projectEventOutbox.count();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, k) {
                  if (k === 'projectEventOutbox')
                    return {
                      ...t.projectEventOutbox,
                      create: async () => {
                        throw new Error('injected handler outbox failure');
                      },
                    };
                  return Reflect.get(t, k);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { ProjectRecruitmentHandlerService } =
    await import('../src/modules/projects/project-recruitment-handler.service.js');
  await expect(
    new ProjectRecruitmentHandlerService(failing).change(
      { projectId: f.projectId, handlerUserId: f.manager.user.id },
      {
        userId: f.manager.user.id,
        uid: f.manager.user.uid,
        role: 'PM',
        sessionId: 'test',
        clientType: 'desktop',
      },
    ),
  ).rejects.toThrow('injected handler outbox failure');
  expect(
    await db.projectManagerRecruitment.findUniqueOrThrow({ where: { id: previous.id } }),
  ).toEqual(previous);
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(rounds);
  expect(await db.projectEventOutbox.count()).toBe(events);
});

test('expert owner candidates enforce assignment organization and live membership across multiple organizations', async () => {
  const f = await expertRecruitmentFixture();
  for (const headers of [f.owner.headers, f.individual.headers])
    expect((await post('/auth/switch-role', { role: 'EXPERT' }, headers)).statusCode).toBe(200);
  // 使用060真实下发来源，不预造组织接单或负责人事实。
  expect(
    (await f.submit([{ ...f.item, subjectType: 'ORGANIZATION', subjectId: f.organization.id }]))
      .statusCode,
  ).toBe(200);
  const assignment = await db.projectExpertAssignment.findFirstOrThrow({
    where: { projectId: f.projectId, organizationId: f.organization.id },
  });
  const member = f.individual;
  const rel = await db.userOrgRel.create({
    data: {
      userId: member.user.id,
      uid: member.user.uid,
      orgId: f.organization.id,
      joinStatus: 'EXIT_APPROVING',
    },
  });
  const other = await db.organization.create({
    data: { name: '候选权限另一组织', expertiseTags: [] },
  });
  await db.userOrgRel.create({
    data: { userId: f.owner.user.id, uid: f.owner.user.uid, orgId: other.id, position: 'OWNER' },
  });
  const read = (headers = f.owner.headers, id = assignment.id) =>
    app.inject({
      url: `/api/v1/expert-assignments/project-owner-candidates?assignmentId=${id}`,
      headers,
    });
  const response = await read();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: f.owner.user.id, position: 'OWNER', projectOwner: false }),
      expect.objectContaining({ userId: member.user.id, position: 'MEMBER', projectOwner: false }),
    ]),
  );
  expect(response.json().data).toHaveLength(2);
  expect((await read(member.headers)).statusCode).toBe(403);
  expect((await read(f.manager.headers)).statusCode).toBe(403);
  for (const status of ['PENDING_LEAVE', 'ACTIVE']) {
    await db.userOrgRel.update({ where: { id: rel.id }, data: { joinStatus: status } });
    expect((await read()).json().data.map((r: { userId: string }) => r.userId)).toContain(
      member.user.id,
    );
  }
  for (const status of ['LEFT', 'PENDING_ACTIVATION']) {
    await db.userOrgRel.update({ where: { id: rel.id }, data: { joinStatus: status } });
    expect((await read()).json().data.map((r: { userId: string }) => r.userId)).not.toContain(
      member.user.id,
    );
  }
  await db.userOrgRel.update({ where: { id: rel.id }, data: { joinStatus: 'ACTIVE' } });
  await db.user.update({ where: { id: member.user.id }, data: { status: 'DISABLED' } });
  expect((await read()).json().data).toHaveLength(1);
  expect((await read(f.owner.headers, 2147483648)).statusCode).toBe(400);
  expect((await read(f.owner.headers, 2147483647)).statusCode).toBe(404);
  await db.userOrgRel.updateMany({
    where: { orgId: f.organization.id, userId: f.owner.user.id },
    data: { joinStatus: 'LEFT' },
  });
  expect((await read()).statusCode).toBe(403);
});

test('expert owner candidates respect accepted owners, removed history and legacy fallback without writing facts', async () => {
  const f = await expertRecruitmentFixture();
  expect((await post('/auth/switch-role', { role: 'EXPERT' }, f.owner.headers)).statusCode).toBe(
    200,
  );
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: `owner-candidates-${f.projectId}`,
      projectId: f.projectId,
      subjectType: 'ORGANIZATION',
      organizationId: f.organization.id,
      status: 'ACCEPTED',
      projectOwnerUserId: f.owner.user.id,
      createdBy: f.user.uid,
    },
  });
  const read = () =>
    app.inject({
      url: `/api/v1/expert-assignments/project-owner-candidates?assignmentId=${assignment.id}`,
      headers: f.owner.headers,
    });
  expect((await read()).json().data[0].projectOwner).toBe(true);
  const history = await db.projectExpertAssignmentOwner.create({
    data: {
      assignmentId: assignment.id,
      userId: f.owner.user.id,
      status: 'REMOVED',
      createdBy: f.user.uid,
    },
  });
  expect((await read()).json().data[0].projectOwner).toBe(false);
  await db.projectExpertAssignmentOwner.update({
    where: { id: history.id },
    data: { status: 'ACTIVE' },
  });
  expect((await read()).json().data[0].projectOwner).toBe(true);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'REJECTED' },
  });
  expect((await read()).json().data[0].projectOwner).toBe(false);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { subjectType: 'INDIVIDUAL', organizationId: null, expertUserId: f.owner.user.id },
  });
  expect((await read()).statusCode).toBe(404);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { subjectType: 'ORGANIZATION', organizationId: f.organization.id, expertUserId: null },
  });
  await db.project.update({ where: { id: f.projectId }, data: { deleted: true } });
  expect((await read()).statusCode).toBe(404);
});

async function expertRecruitmentFixture() {
  const f = await productionPlanFixture();
  const individual = await projectManagerAccount(3);
  const owner = await projectManagerAccount(4);
  const organization = await db.organization.create({
    data: { name: '候选生产组织', expertiseTags: [] },
  });
  await db.userOrgRel.create({
    data: {
      orgId: organization.id,
      userId: owner.user.id,
      uid: owner.user.uid,
      position: 'OWNER',
      joinStatus: 'ACTIVE',
    },
  });
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'RECRUIT_EXECUTION_EXPERT', projectQuantity: '10.1' },
  });
  const item = {
    subjectType: 'INDIVIDUAL',
    subjectId: individual.user.id,
    productionRequirement: 3.1234,
    operatorHeadcount: 2,
    inspectorHeadcount: null,
  };
  const submit = (assignments: unknown[] = [item], headers = f.manager.headers) =>
    post('/projects/expert-recruitments/submit', { projectId: f.projectId, assignments }, headers);
  const candidates = (suffix = '', headers = f.manager.headers) =>
    app.inject({
      url: `/api/v1/projects/expert-recruitments/candidates?projectId=${f.projectId}${suffix}`,
      headers,
    });
  const detail = (headers = f.manager.headers) =>
    app.inject({
      url: `/api/v1/projects/expert-recruitments/detail?projectId=${f.projectId}`,
      headers,
    });
  return { ...f, individual, owner, organization, item, submit, candidates, detail };
}
test('expert recruitment candidates use real unified accounts, independent multiple organizations, owner exclusions and database pagination', async () => {
  const f = await expertRecruitmentFixture();
  // 同一账号可作为个人、多个组织主管；不能用单数organizationId推导对象。
  const secondOrg = await db.organization.create({
    data: { name: '第二候选组织', expertiseTags: [] },
  });
  await db.userOrgRel.create({
    data: {
      orgId: secondOrg.id,
      userId: f.owner.user.id,
      uid: f.owner.user.uid,
      position: 'OWNER',
      joinStatus: 'PENDING_LEAVE',
    },
  });
  const excludedOrg = await db.organization.create({
    data: { name: '主策略官主管组织', expertiseTags: [] },
  });
  await db.userOrgRel.create({
    data: {
      orgId: excludedOrg.id,
      userId: f.manager.user.id,
      uid: f.manager.user.uid,
      position: 'OWNER',
      joinStatus: 'EXIT_APPROVING',
    },
  });
  const pending = await projectManagerAccount(5);
  await db.userOrgRel.create({
    data: {
      orgId: f.organization.id,
      userId: pending.user.id,
      uid: pending.user.uid,
      position: 'MEMBER',
      joinStatus: 'PENDING_ACTIVATION',
    },
  });
  const list = await f.candidates();
  expect(list.statusCode, list.body).toBe(200);
  const rows = list.json().data.records as {
    subjectId: string;
    subjectType: string;
    availableAction: string;
  }[];
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subjectId: f.individual.user.id,
        subjectType: 'INDIVIDUAL',
        availableAction: 'RECRUIT',
      }),
      expect.objectContaining({ subjectId: f.owner.user.id, subjectType: 'INDIVIDUAL' }),
      expect.objectContaining({ subjectId: f.organization.id, subjectType: 'ORGANIZATION' }),
      expect.objectContaining({ subjectId: secondOrg.id, subjectType: 'ORGANIZATION' }),
    ]),
  );
  for (const id of [
    f.user.id,
    f.manager.user.id,
    f.handler.user.id,
    excludedOrg.id,
    pending.user.id,
  ])
    expect(rows.some((r) => r.subjectId === id)).toBe(false);
  const page = await f.candidates('&subjectType=ORGANIZATION&size=1&current=2');
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().data).toMatchObject({ total: 2, current: 2, size: 1, pages: 2 });
  expect(page.json().data.records).toHaveLength(1);
  expect((await f.candidates('&keyword=%25')).json().data.total).toBe(0);
  expect(
    (await f.candidates('&keyword=' + encodeURIComponent(f.owner.user.uid))).json().data.total,
  ).toBe(3);
  expect((await f.candidates('', f.headers)).statusCode).toBe(403);
  expect((await f.detail(f.handler.headers)).json().data).toMatchObject({
    currentOperatorRole: 'EXPERT_RECRUITMENT_HANDLER',
    canChangeHandler: false,
  });
  await db.user.update({ where: { id: f.individual.user.id }, data: { status: 'DISABLED' } });
  expect((await f.submit()).statusCode).toBe(400);
  expect((await f.submit([{ ...f.item, subjectId: pending.user.id }])).statusCode).toBe(400);
  expect(
    (await f.submit([{ ...f.item, subjectType: 'ORGANIZATION', subjectId: excludedOrg.id }]))
      .statusCode,
  ).toBe(400);
  expect(await db.projectExpertAssignment.count({ where: { projectId: f.projectId } })).toBe(0);
});

test('expert recruitment concurrent duplicates serialize, batch dispatch creates pending records and summary without regressing node or version', async () => {
  const f = await expertRecruitmentFixture();
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect((await f.submit([f.item], f.headers)).statusCode).toBe(403);
  const results = await Promise.all([f.submit(), f.submit()]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await db.projectExpertAssignment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toMatchObject({
    currentNodeCode: 'PERSONNEL_MANAGEMENT',
    versionNo: before.versionNo,
  });
  const first = await db.projectExpertAssignment.findFirstOrThrow({
    where: { projectId: f.projectId },
  });
  expect(first).toMatchObject({
    subjectType: 'INDIVIDUAL',
    expertUserId: f.individual.user.id,
    organizationId: null,
    status: 'PENDING_ACCEPTANCE',
    previousAssignmentId: null,
    operatorHeadcount: 2,
  });
  expect(first.productionRequirement!.toString()).toBe('3.1234');
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'MAIN_RECRUIT_EXECUTION_EXPERT',
        status: 'COMPLETED',
        participated: true,
      },
    }),
  ).toBe(1);
  await db.project.update({
    where: { id: f.projectId },
    data: { currentNodeCode: 'PRODUCTION_TASK' },
  });
  const more = await f.submit(
    [
      {
        ...f.item,
        subjectType: 'ORGANIZATION',
        subjectId: f.organization.id,
        productionRequirement: 20,
      },
    ],
    f.handler.headers,
  );
  expect(more.statusCode, more.body).toBe(200);
  expect(more.json().data).toBeNull();
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toMatchObject({
    currentNodeCode: 'PRODUCTION_TASK',
    versionNo: before.versionNo,
  });
  const detail = await f.detail();
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json().data.summary).toEqual({
    activeAssignmentCount: 2,
    pendingAcceptanceCount: 2,
    acceptedCount: 0,
    rejectedCount: 0,
    assignedProductionRequirement: 23.1234,
    remainingProductionRequirement: 0,
  });
  expect(
    (await f.candidates())
      .json()
      .data.records.slice(0, 2)
      .map((r: { availableAction: string }) => r.availableAction),
  ).toEqual(['NONE', 'NONE']);
  expect(
    await db.projectEventOutbox.count({
      where: { projectId: f.projectId, eventType: 'EXPERT_ASSIGNMENTS_CREATED', status: 'PENDING' },
    }),
  ).toBe(2);
  const replacement = await projectManagerAccount(6);
  expect((await f.recruit(replacement.user.id)).statusCode).toBe(200);
  expect((await f.detail()).statusCode).toBe(403);
  expect((await f.candidates('', f.handler.headers)).statusCode).toBe(403);
});

test('expert recruitment rejected sources are project scoped, consumed once, append history and repair retry snapshots and rounds', async () => {
  const f = await expertRecruitmentFixture();
  const source = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'REJECTED-RECRUITMENT',
      projectId: f.projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: f.individual.user.id,
      status: 'REJECTED',
      productionRequirement: 4,
      operatorHeadcount: 1,
      createdBy: f.user.uid,
      rejectedAt: new Date(),
    },
  });
  const sourceBefore = { ...source };
  expect(
    (await f.candidates())
      .json()
      .data.records.find((r: { subjectId: string }) => r.subjectId === f.individual.user.id)
      .availableAction,
  ).toBe('RECRUIT_AGAIN');
  await db.projectRoleNodeSnapshot.create({
    data: {
      projectId: f.projectId,
      userId: f.handler.user.id,
      perspective: 'EXPERT_RECRUITMENT_HANDLER',
      branchNodeCode: 'EXPERT_RECRUITMENT_RETRY',
      branchPriority: 90,
      sourceBizType: 'EXPERT_ASSIGNMENT',
      sourceBizId: source.id,
      sourceEventAt: new Date(),
      calculatedAt: new Date(),
    },
  });
  expect(
    (await f.submit([{ ...f.item, sourceRejectedAssignmentId: source.id + 99999 }])).statusCode,
  ).toBe(400);
  const item = {
    ...f.item,
    subjectType: 'ORGANIZATION',
    subjectId: f.organization.id,
    sourceRejectedAssignmentId: source.id,
  };
  const results = await Promise.all([
    f.submit([item], f.handler.headers),
    f.submit([item], f.handler.headers),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(await db.projectExpertAssignment.findUniqueOrThrow({ where: { id: source.id } })).toEqual(
    sourceBefore,
  );
  const successor = await db.projectExpertAssignment.findFirstOrThrow({
    where: { previousAssignmentId: source.id },
  });
  expect(successor).toMatchObject({
    organizationId: f.organization.id,
    expertUserId: null,
    status: 'PENDING_ACCEPTANCE',
  });
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.handler.user.id,
        taskType: 'EXPERT_RECRUITMENT_RETRY',
        status: 'COMPLETED',
        participated: true,
      },
    }),
  ).toBe(1);
  expect(
    await db.projectRoleNodeSnapshot.count({
      where: { projectId: f.projectId, branchNodeCode: 'EXPERT_RECRUITMENT_RETRY' },
    }),
  ).toBe(0);
  const activeSource = await f.submit([{ ...f.item, sourceRejectedAssignmentId: successor.id }]);
  expect(activeSource.statusCode).toBe(400);
  const other = await db.project.create({
    data: {
      projectNo: 'OTHER-RECRUITMENT',
      requesterType: 'INDIVIDUAL',
      requesterId: f.user.id,
      requesterName: '测试',
      createdBy: f.user.uid,
      updatedBy: f.user.uid,
    },
  });
  const foreign = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'FOREIGN-REJECTED',
      projectId: other.id,
      subjectType: 'INDIVIDUAL',
      expertUserId: f.individual.user.id,
      status: 'REJECTED',
      createdBy: f.user.uid,
    },
  });
  expect((await f.submit([{ ...f.item, sourceRejectedAssignmentId: foreign.id }])).statusCode).toBe(
    400,
  );
});

test('expert recruitment batch validation and outbox failure roll back assignments, project, rounds and snapshots atomically', async () => {
  const f = await expertRecruitmentFixture();
  const project = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const rounds = await db.projectTaskRound.findMany({
    where: { projectId: f.projectId },
    orderBy: { id: 'asc' },
  });
  const snapshots = await db.projectRoleNodeSnapshot.findMany({
    where: { projectId: f.projectId },
    orderBy: { id: 'asc' },
  });
  const events = await db.projectEventOutbox.count();
  expect((await f.submit([f.item, { ...f.item, subjectId: f.manager.user.id }])).statusCode).toBe(
    400,
  );
  expect(await db.projectExpertAssignment.count({ where: { projectId: f.projectId } })).toBe(0);
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, k) {
                  if (k === 'projectEventOutbox')
                    return {
                      ...t.projectEventOutbox,
                      create: async () => {
                        throw new Error('injected recruitment outbox failure');
                      },
                    };
                  return Reflect.get(t, k);
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { ProjectRecruitmentService } =
    await import('../src/modules/projects/project-recruitment.service.js');
  await expect(
    new ProjectRecruitmentService(failing).submit(
      { projectId: f.projectId, assignments: [{ ...f.item, subjectType: 'INDIVIDUAL' }] },
      {
        userId: f.manager.user.id,
        uid: f.manager.user.uid,
        role: 'PM',
        sessionId: 'test',
        clientType: 'desktop',
      },
    ),
  ).rejects.toThrow('injected recruitment outbox failure');
  expect(await db.projectExpertAssignment.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(project);
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(rounds);
  expect(
    await db.projectRoleNodeSnapshot.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(snapshots);
  expect(await db.projectEventOutbox.count()).toBe(events);
});

test('expert task cards isolate real recruitment sources, organization membership and filter aliases', async () => {
  const f = await expertRecruitmentFixture();
  for (const account of [f.owner, f.individual])
    expect((await post('/auth/switch-role', { role: 'EXPERT' }, account.headers)).statusCode).toBe(
      200,
    );
  expect(
    (
      await f.submit([
        f.item,
        { ...f.item, subjectType: 'ORGANIZATION', subjectId: f.organization.id },
      ])
    ).statusCode,
  ).toBe(200);
  const read = (headers = f.individual.headers, body: unknown = {}) =>
    post('/expert-assignments/my-tasks', body, headers);
  const personal = await read();
  expect(personal.statusCode, personal.body).toBe(200);
  expect(personal.headers['cache-control']).toBe('no-store');
  expect(personal.json().data).toHaveLength(1);
  const card = personal.json().data[0];
  expect(card).toMatchObject({
    acceptanceStatus: 'PENDING_ACCEPTANCE',
    currentNodeCode: 'PERSONNEL_MANAGEMENT',
    basicInfo: { subjectType: 'INDIVIDUAL', productionRequirement: 3.1234 },
    operations: { canAccept: true, canReject: true, canReportOutput: false },
  });
  expect((await read(f.owner.headers)).json().data[0].basicInfo.organizationId).toBe(
    f.organization.id,
  );
  expect((await read(f.manager.headers)).statusCode).toBe(403);
  expect((await read(f.individual.headers, { status: 'ACCEPTED' })).json().data).toEqual([]);
  expect(
    (await read(f.individual.headers, { status: 'PENDING_ACCEPTANCE' })).json().data,
  ).toHaveLength(1);
  expect(
    (await read(f.individual.headers, { status: 'ACCEPTED', acceptanceStatus: 'REJECTED' }))
      .statusCode,
  ).toBe(400);
  expect((await read(f.individual.headers, { keyword: '完全不匹配' })).json().data).toEqual([]);
  const org = await db.projectExpertAssignment.findFirstOrThrow({
    where: { projectId: f.projectId, organizationId: f.organization.id },
  });
  // 067尚未实现：以下显式存量夹具仅验证读取，不作为HTTP接单写验收。
  await db.projectExpertAssignment.update({ where: { id: org.id }, data: { status: 'ACCEPTED' } });
  const rel = await db.userOrgRel.create({
    data: {
      orgId: f.organization.id,
      userId: f.individual.user.id,
      uid: f.individual.user.uid,
      joinStatus: 'EXIT_APPROVING',
    },
  });
  const orgCard = (await read()).json().data;
  expect(orgCard).toHaveLength(1);
  expect(orgCard[0]).toMatchObject({
    assignmentId: org.id,
    acceptanceStatus: 'PENDING_ACCEPTANCE',
    accessContext: { projectOwner: false },
  });
  await db.projectExpertAssignmentMember.create({
    data: {
      assignmentId: org.id,
      userId: f.individual.user.id,
      userOrgRelId: rel.id,
      status: 'REJECTED',
      createdBy: f.user.uid,
    },
  });
  expect((await read()).json().data[0].assignmentId).toBe(card.assignmentId);
  await db.userOrgRel.update({ where: { id: rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await read()).json().data[0].assignmentId).toBe(card.assignmentId);
  await db.project.update({ where: { id: f.projectId }, data: { currentNodeCode: 'COMPLETED' } });
  expect((await read()).json().data).toEqual([]);
});

test('expert task cards read latest membership progress and owner history without mutating project facts', async () => {
  const f = await expertRecruitmentFixture();
  expect(
    (await post('/auth/switch-role', { role: 'EXPERT' }, f.individual.headers)).statusCode,
  ).toBe(200);
  expect((await f.submit()).statusCode).toBe(200);
  const assignment = await db.projectExpertAssignment.findFirstOrThrow({
    where: { projectId: f.projectId },
  });
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: { status: 'ACCEPTED' },
  });
  // expertRecruitmentFixture仅准备任职和招募来源，不会持久化生产计划。
  // 显式建立本测试免试读取夹具，不把缺计划默认值当成已配置免试。
  await db.projectProductionPlan.create({
    data: {
      projectId: f.projectId,
      operatorHeadcount: 2,
      operatorCpd: '1',
      totalExpectedOutput: '10',
      needWrittenExam: false,
      confirmedBy: f.manager.user.uid,
      confirmedAt: new Date(),
      createdBy: f.manager.user.uid,
    },
  });
  const read = () => post('/expert-assignments/my-tasks', {}, f.individual.headers);
  expect((await read()).json().data).toEqual([]);
  const member = await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: f.individual.user.id,
      expertAssignmentId: assignment.id,
      status: 'ACTIVE',
      entryDecision: 'YES',
      joinedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const rounds = await db.projectTaskRound.count();
  const events = await db.projectEventOutbox.count();
  expect((await read()).json().data[0]).toMatchObject({
    currentNodeCode: 'PERSONNEL_MANAGEMENT',
    branchNodeCode: 'STANDARD_TRAINING',
  });
  await db.projectMember.update({
    where: { id: member.id },
    data: { standardTrainingConfirmedAt: new Date() },
  });
  expect((await read()).json().data[0].branchNodeCode).toBe('PRODUCTION_TASK');
  await db.projectMember.create({
    data: {
      projectId: f.projectId,
      userId: f.individual.user.id,
      expertAssignmentId: assignment.id,
      status: 'PENDING_ENTRY',
      createdBy: f.user.uid,
    },
  });
  expect((await read()).json().data).toEqual([]);
  await db.projectExpertAssignment.update({
    where: { id: assignment.id },
    data: {
      subjectType: 'ORGANIZATION',
      organizationId: f.organization.id,
      expertUserId: null,
      projectOwnerUserId: f.individual.user.id,
    },
  });
  await db.userOrgRel.create({
    data: { orgId: f.organization.id, userId: f.individual.user.id, uid: f.individual.user.uid },
  });
  expect((await read()).json().data[0]).toMatchObject({
    accessContext: { projectOwner: true },
    basicInfo: { projectOwnerUserId: f.individual.user.id },
  });
  await db.projectExpertAssignmentOwner.create({
    data: {
      assignmentId: assignment.id,
      userId: f.individual.user.id,
      status: 'REMOVED',
      createdBy: f.user.uid,
    },
  });
  expect((await read()).json().data[0]).toMatchObject({
    acceptanceStatus: 'PENDING_ACCEPTANCE',
    accessContext: { projectOwner: false },
    basicInfo: { projectOwnerUserId: null },
  });
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(before);
  expect(await db.projectTaskRound.count()).toBe(rounds);
  expect(await db.projectEventOutbox.count()).toBe(events);
});

async function ownerReplacementFixture() {
  const f = await expertRecruitmentFixture();
  for (const account of [f.owner, f.individual])
    expect((await post('/auth/switch-role', { role: 'EXPERT' }, account.headers)).statusCode).toBe(
      200,
    );
  const rel = await db.userOrgRel.create({
    data: {
      userId: f.individual.user.id,
      uid: f.individual.user.uid,
      orgId: f.organization.id,
      joinStatus: 'EXIT_APPROVING',
    },
  });
  // 067尚未接入；显式准备已接单读取/交接前置，不当作067写验收。
  const assignment = await db.projectExpertAssignment.create({
    data: {
      assignmentNo: `owner-replace-${f.projectId}`,
      projectId: f.projectId,
      organizationId: f.organization.id,
      subjectType: 'ORGANIZATION',
      status: 'ACCEPTED',
      projectOwnerUserId: f.owner.user.id,
      createdBy: f.user.uid,
    },
  });
  const replace = (body: object, legacy = false, headers = f.owner.headers) =>
    post(
      `/expert-assignments/${legacy ? 'change-project-owner' : 'set-project-owners'}`,
      { assignmentId: assignment.id, ...body },
      headers,
    );
  const me = (headers = f.individual.headers) => app.inject({ url: '/api/v1/users/me', headers });
  return { ...f, rel, assignment, replace, me };
}
test('expert owner replacement preserves participants, creates exempt pending entries and serializes idempotent sets', async () => {
  const f = await ownerReplacementFixture();
  // 显式创建免试计划，避免依赖fixture未创建的计划。
  await db.projectProductionPlan.create({
    data: {
      projectId: f.projectId,
      operatorHeadcount: 2,
      operatorCpd: 1,
      totalExpectedOutput: 10,
      needWrittenExam: false,
      confirmedBy: f.manager.user.uid,
      confirmedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  const project = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(false);
  const body = {
    projectOwnerUserIds: [f.owner.user.id, f.individual.user.id, f.individual.user.id],
  };
  const responses = await Promise.all([f.replace(body), f.replace(body)]);
  for (const r of responses) expect(r.statusCode, r.body).toBe(200);
  const assigned = await db.projectExpertAssignment.findUniqueOrThrow({
    where: { id: f.assignment.id },
    include: { owners: true, memberResponses: true, members: true },
  });
  expect(assigned.projectOwnerUserId).toBe(null);
  expect(assigned.owners.filter((o) => o.status === 'ACTIVE')).toHaveLength(2);
  expect(assigned.memberResponses).toEqual([
    expect.objectContaining({
      userId: f.individual.user.id,
      status: 'SELECTED',
      userOrgRelId: f.rel.id,
    }),
  ]);
  expect(assigned.members).toEqual([
    expect.objectContaining({
      userId: f.individual.user.id,
      status: 'PENDING_CONFIRM',
      joinedAt: null,
    }),
  ]);
  const events = await db.projectEventOutbox.count({ where: { projectId: f.projectId } });
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(true);
  const noChange = await f.replace({
    projectOwnerUserIds: [f.individual.user.id, f.owner.user.id],
  });
  expect(noChange.statusCode, noChange.body).toBe(200);
  expect(await db.projectEventOutbox.count({ where: { projectId: f.projectId } })).toBe(events);
  const removed = await f.replace({ projectOwnerUserId: f.owner.user.id }, true);
  expect(removed.statusCode, removed.body).toBe(200);
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(false);
  expect(await db.projectMember.findMany({ where: { projectId: f.projectId } })).toEqual(
    assigned.members,
  );
  expect(
    await db.projectExpertAssignmentMember.findMany({ where: { assignmentId: f.assignment.id } }),
  ).toEqual(assigned.memberResponses);
  const memberRow = await db.projectExpertAssignmentOwner.findUniqueOrThrow({
    where: { assignmentId_userId: { assignmentId: f.assignment.id, userId: f.individual.user.id } },
  });
  expect(memberRow).toMatchObject({ status: 'REMOVED', removedAt: expect.any(Date) });
  expect(await db.project.findUnique({ where: { id: f.projectId } })).toEqual(project);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, role: 'EXPERT', status: 'COMPLETED' },
    }),
  ).toBe(0);
});

test('expert owner replacement rejects unauthorized targets and rolls all writes back when outbox fails', async () => {
  const f = await ownerReplacementFixture();
  expect(
    (await f.replace({ projectOwnerUserIds: [f.individual.user.id] }, false, f.individual.headers))
      .statusCode,
  ).toBe(403);
  expect((await f.replace({ projectOwnerUserIds: [f.manager.user.id] })).statusCode).toBe(400);
  expect((await f.replace({ projectOwnerUserIds: [], projectOwnerUserId: null })).statusCode).toBe(
    400,
  );
  await db.projectExpertAssignment.update({
    where: { id: f.assignment.id },
    data: { status: 'PENDING_ACCEPTANCE' },
  });
  expect((await f.replace({ projectOwnerUserId: f.individual.user.id })).statusCode).toBe(400);
  await db.projectExpertAssignment.update({
    where: { id: f.assignment.id },
    data: { status: 'ACCEPTED' },
  });
  const before = await db.projectExpertAssignment.findUniqueOrThrow({
    where: { id: f.assignment.id },
  });
  const { ExpertAssignmentService } =
    await import('../src/modules/expert/expert-assignment.service.js');
  const failing = new Proxy(db, {
    get(target, property) {
      if (property === '$transaction')
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            run(
              new Proxy(tx, {
                get(inner, key) {
                  if (key === 'projectEventOutbox')
                    return {
                      create: async () => {
                        throw new Error('owner outbox failure');
                      },
                    };
                  return Reflect.get(inner, key);
                },
              }),
            ),
          );
      return Reflect.get(target, property);
    },
  });
  await expect(
    new ExpertAssignmentService(failing).setProjectOwners(
      { assignmentId: f.assignment.id, projectOwnerUserId: f.individual.user.id },
      {
        userId: f.owner.user.id,
        uid: f.owner.user.uid,
        role: 'EXPERT',
        clientType: 'desktop',
        sessionId: 'fixture',
      },
    ),
  ).rejects.toThrow('owner outbox failure');
  expect(await db.projectExpertAssignment.findUnique({ where: { id: f.assignment.id } })).toEqual(
    before,
  );
  expect(await db.projectExpertAssignmentOwner.count()).toBe(0);
  expect(await db.projectExpertAssignmentMember.count()).toBe(0);
  expect(await db.projectMember.count()).toBe(0);
  expect(
    await db.projectTaskRound.count({ where: { projectId: f.projectId, role: 'EXPERT' } }),
  ).toBe(0);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await f.replace({ projectOwnerUserId: f.individual.user.id })).statusCode).toBe(400);
});

test('expert owner replacement restores selected responses, reconciles exam rounds and revokes management after departure', async () => {
  const f = await ownerReplacementFixture();
  await db.projectProductionPlan.create({
    data: {
      projectId: f.projectId,
      operatorHeadcount: 2,
      operatorCpd: 1,
      totalExpectedOutput: 10,
      needWrittenExam: true,
      confirmedBy: f.manager.user.uid,
      confirmedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  const exam = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'owner-exam',
      examName: '负责人考试',
      createdBy: f.user.uid,
    },
  });
  const version = await db.entranceExamVersion.create({
    data: {
      examId: exam.id,
      versionNo: 1,
      examNameSnapshot: exam.examName,
      durationMinutes: 60,
      registrationDeadline: new Date('2099-01-01T00:00:00Z'),
      fullScore: 20,
      passScore: 12,
      publishedBy: f.user.uid,
      publishedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  await db.projectEntranceExam.update({
    where: { id: exam.id },
    data: { currentVersionId: version.id },
  });
  const old = await db.projectExpertAssignmentMember.create({
    data: {
      assignmentId: f.assignment.id,
      userId: f.individual.user.id,
      userOrgRelId: f.rel.id,
      status: 'REJECTED',
      rejectReason: '旧拒绝',
      createdBy: f.user.uid,
    },
  });
  const result = await f.replace({ projectOwnerUserId: f.individual.user.id });
  expect(result.statusCode, result.body).toBe(200);
  expect(
    await db.projectExpertAssignmentMember.findUnique({ where: { id: old.id } }),
  ).toMatchObject({ status: 'SELECTED', rejectReason: null });
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(
    await db.projectTaskRound.findMany({
      where: {
        projectId: f.projectId,
        userId: f.individual.user.id,
        role: 'EXPERT',
        status: 'OPEN',
      },
    }),
  ).toEqual([expect.objectContaining({ taskType: 'ENTRANCE_EXAM', participated: false })]);
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(true);
  expect((await post('/auth/switch-role', { role: 'PM' }, f.individual.headers)).statusCode).toBe(
    200,
  );
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(false);
  expect(
    (await post('/auth/switch-role', { role: 'EXPERT' }, f.individual.headers)).statusCode,
  ).toBe(200);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(false);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'ACTIVE' } });
  await db.project.update({ where: { id: f.projectId }, data: { deleted: true } });
  expect((await f.me()).json().data.hasExpertManagementRole).toBe(false);
  expect((await f.replace({ projectOwnerUserId: f.individual.user.id })).statusCode).toBe(404);
});

async function expertResponseFixture(needWrittenExam = false) {
  const f = await expertRecruitmentFixture();
  for (const account of [f.individual, f.owner])
    expect((await post('/auth/switch-role', { role: 'EXPERT' }, account.headers)).statusCode).toBe(
      200,
    );
  const rel = await db.userOrgRel.create({
    data: {
      orgId: f.organization.id,
      userId: f.individual.user.id,
      uid: f.individual.user.uid,
      joinStatus: 'PENDING_LEAVE',
    },
  });
  await db.projectProductionPlan.create({
    data: {
      projectId: f.projectId,
      operatorHeadcount: 2,
      operatorCpd: 1,
      totalExpectedOutput: 10,
      needWrittenExam,
      confirmedBy: f.manager.user.uid,
      confirmedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  expect(
    (
      await f.submit([
        f.item,
        { ...f.item, subjectType: 'ORGANIZATION', subjectId: f.organization.id },
      ])
    ).statusCode,
  ).toBe(200);
  const assignments = await db.projectExpertAssignment.findMany({
    where: { projectId: f.projectId },
  });
  const personal = assignments.find((a) => a.subjectType === 'INDIVIDUAL')!;
  const organization = assignments.find((a) => a.subjectType === 'ORGANIZATION')!;
  const respond = (
    assignmentId: number,
    body: object = { decision: 'ACCEPT' },
    headers = f.individual.headers,
  ) => post('/expert-assignments/respond', { assignmentId, ...body }, headers);
  return { ...f, rel, personal, orgAssignment: organization, respond };
}

test('expert response personal acceptance serializes concurrent decisions and creates exempt pending entry without changing project', async () => {
  const f = await expertResponseFixture();
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  expect((await f.respond(f.personal.id, { decision: 'ACCEPT' }, f.owner.headers)).statusCode).toBe(
    403,
  );
  expect(
    (
      await f.respond(f.personal.id, {
        decision: 'ACCEPT',
        projectOwnerUserId: f.individual.user.id,
      })
    ).statusCode,
  ).toBe(400);
  const responses = await Promise.all([f.respond(f.personal.id), f.respond(f.personal.id)]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(responses.find((r) => r.statusCode === 200)!.json().data).toMatchObject({
    status: 'ACCEPTED',
    memberStatus: null,
    movementId: null,
    nextAction: 'WAIT_ENTRY_CONFIRMATION',
  });
  expect(await db.projectMember.findMany({ where: { expertAssignmentId: f.personal.id } })).toEqual(
    [
      expect.objectContaining({
        userId: f.individual.user.id,
        status: 'PENDING_CONFIRM',
        joinedAt: null,
        userOrgRelId: null,
      }),
    ],
  );
  expect(await db.project.findUnique({ where: { id: f.projectId } })).toEqual(before);
  expect(
    (
      await post(
        '/expert-assignments/respond',
        { movementId: 1, decision: 'ACCEPT' },
        f.individual.headers,
      )
    ).statusCode,
  ).toBe(503);
  expect((await f.respond(f.personal.id, { movementId: 1, decision: 'ACCEPT' })).statusCode).toBe(
    400,
  );
  await db.project.update({ where: { id: f.projectId }, data: { deleted: true } });
  expect((await f.respond(f.personal.id)).statusCode).toBe(404);
});

test('expert response organization initializes owners and dynamic member responses are idempotent with no organization retry', async () => {
  const f = await expertResponseFixture();
  expect((await f.respond(f.orgAssignment.id)).statusCode).toBe(403);
  expect(
    (await f.respond(f.orgAssignment.id, { decision: 'ACCEPT' }, f.owner.headers)).statusCode,
  ).toBe(400);
  expect(
    (
      await f.respond(
        f.orgAssignment.id,
        { decision: 'ACCEPT', projectOwnerUserId: f.manager.user.id },
        f.owner.headers,
      )
    ).statusCode,
  ).toBe(400);
  const accepted = await f.respond(
    f.orgAssignment.id,
    { decision: 'ACCEPT', projectOwnerUserId: f.owner.user.id },
    f.owner.headers,
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json().data).toMatchObject({
    nextAction: 'MANAGE_PROJECT_MEMBERS',
    notifiedMemberCount: 2,
  });
  expect(
    await db.projectExpertAssignmentMember.findMany({
      where: { assignmentId: f.orgAssignment.id },
    }),
  ).toEqual([expect.objectContaining({ userId: f.owner.user.id, status: 'SELECTED' })]);
  expect(
    (await f.respond(f.orgAssignment.id, { decision: 'ACCEPT' }, f.owner.headers)).statusCode,
  ).toBe(409);
  const cards = await post('/expert-assignments/my-tasks', {}, f.individual.headers);
  expect(cards.json().data).toEqual([
    expect.objectContaining({
      assignmentId: f.orgAssignment.id,
      operations: { canAccept: true, canReject: true, canReportOutput: false },
    }),
  ]);
  const responses = await Promise.all([
    f.respond(f.orgAssignment.id),
    f.respond(f.orgAssignment.id),
  ]);
  for (const r of responses) expect(r.statusCode, r.body).toBe(200);
  expect(responses[0]!.json().data).toMatchObject({ status: 'ACCEPTED', memberStatus: 'ACCEPTED' });
  expect(
    await db.projectMember.count({
      where: { expertAssignmentId: f.orgAssignment.id, userId: f.individual.user.id },
    }),
  ).toBe(1);
  expect(
    await db.projectEventOutbox.count({
      where: { projectId: f.projectId, eventType: 'EXPERT_ASSIGNMENT_RESPONDED' },
    }),
  ).toBe(2);
  expect(
    (await f.respond(f.orgAssignment.id, { decision: 'REJECT', rejectReason: '不参与' }))
      .statusCode,
  ).toBe(409);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await f.respond(f.orgAssignment.id)).statusCode).toBe(403);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'EXPERT_RECRUITMENT_RETRY' },
    }),
  ).toBe(0);
});

test('expert response subject rejection opens retry sources consumed once by recruitment while member rejection preserves organization', async () => {
  const f = await expertResponseFixture(true);
  expect(
    (await f.respond(f.personal.id, { decision: 'REJECT', rejectReason: '  ' })).statusCode,
  ).toBe(400);
  const rejected = await f.respond(f.personal.id, {
    decision: 'REJECT',
    rejectReason: '  暂无时间  ',
  });
  expect(rejected.statusCode, rejected.body).toBe(200);
  expect(
    await db.projectExpertAssignment.findUnique({ where: { id: f.personal.id } }),
  ).toMatchObject({ status: 'REJECTED', rejectReason: '暂无时间', rejectedAt: expect.any(Date) });
  expect(
    await db.projectTaskRound.findMany({
      where: { projectId: f.projectId, taskType: 'EXPERT_RECRUITMENT_RETRY', status: 'OPEN' },
    }),
  ).toEqual([expect.objectContaining({ userId: f.handler.user.id, participated: false })]);
  expect(
    await db.projectRoleNodeSnapshot.count({
      where: { projectId: f.projectId, branchNodeCode: 'EXPERT_RECRUITMENT_RETRY' },
    }),
  ).toBe(1);
  expect(
    (await f.submit([{ ...f.item, sourceRejectedAssignmentId: f.personal.id }], f.handler.headers))
      .statusCode,
  ).toBe(200);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'EXPERT_RECRUITMENT_RETRY', status: 'OPEN' },
    }),
  ).toBe(0);
  expect(
    (
      await f.respond(
        f.orgAssignment.id,
        { decision: 'ACCEPT', projectOwnerUserId: f.owner.user.id },
        f.owner.headers,
      )
    ).statusCode,
  ).toBe(200);
  const memberRejected = await f.respond(f.orgAssignment.id, {
    decision: 'REJECT',
    rejectReason: '不参与',
  });
  expect(memberRejected.statusCode, memberRejected.body).toBe(200);
  expect(memberRejected.json().data).toMatchObject({
    status: 'ACCEPTED',
    memberStatus: 'REJECTED',
    nextAction: 'VIEW_RESULT',
  });
  const events = await db.projectEventOutbox.count();
  expect(
    (await f.respond(f.orgAssignment.id, { decision: 'REJECT', rejectReason: '重复原因' }))
      .statusCode,
  ).toBe(200);
  expect(await db.projectEventOutbox.count()).toBe(events);
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(
    await db.projectTaskRound.count({
      where: { projectId: f.projectId, taskType: 'EXPERT_RECRUITMENT_RETRY', status: 'OPEN' },
    }),
  ).toBe(0);
});

test('expert response rolls organization acceptance, selected owners, entries and rounds back on outbox failure', async () => {
  const f = await expertResponseFixture();
  const before = await db.projectExpertAssignment.findUnique({ where: { id: f.orgAssignment.id } });
  const { ExpertAssignmentService } =
    await import('../src/modules/expert/expert-assignment.service.js');
  const failing = new Proxy(db, {
    get(target, property) {
      if (property === '$transaction')
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            run(
              new Proxy(tx, {
                get(inner, key) {
                  if (key === 'projectEventOutbox')
                    return {
                      create: async () => {
                        throw new Error('response outbox failure');
                      },
                    };
                  return Reflect.get(inner, key);
                },
              }),
            ),
          );
      return Reflect.get(target, property);
    },
  });
  await expect(
    new ExpertAssignmentService(failing).respond(
      {
        assignmentId: f.orgAssignment.id,
        decision: 'ACCEPT',
        projectOwnerUserIds: [f.owner.user.id, f.individual.user.id],
      },
      {
        userId: f.owner.user.id,
        uid: f.owner.user.uid,
        role: 'EXPERT',
        clientType: 'desktop',
        sessionId: 'fixture',
      },
    ),
  ).rejects.toThrow('response outbox failure');
  expect(
    await db.projectExpertAssignment.findUnique({ where: { id: f.orgAssignment.id } }),
  ).toEqual(before);
  expect(await db.projectExpertAssignmentOwner.count()).toBe(0);
  expect(await db.projectExpertAssignmentMember.count()).toBe(0);
  expect(await db.projectMember.count()).toBe(0);
  expect(
    await db.projectTaskRound.count({ where: { projectId: f.projectId, role: 'EXPERT' } }),
  ).toBe(0);
});

test('expert response written exam opens expert rounds without creating attempts or admitting members', async () => {
  const f = await expertResponseFixture(true);
  const exam = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'response-exam',
      examName: '接单考试',
      createdBy: f.user.uid,
    },
  });
  const version = await db.entranceExamVersion.create({
    data: {
      examId: exam.id,
      versionNo: 1,
      examNameSnapshot: exam.examName,
      durationMinutes: 60,
      registrationDeadline: new Date('2099-01-01T00:00:00Z'),
      fullScore: 20,
      passScore: 12,
      publishedBy: f.user.uid,
      publishedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  await db.projectEntranceExam.update({
    where: { id: exam.id },
    data: { currentVersionId: version.id },
  });
  const personal = await f.respond(f.personal.id);
  expect(personal.statusCode, personal.body).toBe(200);
  expect(personal.json().data.nextAction).toBe('TAKE_ENTRANCE_EXAM');
  const organization = await f.respond(
    f.orgAssignment.id,
    { decision: 'ACCEPT', projectOwnerUserIds: [f.owner.user.id] },
    f.owner.headers,
  );
  expect(organization.statusCode, organization.body).toBe(200);
  // 组织待响应身份覆盖个人已接单身份，先撤旧考试轮次；成员实际接单后再开新轮次。
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.individual.user.id,
        taskType: 'ENTRANCE_EXAM',
        status: 'OPEN',
      },
    }),
  ).toBe(0);
  expect((await f.respond(f.orgAssignment.id)).statusCode).toBe(200);
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.entranceExamAttempt.count({ where: { examId: exam.id } })).toBe(0);
  const rounds = await db.projectTaskRound.findMany({
    where: { projectId: f.projectId, role: 'EXPERT', taskType: 'ENTRANCE_EXAM', status: 'OPEN' },
  });
  expect(rounds.map((r) => r.userId).sort()).toEqual(
    [f.owner.user.id, f.individual.user.id].sort(),
  );
  expect(rounds.every((r) => r.participated === false)).toBe(true);
});

async function examCandidateFixture() {
  const f = await expertResponseFixture(true);
  const exam = await db.projectEntranceExam.create({
    data: {
      projectId: f.projectId,
      examNo: 'candidate-entry',
      examName: '入场考试',
      createdBy: f.user.uid,
    },
  });
  const version = await db.entranceExamVersion.create({
    data: {
      examId: exam.id,
      versionNo: 1,
      examNameSnapshot: exam.examName,
      durationMinutes: 60,
      registrationDeadline: new Date('2099-01-01T00:00:00Z'),
      fullScore: 20,
      passScore: 12,
      publishedBy: f.user.uid,
      publishedAt: new Date(),
      createdBy: f.user.uid,
      papers: {
        create: {
          sequenceNo: 1,
          paperName: '固定卷',
          totalScore: 20,
          createdBy: f.user.uid,
          questions: {
            create: {
              sequenceNo: 1,
              questionContent: '请作答',
              referenceAnswer: '不得泄露',
              score: 20,
              createdBy: f.user.uid,
            },
          },
        },
      },
    },
  });
  await db.projectEntranceExam.update({
    where: { id: exam.id },
    data: { currentVersionId: version.id },
  });
  expect((await f.respond(f.personal.id)).statusCode).toBe(200);
  const enter = (headers = f.individual.headers) =>
    post('/entrance-exams/enter', { projectId: f.projectId }, headers);
  const current = (headers = f.individual.headers) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/entrance-exams/current?projectId=${f.projectId}`,
      headers,
    });
  return { ...f, exam, version, enter, current };
}

test('exam candidate entry serializes concurrent binding and preserves original paper after edit and close without admitting member', async () => {
  const f = await examCandidateFixture();
  expect((await f.current()).json().data.status).toBe('NOT_EXAMINED');
  const before = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const responses = await Promise.all([f.enter(), f.enter(), f.enter()]);
  for (const r of responses) expect(r.statusCode, r.body).toBe(200);
  const data = responses[0]!.json().data;
  expect(responses.map((r) => r.json().data)).toEqual([data, data, data]);
  expect(JSON.stringify(data)).not.toContain('不得泄露');
  expect(await db.entranceExamAttempt.count()).toBe(1);
  expect(await db.entranceExamAnswer.count()).toBe(0);
  expect(await db.entranceExamGradingRecord.count()).toBe(0);
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(before);
  const v2 = await db.entranceExamVersion.create({
    data: {
      examId: f.exam.id,
      versionNo: 2,
      examNameSnapshot: '新版本',
      durationMinutes: null,
      registrationDeadline: new Date('2099-01-01Z'),
      fullScore: 40,
      passScore: 30,
      publishedBy: f.user.uid,
      publishedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  await db.projectEntranceExam.update({
    where: { id: f.exam.id },
    data: { currentVersionId: v2.id, status: 'CLOSED' },
  });
  expect((await f.enter()).json().data).toEqual(data);
  expect((await f.current()).json().data.status).toBe('NOT_PASSED');
  await db.entranceExamAttempt.update({
    where: { id: data.attemptId },
    data: { submittedAt: new Date(), gradingStatus: 'PENDING' },
  });
  expect((await f.enter()).statusCode).toBe(409);
  expect((await f.current()).json().data.status).toBe('PENDING');
  await db.entranceExamAttempt.update({
    where: { id: data.attemptId },
    data: { finalResult: 'ADMITTED', finalDecidedAt: new Date() },
  });
  expect((await f.current()).json().data.status).toBe('PASSED');
});

test('exam candidate entry validates organization precedence, supervisor, departure and unchanged source binding', async () => {
  const f = await examCandidateFixture();
  expect(
    (
      await f.respond(
        f.orgAssignment.id,
        { decision: 'ACCEPT', projectOwnerUserIds: [f.individual.user.id] },
        f.owner.headers,
      )
    ).statusCode,
  ).toBe(200);
  expect((await f.enter(f.owner.headers)).statusCode).toBe(403);
  const result = await f.enter();
  expect(result.statusCode, result.body).toBe(200);
  const a = await db.entranceExamAttempt.findUniqueOrThrow({
    where: { id: result.json().data.attemptId },
  });
  expect(a).toMatchObject({
    sourceBizId: f.orgAssignment.id,
    organizationId: f.organization.id,
    userOrgRelId: f.rel.id,
    gradingStatus: 'NOT_STARTED',
  });
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'LEFT' } });
  // 个人接单仍有效，但不能把原组织答卷绑定静默改成个人。
  expect((await f.enter()).statusCode).toBe(403);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'ACTIVE' } });
  expect((await f.enter()).statusCode).toBe(200);
  await db.entranceExamAttempt.update({ where: { id: a.id }, data: { cancelledAt: new Date() } });
  expect((await f.enter()).statusCode).toBe(400);
  await post('/auth/switch-role', { role: 'PM' }, f.individual.headers);
  expect((await f.current()).statusCode).toBe(403);
  await post('/auth/switch-role', { role: 'EXPERT' }, f.individual.headers);
  await db.project.update({ where: { id: f.projectId }, data: { deleted: true } });
  expect((await f.current()).statusCode).toBe(404);
});

test('exam candidate entry rolls binding back on invalid paper and rejects missing, expired and exempt exams', async () => {
  const f = await examCandidateFixture();
  await db.entranceExamQuestion.deleteMany({ where: { paper: { examVersionId: f.version.id } } });
  const failed = await f.enter();
  expect(failed.statusCode, failed.body).toBe(500);
  expect(await db.entranceExamAttempt.count()).toBe(0);
  await db.entranceExamVersion.update({
    where: { id: f.version.id },
    data: { registrationDeadline: new Date(0) },
  });
  expect((await f.enter()).statusCode).toBe(400);
  await db.projectEntranceExam.update({ where: { id: f.exam.id }, data: { deleted: true } });
  expect((await f.enter()).statusCode).toBe(404);
  await db.projectProductionPlan.update({
    where: { projectId: f.projectId },
    data: { needWrittenExam: false },
  });
  expect((await f.enter()).statusCode).toBe(400);
  expect((await f.current()).json().data.status).toBe('NOT_EXAMINED');
});

async function candidateSubmissionFixture(firstMode: 'MANUAL' | 'AUTO' = 'MANUAL') {
  const f = await examCandidateFixture();
  // 选答只影响是否必须作答；每题仍须正分，完整试卷分值合计保持20。
  const required = await db.entranceExamQuestion.findFirstOrThrow({
    where: { paper: { examVersionId: f.version.id } },
  });
  await db.entranceExamQuestion.update({ where: { id: required.id }, data: { score: 10 } });
  const optional = await db.entranceExamQuestion.create({
    data: {
      paperId: required.paperId,
      sequenceNo: 2,
      questionContent: '选答',
      score: 10,
      requiredFlag: false,
      createdBy: f.user.uid,
    },
  });
  const rounds = [];
  for (const [index, mode] of [firstMode, firstMode === 'AUTO' ? 'MANUAL' : 'AUTO'].entries()) {
    rounds.push(
      await db.entranceExamGradingRound.create({
        data: {
          examVersionId: f.version.id,
          roundNo: index + 1,
          gradingMode: mode,
          reviewersJson: [{ userId: f.manager.user.id }],
          toolCode: mode === 'AUTO' ? 'mock' : null,
          createdBy: f.user.uid,
        },
      }),
    );
  }
  const entered = await f.enter();
  expect(entered.statusCode, entered.body).toBe(200);
  const paper = entered.json().data;
  const questionId = paper.questions[0].questionId as number;
  expect(paper.questions.map((q: { score: number }) => q.score)).toEqual([10, 10]);
  expect(paper.questions.reduce((total: number, q: { score: number }) => total + q.score, 0)).toBe(
    paper.fullScore,
  );
  const input = {
    projectId: f.projectId,
    attemptId: paper.attemptId,
    integritySigned: true,
    answers: [{ questionId, answerContent: '完整答案' }],
  };
  const submitExam = (patch = {}, headers = f.individual.headers) =>
    post('/entrance-exams/submit', { ...input, ...patch }, headers);
  const cancelExam = (headers = f.individual.headers) =>
    post('/entrance-exams/cancel', { projectId: f.projectId, attemptId: paper.attemptId }, headers);
  return { ...f, paper, questionId, optional, rounds, input, submitExam, cancelExam };
}

test('exam candidate submission concurrent complete paper preserves closed historical rounds through manual and signed mock admission', async () => {
  const f = await candidateSubmissionFixture();
  const project = await db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  const v2 = await db.entranceExamVersion.create({
    data: {
      examId: f.exam.id,
      versionNo: 2,
      examNameSnapshot: '新配置',
      registrationDeadline: new Date('2099-01-01Z'),
      fullScore: 100,
      passScore: 99,
      publishedBy: f.user.uid,
      publishedAt: new Date(),
      createdBy: f.user.uid,
    },
  });
  await db.projectEntranceExam.update({
    where: { id: f.exam.id },
    data: { currentVersionId: v2.id, status: 'CLOSED' },
  });
  const responses = await Promise.all([f.submitExam(), f.submitExam()]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(responses.find((r) => r.statusCode === 200)!.json().data).toMatchObject({
    attemptId: f.paper.attemptId,
    answerCount: 2,
    gradingRoundCount: 2,
    gradingStatus: 'PENDING',
  });
  const answers = await db.entranceExamAnswer.findMany({
    where: { attemptId: f.paper.attemptId },
    orderBy: { questionId: 'asc' },
  });
  expect(answers).toHaveLength(2);
  expect(answers.find((a) => a.questionId === f.optional.id)).toMatchObject({
    answeredFlag: false,
    answerContent: null,
  });
  const records = await db.entranceExamGradingRecord.findMany({
    where: { attemptId: f.paper.attemptId },
    include: { items: true },
    orderBy: { id: 'asc' },
  });
  expect(records.map((r) => [r.examVersionId, r.status, r.items.length])).toEqual([
    [f.version.id, 'PENDING', 2],
    [f.version.id, 'WAITING', 2],
  ]);
  for (const record of records)
    for (const item of record.items)
      expect(answers.find((a) => a.id === item.answerId)).toMatchObject({
        attemptId: item.attemptId,
        questionId: item.questionId,
        paperId: f.paper.paperId,
      });
  expect((await f.current()).json().data.status).toBe('PENDING');
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.individual.user.id,
        taskType: 'ENTRANCE_EXAM',
        status: 'COMPLETED',
        participated: true,
      },
    }),
  ).toBe(1);
  expect(
    await db.projectTaskRound.count({
      where: {
        projectId: f.projectId,
        userId: f.manager.user.id,
        taskType: 'ENTRANCE_EXAM_GRADING',
        status: 'OPEN',
      },
    }),
  ).toBe(2); // NAVIGATOR/PM两种会话待办
  const items = answers.map((a) => ({ questionId: a.questionId, correctness: 'CORRECT' }));
  const manual = await post(
    '/entrance-exams/grading/manual',
    {
      projectId: f.projectId,
      examId: f.exam.id,
      attemptId: f.paper.attemptId,
      gradingRecordId: records[0]!.id,
      items,
    },
    f.manager.headers,
  );
  expect(manual.statusCode, manual.body).toBe(200);
  expect(manual.json().data.finalResult).toBe('PENDING');
  const auto = new ExamAutoService(db),
    claim = await auto.claim(records[1]!.id);
  expect(claim).not.toBeNull();
  const callback = await autoHttpCallback({ ...claim!, status: 'SUCCEEDED', items });
  expect(callback.statusCode, callback.body).toBe(200);
  expect(callback.json().data.finalResult).toBe('ADMITTED');
  expect((await f.current()).json().data.status).toBe('PASSED');
  expect(
    await db.projectMember.findUnique({ where: { admissionAttemptId: f.paper.attemptId } }),
  ).toMatchObject({
    projectId: f.projectId,
    expertAssignmentId: f.personal.id,
    status: 'PENDING_CONFIRM',
    joinedAt: null,
  });
  expect(await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).toEqual(project);
  expect((await f.enter()).statusCode).toBe(409);
  expect((await f.cancelExam()).statusCode).toBe(409);
});

test('exam candidate submission AUTO first uses explicit mock failure retry and manual elimination without granting entry', async () => {
  const f = await candidateSubmissionFixture('AUTO');
  const submitted = await f.submitExam();
  expect(submitted.statusCode, submitted.body).toBe(200);
  const records = await db.entranceExamGradingRecord.findMany({
    where: { attemptId: f.paper.attemptId },
    orderBy: { id: 'asc' },
  });
  const first = records[0]!,
    second = records[1]!;
  const outbox = await db.projectEventOutbox.findFirstOrThrow({
    where: { projectId: f.projectId, eventType: 'EXAM_AUTO_DISPATCH_REQUESTED' },
  });
  expect(outbox.payload).toMatchObject({
    gradingRecordId: first.id,
    provider: 'mock',
    executionStatus: 'NOT_EXECUTED',
  });
  const auto = new ExamAutoService(db),
    claim = await auto.claim(first.id);
  const failed = await autoHttpCallback({ ...claim!, status: 'FAILED', errorMessage: '模拟失败' });
  expect(failed.statusCode, failed.body).toBe(200);
  expect(
    (await db.entranceExamGradingRecord.findUniqueOrThrow({ where: { id: second.id } })).status,
  ).toBe('WAITING');
  const retried = await post(
    '/entrance-exams/grading/retry',
    { projectId: f.projectId, examId: f.exam.id, gradingRecordId: first.id },
    f.manager.headers,
  );
  expect(retried.statusCode, retried.body).toBe(200);
  const nextClaim = await auto.claim(first.id);
  const items = [f.questionId, f.optional.id].map((questionId) => ({
    questionId,
    correctness: 'INCORRECT' as const,
  }));
  const completed = await autoHttpCallback({ ...nextClaim!, status: 'SUCCEEDED', items });
  expect(completed.statusCode, completed.body).toBe(200);
  const manual = await post(
    '/entrance-exams/grading/manual',
    {
      projectId: f.projectId,
      examId: f.exam.id,
      attemptId: f.paper.attemptId,
      gradingRecordId: second.id,
      items,
    },
    f.manager.headers,
  );
  expect(manual.statusCode, manual.body).toBe(200);
  expect(manual.json().data.finalResult).toBe('ELIMINATED');
  expect((await f.current()).json().data.status).toBe('NOT_PASSED');
  expect(await db.projectMember.count({ where: { projectId: f.projectId } })).toBe(0);
});

test('exam candidate submission and cancellation serialize to one winner and timeout still permits final cancellation without answers', async () => {
  const f = await candidateSubmissionFixture();
  const results = await Promise.all([f.submitExam(), f.cancelExam()]);
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  const attempt = await db.entranceExamAttempt.findUniqueOrThrow({
    where: { id: f.paper.attemptId },
  });
  expect(Boolean(attempt.submittedAt)).not.toBe(Boolean(attempt.cancelledAt));
  expect(await db.entranceExamAnswer.count()).toBe(attempt.submittedAt ? 2 : 0);
  expect(await db.entranceExamGradingRecord.count()).toBe(attempt.submittedAt ? 2 : 0);
  expect((await f.cancelExam()).statusCode).toBe(attempt.submittedAt ? 409 : 400);
  expect((await f.enter()).statusCode).toBe(attempt.submittedAt ? 409 : 400);
  // 第二位有效个人接单考生单独验证超时取消，不篡改前一应试终态。
  const other = await projectManagerAccount(8);
  await post('/auth/switch-role', { role: 'EXPERT' }, other.headers);
  await db.projectExpertAssignment.create({
    data: {
      assignmentNo: 'candidate-timeout',
      projectId: f.projectId,
      subjectType: 'INDIVIDUAL',
      expertUserId: other.user.id,
      status: 'ACCEPTED',
      createdBy: f.user.uid,
    },
  });
  const entered = await f.enter(other.headers);
  expect(entered.statusCode, entered.body).toBe(200);
  const attemptId = entered.json().data.attemptId;
  await db.entranceExamAttempt.update({
    where: { id: attemptId },
    data: { answerDeadlineAt: new Date(0) },
  });
  expect((await f.submitExam({ attemptId }, other.headers)).statusCode).toBe(400);
  const cancelled = await post(
    '/entrance-exams/cancel',
    { projectId: f.projectId, attemptId },
    other.headers,
  );
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  expect((await f.enter(other.headers)).statusCode).toBe(400);
  expect(await db.entranceExamAnswer.count({ where: { attemptId } })).toBe(0);
  const tasks = await post('/expert-assignments/my-tasks', {}, other.headers);
  expect(tasks.statusCode, tasks.body).toBe(200);
  expect(JSON.stringify(tasks.json().data)).not.toContain('ENTRANCE_EXAM');
});

test('exam candidate submission rejects foreign owners incomplete answers role and replaced organization without any saved work', async () => {
  const f = await candidateSubmissionFixture();
  for (const patch of [
    { integritySigned: false },
    { answers: [] },
    { answers: [{ questionId: f.optional.id, answerContent: '选答' }] },
    {
      answers: [
        { questionId: f.questionId, answerContent: 'x' },
        { questionId: f.questionId, answerContent: 'y' },
      ],
    },
    { answers: [{ questionId: f.questionId + 99999, answerContent: 'foreign' }] },
  ]) {
    const result = await f.submitExam(patch);
    expect(result.statusCode, result.body).toBe(400);
  }
  expect((await f.submitExam({}, f.owner.headers)).statusCode).toBe(403);
  expect((await f.submitExam({}, f.manager.headers)).statusCode).toBe(403);
  const accepted = await f.respond(
    f.orgAssignment.id,
    { decision: 'ACCEPT', projectOwnerUserIds: [f.individual.user.id] },
    f.owner.headers,
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
  // 仍有个人接单，但原个人卷不能换绑到新组织身份。
  expect((await f.submitExam()).statusCode).toBe(403);
  expect((await f.cancelExam()).statusCode).toBe(403);
  expect(await db.entranceExamAnswer.count()).toBe(0);
  expect(await db.entranceExamGradingRecord.count()).toBe(0);
  expect(
    (await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.paper.attemptId } }))
      .submittedAt,
  ).toBeNull();
});

async function candidateAnswerUpload(ownerUid: string, suffix: string) {
  const key = `entrance-exam-attachment/2026/10/23/candidate-${suffix}.txt`,
    body = Buffer.from('answer');
  await storage.put(key, body, 'text/plain');
  return registry.register(
    {
      objectKey: key,
      fileName: '答卷.txt',
      extension: 'txt',
      contentType: 'text/plain',
      fileSize: body.length,
      fileHash: 'b'.repeat(64),
    },
    'ENTRANCE_EXAM_ATTACHMENT',
    'PROJECT_ATTACHMENT',
    ownerUid,
  );
}
test('exam candidate submission claims own answer files and isolates candidate reference files and managed organization scopes', async () => {
  const f = await candidateSubmissionFixture();
  // 以独立组织考生进入，主管及项目负责人均可按组织职责查看答卷附件。
  expect(
    (
      await f.respond(
        f.orgAssignment.id,
        { decision: 'ACCEPT', projectOwnerUserIds: [f.individual.user.id] },
        f.owner.headers,
      )
    ).statusCode,
  ).toBe(200);
  const candidate = await projectManagerAccount(8);
  await post('/auth/switch-role', { role: 'EXPERT' }, candidate.headers);
  await db.userOrgRel.create({
    data: {
      userId: candidate.user.id,
      uid: candidate.user.uid,
      orgId: f.organization.id,
      joinStatus: 'ACTIVE',
    },
  });
  expect(
    (await f.respond(f.orgAssignment.id, { decision: 'ACCEPT' }, candidate.headers)).statusCode,
  ).toBe(200);
  const entered = await f.enter(candidate.headers);
  expect(entered.statusCode, entered.body).toBe(200);
  const attemptId = entered.json().data.attemptId;
  const own = await candidateAnswerUpload(candidate.user.uid, 'own');
  const reference = await candidateAnswerUpload(f.manager.user.uid, 'reference');
  await db.$transaction(async (tx) => {
    await registry.claimForEntranceExam(
      tx,
      reference.record.objectKey,
      reference.uploadToken,
      f.manager.user.uid,
      String(f.exam.id),
    );
    await tx.entranceExamQuestion.update({
      where: { id: f.questionId },
      data: { referenceFilesJson: [{ objectKey: reference.record.objectKey }] },
    });
  });
  const view = (key: string, headers: Record<string, string>) =>
    app.inject({ url: `/api/v1/files/view?objectKey=${encodeURIComponent(key)}`, headers });
  const answerFiles = [
    { objectKey: own.record.objectKey, uploadToken: own.uploadToken, fileName: '伪造元数据' },
  ];
  expect(
    (
      await f.submitExam(
        {
          attemptId,
          answers: [
            { questionId: f.questionId, answerFiles: [{ ...answerFiles[0], uploadToken: 'bad' }] },
          ],
        },
        candidate.headers,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.submitExam(
        {
          attemptId,
          answers: [
            {
              questionId: f.questionId,
              answerFiles: [
                { objectKey: reference.record.objectKey, uploadToken: reference.uploadToken },
              ],
            },
          ],
        },
        candidate.headers,
      )
    ).statusCode,
  ).toBe(409);
  const response = await f.submitExam(
    { attemptId, answers: [{ questionId: f.questionId, answerFiles }] },
    candidate.headers,
  );
  expect(response.statusCode, response.body).toBe(200);
  const answer = await db.entranceExamAnswer.findFirstOrThrow({
    where: { attemptId, questionId: f.questionId },
  });
  expect(answer).toMatchObject({
    answerContent: null,
    answeredFlag: true,
    answerFilesJson: [{ objectKey: own.record.objectKey, fileName: '答卷.txt' }],
  });
  for (const account of [candidate, f.owner, f.individual, f.manager]) {
    const result = await view(own.record.objectKey, account.headers);
    expect(result.statusCode, result.body).toBe(200);
  }
  expect((await view(reference.record.objectKey, candidate.headers)).statusCode).toBe(403);
  expect((await view(reference.record.objectKey, f.owner.headers)).statusCode).toBe(403);
  const outsider = await projectManagerAccount(9);
  await post('/auth/switch-role', { role: 'EXPERT' }, outsider.headers);
  expect((await view(own.record.objectKey, outsider.headers)).statusCode).toBe(403);
  await db.userOrgRel.updateMany({
    where: { userId: candidate.user.id, orgId: f.organization.id },
    data: { joinStatus: 'LEFT' },
  });
  expect((await view(own.record.objectKey, candidate.headers)).statusCode).toBe(403);
  await db.userOrgRel.update({ where: { id: f.rel.id }, data: { joinStatus: 'LEFT' } });
  expect((await view(own.record.objectKey, f.individual.headers)).statusCode).toBe(403);
});

test('exam candidate submission and cancellation outbox faults roll back answers claims rounds tasks and attempt atomically', async () => {
  const f = await candidateSubmissionFixture();
  const upload = await candidateAnswerUpload(f.individual.user.uid, 'rollback');
  const snapshot = async () => ({
    attempt: await db.entranceExamAttempt.findUniqueOrThrow({ where: { id: f.paper.attemptId } }),
    file: await db.uploadedFile.findUniqueOrThrow({ where: { id: upload.record.id } }),
    rounds: await db.projectTaskRound.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
    snapshots: await db.projectRoleNodeSnapshot.findMany({
      where: { projectId: f.projectId },
      orderBy: { id: 'asc' },
    }),
    events: await db.projectEventOutbox.count(),
  });
  const before = await snapshot();
  const failing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, k) {
                  if (k === 'projectEventOutbox')
                    return {
                      ...t.projectEventOutbox,
                      create: async () => {
                        throw new Error('candidate outbox failure');
                      },
                    };
                  return Reflect.get(t, k);
                },
              }),
            ),
          );
      return Reflect.get(target, key);
    },
  });
  const service = new ExamCandidateCommandService(failing, registry);
  const principal = {
    userId: f.individual.user.id,
    uid: f.individual.user.uid,
    role: 'EXPERT' as const,
    sessionId: 'unused',
    clientType: 'desktop' as const,
  };
  await expect(
    service.submit(
      {
        ...f.input,
        answers: [
          {
            questionId: f.questionId,
            answerFiles: [{ objectKey: upload.record.objectKey, uploadToken: upload.uploadToken }],
          },
        ],
      },
      principal,
    ),
  ).rejects.toThrow('candidate outbox failure');
  expect(await snapshot()).toEqual(before);
  expect(await db.entranceExamAnswer.count()).toBe(0);
  expect(await db.entranceExamGradingRecord.count()).toBe(0);
  await expect(service.cancel(f.input, principal)).rejects.toThrow('candidate outbox failure');
  expect(await snapshot()).toEqual(before);
  const result = await f.submitExam({
    answers: [
      {
        questionId: f.questionId,
        answerFiles: [{ objectKey: upload.record.objectKey, uploadToken: upload.uploadToken }],
      },
    ],
  });
  expect(result.statusCode, result.body).toBe(200);
});

// 09组织排班批次；延用专用_test库和串行清理，不操作开发库。
async function organizationScheduleFixture() {
  const tables = await db.$queryRaw<
    { receipt: string | null; events: string | null }[]
  >`SELECT to_regclass('public."OrganizationScheduleReceipt"')::text AS receipt, to_regclass('public."AttendanceEventOutbox"')::text AS events`;
  if (!tables[0]?.receipt || !tables[0]?.events)
    throw new Error(
      '专用测试库需第22迁移20261023010000_organization_schedules；先pnpm db:deploy:test再定向复验organization schedules',
    );
  const f = await memberFixture();
  const member = await f.add(),
    admin = await f.add('ADMIN'),
    pending = await f.add('MEMBER', 'PENDING_ACTIVATION');
  const payload = {
    orgId: f.orgId,
    schedules: [
      {
        memberId: member.rel.id,
        scheduleDate: '2026-10-01',
        dayType: 'WORK',
        startTime: '09:00',
        endTime: '18:00',
      },
    ],
    overwrite: false,
  };
  const write = (body: unknown = payload, key = 'schedule', headers = f.headers) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/organizations/schedules/details/batch',
      payload: body as never,
      headers: { ...headers, 'idempotency-key': key },
    });
  const list = (body = {}, headers = f.headers) =>
    post('/organizations/schedules', { orgId: f.orgId, month: '2026-10', ...body }, headers);
  return { ...f, member, admin, pending, payload, write, list };
}
test('organization schedules: concurrent idempotency, overwrite conflicts and API isolation persist exact receipts and pending events', async () => {
  const f = await organizationScheduleFixture();
  const results = await Promise.all([f.write(), f.write()]);
  expect(
    results.map((r) => r.statusCode),
    results.map((r) => r.body).join('\n'),
  ).toEqual([200, 200]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  expect(results[0]!.json().data).toMatchObject({
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
  });
  expect(await db.organizationScheduleReceipt.count()).toBe(1);
  expect(await db.attendanceEventOutbox.count({ where: { status: 'PENDING' } })).toBe(1);
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  const conflict = await f.write(f.payload, 'another');
  expect(conflict.json().data).toMatchObject({
    createdCount: 0,
    skippedCount: 1,
    conflicts: [{ memberId: f.member.rel.id, scheduleDate: '2026-10-01', versionNo: 0 }],
  });
  expect((await f.write({ ...f.payload, overwrite: true })).statusCode).toBe(409);
  expect(
    (await f.write({ ...f.payload, overwrite: true }, 'overwrite', f.admin.headers)).statusCode,
  ).toBe(200);
  expect(await db.orgMemberSchedule.findFirstOrThrow()).toMatchObject({ versionNo: 1 });
  const { OrganizationScheduleService } =
    await import('../src/modules/attendance/organization-schedule.service.js');
  const holiday = {
    month: async () => ({ days: [{ date: '2026-10-01', calendarDayType: 'PUBLIC_HOLIDAY' }] }),
  } as unknown as import('../src/modules/attendance/holiday-calendar.service.js').HolidayCalendarService;
  const service = new OrganizationScheduleService(db, holiday);
  const p = {
    userId: f.owner.id,
    uid: f.owner.uid,
    role: 'EXPERT' as const,
    sessionId: 'test',
    clientType: 'desktop' as const,
  };
  const range = await service.batch(
    'schedule',
    {
      orgId: f.orgId,
      memberIds: [f.member.rel.id, f.member.rel.id],
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      dayType: 'REST',
      overwrite: false,
    },
    p,
  );
  expect(range).toMatchObject({ createdCount: 2, skippedCount: 0 }); // 周四放假；周五和周一。
  expect(await db.organizationScheduleReceipt.count({ where: { kind: 'BATCH' } })).toBe(1);
});
test('organization schedules: database filters, whole-month readonly calendar, manager scope and organization loss are enforced', async () => {
  const f = await organizationScheduleFixture();
  await db.userOrgRel.update({
    where: { id: f.member.rel.id },
    data: { joinedAt: new Date('2026-09-30T16:00:00Z'), employmentType: 'FULL_TIME' },
  });
  expect((await f.write()).statusCode).toBe(200);
  const list = await f.list({ keyword: '2026-10-01', employmentType: 'FULL_TIME', size: 1 });
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().data).toMatchObject({
    total: 1,
    pages: 1,
    members: [{ memberId: f.member.rel.id, canSchedule: true }],
  });
  expect(list.json().data.members[0].days).toHaveLength(31);
  expect(list.json().data.members[0].days[0]).toMatchObject({
    scheduleDate: '2026-10-01',
    dayType: 'WORK',
  });
  expect((await f.list({ keyword: f.member.user.displayName })).json().data.total).toBe(1);
  expect((await f.list({ keyword: f.member.user.phoneE164.slice(3) })).json().data.total).toBe(1);
  expect((await f.list({ keyword: f.member.rel.id.slice(0, 15) })).json().data.total).toBe(1);
  expect((await f.list({ projectId: 2147483647 })).json().data.total).toBe(0);
  expect((await f.list({ current: 2147483647 })).json().data.members).toEqual([]);
  expect((await f.list({}, f.member.headers)).statusCode).toBe(403);
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  const unauthorizedOrg = await db.organization.create({
    data: { name: '异组织排班范围', expertiseTags: [], status: 'ACTIVE', verifyStatus: 'APPROVED' },
  });
  expect((await f.list({ orgId: unauthorizedOrg.id })).statusCode).toBe(403);
  expect((await f.write({ ...f.payload, orgId: unauthorizedOrg.id })).statusCode).toBe(403);
  expect(
    (
      await f.write(
        { ...f.payload, schedules: [{ ...f.payload.schedules[0], memberId: f.pending.rel.id }] },
        'pending',
      )
    ).statusCode,
  ).toBe(400);
  await db.userOrgRel.update({ where: { id: f.ownerRel.id }, data: { joinStatus: 'LEFT' } });
  expect((await f.write()).statusCode).toBe(403); // 已有回执也不能绕过失权。
  expect((await f.list()).statusCode).toBe(403);
});
test('organization schedules: existing daily is recalculated after schedule insert/overwrite while manual leave and audit remain intact', async () => {
  const f = await organizationScheduleFixture();
  const daily = await db.orgAttendanceDaily.create({
    data: {
      scopeKey: f.orgId,
      orgId: f.orgId,
      userOrgRelId: f.member.rel.id,
      userId: f.member.user.id,
      attendanceDate: new Date('2026-10-01'),
      firstClockInAt: new Date('2026-10-01T09:30:00Z'),
      lastClockOutAt: new Date('2026-10-01T17:30:00Z'),
      autoStatus: 'UNSCHEDULED',
      finalStatus: 'LEAVE',
      manualOverride: true,
      manualRemark: '已审批请假',
      createdBy: f.owner.uid,
      updatedBy: f.owner.uid,
    },
  });
  expect((await f.write()).statusCode).toBe(200);
  expect(await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: daily.id } })).toMatchObject({
    autoStatus: 'LATE_EARLY',
    finalStatus: 'LEAVE',
    manualRemark: '已审批请假',
    versionNo: 1,
    lateMinutes: 30,
    earlyLeaveMinutes: 30,
    workedMinutes: 480,
  });
  const rest = {
    ...f.payload,
    schedules: [{ memberId: f.member.rel.id, scheduleDate: '2026-10-01', dayType: 'REST' }],
    overwrite: true,
  };
  expect((await f.write(rest, 'rest')).statusCode).toBe(200);
  expect(await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: daily.id } })).toMatchObject({
    autoStatus: 'REST',
    finalStatus: 'LEAVE',
    versionNo: 2,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
  });
  expect(await db.orgAttendanceAdjustment.count()).toBe(0); // 重算不伪造人工审计。
});
test('organization schedules: receipt/outbox failures roll back schedule and daily, leaving key reusable', async () => {
  const f = await organizationScheduleFixture();
  const { OrganizationScheduleService } =
    await import('../src/modules/attendance/organization-schedule.service.js');
  const p = {
    userId: f.owner.id,
    uid: f.owner.uid,
    role: 'EXPERT' as const,
    sessionId: 'test',
    clientType: 'desktop' as const,
  };
  expect((await f.write()).statusCode).toBe(200);
  const original = await db.orgMemberSchedule.findFirstOrThrow();
  await db.orgAttendanceDaily.create({
    data: {
      scopeKey: f.orgId,
      orgId: f.orgId,
      userOrgRelId: f.member.rel.id,
      userId: f.member.user.id,
      scheduleId: original.id,
      attendanceDate: new Date('2026-10-01'),
      autoStatus: 'ABSENT',
      finalStatus: 'ABSENT',
      createdBy: f.owner.uid,
      updatedBy: f.owner.uid,
    },
  });
  const before = await db.orgAttendanceDaily.findFirstOrThrow();
  const update = {
    ...f.payload,
    overwrite: true,
    schedules: [{ memberId: f.member.rel.id, scheduleDate: '2026-10-01', dayType: 'REST' }],
  };
  for (const model of ['attendanceEventOutbox', 'organizationScheduleReceipt'] as const) {
    const faulty = new Proxy(db, {
      get(target, property) {
        if (property === '$transaction')
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
            target.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(inner, name) {
                      if (name === model)
                        return new Proxy(inner[model], {
                          get(delegate, operation) {
                            if (operation === 'create')
                              return () => {
                                throw new Error(`injected ${model}`);
                              };
                            return Reflect.get(delegate, operation);
                          },
                        });
                      return Reflect.get(inner, name);
                    },
                  }),
                ),
              options as never,
            );
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      new OrganizationScheduleService(faulty).details('rollback', update as never, p),
    ).rejects.toThrow('injected');
    expect(await db.orgMemberSchedule.findFirstOrThrow()).toEqual(original);
    expect(await db.orgAttendanceDaily.findFirstOrThrow()).toEqual(before);
    expect(await db.organizationScheduleReceipt.count()).toBe(1);
    expect(await db.attendanceEventOutbox.count()).toBe(1);
  }
  expect((await f.write(update, 'rollback')).statusCode).toBe(200);
});

// 09工作台打卡；只在既有专用_test库守卫下执行，需第23迁移。
async function attendanceClockFixture() {
  const tables = await db.$queryRaw<
    { events: string | null }[]
  >`SELECT to_regclass('public."AttendanceClockEvent"')::text AS events`;
  if (!tables[0]?.events)
    throw new Error(
      '专用_test库需第23迁移20261023020000_attendance_clock_events；先pnpm db:deploy:test，再定向复验attendance clock',
    );
  const f = await memberFixture(),
    member = await f.add();
  const { AttendanceClockService } =
    await import('../src/modules/attendance/attendance-clock.service.js');
  let now = new Date('2026-10-23T01:30:00.123Z');
  const service = new AttendanceClockService(db, () => now);
  const principal = {
    userId: member.user.id,
    uid: member.user.uid,
    role: 'EXPERT' as const,
    clientType: 'desktop' as const,
    sessionId: 'test',
  };
  const input = { orgId: f.orgId, timezone: 'Asia/Shanghai' };
  const clock = (key: string, extra = {}) =>
    service.clock(key, { ...input, ...extra }, principal, '127.0.0.1');
  return {
    ...f,
    member,
    service,
    principal,
    input,
    clock,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}
test('attendance clock: HTTP context is readonly, concurrent same-key clicks persist one immutable event and next clicks serialize', async () => {
  const f = await attendanceClockFixture();
  const url = `/api/v1/organizations/attendance/clock-context?orgId=${f.orgId}`;
  const context = await app.inject({ method: 'GET', url, headers: f.member.headers });
  expect(context.statusCode, context.body).toBe(200);
  expect(context.json().data).toMatchObject({
    orgId: f.orgId,
    canClock: true,
    nextClockType: 'CLOCK_IN',
    scheduleId: null,
  });
  expect(await db.orgAttendanceDaily.count()).toBe(0);
  const click = (key: string, extra = {}) =>
    post(
      '/organizations/attendance/clock',
      { orgId: f.orgId, ...extra },
      { ...f.member.headers, 'idempotency-key': key },
    );
  const responses = await Promise.all([click('same'), click('same')]);
  expect(
    responses.map((r) => r.statusCode),
    responses.map((r) => r.body).join('\n'),
  ).toEqual([200, 200]);
  expect(responses[0]!.json()).toEqual(responses[1]!.json());
  expect(responses[0]!.json().data).toMatchObject({
    clockType: 'CLOCK_IN',
    dailyAttendance: { autoStatus: 'UNSCHEDULED', versionNo: 1 },
  });
  const next = await Promise.all([click('out1'), click('out2')]);
  expect(
    next.map((r) => r.statusCode),
    next.map((r) => r.body).join('\n'),
  ).toEqual([200, 200]);
  expect(next.map((r) => r.json().data.clockType)).toEqual(['CLOCK_OUT', 'CLOCK_OUT']);
  expect(await db.attendanceClockEvent.count()).toBe(3);
  expect(await db.orgAttendanceDaily.findFirstOrThrow()).toMatchObject({ versionNo: 3 });
  expect(
    await db.attendanceEventOutbox.count({
      where: { status: 'PENDING', eventType: 'ATTENDANCE_CLOCK' },
    }),
  ).toBe(3);
  const before = await db.attendanceClockEvent.findMany({ orderBy: { id: 'asc' } });
  expect((await click('same', { clockType: 'CLOCK_OUT' })).statusCode).toBe(409);
  await expect(
    db.attendanceClockEvent.update({
      where: { id: before[0]!.id },
      data: { sourceRef: 'changed' },
    }),
  ).rejects.toThrow('append-only');
  await expect(db.attendanceClockEvent.delete({ where: { id: before[0]!.id } })).rejects.toThrow(
    'append-only',
  );
  expect(await db.attendanceClockEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
});
test('attendance clock: server phase, repeated outs, original-event schedule replay and manual status/audit protection are transactional', async () => {
  const f = await attendanceClockFixture();
  const first = await f.clock('in', {
    clockType: 'CLOCK_IN',
    sourceRef: 'request-1',
    extJson: { device: 'desktop' },
  });
  f.setNow('2026-10-23T09:30:00Z');
  await f.clock('out');
  const row = await db.orgAttendanceDaily.findUniqueOrThrow({
    where: { id: first.dailyAttendance.id },
  });
  const update = await post(
    '/organizations/attendance/update',
    {
      orgId: f.orgId,
      dailyId: row.id,
      versionNo: row.versionNo,
      finalStatus: 'LEAVE',
      manualRemark: '主管已批准',
    },
    f.headers,
  );
  expect(update.statusCode, update.body).toBe(200);
  const audit = await db.orgAttendanceAdjustment.findMany();
  // 故意污染派生首末快照，排班变更必须从原始事件恢复。
  await db.orgAttendanceDaily.update({
    where: { id: row.id },
    data: { firstClockInAt: new Date('2026-10-23T01:00Z'), lastClockOutAt: null },
  });
  const write = (startTime: string, endTime: string, key: string) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/organizations/schedules/details/batch',
      headers: { ...f.headers, 'idempotency-key': key },
      payload: {
        orgId: f.orgId,
        overwrite: true,
        schedules: [
          {
            memberId: f.member.rel.id,
            scheduleDate: '2026-10-23',
            dayType: 'WORK',
            startTime,
            endTime,
          },
        ],
      },
    });
  const changed = await write('09:00', '18:00', 'replay');
  expect(changed.statusCode, changed.body).toBe(200);
  expect(await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    firstClockInAt: new Date('2026-10-23T09:30:00.123Z'),
    lastClockOutAt: new Date('2026-10-23T17:30:00Z'),
    autoStatus: 'LATE_EARLY',
    finalStatus: 'LEAVE',
    manualRemark: '主管已批准',
    lateMinutes: 30,
    earlyLeaveMinutes: 30,
    workedMinutes: 479,
  });
  f.setNow('2026-10-23T10:30:00Z');
  const later = await f.clock('later');
  expect(later.dailyAttendance).toMatchObject({
    autoStatus: 'LATE',
    finalStatus: 'LEAVE',
    earlyLeaveMinutes: 0,
    workedMinutes: 539,
  });
  expect(await db.orgAttendanceAdjustment.findMany()).toEqual(audit);
  const events = await db.attendanceClockEvent.findMany({ orderBy: { id: 'asc' } });
  const replay = await f.clock('in', { timezone: 'UTC', sourceRef: 'ignored' });
  expect(replay.eventId).toBe(first.eventId); // 旧接口只比较预期类型，其余元数据不改写。
  expect(replay.dailyAttendance).toEqual(later.dailyAttendance);
  expect(await db.attendanceClockEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(events);
  // 新一天只查当天排班/事件，不继承昨日上班卡；午后首次为下班卡。
  f.setNow('2026-10-24T06:00:00Z');
  const tomorrow = await app.inject({
    method: 'PUT',
    url: '/api/v1/organizations/schedules/details/batch',
    headers: { ...f.headers, 'idempotency-key': 'tomorrow' },
    payload: {
      orgId: f.orgId,
      overwrite: false,
      schedules: [
        {
          memberId: f.member.rel.id,
          scheduleDate: '2026-10-24',
          dayType: 'WORK',
          startTime: '09:00',
          endTime: '18:00',
        },
      ],
    },
  });
  expect(tomorrow.statusCode, tomorrow.body).toBe(200);
  expect((await f.service.context(f.input, f.principal)).nextClockType).toBe('CLOCK_OUT');
  await expect(f.clock('stale', { clockType: 'CLOCK_IN' })).rejects.toMatchObject({ status: 409 });
  expect((await f.clock('tomorrow')).dailyAttendance).toMatchObject({
    attendanceDate: '2026-10-24',
    firstClockInAt: null,
    autoStatus: 'EARLY_LEAVE',
  });
});
test('attendance clock: multi-org target, pending-leave, actual loss, no-org role and personal schedule replay isolate scopes', async () => {
  const f = await attendanceClockFixture();
  const org = await db.organization.create({
    data: { name: '打卡第二组织', expertiseTags: [] },
  });
  await db.userOrgRel.create({
    data: {
      orgId: org.id,
      userId: f.member.user.id,
      uid: f.member.user.uid,
      joinStatus: 'PENDING_LEAVE',
      position: 'MEMBER',
    },
  });
  await f.clock('shared');
  const second = await f.service.clock('shared', { orgId: org.id }, f.principal, '127.0.0.1');
  expect(second.clockType).toBe('CLOCK_IN');
  expect(second.orgId).toBe(org.id);
  await expect(f.service.clock('personal', {}, f.principal, '127.0.0.1')).rejects.toMatchObject({
    status: 403,
  });
  const outsider = await f.add('MEMBER', 'PENDING_ACTIVATION');
  await expect(
    f.service.context(f.input, { ...f.principal, userId: outsider.user.id }),
  ).rejects.toMatchObject({ status: 403 });
  await db.userOrgRel.update({ where: { id: f.member.rel.id }, data: { joinStatus: 'LEFT' } });
  await expect(f.clock('shared')).rejects.toMatchObject({ status: 403 }); // 幂等不能绕过当前失权。
  await db.userOrgRel.updateMany({
    where: { userId: f.member.user.id },
    data: { joinStatus: 'LEFT' },
  });
  await expect(
    f.service.clock('personal', {}, { ...f.principal, role: 'PM' }, '127.0.0.1'),
  ).rejects.toMatchObject({ status: 403 });
  const personal = await f.service.clock('shared', {}, f.principal, '127.0.0.1');
  expect(personal).toMatchObject({
    orgId: null,
    memberId: null,
    clockType: 'CLOCK_IN',
    dailyAttendance: { autoStatus: 'UNSCHEDULED' },
  });
  const { AttendanceService } = await import('../src/modules/attendance/attendance.service.js');
  const schedule = await new AttendanceService(db).batch(
    'self-replay',
    { overwrite: true, schedules: [{ scheduleDate: '2026-10-23', dayType: 'REST' }] },
    f.principal,
  );
  expect(schedule).toMatchObject({ createdCount: 1 });
  expect(
    await db.orgAttendanceDaily.findUniqueOrThrow({ where: { id: personal.dailyAttendance.id } }),
  ).toMatchObject({
    autoStatus: 'REST',
    finalStatus: 'REST',
    firstClockInAt: new Date('2026-10-23T09:30:00.123Z'),
  });
  expect(await db.attendanceClockEvent.count()).toBe(3);
});
test('attendance clock: midnight resets event window, timezone date and milliseconds persist, retry replays old day', async () => {
  const f = await attendanceClockFixture();
  f.setNow('2026-10-23T15:59:59.999Z');
  const first = await f.clock('yesterday');
  expect(first.clockAt).toBe('2026-10-23 23:59:59.999');
  f.setNow('2026-10-23T16:00:00.001Z');
  const context = await f.service.context(f.input, f.principal);
  expect(context).toMatchObject({
    attendanceDate: '2026-10-24',
    nextClockType: 'CLOCK_IN',
    firstClockInAt: null,
    lastClockOutAt: null,
  });
  const second = await f.clock('today');
  expect(second.dailyAttendance.attendanceDate).toBe('2026-10-24');
  expect((await f.clock('yesterday')).eventId).toBe(first.eventId);
  expect(await db.orgAttendanceDaily.count()).toBe(2);
  expect(
    await db.attendanceClockEvent.findUniqueOrThrow({ where: { id: second.eventId } }),
  ).toMatchObject({
    occurredAt: new Date('2026-10-23T16:00:00.001Z'),
    clockAt: new Date('2026-10-24T00:00:00.001Z'),
    timezone: 'Asia/Shanghai',
  });
  await expect(
    f.service.context({ ...f.input, timezone: 'bad' }, f.principal),
  ).rejects.toMatchObject({ status: 400 });
});
test('attendance clock: daily/outbox failures roll back original event, daily and key so retry is reusable', async () => {
  const f = await attendanceClockFixture();
  const { AttendanceClockService } =
    await import('../src/modules/attendance/attendance-clock.service.js');
  for (const model of ['orgAttendanceDaily', 'attendanceEventOutbox'] as const) {
    const faulty = new Proxy(db, {
      get(target, property) {
        if (property === '$transaction')
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
            target.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(inner, name) {
                      if (name === model)
                        return new Proxy(inner[model], {
                          get(delegate, operation) {
                            if (
                              operation ===
                              (model === 'orgAttendanceDaily' ? 'updateMany' : 'create')
                            )
                              return () => {
                                throw new Error(`injected ${model}`);
                              };
                            return Reflect.get(delegate, operation);
                          },
                        });
                      return Reflect.get(inner, name);
                    },
                  }),
                ),
              options as never,
            );
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      new AttendanceClockService(faulty).clock('rollback', f.input, f.principal, '127.0.0.1'),
    ).rejects.toThrow(`injected ${model}`);
    expect(await db.attendanceClockEvent.count()).toBe(0);
    expect(await db.orgAttendanceDaily.count()).toBe(0);
    expect(await db.attendanceEventOutbox.count()).toBe(0);
  }
  expect((await f.clock('rollback')).clockType).toBe('CLOCK_IN');
  expect(await db.attendanceClockEvent.count()).toBe(1);
});
