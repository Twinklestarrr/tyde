import multipart from '@fastify/multipart';
import type { PrismaClient } from '@prisma/client';
import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { Config } from '../../config/index.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { importSchema, templateSchema } from './import.schema.js';
import { IMPORT_MAX_BYTES, template, type ImportFile } from './member-import.parser.js';
import { MemberImportService } from './member-import.service.js';
export async function memberImportRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  config: Config,
  identity: (req: FastifyRequest) => AuthPrincipal,
) {
  const service = new MemberImportService(db);
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 2,
      parts: 3,
      fileSize: Math.min(config.files.maxSize, IMPORT_MAX_BYTES),
      fieldSize: IMPORT_MAX_BYTES,
      fieldNameSize: 32,
    },
  });
  app.get(
    `${API_PREFIX}/organizations/member-imports/template`,
    { schema: templateSchema },
    async (req, reply) => {
      const english = /^en\b/i.test(req.headers['accept-language'] ?? '');
      const name = english ? 'Member import template.xlsx' : '成员导入模板.xlsx';
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header(
          'Content-Disposition',
          `attachment; filename="member-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .header('X-Content-Type-Options', 'nosniff')
        .send(template(english));
    },
  );
  type Body = { orgId?: string; memberText?: string; csvFile?: string };
  const files = new WeakMap<FastifyRequest, ImportFile>();
  app.post<{ Body: Body; Querystring: Body; Headers: { 'idempotency-key': string } }>(
    `${API_PREFIX}/organizations/member-imports/generate`,
    {
      bodyLimit: config.files.maxRequestSize,
      schema: importSchema(),
      preValidation: async (req) => {
        if (!req.isMultipart())
          throw new AppError(400, 'VALIDATION_ERROR', '请使用multipart/form-data');
        const body: Body = {},
          seen = new Set<string>();
        let total = 0,
          sizeError: AppError | undefined;
        const count = (chunk: Buffer) => {
          total += chunk.length;
          if (total > config.files.maxRequestSize && !sizeError) {
            sizeError = new AppError(413, 'PAYLOAD_TOO_LARGE', '导入请求超过总大小限制');
            req.raw.emit('error', sizeError);
          }
        };
        req.raw.on('data', count);
        try {
          for await (const part of req.parts()) {
            if (seen.has(part.fieldname))
              throw new AppError(400, 'VALIDATION_ERROR', '表单字段重复');
            seen.add(part.fieldname);
            if (part.type === 'file') {
              if (part.fieldname !== 'csvFile')
                throw new AppError(400, 'VALIDATION_ERROR', '文件字段名必须为csvFile');
              const bytes = await part.toBuffer();
              files.set(req, { fileName: part.filename, contentType: part.mimetype, bytes });
              body.csvFile = part.filename;
            } else {
              if (
                !['orgId', 'memberText'].includes(part.fieldname) ||
                typeof part.value !== 'string' ||
                part.valueTruncated ||
                part.fieldnameTruncated
              )
                throw new AppError(400, 'VALIDATION_ERROR', '表单字段不正确或超过限制');
              body[part.fieldname as 'orgId' | 'memberText'] = part.value;
            }
          }
        } catch (error) {
          if (sizeError) throw sizeError;
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
            '导入格式不正确或超过大小/字段数量限制',
          );
        } finally {
          req.raw.off('data', count);
        }
        for (const key of ['orgId', 'memberText'] as const) {
          if (
            body[key] !== undefined &&
            req.query[key] !== undefined &&
            body[key] !== req.query[key]
          )
            throw new AppError(400, 'VALIDATION_ERROR', '查询和表单同名字段冲突');
          if (body[key] === undefined && req.query[key] !== undefined) body[key] = req.query[key];
        }
        if (!body.orgId) throw new AppError(400, 'VALIDATION_ERROR', 'orgId不能为空');
        req.body = body;
      },
    },
    async (req, reply) => {
      const result = await service.generate(
        req.headers['idempotency-key'],
        req.body.orgId!,
        identity(req),
        files.get(req),
        req.body.memberText,
      );
      files.delete(req);
      const invalid = result.rowErrors.length > 0;
      return reply.code(invalid ? 400 : 200).send({
        code: invalid ? 400 : 200,
        message: invalid ? '成员信息校验失败' : '操作成功',
        data: result,
      });
    },
  );
}
