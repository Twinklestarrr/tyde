import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ManagementService } from '../management/management.service.js';
import { resolveCurrentRequester } from './project-requester.js';

export interface CategoryQuery {
  categoryLevel?: number;
  keyword?: string;
}
export interface RequesterParams {
  requesterType: 'INDIVIDUAL' | 'ORGANIZATION';
  requesterId: string;
}
export class ProjectFoundationService {
  private readonly management: ManagementService;
  constructor(readonly db: PrismaClient) {
    this.management = new ManagementService(db);
  }

  async categories(query: CategoryQuery, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'NAVIGATOR');
    if (query.categoryLevel !== undefined && ![1, 2, 3].includes(query.categoryLevel))
      throw new AppError(400, 'VALIDATION_ERROR', '分类级别必须为1、2或3');
    const keyword = query.keyword?.trim();
    // LIKE的%/_沿用旧模糊匹配语义；PostgreSQL大小写规则与旧库兼容仍待验收。
    return this.db.projectCategory.findMany({
      where: {
        status: 'ENABLED',
        ...(query.categoryLevel !== undefined ? { categoryLevel: query.categoryLevel } : {}),
        ...(keyword
          ? {
              OR: [
                { categoryName: { contains: keyword } },
                { categoryCode: { contains: keyword } },
                { searchKeywords: { contains: keyword } },
              ],
            }
          : {}),
      },
      orderBy: [{ categoryLevel: 'asc' }, { sortNo: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        categoryCode: true,
        categoryName: true,
        categoryLevel: true,
        sortNo: true,
      },
    });
  }

  async requester(params: RequesterParams, principal: AuthPrincipal) {
    await this.management.requireRole(principal, 'NAVIGATOR');
    return (await resolveCurrentRequester(this.db, principal, params)).requester;
  }
}
