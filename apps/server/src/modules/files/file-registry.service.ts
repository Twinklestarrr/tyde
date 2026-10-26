import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, UploadedFile } from '@prisma/client';
import { AuthError } from '../auth/auth.error.js';
import type { FileConfig } from './file.config.js';
import type { FileBizType, FileCategory } from './file.types.js';
import { businesses } from './file.types.js';
import { validObjectKey, type ObjectStorage } from './object-storage.js';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
type Tx = Prisma.TransactionClient;
type Metadata = {
  objectKey: string;
  fileName: string;
  extension: string;
  contentType: string;
  fileSize: number;
  fileHash: string;
};

export class FileRegistryService {
  constructor(
    readonly db: PrismaClient,
    readonly storage: ObjectStorage,
    readonly config: FileConfig,
  ) {}

  async register(
    metadata: Metadata,
    bizType: FileBizType,
    category: FileCategory,
    ownerUid: string | null,
  ) {
    const uploadToken = randomBytes(32).toString('base64url');
    const record = await this.db.uploadedFile.create({
      data: {
        ...metadata,
        objectKey: validObjectKey(metadata.objectKey),
        claimTokenHash: tokenHash(uploadToken),
        bizType,
        category,
        sensitiveFlag: businesses[bizType].sensitive,
        ownerUid,
        expiresAt: new Date(Date.now() + this.config.unclaimedExpireSeconds * 1000),
      },
    });
    return { record, uploadToken };
  }

  private async locked(tx: Tx, objectKey: string) {
    const key = validObjectKey(objectKey);
    const records = await tx.$queryRaw<
      UploadedFile[]
    >`SELECT * FROM "UploadedFile" WHERE "objectKey" = ${key} FOR UPDATE`;
    return records[0];
  }

  private validateClaim(
    record: UploadedFile | undefined,
    bizType: FileBizType,
    rawToken: string,
    ownerUid?: string,
  ) {
    if (!record || record.bizType !== bizType)
      throw new AuthError(400, 'BAD_REQUEST', '上传记录不存在或业务类型不匹配');
    if (
      record.status !== 'UPLOADED' ||
      !record.expiresAt ||
      record.expiresAt.getTime() <= Date.now()
    )
      throw new AuthError(409, 'DUPLICATE', '文件已被认领或上传凭证已过期');
    if (ownerUid !== undefined && (!record.ownerUid || record.ownerUid !== ownerUid))
      throw new AuthError(403, 'FORBIDDEN', '不能认领其他用户上传的文件');
    if (!rawToken?.trim()) throw new AuthError(400, 'BAD_REQUEST', '附件上传凭证不能为空');
    const expected = Buffer.from(record.claimTokenHash, 'hex');
    const supplied = Buffer.from(tokenHash(rawToken), 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      throw new AuthError(403, 'FORBIDDEN', '附件上传凭证无效');
    return record;
  }

  private async verifyObject(record: UploadedFile) {
    const metadata = await this.storage.head(record.objectKey);
    if (!metadata || metadata.size !== record.fileSize)
      throw new AuthError(400, 'BAD_REQUEST', '上传文件不存在或大小校验失败，请重新上传');
  }

  /** 调用方必须传入业务事务；注册组织、消费验证码、写用户与文件认领一同提交/回滚。 */
  async claim(
    tx: Tx,
    objectKey: string,
    token: string,
    bizType: FileBizType,
    claimedBizType: string,
    claimedBizId: string,
    ownerUid?: string,
  ) {
    const record = this.validateClaim(await this.locked(tx, objectKey), bizType, token, ownerUid);
    await this.verifyObject(record);
    return tx.uploadedFile.update({
      where: { id: record.id },
      data: {
        status: 'CLAIMED',
        claimedBizType,
        claimedBizId,
        claimedAt: new Date(),
        expiresAt: null,
      },
    });
  }

  claimForOrganizationRegistration(tx: Tx, key: string, token: string, organizationId: string) {
    // 与旧注册规则一致：匿名/已登录预上传均以高熵一次性 token 证明持有，不要求 ownerUid。
    return this.claim(
      tx,
      key,
      token,
      'BUSINESS_LICENSE',
      'ORGANIZATION_BUSINESS_LICENSE',
      organizationId,
    );
  }
  claimForProject(tx: Tx, key: string, token: string, ownerUid: string, projectId: string) {
    return this.claim(
      tx,
      key,
      token,
      'PROJECT_ATTACHMENT',
      'PROJECT_ATTACHMENT',
      projectId,
      ownerUid,
    );
  }
  /** 调用方已锁组织并校验主管；图片认领、资料保存及旧图片释放共享同一事务。 */
  async syncOrganizationLogo(
    tx: Tx,
    organizationId: string,
    ownerUid: string,
    value: string,
    token?: string | null,
  ) {
    let key: string | null = value.startsWith('org-logo/') ? validObjectKey(value) : null;
    if (!key && /^https?:\/\//i.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new AuthError(400, 'BAD_REQUEST', 'Logo图片地址格式不正确');
      }
      const candidate = url.pathname.replace(/^\/(?:tyde\/)?/, '');
      if (candidate.startsWith('org-logo/')) {
        const normalized = validObjectKey(candidate);
        const expected = new URL(this.storage.accessUrl(normalized, 2147483647));
        if (url.origin === expected.origin && url.pathname === expected.pathname) key = normalized;
      }
    }
    if (key) {
      const record = await this.locked(tx, key);
      // 组织已认领的图片可重复保存，主管交接不改变图片归属。
      if (
        record?.status !== 'CLAIMED' ||
        record.bizType !== 'ORG_LOGO' ||
        record.claimedBizType !== 'ORGANIZATION_LOGO' ||
        record.claimedBizId !== organizationId
      ) {
        const upload = this.validateClaim(record, 'ORG_LOGO', token ?? '', ownerUid);
        await this.verifyObject(upload);
        await tx.uploadedFile.update({
          where: { id: upload.id },
          data: {
            status: 'CLAIMED',
            claimedBizType: 'ORGANIZATION_LOGO',
            claimedBizId: organizationId,
            claimedAt: new Date(),
            expiresAt: null,
          },
        });
      }
    } else if (token != null) {
      throw new AuthError(400, 'BAD_REQUEST', 'Logo上传凭证必须与ORG_LOGO图片objectKey一起提交');
    }
    await tx.uploadedFile.updateMany({
      where: {
        status: 'CLAIMED',
        claimedBizType: 'ORGANIZATION_LOGO',
        claimedBizId: organizationId,
        ...(key ? { objectKey: { not: key } } : {}),
      },
      data: {
        status: 'RELEASED',
        expiresAt: new Date(Date.now() + this.config.releasedExpireSeconds * 1000),
      },
    });
    return key ? this.storage.accessUrl(key, 2147483647) : value;
  }
  /** 调用方持有本人认证锁；认领、资料写入与旧头像释放必须在同一事务。 */
  async syncAvatar(tx: Tx, userId: string, ownerUid: string, value: string, token?: string | null) {
    let key: string | null = value.startsWith('avatar/') ? validObjectKey(value) : null;
    // 兼容上传响应URL。只识别服务端实际签发的同源对象地址，不接受任意主机伪装。
    if (!key && /^https?:\/\//i.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new AuthError(400, 'BAD_REQUEST', '头像URL格式不正确');
      }
      const candidate = url.pathname.replace(/^\/(?:tyde\/)?/, '');
      if (candidate.startsWith('avatar/')) {
        const normalized = validObjectKey(candidate);
        const expected = new URL(this.storage.accessUrl(normalized, 2147483647));
        if (url.origin === expected.origin && url.pathname === expected.pathname) key = normalized;
      }
    }
    let avatarUrl: string | null = value || null;
    if (key) {
      const record = await this.locked(tx, key);
      if (
        record?.status === 'CLAIMED' &&
        record.bizType === 'AVATAR' &&
        record.claimedBizType === 'USER_AVATAR' &&
        record.claimedBizId === userId &&
        record.ownerUid === ownerUid
      ) {
        // 已认领的本人头像重放无需再次消费token。
      } else {
        const upload = this.validateClaim(record, 'AVATAR', token ?? '', ownerUid);
        await this.verifyObject(upload);
        await tx.uploadedFile.update({
          where: { id: upload.id },
          data: {
            status: 'CLAIMED',
            claimedBizType: 'USER_AVATAR',
            claimedBizId: userId,
            claimedAt: new Date(),
            expiresAt: null,
          },
        });
      }
      avatarUrl = this.storage.accessUrl(key, 2147483647);
    } else if (token != null) {
      throw new AuthError(400, 'BAD_REQUEST', '头像上传凭证必须与AVATAR文件objectKey一起提交');
    }
    await tx.uploadedFile.updateMany({
      where: {
        status: 'CLAIMED',
        claimedBizType: 'USER_AVATAR',
        claimedBizId: userId,
        ...(key ? { objectKey: { not: key } } : {}),
      },
      data: {
        status: 'RELEASED',
        expiresAt: new Date(Date.now() + this.config.releasedExpireSeconds * 1000),
      },
    });
    return avatarUrl;
  }
  claimForEntranceExam(tx: Tx, key: string, token: string, ownerUid: string, examId: string) {
    return this.claim(
      tx,
      key,
      token,
      'ENTRANCE_EXAM_ATTACHMENT',
      'ENTRANCE_EXAM_ATTACHMENT',
      examId,
      ownerUid,
    );
  }
  async inspectEntranceExamUpload(key: string, token: string, ownerUid: string) {
    return this.validateClaim(
      (await this.db.uploadedFile.findUnique({ where: { objectKey: validObjectKey(key) } })) ??
        undefined,
      'ENTRANCE_EXAM_ATTACHMENT',
      token,
      ownerUid,
    );
  }
  async reuseEntranceExamFile(tx: Tx, id: string, key: string, examId: string) {
    const record = await tx.uploadedFile.findUnique({ where: { id } });
    if (
      !record ||
      record.objectKey !== validObjectKey(key) ||
      record.status !== 'CLAIMED' ||
      record.bizType !== 'ENTRANCE_EXAM_ATTACHMENT' ||
      record.claimedBizType !== 'ENTRANCE_EXAM_ATTACHMENT' ||
      record.claimedBizId !== examId
    )
      throw new AuthError(400, 'BAD_REQUEST', '准入考试旧附件不存在或不属于当前考试');
    return record;
  }
  async releaseProjectAttachment(tx: Tx, key: string, projectId: string) {
    return tx.uploadedFile.updateMany({
      where: {
        objectKey: validObjectKey(key),
        status: 'CLAIMED',
        claimedBizType: 'PROJECT_ATTACHMENT',
        claimedBizId: projectId,
      },
      data: {
        status: 'RELEASED',
        expiresAt: new Date(Date.now() + this.config.releasedExpireSeconds * 1000),
      },
    });
  }
  async deleteOwnedUnclaimed(key: string, ownerUid: string) {
    return this.db.$transaction(async (tx) => {
      const record = await this.locked(tx, key);
      if (
        !record ||
        record.status !== 'UPLOADED' ||
        !record.ownerUid ||
        record.ownerUid !== ownerUid
      )
        throw new AuthError(403, 'FORBIDDEN', '文件已被业务使用或无权删除');
      await this.storage.delete(record.objectKey);
      await tx.uploadedFile.update({
        where: { id: record.id },
        data: { status: 'DELETED', deletedAt: new Date(), expiresAt: null },
      });
      return true;
    });
  }
  async cleanupExpired() {
    const candidates = await this.db.uploadedFile.findMany({
      where: {
        status: { in: ['UPLOADED', 'RELEASED'] },
        expiresAt: { lte: new Date() },
      },
      orderBy: { expiresAt: 'asc' },
      take: this.config.cleanupBatchSize,
    });
    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        deleted += await this.db.$transaction(async (tx) => {
          const record = await this.locked(tx, candidate.objectKey);
          if (
            !record ||
            !['UPLOADED', 'RELEASED'].includes(record.status) ||
            !record.expiresAt ||
            record.expiresAt.getTime() > Date.now()
          )
            return 0;
          await this.storage.delete(record.objectKey);
          await tx.uploadedFile.delete({ where: { id: record.id } });
          return 1;
        });
      } catch {
        failed++;
      }
    }
    return { deleted, failed };
  }
}
