import { randomInt, randomUUID } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  type User,
  type Organization,
  type UserOrgRel,
} from '@prisma/client';
import { BUSINESS_ROLES, type BusinessRole } from '@tyde/shared';
import type {
  OrganizationCreateInput,
  AuthUser,
  UserProfileUpdateInput,
  NicknameCheckResult,
  LoginInput,
  LoginResponse,
  SmsSendInput,
  SmsLoginInput,
  SmsLoginResponse,
  SmsRegisterInput,
  PasswordResetInput,
} from '@tyde/shared';
import type { Config } from '../../config/index.js';
import { AuthError } from './auth.error.js';
import {
  codeDigest,
  digest,
  matchesDigest,
  MOCK_CODE,
  newToken,
  SESSION_DAYS,
  type ClientType,
} from './security.js';
import { hashPassword, verifyPassword } from './password.js';
import { MockSmsProvider, type SmsProvider } from './sms.js';
import { FileRegistryService } from '../files/file-registry.service.js';
import { lockOrganization, participatingStatuses } from '../organizations/organization.service.js';
import { createObjectStorage } from '../files/object-storage.js';
type Tx = Prisma.TransactionClient;
type Profile = User & {
  memberships?: (UserOrgRel & { organization: Organization })[];
  assignmentOwners?: { assignment: { organizationId: string | null } }[];
  legacyOwnerAssignments?: { organizationId: string | null }[];
};
const profileInclude = {
  assignmentOwners: {
    where: {
      status: 'ACTIVE',
      assignment: { subjectType: 'ORGANIZATION', status: 'ACCEPTED', project: { deleted: false } },
    },
    select: { assignment: { select: { organizationId: true } } },
  },
  legacyOwnerAssignments: {
    where: {
      subjectType: 'ORGANIZATION',
      status: 'ACCEPTED',
      owners: { none: {} },
      project: { deleted: false },
    },
    select: { organizationId: true },
  },
  memberships: {
    where: { joinStatus: { in: participatingStatuses }, organization: { deleted: false } },
    include: { organization: true },
  },
};
// 服务端业务身份；角色只表示登录身份，业务权限和数据范围仍由各模块检查。
export interface AuthPrincipal {
  userId: string;
  uid: string;
  sessionId: string;
  role: BusinessRole;
  clientType: ClientType;
}
const invalid = (message: string) => new AuthError(400, 'VALIDATION_ERROR', message);
const unauthorized = () => new AuthError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
function phoneNumber(phone: string): string {
  return `+86${phone}`;
}
async function lock(tx: Tx, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}
function publicUser(user: Profile, selectedRole: BusinessRole | null = null): AuthUser {
  const memberships = (user.memberships ?? []).filter(
    (rel) => participatingStatuses.includes(rel.joinStatus) && !rel.organization.deleted,
  );
  const chosen = [...memberships].sort((a, b) => {
    const owner = Number(b.position === 'OWNER') - Number(a.position === 'OWNER');
    return (
      owner ||
      (a.joinedAt?.getTime() ?? Infinity) - (b.joinedAt?.getTime() ?? Infinity) ||
      a.id.localeCompare(b.id)
    );
  })[0];
  const org = chosen?.organization;
  const result: AuthUser = {
    id: user.id,
    uid: user.uid,
    accountType: 'INDIVIDUAL',
    phone: user.phoneE164.slice(3).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
    nickname: user.displayName,
    realName: user.realName ?? user.displayName,
    idCardNo: user.idCardNo
      ? `${user.idCardNo.slice(0, 3)}${'*'.repeat(user.idCardNo.length - 7)}${user.idCardNo.slice(-4)}`
      : null,
    idVerified: user.idVerified ?? 0,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    role: selectedRole ?? 'EXPERT',
    roles: [...BUSINESS_ROLES],
    selectedRole,
    hasExpertManagementRole: Boolean(
      selectedRole === 'EXPERT' &&
      (memberships.some((rel) => rel.position === 'OWNER') ||
        [
          ...(user.assignmentOwners ?? []).map((o) => o.assignment),
          ...(user.legacyOwnerAssignments ?? []),
        ].some((a) => memberships.some((r) => r.orgId === a.organizationId))),
    ),
    status: user.status,
    creditScore: 100,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lastLoginIp: user.lastLoginIp,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    organization: org
      ? {
          id: org.id,
          name: org.name,
          unifiedCreditCode: org.unifiedCreditCode,
          description: org.description,
          businessLicenseUrl: org.businessLicenseKey ?? null,
          logoUrl: org.logoUrl,
          expertiseTags: org.expertiseTags,
          verifyStatus: org.verifyStatus,
          status: org.status,
          position: chosen!.position,
          joinStatus: chosen!.joinStatus,
          createdAt: org.createdAt.toISOString(),
        }
      : null,
  };
  result.organizations = [...memberships]
    .sort((a, b) => a.orgId.localeCompare(b.orgId))
    .map((rel) => ({
      id: rel.orgId,
      name: rel.organization.name,
      position: rel.position,
      joinStatus: rel.joinStatus,
      status: rel.organization.status,
      verifyStatus: rel.organization.verifyStatus,
    }));
  return result;
}
export class AuthService {
  constructor(
    readonly db: PrismaClient,
    private readonly config: Config,
    private readonly sms: SmsProvider = new MockSmsProvider(),
    private readonly files = new FileRegistryService(
      db,
      createObjectStorage(config.files),
      config.files,
    ),
  ) {}
  private async rate(entries: { key: string; max: number; seconds: number }[]) {
    const now = Date.now();
    const limited = await this.db.$transaction(async (tx) => {
      let retry = 0;
      for (const e of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
        const window = Math.floor(now / (e.seconds * 1000));
        const expiresAt = new Date((window + 1) * e.seconds * 1000);
        const row = await tx.authRateLimit.upsert({
          where: { key: `${e.key}:${window}` },
          create: { key: `${e.key}:${window}`, count: 1, expiresAt },
          update: { count: { increment: 1 } },
        });
        if (row.count > e.max)
          retry = Math.max(retry, Math.ceil((expiresAt.getTime() - now) / 1000));
      }
      return retry;
    });
    if (limited) throw new AuthError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试', limited);
  }
  async sendCode(input: SmsSendInput, ip: string) {
    const phone = phoneNumber(input.phone);
    await this.rate([
      { key: `send-phone:${phone}`, max: 5, seconds: 900 },
      { key: `send-ip:${digest(ip)}`, max: 30, seconds: 900 },
    ]);
    const result = await this.db.$transaction(
      async (tx) => {
        await lock(tx, phone);
        const now = new Date();
        const recent = await tx.verificationChallenge.findFirst({
          where: { phoneE164: phone },
          orderBy: { createdAt: 'desc' },
        });
        const wait = recent
          ? Math.ceil((recent.createdAt.getTime() + 60_000 - now.getTime()) / 1000)
          : 0;
        if (wait > 0) return new AuthError(429, 'RATE_LIMITED', '请等待后重新获取验证码', wait);
        const id = randomUUID();
        const code =
          this.sms.mode === 'mock' ? MOCK_CODE : String(randomInt(0, 1_000_000)).padStart(6, '0');
        await tx.verificationChallenge.updateMany({
          where: { phoneE164: phone, purpose: input.scene, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: now },
        });
        await tx.verificationChallenge.create({
          data: {
            id,
            phoneE164: phone,
            purpose: input.scene,
            codeDigest: codeDigest(this.config.codeSecret, id, phone, code, input.scene),
            expiresAt: new Date(now.getTime() + 300_000),
          },
        });
        await this.sms.send(phone, code, id);
        return '验证码已发送，请注意查收';
      },
      { timeout: 10_000 },
    );
    if (result instanceof AuthError) throw result;
    return result;
  }
  private async consume(
    tx: Tx,
    phone: string,
    scene: string,
    code: string,
  ): Promise<AuthError | undefined> {
    const row = await tx.verificationChallenge.findFirst({
      where: { phoneE164: phone, purpose: scene },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    if (!row || row.expiresAt <= now || row.consumedAt || row.invalidatedAt)
      return invalid('验证码错误或已过期');
    if (row.failedAttempts >= 5)
      return new AuthError(
        429,
        'CODE_ATTEMPTS_EXCEEDED',
        '验证码尝试次数已用尽，请重新获取',
        Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)),
      );
    if (
      !matchesDigest(row.codeDigest, codeDigest(this.config.codeSecret, row.id, phone, code, scene))
    ) {
      await tx.verificationChallenge.update({
        where: { id: row.id },
        data: { failedAttempts: { increment: 1 } },
      });
      return invalid('验证码错误或已过期');
    }
    await tx.verificationChallenge.update({ where: { id: row.id }, data: { consumedAt: now } });
  }
  private async issue(
    tx: Tx,
    user: User,
    client: ClientType,
    ip?: string,
    selectedRole: BusinessRole = 'EXPERT',
  ): Promise<LoginResponse> {
    if (user.status !== 'ACTIVE')
      throw new AuthError(403, 'FORBIDDEN', '账户已被禁用，请联系平台运营');
    if (ip !== undefined) {
      const pending = await tx.userOrgRel.findMany({
        where: { userId: user.id, joinStatus: 'PENDING_ACTIVATION' },
        select: { orgId: true },
        orderBy: { orgId: 'asc' },
      });
      for (const rel of pending) await lockOrganization(tx, rel.orgId);
      if (pending.length)
        await tx.userOrgRel.updateMany({
          where: { userId: user.id, joinStatus: 'PENDING_ACTIVATION' },
          data: {
            joinStatus: 'ACTIVE',
            versionNo: { increment: 1 },
            updatedBy: user.uid,
            updatedAt: new Date(),
          },
        });
    }
    if (ip !== undefined)
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      });
    const accessToken = newToken(),
      refreshToken = newToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await tx.session.create({
      data: {
        tokenDigest: digest(accessToken),
        refreshDigest: digest(refreshToken),
        refreshExpiresAt: expiresAt,
        userId: user.id,
        clientType: client,
        selectedRole,
        expiresAt,
      },
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: SESSION_DAYS * 86_400 };
  }
  async register(input: SmsRegisterInput, ip: string): Promise<AuthUser> {
    if (Boolean(input.code) === Boolean(input.registrationToken))
      throw invalid('验证码和注册凭证必须且只能提交一个');
    if (input.password !== input.confirmPassword) throw invalid('两次输入的密码不一致');
    const realName = input.realName.trim();
    if (!/^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\-·]{0,63}$/.test(realName))
      throw invalid('姓名格式不正确，仅支持中英文、连字符与间隔号');
    const idCardNo = input.idCardNo?.trim().toUpperCase() || null;
    if (idCardNo && !/^(\d{15}|\d{17}[0-9X])$/.test(idCardNo)) throw invalid('身份证号格式不正确');
    const email = input.email?.trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('邮箱格式不正确');
    const passwordHash = await hashPassword(input.password);
    await this.rate([{ key: `register-ip:${digest(ip)}`, max: 100, seconds: 900 }]);
    try {
      const result = await this.db.$transaction(async (tx) => {
        const phone = phoneNumber(input.phone);
        await lock(tx, phone);
        if (input.registrationToken) {
          const used = await tx.registrationGrant.updateMany({
            where: {
              tokenDigest: digest(`sms-registration:${input.registrationToken}`),
              phoneE164: phone,
              consumedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { consumedAt: new Date() },
          });
          if (used.count !== 1) return invalid('注册凭证无效或已过期，请重新获取登录验证码');
        } else {
          const error = await this.consume(tx, phone, 'register', input.code!);
          if (error) return error;
        }
        const uid = randomUUID().replaceAll('-', '');
        const user = await tx.user.create({
          data: {
            uid,
            // 初始迁移要求 username 以字母开头且不超过 32 字符；uid 保留完整 UUID。
            username: `u${uid.slice(1)}`,
            phoneE164: phone,
            phoneRegion: 'CN',
            displayName: input.nickname?.trim() || realName,
            realName,
            passwordHash,
            email,
            idCardNo,
            accountType: 'INDIVIDUAL',
            role: 'EXPERT',
          },
          include: profileInclude,
        });
        return publicUser(user);
      });
      if (result instanceof AuthError) throw result;
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(
          409,
          'DUPLICATE',
          '手机号/昵称/邮箱/身份证/组织信息已被占用，请更换后重试',
        );
      throw error;
    }
  }
  async login(input: LoginInput, ip: string, client: ClientType) {
    const selectedRole = this.businessRole(input.role);
    const account = input.account.trim().toLowerCase();
    await this.rate([
      { key: `login-ip:${digest(ip)}`, max: 100, seconds: 900 },
      { key: `login-account:${digest(account)}`, max: 10, seconds: 900 },
    ]);
    const user = await this.db.user.findFirst({
      where: { OR: [{ phoneE164: phoneNumber(account) }, { email: account }, { uid: account }] },
    });
    if (!(await verifyPassword(input.password, user?.passwordHash ?? null)) || !user)
      throw new AuthError(401, 'BAD_CREDENTIALS', '账号或密码错误');
    return this.db.$transaction(async (tx) => {
      await lock(tx, user.phoneE164);
      // Re-read under the password-reset lock so old passwords cannot create new sessions after reset.
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.passwordHash !== user.passwordHash)
        throw new AuthError(401, 'BAD_CREDENTIALS', '账号或密码错误');
      return this.issue(tx, current, client, ip, selectedRole);
    });
  }
  async loginBySms(
    input: SmsLoginInput,
    ip: string,
    client: ClientType,
  ): Promise<SmsLoginResponse> {
    const selectedRole = this.businessRole(input.role);
    await this.rate([{ key: `verify-ip:${digest(ip)}`, max: 100, seconds: 900 }]);
    const result = await this.db.$transaction(async (tx) => {
      const phone = phoneNumber(input.phone);
      await lock(tx, phone);
      const error = await this.consume(tx, phone, 'login', input.code);
      if (error) return error;
      const user = await tx.user.findUnique({ where: { phoneE164: phone } });
      if (!user) {
        const registrationToken = newToken();
        const expiresAt = new Date(Date.now() + 600_000);
        // 重新验证同一手机号时使之前的注册凭证失效，只保留最新一次。
        await tx.registrationGrant.updateMany({
          where: { phoneE164: phone, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        await tx.registrationGrant.create({
          data: {
            tokenDigest: digest(`sms-registration:${registrationToken}`),
            phoneE164: phone,
            phoneRegion: 'CN',
            expiresAt,
          },
        });
        return {
          status: 'registration_required' as const,
          registrationToken,
          expiresAt: expiresAt.toISOString(),
        };
      }
      return this.issue(tx, user, client, ip, selectedRole);
    });
    if (result instanceof AuthError) throw result;
    return result;
  }
  async resetPassword(input: PasswordResetInput, ip: string) {
    await this.rate([{ key: `reset-ip:${digest(ip)}`, max: 100, seconds: 900 }]);
    const passwordHash = await hashPassword(input.newPassword);
    const result = await this.db.$transaction(async (tx) => {
      const phone = phoneNumber(input.phone);
      await lock(tx, phone);
      const error = await this.consume(tx, phone, 'reset_password', input.code);
      if (error) return error;
      const user = await tx.user.findUnique({ where: { phoneE164: phone } });
      if (!user) return new AuthError(404, 'NOT_FOUND', '手机号未注册');
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    if (result instanceof AuthError) throw result;
  }
  async refresh(refreshToken: string, client: ClientType) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw unauthorized();
    const initial = await this.db.session.findUnique({
      where: { refreshDigest: digest(refreshToken) },
      include: { user: true },
    });
    if (!initial) throw unauthorized();
    return this.db.$transaction(async (tx) => {
      await lock(tx, initial.user.phoneE164);
      const now = new Date();
      const used = await tx.session.updateMany({
        where: {
          id: initial.id,
          revokedAt: null,
          clientType: client,
          refreshExpiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (used.count !== 1) throw unauthorized();
      const user = await tx.user.findUniqueOrThrow({ where: { id: initial.userId } });
      const latest = await tx.session.findUniqueOrThrow({ where: { id: initial.id } });
      return this.issue(tx, user, client, undefined, this.businessRole(latest.selectedRole));
    });
  }
  private async requireSession(token: string | undefined, client: ClientType) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    const session = await this.db.session.findUnique({
      where: { tokenDigest: digest(token) },
      include: { user: { include: profileInclude } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.clientType !== client ||
      session.user.status !== 'ACTIVE'
    )
      throw unauthorized();
    return session;
  }
  async authenticate(token: string | undefined, client: ClientType): Promise<AuthPrincipal> {
    const session = await this.requireSession(token, client);
    return {
      userId: session.userId,
      uid: session.user.uid,
      sessionId: session.id,
      role: this.businessRole(session.selectedRole),
      clientType: client,
    };
  }
  async me(token: string | undefined, client: ClientType) {
    const session = await this.requireSession(token, client);
    return publicUser(session.user, this.businessRole(session.selectedRole));
  }
  async checkNickname(nickname: string): Promise<NicknameCheckResult> {
    const name = nickname.trim();
    if (!name || Array.from(name).length > 64) throw invalid('昵称不能为空或超过64字符');
    const exists = async (displayName: string) =>
      Boolean(await this.db.user.findUnique({ where: { displayName }, select: { id: true } }));
    if (!(await exists(name)))
      return { nickname: name, available: true, suggestion: name, message: '昵称可用' };
    // 推荐值也遵守注册64字符上限；最多1000次，避免无限数据库查询。
    for (let i = 1; i <= 1000; i++) {
      const suffix = String(i);
      const candidate =
        Array.from(name)
          .slice(0, 64 - suffix.length)
          .join('') + suffix;
      if (!(await exists(candidate)))
        return {
          nickname: name,
          available: false,
          suggestion: candidate,
          message: `昵称已存在，可使用推荐昵称「${candidate}」`,
        };
    }
    throw new AuthError(409, 'DUPLICATE', '暂无可用推荐昵称，请更换昵称');
  }
  async updateCurrentUser(
    token: string | undefined,
    client: ClientType,
    input: UserProfileUpdateInput,
  ) {
    const session = await this.requireSession(token, client);
    const hasPassword = input.newPassword != null;
    if (input.avatarUploadToken != null && input.avatarUrl == null)
      throw invalid('avatarUploadToken必须与avatarUrl一起提交');
    if (hasPassword || input.confirmNewPassword != null) {
      if (
        !hasPassword ||
        input.confirmNewPassword == null ||
        input.newPassword !== input.confirmNewPassword
      )
        throw invalid('两次输入的新密码不一致');
    }
    const passwordHash = hasPassword ? await hashPassword(input.newPassword!) : undefined;
    try {
      return await this.db.$transaction(async (tx) => {
        // 与登录、刷新及重置密码共用手机号锁，锁内复查会话，防止已撤销凭据继续写入。
        await lock(tx, session.user.phoneE164);
        const active = await tx.session.findUnique({
          where: { id: session.id },
          include: { user: true },
        });
        if (
          !active ||
          active.revokedAt ||
          active.expiresAt <= new Date() ||
          active.user.status !== 'ACTIVE'
        )
          throw unauthorized();
        const data: Prisma.UserUpdateInput = { updatedBy: session.user.uid, updatedAt: new Date() };
        if (input.avatarUrl != null)
          data.avatarUrl = await this.files.syncAvatar(
            tx,
            session.userId,
            session.user.uid,
            input.avatarUrl.trim(),
            input.avatarUploadToken,
          );
        if (input.bio != null) data.bio = input.bio.trim() || null;
        if (input.idCardNo != null) {
          const idCardNo = input.idCardNo.trim().toUpperCase() || null;
          if (idCardNo && !/^(\d{15}|\d{17}[0-9X])$/.test(idCardNo))
            throw invalid('身份证号格式不正确');
          if (active.user.idVerified === 1 && active.user.idCardNo !== idCardNo)
            throw new AuthError(403, 'FORBIDDEN', '身份证已实名认证，不能修改');
          data.idCardNo = idCardNo;
        }
        if (passwordHash !== undefined) data.passwordHash = passwordHash;
        // roles兼容字段不修改三角色资格或当前会话身份。
        const user = await tx.user.update({
          where: { id: session.userId },
          data,
          include: profileInclude,
        });
        if (passwordHash !== undefined)
          await tx.session.updateMany({
            where: { userId: session.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        return publicUser(user, this.businessRole(active.selectedRole));
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(409, 'DUPLICATE', '身份证号已被其他用户使用');
      throw error;
    }
  }
  async createOrganization(
    token: string | undefined,
    client: ClientType,
    input: OrganizationCreateInput,
  ) {
    const session = await this.requireSession(token, client);
    if (this.businessRole(session.selectedRole) !== 'EXPERT')
      throw new AuthError(403, 'FORBIDDEN', '请切换到执行专家角色创建组织');
    const name = input.name.trim();
    if (!name) throw invalid('组织名称不能为空');
    if (input.logoUploadToken != null && input.logoUrl == null)
      throw invalid('logoUploadToken必须与logoUrl一起提交');
    try {
      return await this.db.$transaction(async (tx) => {
        await lock(tx, session.user.phoneE164);
        const active = await tx.session.findUnique({
          where: { id: session.id },
          include: { user: true },
        });
        if (
          !active ||
          active.revokedAt ||
          active.expiresAt <= new Date() ||
          active.user.status !== 'ACTIVE'
        )
          throw unauthorized();
        if (this.businessRole(active.selectedRole) !== 'EXPERT')
          throw new AuthError(403, 'FORBIDDEN', '请切换到执行专家角色创建组织');
        const org = await tx.organization.create({
          data: {
            name,
            unifiedCreditCode: input.unifiedCreditCode?.trim() || null,
            description: input.description?.trim() || null,
            logoUrl: input.logoUrl?.trim() || null,
            expertiseTags: input.expertiseTags ?? [],
            status: 'ACTIVE',
            verifyStatus: 'APPROVED',
            updatedBy: session.user.uid,
          },
        });
        if (input.businessLicense) {
          const file = await this.files.claimForOrganizationRegistration(
            tx,
            input.businessLicense.objectKey,
            input.businessLicense.uploadToken,
            org.id,
          );
          org.businessLicenseKey = file.objectKey;
          await tx.organization.update({
            where: { id: org.id },
            data: { businessLicenseKey: file.objectKey },
          });
        }
        if (input.logoUrl != null) {
          org.logoUrl =
            (await this.files.syncOrganizationLogo(
              tx,
              org.id,
              session.user.uid,
              input.logoUrl.trim(),
              input.logoUploadToken,
            )) || null;
          await tx.organization.update({ where: { id: org.id }, data: { logoUrl: org.logoUrl } });
        }
        await tx.userOrgRel.create({
          data: {
            userId: session.userId,
            uid: session.user.uid,
            orgId: org.id,
            position: 'OWNER',
            joinStatus: 'ACTIVE',
            createdBy: session.user.uid,
            updatedBy: session.user.uid,
          },
        });
        return {
          id: org.id,
          name: org.name,
          unifiedCreditCode: org.unifiedCreditCode,
          description: org.description,
          businessLicenseUrl: org.businessLicenseKey,
          logoUrl: org.logoUrl,
          expertiseTags: org.expertiseTags,
          verifyStatus: org.verifyStatus,
          status: org.status,
          position: 'OWNER',
          createdAt: org.createdAt.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AuthError(409, 'DUPLICATE', '组织名称或统一社会信用代码已被占用');
      throw error;
    }
  }
  private businessRole(role?: string): BusinessRole {
    if (role === undefined) return 'EXPERT';
    if (!(BUSINESS_ROLES as readonly string[]).includes(role))
      throw new AuthError(403, 'FORBIDDEN', '仅可使用领航员、策略官或执行专家角色');
    return role as BusinessRole;
  }
  async switchRole(token: string | undefined, client: ClientType, role: BusinessRole) {
    const selectedRole = this.businessRole(role);
    const session = await this.requireSession(token, client);
    await this.db.$transaction(async (tx) => {
      await lock(tx, session.user.phoneE164);
      const result = await tx.session.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: { status: 'ACTIVE' },
        },
        data: { selectedRole },
      });
      if (result.count !== 1) throw unauthorized();
    });
    return { selectedRole, roles: [...BUSINESS_ROLES] };
  }
  async logout(token: string | undefined) {
    if (token)
      await this.db.session.updateMany({
        where: { tokenDigest: digest(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }
}
