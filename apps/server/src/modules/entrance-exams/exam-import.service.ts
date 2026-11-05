import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { uploadPolicy, validateUpload } from '../files/file-validation.js';
import { FileService } from '../files/file.service.js';
import { requireExamManager } from './exam-access.js';
import type { ExamFileInput } from './exam-config.types.js';
import { EXAM_SOURCE_LIMIT, importBad } from './exam-import.domain.js';
import { parseExamExcel, parseExamText } from './exam-import.parser.js';
export interface ExamAttachmentRef {
  name: string;
  objectKey: string;
  uploadToken: string;
}
export interface ExamImportInput {
  projectId: string;
  file?: string;
  redocUrl?: string;
  attachmentRefs?: ExamAttachmentRef[];
}
export interface ExamImportFile {
  fileName: string;
  bytes: Buffer;
}
export class ExamImportService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileService,
  ) {}
  async parse(input: ExamImportInput, file: ExamImportFile | undefined, principal: AuthPrincipal) {
    const projectId = Number(input.projectId);
    if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
      throw importBad('项目ID必须为32位正整数');
    const hasUrl = Boolean(input.redocUrl?.trim());
    if (Boolean(file) === hasUrl) throw importBad('file与redocUrl必须且只能提供一个');
    await this.db.$transaction((tx) => requireExamManager(tx, projectId, principal), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    if (hasUrl)
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        '远程文档导入尚未配置可用来源，请使用XLS/XLSX/TXT文件',
      );
    if (!file?.bytes.length || file.bytes.length > EXAM_SOURCE_LIMIT)
      throw importBad('解析文件不能为空且不能超过10MiB');
    const name = file.fileName.toLowerCase();
    const sourceType = /\.xlsx?$/.test(name) ? 'EXCEL' : name.endsWith('.txt') ? 'TXT' : null;
    if (!sourceType) throw importBad('仅支持.xls、.xlsx、.txt文件；远程文档请使用redocUrl');
    const parsed = sourceType === 'TXT' ? parseExamText(file.bytes) : parseExamExcel(file.bytes);
    const supplied = input.attachmentRefs ?? [],
      references = new Map<string, ExamAttachmentRef>();
    for (const ref of supplied) {
      const key = ref.name.trim();
      if (!key || references.has(key)) throw importBad('预上传附件名称不能为空或重复');
      references.set(key, ref);
    }
    const previews = new Map<string, ExamFileInput>(),
      objectKeys = new Set<string>();
    let total = 0;
    // 全部文件/凭证预检通过后才上传图片；不创建考试，不消费或认领任何上传凭证。
    for (const binding of parsed.bindings) {
      if (binding.asset.bytes) {
        total += binding.asset.bytes.length;
        validateUpload(
          {
            fileName: binding.asset.name,
            declaredType: 'application/octet-stream',
            content: binding.asset.bytes,
          },
          uploadPolicy('ENTRANCE_EXAM_ATTACHMENT').category,
          Math.min(this.files.registry.config.maxSize, EXAM_SOURCE_LIMIT),
        );
      } else {
        const ref = references.get(binding.asset.name);
        if (!ref) throw importBad(`${binding.location}缺少预上传附件：${binding.asset.name}`);
        const record = await this.files.registry.inspectEntranceExamUpload(
          ref.objectKey,
          ref.uploadToken,
          principal.uid,
        );
        if (objectKeys.has(record.objectKey))
          throw importBad('同一个预上传附件不能重复引用，请分别上传');
        objectKeys.add(record.objectKey);
        total += record.fileSize;
        previews.set(binding.asset.name, {
          objectKey: record.objectKey,
          uploadToken: ref.uploadToken,
          fileName: record.fileName,
          extension: record.extension,
          contentType: record.contentType,
          size: record.fileSize,
          fileHash: record.fileHash,
          sensitive: true,
          url: `/api/v1/files/view?objectKey=${encodeURIComponent(record.objectKey)}`,
        });
      }
      if (total > 50 * 1024 * 1024) throw importBad('附件总大小超过50MiB限制');
    }
    for (const binding of parsed.bindings) {
      const preview = binding.asset.bytes
        ? await this.files.upload(
            {
              fileName: binding.asset.name,
              declaredType: 'application/octet-stream',
              content: binding.asset.bytes,
            },
            'ENTRANCE_EXAM_ATTACHMENT',
            undefined,
            principal.uid,
          )
        : previews.get(binding.asset.name)!;
      binding.target.push({
        ...preview,
        url: preview.url ?? `/api/v1/files/view?objectKey=${encodeURIComponent(preview.objectKey)}`,
      });
    }
    parsed.config.projectId = projectId;
    return { formatVersion: '1', sourceType, config: parsed.config };
  }
}
