import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { businesses, categories } from './file.types.js';
const text = (description: string, example: string) => ({
  type: 'string',
  description,
  examples: [example],
});
export const uploadExample = {
  fileId: '00000000-0000-4000-8000-000000000001',
  objectKey: 'business-license/2026/10/16/0123456789abcdef0123456789abcdef.png',
  uploadToken: 'a'.repeat(43),
  url: null,
  sensitive: true,
  fileName: '营业执照.png',
  extension: 'png',
  size: 1024,
  contentType: 'image/png',
  fileHash: 'b'.repeat(64),
};
export const uploadResponse = {
  type: 'object',
  description: '文件上传结果及一次性认领凭证；敏感对象不包含直接访问链接。',
  required: Object.keys(uploadExample),
  examples: [uploadExample],
  properties: {
    fileId: {
      type: 'string',
      format: 'uuid',
      description: '上传台账UUID；成员表现attachmentIds使用此ID，配合uploadToken认领。',
      examples: [uploadExample.fileId],
    },
    objectKey: text(
      '相对于项目 tyde/ 主目录的唯一业务 Key，后续认领、查看或删除原样使用；不是 URL，不含 bucket 名或 tyde/ 前缀。',
      uploadExample.objectKey,
    ),
    uploadToken: text(
      '256 位随机一次性认领凭证，仅本次返回；默认 24 小时有效，可由服务端配置。组织创建使用 BUSINESS_LICENSE；头像使用AVATAR，保存资料时以avatarUrl=objectKey及avatarUploadToken=uploadToken关联；业务附件由对应业务认领；不能代替登录或作为查看凭据。',
      uploadExample.uploadToken,
    ),
    url: {
      ...text(
        '非敏感文件签名 URL；图片默认最大有效期 2147483647 秒，其他默认 604800 秒可配置；敏感文件固定为 null，必须鉴权代理查看。',
        'https://storage.example/avatar/example.png?Expires=1800000000&Signature=example',
      ),
      nullable: true,
      examples: [null],
    },
    sensitive: {
      type: 'boolean',
      description: '是否为敏感业务文件；true=仅鉴权代理读取，false=允许签名链接。',
      examples: [true],
    },
    fileName: text('已去路径的原始文件名，最长 255 字符。', uploadExample.fileName),
    extension: text('小写扩展名，不含点号；缺失或非白名单类型拒绝上传。', 'png'),
    size: {
      type: 'integer',
      minimum: 1,
      description: '文件内容大小，单位字节；不含 multipart 边界和表单字段。',
      examples: [1024],
    },
    contentType: text('服务端根据扩展名、声明 MIME 与内容校验确定的规范媒体类型。', 'image/png'),
    fileHash: {
      ...text('文件原始内容 SHA-256，64 位小写十六进制。', uploadExample.fileHash),
      pattern: '^[a-f0-9]{64}$',
    },
  },
};
export function uploadBody(batch: boolean) {
  const file = {
    type: 'string',
    format: 'binary',
    description: '文件二进制内容，必填；文件名必须带白名单扩展名，声明 MIME 与实际内容须一致。',
  };
  return {
    type: 'object',
    additionalProperties: false,
    description: 'multipart/form-data 表单；文件字段与业务字段的顺序不限。',
    required: [batch ? 'files' : 'file'],
    properties: {
      [batch ? 'files' : 'file']: batch
        ? {
            type: 'array',
            minItems: 1,
            description: '多个文件，用同名 files 字段重复提交；默认最多 10 个，服务端可配置。',
            items: file,
          }
        : file,
      bizType: {
        ...text(
          '业务类型，大小写不敏感；省略或空白为 COMMON。BUSINESS_LICENSE=营业执照、ID_CARD=身份证、ORG_LOGO=组织标志、AVATAR=头像、IMAGE=图片、VIDEO=视频、DOCUMENT=文档、EXCEL=表格、JSON=JSON数据、PROJECT_ATTACHMENT=项目附件、ENTRANCE_EXAM_ATTACHMENT=准入考试附件、COMMON=通用文件。除 COMMON 外大类固定，不能用 category 放宽；头像与两种业务附件须登录，关联头像需将objectKey及uploadToken作为avatarUrl和avatarUploadToken提交/users/me/update。',
          'BUSINESS_LICENSE',
        ),
        enum: Object.keys(businesses),
      },
      category: {
        ...text(
          '文件大类，大小写不敏感；省略或空白按 bizType 推断，固定业务类型不受此参数放宽。IMAGE=图片10MiB、DOCUMENT=文档/Markdown/压缩包20MiB、VIDEO=视频50MiB、EXCEL=表格20MiB、JSON=JSON数据10MiB、PROJECT_ATTACHMENT=业务附件50MiB、ANY=已知安全类型50MiB。均受全局单文件限制，默认50MiB。',
          'IMAGE',
        ),
        enum: Object.keys(categories),
      },
    },
    examples: [
      batch
        ? {
            files: ['营业执照.png', '营业执照背面.png'],
            bizType: 'BUSINESS_LICENSE',
            category: 'IMAGE',
          }
        : { file: '营业执照.png', bizType: 'BUSINESS_LICENSE', category: 'IMAGE' },
    ],
  };
}
export const keyQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['objectKey'],
  description: '文件查询参数，不接受公开 URL 或路径穿越。',
  properties: {
    objectKey: {
      ...text(
        '上传返回的相对业务 Key，必填，最多 512 字符；原样传入，不加 bucket 名或 tyde/ 前缀，不能传签名 URL。',
        uploadExample.objectKey,
      ),
      minLength: 1,
      maxLength: 512,
    },
  },
};
export function fileSchema(
  operationId: string,
  summary: string,
  description: string,
  data: Record<string, unknown>,
  authenticated = true,
): FastifySchema {
  const errors: Record<number, string> = {
    400: '请求格式、字段、文件类型或内容不正确。',
    401: '必须登录，或会话已失效。',
    403: '无文件权限、敏感文件不允许签名链接或请求来源不可信；已认领项目附件须存活项目/附件关系，并具备创建人NAVIGATOR或当前主策略官/协作负责人PM授权；专家项目附件须真实接单及准入条件；考试附件管理端须当前PM角色且为主策略官/协作负责人或当前NAVIGATOR角色且为需求方/创建人，考生与组织职责分支待07/08。',
    404: '文件不存在。',
    413: '文件、数量或整个 multipart 请求超过服务端限制。',
    500: '内部处理失败。',
    503: '对象存储未配置或数据库/存储暂不可用。',
  };
  return {
    operationId,
    summary,
    description: `${description}\n\nWeb/Electron 页面使用 HttpOnly Cookie，写操作须携带 WEB_ORIGINS 或 DESKTOP_ORIGINS 中的精确可信 Origin，客户端声明 X-Tyde-Client: web；桌面来源 Cookie 使用 SameSite=None、Secure，跨源 fetch 须携带 credentials: include。普通无 Origin、sec-fetch-* 或 Cookie 的 API 客户端使用 Bearer，可声明 X-Tyde-Client: desktop。配置默认关闭存储，未配置时 HTTP 503。OSS 物理对象统一位于 bucket 的 tyde/ 主目录，接口 objectKey 为该目录内的相对业务键。`,
    tags: ['Files'],
    security: authenticated ? [{ webSession: [] }, { desktopSession: [] }] : [],
    response: {
      200: resultSchema(data),
      ...Object.fromEntries(
        Object.entries(errors).map(([status, description]) => [
          status,
          {
            ...resultSchema({ type: 'null', description: '失败时无业务数据，固定为 null。' }),
            description,
            examples: [{ code: Number(status), message: description, data: null }],
          },
        ]),
      ),
    },
  };
}
