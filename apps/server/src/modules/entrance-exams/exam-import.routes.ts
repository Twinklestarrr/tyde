import multipart from '@fastify/multipart';
import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { EXAM_SOURCE_LIMIT } from './exam-import.domain.js';
import { examImportSchema } from './exam-import.schema.js';
import type { ExamImportFile, ExamImportInput, ExamImportService } from './exam-import.service.js';
const REQUEST_LIMIT = EXAM_SOURCE_LIMIT + 256 * 1024;
export async function examImportRoutes(
  app: FastifyInstance,
  service: ExamImportService,
  identity: (req: FastifyRequest) => AuthPrincipal,
) {
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 3,
      parts: 4,
      fileSize: EXAM_SOURCE_LIMIT,
      fieldSize: 128 * 1024,
      fieldNameSize: 32,
    },
  });
  const files = new WeakMap<FastifyRequest, ExamImportFile>();
  app.post<{ Body: ExamImportInput; Querystring: { projectId?: string; redocUrl?: string } }>(
    `${API_PREFIX}/entrance-exams/import/parse`,
    {
      bodyLimit: REQUEST_LIMIT,
      schema: examImportSchema,
      preValidation: async (req) => {
        if (!req.isMultipart())
          throw new AppError(400, 'VALIDATION_ERROR', '请使用multipart/form-data');
        const body: Partial<ExamImportInput> = {},
          seen = new Set<string>();
        let total = 0,
          tooLarge: AppError | undefined;
        const count = (chunk: Buffer) => {
          total += chunk.length;
          if (total > REQUEST_LIMIT && !tooLarge) {
            tooLarge = new AppError(413, 'PAYLOAD_TOO_LARGE', '导入请求超过总大小限制');
            req.raw.emit('error', tooLarge);
          }
        };
        req.raw.on('data', count);
        try {
          for await (const part of req.parts()) {
            if (seen.has(part.fieldname))
              throw new AppError(400, 'VALIDATION_ERROR', '表单字段重复');
            seen.add(part.fieldname);
            if (part.type === 'file') {
              if (part.fieldname !== 'file')
                throw new AppError(400, 'VALIDATION_ERROR', '文件字段名必须为file');
              files.set(req, { fileName: part.filename, bytes: await part.toBuffer() });
              body.file = part.filename;
            } else {
              if (
                !['projectId', 'redocUrl', 'attachmentRefs'].includes(part.fieldname) ||
                part.valueTruncated ||
                part.fieldnameTruncated
              )
                throw new AppError(400, 'VALIDATION_ERROR', '表单字段不正确或超过大小限制');
              if (part.fieldname === 'attachmentRefs') {
                body.attachmentRefs =
                  typeof part.value === 'string' ? JSON.parse(part.value) : part.value;
              } else {
                if (typeof part.value !== 'string')
                  throw new AppError(400, 'VALIDATION_ERROR', '项目或来源字段必须为字符串');
                body[part.fieldname as 'projectId' | 'redocUrl'] = part.value;
              }
            }
          }
        } catch (error) {
          if (tooLarge) throw tooLarge;
          if (error instanceof AppError) throw error;
          const code = (error as { code?: string }).code;
          throw new AppError(
            code &&
              [
                'FST_REQ_FILE_TOO_LARGE',
                'FST_FILES_LIMIT',
                'FST_FIELDS_LIMIT',
                'FST_PARTS_LIMIT',
              ].includes(code)
              ? 413
              : 400,
            'VALIDATION_ERROR',
            '导入格式或字段不合法，或超过大小/数量限制',
          );
        } finally {
          req.raw.off('data', count);
        }
        for (const key of ['projectId', 'redocUrl'] as const) {
          if (
            body[key] !== undefined &&
            req.query[key] !== undefined &&
            body[key] !== req.query[key]
          )
            throw new AppError(400, 'VALIDATION_ERROR', '查询和表单同名字段冲突');
          if (body[key] === undefined && req.query[key] !== undefined) body[key] = req.query[key];
        }
        req.body = body as ExamImportInput;
      },
    },
    async (req) => {
      const result = await service.parse(req.body, files.get(req), identity(req));
      files.delete(req);
      return { code: 200, message: '操作成功', data: result };
    },
  );
}
