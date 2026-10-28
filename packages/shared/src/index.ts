import type {
  AuthUser,
  BusinessRole,
  LoginInput,
  RegistrationRequired,
  SmsLoginInput,
  SmsRegisterInput,
  SmsSendInput,
  UserProfileUpdateInput,
} from './auth.js';

export const APP_NAME = 'tyde';
export const API_PREFIX = '/api/v1';
/** 当前 mock 短信的固定测试码，服务端使用、前端发码成功后展示；接入真实短信时移除展示。 */
export const MOCK_SMS_CODE = '095270';
export { IPC } from './ipc.js';
export * from './auth.js';
export * from './organizations.js';
export * from './workbench.js';
export * from './projects.js';
export * from './expert-tasks.js';
export * from './entrance-exams.js';
import type {
  BusinessLicenseUploadResult,
  OrganizationApi,
  OrganizationImportResult,
} from './organizations.js';
import type { WorkbenchApi } from './workbench.js';
import type { ProjectApi } from './projects.js';
import type { ExpertTasksApi } from './expert-tasks.js';
import type { EntranceExamApi } from './entrance-exams.js';

/** 登录令牌由平台适配器保管，页面只接收登录状态或注册指引。 */
export interface Authenticated {
  status: 'authenticated';
}
export type VerifyResult = Authenticated | RegistrationRequired;
export interface ApiFailure {
  code: string | number;
  message: string;
  requestId?: string;
  fields?: Record<string, string>;
}
export class ApiError extends Error {
  readonly code: string | number;
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfter?: number;
  constructor(status: number, failure: ApiFailure, retryAfter?: number) {
    super(failure.message);
    this.name = 'ApiError';
    this.code = failure.code;
    this.status = status;
    this.requestId = failure.requestId;
    this.retryAfter = retryAfter;
  }
}
/** 行级校验失败携带完整导入结果，供页面逐行展示；并非导入成功。 */
export class OrganizationImportError extends ApiError {
  readonly result: OrganizationImportResult;
  constructor(failure: ApiFailure, result: OrganizationImportResult, retryAfter?: number) {
    super(400, failure, retryAfter);
    this.name = 'OrganizationImportError';
    this.result = result;
  }
}
/** 现有组织资料查询响应；权限与身份由后端按指定组织校验。 */
export interface OrganizationDetail {
  id: string;
  name: string;
  unifiedCreditCode: string | null;
  description: string | null;
  businessLicenseUrl: string | null;
  logoUrl: string | null;
  expertiseTags: string[];
  verifyStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  status: 'ACTIVE' | 'FROZEN' | 'DISSOLVED';
  position: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: string;
}
/** 与现有 AVATAR/IMAGE 上传策略一致；实际内容与声明 MIME 仍由服务端校验。 */
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] as const;
export const AVATAR_ACCEPT = AVATAR_EXTENSIONS.map((extension) => `.${extension}`).join(',');
/** 组织 Logo 与头像使用同一图片策略。 */
export const ORG_LOGO_MAX_BYTES = AVATAR_MAX_BYTES;
export const ORG_LOGO_ACCEPT = AVATAR_ACCEPT;
export interface ImageUploadResult {
  objectKey: string;
  /** 一次性认领凭证，仅内存保留，随对应资料保存请求提交。 */
  uploadToken: string;
  url: string | null;
  sensitive: false;
  fileName: string;
  extension: (typeof AVATAR_EXTENSIONS)[number];
  size: number;
  contentType: string;
  fileHash: string;
}
export type AvatarUploadResult = ImageUploadResult;
export type OrganizationLogoUploadResult = ImageUploadResult;
export interface AuthApi
  extends OrganizationApi, WorkbenchApi, ProjectApi, ExpertTasksApi, EntranceExamApi {
  health(): Promise<{ status: string }>;
  sendCode(input: SmsSendInput): Promise<string>;
  login(input: LoginInput): Promise<void>;
  verifyCode(input: SmsLoginInput): Promise<VerifyResult>;
  completeRegistration(input: SmsRegisterInput): Promise<AuthUser>;
  getCurrentUser(): Promise<AuthUser>;
  switchRole(role: BusinessRole): Promise<{ selectedRole: BusinessRole; roles: BusinessRole[] }>;
  updateProfile(input: UserProfileUpdateInput): Promise<AuthUser>;
  uploadAvatar(file: File): Promise<AvatarUploadResult>;
  uploadOrganizationLogo(file: File): Promise<OrganizationLogoUploadResult>;
  uploadBusinessLicense(file: File): Promise<BusinessLicenseUploadResult>;
  /** 成功会撤销全部会话，调用方须返回登录页。 */
  changePassword(newPassword: string, confirmNewPassword: string): Promise<void>;
  getOrganization(orgId: string): Promise<OrganizationDetail>;
  logout(): Promise<void>;
}
export type BridgeResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: ApiFailure; retryAfter?: number };
/** 桌面仅向页面提供公开运行配置，不暴露认证、任意网络或系统接口。 */
export interface DesktopBridge {
  getRuntimeConfig(): Promise<BridgeResult<{ apiBaseUrl: string }>>;
}
