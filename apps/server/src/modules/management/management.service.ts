import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

export type ManagementRole = 'NAVIGATOR' | 'PM';
export interface GrantChange {
  uid: string;
  role: ManagementRole;
  action: 'GRANT' | 'REVOKE';
  actor: string;
  reason: string;
}

export class ManagementService {
  constructor(readonly db: PrismaClient) {}

  // 使用服务端会话角色；项目归属和任职资格由各业务继续检查。
  async requireRole(principal: AuthPrincipal, role: ManagementRole) {
    if (!(await this.hasRole(principal, role)))
      throw new AppError(403, 'FORBIDDEN', '请切换到对应业务角色');
  }

  async hasRole(principal: AuthPrincipal, role: ManagementRole) {
    return hasManagementRole(this.db, principal, role);
  }

  // 保留内部方法签名供旧运维脚本明确失败，避免产生已撤销三角色的假象。
  async change(_input: GrantChange): Promise<{ changed: boolean }> {
    void _input;
    throw new AppError(409, 'CONFLICT', '统一账号自带三角色，不再支持独立授予或撤销管理角色');
  }
}

export async function hasManagementRole(
  db: unknown,
  principal: AuthPrincipal,
  role: ManagementRole,
) {
  // 认证层已验证账号ACTIVE；权限视角来自服务端会话，不读取角色请求头或历史授权表。
  void db;
  return principal.role === role;
}
