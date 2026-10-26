import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '@tyde/shared';
import type { Config } from '../../config/index.js';
import { AuthError } from '../auth/auth.error.js';
import type { AuthService, AuthPrincipal } from '../auth/auth.service.js';
import { validateTransport } from '../auth/security.js';
import { FileService } from './file.service.js';
import type { UploadInput } from './file-validation.js';
import { fileSchema, keyQuery, uploadBody, uploadResponse } from './file.schema.js';

export async function fileRoutes(
  parent: FastifyInstance,
  service: FileService,
  auth: AuthService,
  config: Config,
) {
  await parent.register(
    async (app) => {
      await app.register(multipart, {
        limits: {
          fileSize: config.files.maxSize,
          files: config.files.maxBatchCount,
          fields: 2,
          fieldSize: 128,
          fieldNameSize: 32,
          parts: config.files.maxBatchCount + 2,
        },
      });
      const identities = new WeakMap<FastifyRequest, AuthPrincipal | null>();
      const contents = new WeakMap<FastifyRequest, UploadInput[]>();
      app.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (
          !req.headers['x-tyde-client'] &&
          !req.headers.origin &&
          !req.headers.cookie &&
          !Object.keys(req.headers).some((k) => k.startsWith('sec-fetch-'))
        )
          req.headers['x-tyde-client'] = 'desktop';
        let client;
        try {
          client = validateTransport(req.headers, req.method, [
            ...config.webOrigins,
            ...config.desktopOrigins,
          ]);
        } catch {
          throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', '请求来源或会话凭据组合不可信');
        }
        const token =
          client === 'desktop'
            ? req.headers.authorization?.replace(/^Bearer /, '')
            : req.cookies[config.cookieSecure ? '__Host-tyde_session' : 'tyde_session'];
        identities.set(req, token ? await auth.authenticate(token, client) : null);
        const path = req.url.split('?')[0];
        if (path !== `${API_PREFIX}/files/view` && req.method !== 'POST' && !identities.get(req))
          throw new AuthError(401, 'UNAUTHENTICATED', '请先登录');
      });
      for (const batch of [false, true]) {
        const path = `${API_PREFIX}/files/upload${batch ? '/batch' : ''}`;
        app.post<{ Body: { bizType?: string; category?: string } }>(
          path,
          {
            bodyLimit: config.files.maxRequestSize,
            schema: {
              ...fileSchema(
                batch ? 'uploadBatch' : 'upload',
                batch ? '批量上传文件' : '上传单个文件',
                'multipart 上传；普通文件可匿名或登录上传，头像/项目附件/考试附件须登录。全局单文件默认50MiB、总请求100MiB、批量10个，可配置；类型与内容须通过校验。敏感文件不返回 URL。批量逐个上传，后续文件失败时此前成功文件保留至过期清理。',
                batch
                  ? {
                      type: 'array',
                      description: '按上传顺序返回文件结果，非空。',
                      items: uploadResponse,
                      examples: [[uploadResponse.examples[0]]],
                    }
                  : uploadResponse,
                false,
              ),
              consumes: ['multipart/form-data'],
              body: uploadBody(batch),
            },
            preValidation: async (req) => {
              if (!req.isMultipart())
                throw new AuthError(400, 'BAD_REQUEST', '请使用 multipart/form-data');
              const files: UploadInput[] = [],
                body: Record<string, string | string[]> = {};
              const seen = new Set<string>();
              if (Number(req.headers['content-length']) > config.files.maxRequestSize)
                throw new AuthError(413, 'PAYLOAD_TOO_LARGE', '上传请求超过大小限制');
              let received = 0;
              let sizeError: AuthError | undefined;
              const count = (chunk: Buffer) => {
                received += chunk.length;
                if (received > config.files.maxRequestSize && !sizeError) {
                  sizeError = new AuthError(413, 'PAYLOAD_TOO_LARGE', '上传请求超过大小限制');
                  // multipart 直接消费 req.raw；通过它的 error 监听终止解析，不创建旁路流。
                  req.raw.emit('error', sizeError);
                }
              };
              req.raw.on('data', count);
              try {
                for await (const part of req.parts()) {
                  if (part.type === 'file') {
                    if (
                      typeof part.filename !== 'string' ||
                      part.fieldname !== (batch ? 'files' : 'file') ||
                      (!batch && files.length)
                    )
                      throw new AuthError(400, 'BAD_REQUEST', '文件字段名或数量不正确');
                    const content = await part.toBuffer();
                    files.push({ fileName: part.filename, declaredType: part.mimetype, content });
                  } else {
                    if (
                      !['bizType', 'category'].includes(part.fieldname) ||
                      seen.has(part.fieldname) ||
                      typeof part.value !== 'string' ||
                      part.valueTruncated ||
                      part.fieldnameTruncated
                    )
                      throw new AuthError(400, 'BAD_REQUEST', '表单字段不正确或重复');
                    seen.add(part.fieldname);
                    const normalized = part.value.trim().toUpperCase();
                    if (normalized) body[part.fieldname] = normalized;
                  }
                }
              } catch (error) {
                if (sizeError) throw sizeError;
                if (error instanceof AuthError) throw error;
                const code = (error as { code?: string }).code;
                throw new AuthError(
                  code &&
                    [
                      'FST_REQ_FILE_TOO_LARGE',
                      'FST_FILES_LIMIT',
                      'FST_FIELDS_LIMIT',
                      'FST_PARTS_LIMIT',
                    ].includes(code)
                    ? 413
                    : 400,
                  'BAD_REQUEST',
                  '上传格式不正确或超过限制',
                );
              } finally {
                req.raw.off('data', count);
              }
              if (sizeError) throw sizeError;
              if (!files.length) throw new AuthError(400, 'BAD_REQUEST', '上传文件不能为空');
              contents.set(req, files);
              // 文件内容已由流解析保存，schema 校验逻辑表单，Swagger 保留 binary 字段。
              body[batch ? 'files' : 'file'] = batch
                ? files.map((f) => f.fileName)
                : files[0]!.fileName;
              req.body = body;
            },
          },
          async (req) => {
            const result = [];
            for (const file of contents.get(req)!)
              result.push(
                await service.upload(
                  file,
                  req.body.bizType,
                  req.body.category,
                  identities.get(req)?.uid ?? null,
                ),
              );
            contents.delete(req);
            return { code: 200, message: '操作成功', data: batch ? result : result[0] };
          },
        );
      }
      app.get<{ Querystring: { objectKey: string } }>(
        `${API_PREFIX}/files/view`,
        {
          schema: {
            ...fileSchema(
              'view',
              '查看/下载文件（鉴权代理）',
              '需登录；文件内容从存储代理返回，绝不暴露 OSS URL。敏感文件只允许上传者或已认领营业执照所属组织的 OWNER/ADMIN。匿名预上传凭证不能用于读取。已认领项目附件允许具有当前NAVIGATOR角色的项目创建人，且项目未删除/附件ACTIVE；上传者身份不能代替项目授权。当前ASSIGNED主策略官/协作负责人须当前PM角色才能读取；更换/撤销后失效。专家项目附件须真实已接单：需笔试时限有效组织主管/项目负责人或已通过准入者；免试时限分配个人或有效组织成员。不凭ACTIVE项目成员身份放行。新来源表需第15迁移。已认领考试附件须绑定未删除考试/项目，允许当前PM角色的当前主策略官/协作负责人，或当前NAVIGATOR角色的项目需求方/创建人；上传者身份不继续授权。考生及已接单组织职责按绑定试卷和答案来源读取。成员表现附件上传使用MEMBER_PERFORMANCE_ATTACHMENT；已认领后仅当前人员管理读权限可读，按表现记录的具体项目成员/组织范围校验，原上传者失权后也不能读取。',
              {},
            ),
            querystring: keyQuery,
            response: {
              ...(fileSchema('', '', '', {}).response as Record<string, unknown>),
              200: {
                description:
                  '原始文件字节流；图片/PDF 可内联，其余下载；no-store, private 禁止缓存，nosniff 禁止嗅探。',
                content: Object.fromEntries(
                  [
                    'application/octet-stream',
                    'image/jpeg',
                    'image/png',
                    'image/gif',
                    'image/bmp',
                    'image/webp',
                    'application/pdf',
                  ].map((type) => [
                    type,
                    {
                      schema: {
                        type: 'string',
                        format: 'binary',
                        description: '文件原始二进制字节；非 JSON 包装。',
                        ...(type === 'application/octet-stream'
                          ? { examples: ['示例文档内容'] }
                          : {}),
                      },
                    },
                  ]),
                ),
              },
            },
          },
        },
        async (req, reply) => {
          const object = await service.open(req.query.objectKey, identities.get(req) ?? null);
          const safe = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/bmp',
            'image/webp',
            'application/pdf',
          ].includes(object.contentType);
          return reply
            .type(safe ? object.contentType : 'application/octet-stream')
            .header('Content-Length', object.size)
            .header('Content-Disposition', safe ? 'inline' : 'attachment')
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'no-store, private')
            .send(object.stream);
        },
      );
      app.get<{ Querystring: { objectKey: string; expireSeconds?: string } }>(
        `${API_PREFIX}/files/access-url`,
        {
          schema: {
            ...fileSchema(
              'accessUrl',
              '获取文件访问链接（仅非敏感文件）',
              '需登录；敏感目录或台账一律403。仅接受新项目存活台账对象，不支持未迁移的旧对象。未传或非正数有效期时，图片用最大值2147483647秒，其他用配置默认604800秒。',
              {
                type: 'string',
                description: '带签名的 HTTPS 文件访问 URL，仅非敏感文件。',
                examples: [
                  'https://storage.example/avatar/example.png?Expires=1800000000&Signature=example',
                ],
              },
            ),
            querystring: {
              ...keyQuery,
              properties: {
                ...keyQuery.properties,
                expireSeconds: {
                  type: 'string',
                  pattern: '^-?[0-9]+$',
                  maxLength: 11,
                  description:
                    '选填的32位有符号整数文本，单位秒；省略或小于等于0时用默认值，最大2147483647。',
                  examples: ['3600'],
                },
              },
            },
          },
        },
        async (req) => {
          const expire =
            req.query.expireSeconds === undefined ? undefined : Number(req.query.expireSeconds);
          if (
            expire !== undefined &&
            (!Number.isInteger(expire) || expire < -2147483648 || expire > 2147483647)
          )
            throw new AuthError(400, 'BAD_REQUEST', '有效期超出整数范围');
          return {
            code: 200,
            message: '操作成功',
            data: await service.accessUrl(req.query.objectKey, expire),
          };
        },
      );
      app.delete<{ Querystring: { objectKey: string } }>(
        `${API_PREFIX}/files`,
        {
          schema: {
            ...fileSchema(
              'delete',
              '删除文件',
              '需登录；只可删除本人上传且尚未认领的文件，匿名上传和已认领文件拒绝删除。重复删除返回403。对象删除成功后标记台账DELETED；与认领共享行锁。',
              {
                type: 'boolean',
                description: '删除成功固定为 true；失败返回错误而不是 false。',
                examples: [true],
              },
            ),
            querystring: keyQuery,
          },
        },
        async (req) => ({
          code: 200,
          message: '操作成功',
          data: await service.registry.deleteOwnedUnclaimed(
            req.query.objectKey,
            identities.get(req)!.uid,
          ),
        }),
      );
    },
    { prefix: '' },
  );
}
