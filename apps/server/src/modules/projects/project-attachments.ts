import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import type { ProjectAttachmentInput } from './project-creation.types.js';

const bad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
// 调用方先锁创建人，再写/锁项目；本方法始终复用同一业务事务。
export async function syncProjectAttachments(
  tx: Prisma.TransactionClient,
  files: FileRegistryService,
  projectId: number,
  requests: ProjectAttachmentInput[] | null | undefined,
  uid: string,
  uploaderName: string,
) {
  if (requests == null) return;
  const existing = await tx.projectAttachment.findMany({ where: { projectId, status: 'ACTIVE' } });
  const byId = new Map(existing.map((a) => [a.id, a]));
  const byKey = new Map(existing.map((a) => [a.objectKey, a]));
  const retained = new Set<number>();
  const newKeys = new Set<string>();
  for (const request of requests) {
    if (!request) throw bad('附件信息不能为空');
    const key = request.objectKey?.trim();
    const old = request.id != null ? byId.get(request.id) : key ? byKey.get(key) : undefined;
    if (request.id != null && !old) throw bad('附件不属于当前项目或已删除');
    if (old) {
      if (retained.has(old.id)) throw bad('附件列表存在重复文件');
      retained.add(old.id);
      if (request.sortNo != null)
        await tx.projectAttachment.update({
          where: { id: old.id },
          data: { sortNo: request.sortNo, updatedBy: uid },
        });
      continue;
    }
    if (!request.attachmentType || !key || !request.uploadToken?.trim())
      throw bad('附件必填信息未填写');
    if (newKeys.has(key)) throw bad('附件列表存在重复文件');
    newKeys.add(key);
    const file = await files.claimForProject(tx, key, request.uploadToken, uid, String(projectId));
    await tx.projectAttachment.create({
      data: {
        projectId,
        attachmentType: request.attachmentType,
        objectKey: file.objectKey,
        fileName: file.fileName,
        extension: file.extension,
        contentType: file.contentType,
        fileSize: file.fileSize,
        fileHash: file.fileHash,
        sortNo: request.sortNo ?? 0,
        status: 'ACTIVE',
        uploaderName,
        createdBy: uid,
        updatedBy: uid,
      },
    });
  }
  for (const old of existing) {
    if (retained.has(old.id)) continue;
    await tx.projectAttachment.update({
      where: { id: old.id },
      data: { status: 'DELETED', updatedBy: uid },
    });
    await files.releaseProjectAttachment(tx, old.objectKey, String(projectId));
  }
}
