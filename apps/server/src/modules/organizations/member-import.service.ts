import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { shanghaiDay } from './departure.service.js';
import {
  maskImportPhone,
  parseImport,
  resolveImport,
  rowError,
  type ImportFile,
  type RowError,
  type SourceType,
} from './member-import.parser.js';
import { businessDate } from './member.domain.js';
import { participatingStatuses } from './organization.domain.js';
import { lockOrganization } from './organization.repository.js';
const effectiveStatuses = ['PENDING', 'PENDING_ACTIVATION', ...participatingStatuses];
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export interface GeneratedMember {
  memberId: string;
  userId: string;
  uid: string;
  accountType: string;
  phoneMasked: string | null;
  realName: string;
  position: string;
  employmentType: string | null;
  joinedAt: string | null;
  joinStatus: string;
}
export interface ImportResponse {
  sourceType: SourceType;
  textIgnored: boolean;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  createdCount: number;
  rowErrors: RowError[];
  members: GeneratedMember[];
  createdAt: string | null;
}
export class MemberImportService {
  constructor(readonly db: PrismaClient) {}
  async generate(
    key: string,
    orgId: string,
    principal: AuthPrincipal,
    file?: ImportFile,
    memberText?: string,
  ): Promise<ImportResponse> {
    orgId = orgId.toLowerCase();
    if (!key.trim() || key.length > 128)
      throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key不能为空且不能超过128字符');
    await this.manager(this.db, orgId, principal.userId);
    const input = resolveImport(file, memberText);
    const scope = hash(`${orgId}:${principal.userId}:${key.trim()}`);
    const requestHash = createHash('sha256')
      .update(`${orgId}:${input.sourceType}:${input.textIgnored}:`)
      .update(input.content)
      .digest('hex');
    const parsed = parseImport(input);
    try {
      return await this.db.$transaction(
        async (tx) => {
          const acquired = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`member-import:${scope}`},0)) AS locked`;
          if (!acquired[0]?.locked)
            throw new AppError(409, 'DUPLICATE', '批量生成请求正在处理中，请稍后重试');
          // 与注册/登录共用手机号锁；按手机号排序，再锁组织，避免激活与跨组织导入死锁。
          const phones =
            parsed.rows.length > 500
              ? []
              : [
                  ...new Set(
                    parsed.rows
                      .filter((r) => /^1[3-9]\d{9}$/.test(r.phone))
                      .map((r) => `+86${r.phone}`),
                  ),
                ].sort();
          for (const phone of phones)
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phone},0))::text`;
          await lockOrganization(tx, orgId);
          await this.manager(tx, orgId, principal.userId);
          const receipt = await tx.memberImportReceipt.findUnique({ where: { key: scope } });
          const now = new Date();
          if (receipt && receipt.expiresAt > now) {
            if (receipt.requestHash !== requestHash)
              throw new AppError(409, 'DUPLICATE', 'Idempotency-Key已用于其他请求');
            return receipt.response as unknown as ImportResponse;
          }
          const errors = [...parsed.errors];
          const response: ImportResponse = {
            sourceType: input.sourceType,
            textIgnored: input.textIgnored,
            totalCount: parsed.rows.length,
            validCount: parsed.rows.length,
            invalidCount: 0,
            createdCount: 0,
            rowErrors: [],
            members: [],
            createdAt: null,
          };
          const existing = await tx.user.findMany({ where: { phoneE164: { in: phones } } });
          const relations = await tx.userOrgRel.findMany({
            where: { userId: { in: existing.map((u) => u.id) } },
          });
          for (const row of parsed.rows) {
            const user = existing.find((u) => u.phoneE164 === `+86${row.phone}`);
            if (!user) continue;
            const rels = relations.filter((rel) => rel.userId === user.id);
            if (
              rels.some((rel) => rel.orgId === orgId && effectiveStatuses.includes(rel.joinStatus))
            )
              errors.push(
                rowError(
                  row.rowNo,
                  'phone',
                  maskImportPhone(row.phone),
                  'ACCOUNT_REGISTERED',
                  '该用户已在当前组织中',
                ),
              );
          }
          if (!errors.length) {
            const added = parsed.rows.filter((r) => r.position === 'ADMIN').length;
            if (added) {
              const count = await tx.userOrgRel.count({
                where: { orgId, position: 'ADMIN', joinStatus: { in: effectiveStatuses } },
              });
              if (count + added > 5)
                errors.push(
                  rowError(
                    0,
                    'position',
                    String(added),
                    'LIMIT_EXCEEDED',
                    `每个组织最多5名管理员，当前已有${count}名，本次申请新增${added}名`,
                  ),
                );
            }
          }
          if (errors.length) {
            response.invalidCount = errors.some((e) => e.rowNo === 0)
              ? parsed.rows.length
              : new Set(errors.map((e) => e.rowNo)).size;
            response.validCount = Math.max(0, response.totalCount - response.invalidCount);
            response.rowErrors = errors;
          } else {
            for (const row of parsed.rows) {
              let user = existing.find((u) => u.phoneE164 === `+86${row.phone}`);
              const fresh = !user;
              if (!user) {
                const uid = randomUUID().replaceAll('-', '');
                user = await tx.user.create({
                  data: {
                    uid,
                    username: `u${uid.slice(1)}`,
                    phoneE164: `+86${row.phone}`,
                    phoneRegion: 'CN',
                    displayName: `${Array.from(row.realName).slice(0, 55).join('')}_${uid.slice(0, 8)}`,
                    realName: row.realName,
                    accountType: 'INDIVIDUAL',
                    passwordHash: null,
                    role: 'EXPERT',
                    status: 'ACTIVE',
                    updatedBy: principal.uid,
                  },
                });
              }
              const previous = relations.find(
                (rel) => rel.userId === user.id && rel.orgId === orgId,
              );
              const data = {
                position: row.position!,
                employmentType: row.employmentType,
                joinStatus: fresh ? 'PENDING_ACTIVATION' : 'ACTIVE',
                joinedAt: businessDate(row.joinedDate ?? shanghaiDay(now), true),
                plannedLeaveDate: null,
                leftAt: null,
                updatedBy: principal.uid,
                updatedAt: now,
              };
              const rel = previous
                ? await tx.userOrgRel.update({
                    where: { id: previous.id },
                    data: { ...data, versionNo: { increment: 1 } },
                  })
                : await tx.userOrgRel.create({
                    data: {
                      ...data,
                      userId: user.id,
                      uid: user.uid,
                      orgId,
                      versionNo: 0,
                      createdBy: principal.uid,
                    },
                  });
              const nickname = user.displayName.trim(),
                realName = user.realName?.trim();
              response.members.push({
                memberId: rel.id,
                userId: user.id,
                uid: user.uid,
                accountType: 'INDIVIDUAL',
                phoneMasked: maskImportPhone(row.phone),
                realName:
                  nickname && realName
                    ? `${nickname}(${realName})`
                    : nickname || realName || user.uid,
                position: rel.position,
                employmentType: rel.employmentType,
                joinedAt: rel.joinedAt?.toISOString() ?? null,
                joinStatus: rel.joinStatus,
              });
            }
            response.createdCount = parsed.rows.length;
            response.createdAt = now.toISOString();
          }
          await tx.memberImportReceipt.upsert({
            where: { key: scope },
            create: {
              key: scope,
              requestHash,
              response: response as unknown as Prisma.InputJsonValue,
              expiresAt: new Date(now.getTime() + 86_400_000),
            },
            update: {
              requestHash,
              response: response as unknown as Prisma.InputJsonValue,
              expiresAt: new Date(now.getTime() + 86_400_000),
              createdAt: now,
            },
          });
          return response;
        },
        { maxWait: 15_000, timeout: 60_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AppError(409, 'DUPLICATE', '成员手机号或组织关系已被占用，请刷新后重试');
      throw error;
    }
  }
  private async manager(
    db: Prisma.TransactionClient | PrismaClient,
    orgId: string,
    userId: string,
  ) {
    const rel = await db.userOrgRel.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (
      !rel ||
      !participatingStatuses.includes(rel.joinStatus) ||
      !['OWNER', 'ADMIN'].includes(rel.position)
    )
      throw new AppError(403, 'FORBIDDEN', '仅组织主管或管理员可批量生成成员');
    if (!(await db.organization.findFirst({ where: { id: orgId, deleted: false } })))
      throw new AppError(404, 'NOT_FOUND', '组织不存在');
  }
}
