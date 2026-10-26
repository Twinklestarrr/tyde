import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';

const orgId = '00000000-0000-4000-8000-000000000002';
const text = (description: string, example: string | null, nullable = false) => ({
  type: 'string',
  description,
  examples: [example],
  ...(nullable ? { nullable: true } : {}),
});
export const orgIdField = {
  ...text(
    '组织 ID，必填；当前新项目为 UUID 字符串，旧数值 ID 尚未转换，不可混用新旧库标识。',
    orgId,
  ),
  format: 'uuid',
};
export const organizationQuery = {
  type: 'object',
  description: '组织资料查询参数；必须指定目标组织。',
  additionalProperties: false,
  required: ['orgId'],
  properties: { orgId: orgIdField },
  examples: [{ orgId }],
};
export const organizationUpdateBody = {
  type: 'object',
  description: '组织资料部分更新；仅可修改简介和 Logo。',
  additionalProperties: false,
  required: ['orgId'],
  properties: {
    orgId: orgIdField,
    description: {
      ...text(
        '组织简介；可选，不传或 null 保持原值；去除首尾空白，空白字符串清为空串，最多1000字符。',
        '提供数据标注服务。',
        true,
      ),
      maxLength: 1000,
    },
    logoUrl: {
      ...text(
        '组织 Logo 图片地址或 ORG_LOGO objectKey；可选，不传或 null 保持原值；去除首尾空白，空白字符串清空，最多500字符。新上传图片须同时提交logoUploadToken，校验本人上传并认领；组织已认领图片可重复保存。替换或清空会在同一事务释放旧图，旧外部HTTPS地址兼容保留。',
        'org-logo/2026/10/23/example.png',
        true,
      ),
      maxLength: 500,
    },
    logoUploadToken: {
      ...text(
        '新上传Logo的一次性凭证，须与logoUrl=objectKey一起提交；来自登录后bizType=ORG_LOGO图片上传。默认24小时内有效，仅保存在内存；错误或他人凭证403，过期或已被其他组织认领409。旧地址或清空时省略，null视为未提供。',
        'example-upload-token',
        true,
      ),
      minLength: 1,
      maxLength: 256,
    },
  },
  examples: [{ orgId, description: '提供数据标注服务。', logoUrl: 'https://example.com/logo.png' }],
};
export const organizationDetailResponse = {
  type: 'object',
  description: '实际持久化的组织资料及当前用户在目标组织的身份；不含工作台统计。',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'unifiedCreditCode',
    'description',
    'businessLicenseUrl',
    'logoUrl',
    'expertiseTags',
    'verifyStatus',
    'status',
    'position',
    'createdAt',
  ],
  properties: {
    id: orgIdField,
    name: text('组织名称。', '示例标注团队'),
    unifiedCreditCode: text('统一社会信用代码；未填写为 null。', null, true),
    description: text('组织简介；未填写为 null，主动清空为空串。', '提供数据标注服务。', true),
    businessLicenseUrl: text(
      '已认领营业执照 objectKey，沿用旧字段名，并非公开 URL；未上传为 null，读取需文件鉴权代理。',
      null,
      true,
    ),
    logoUrl: text(
      '组织 Logo 图片地址；新认领图片返回可展示URL，兼容历史objectKey。未填写为 null，主动清空为空串。',
      'https://example.com/logo.png',
      true,
    ),
    expertiseTags: {
      type: 'array',
      description: '擅长领域；无标签为空数组，去除首尾空白及空标签。',
      items: text('单个擅长领域标签。', '图像标注'),
      examples: [['图像标注']],
    },
    verifyStatus: {
      ...text(
        '组织认证状态：PENDING=待审核、APPROVED=通过、REJECTED=拒绝；新建固定APPROVED，表示创建即生效，无人工审核；PENDING/REJECTED仅为历史枚举。',
        'APPROVED',
      ),
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
    },
    status: {
      ...text(
        '组织状态：ACTIVE=正常、FROZEN=冻结、DISSOLVED=解散；读取数据库，默认ACTIVE。沿用旧资料服务，不额外按此状态禁止读取。',
        'ACTIVE',
      ),
      enum: ['ACTIVE', 'FROZEN', 'DISSOLVED'],
    },
    position: {
      ...text(
        '当前用户在指定组织的身份：OWNER=主管、ADMIN=管理员、MEMBER=普通成员；本接口只允许前两者读取。',
        'OWNER',
      ),
      enum: ['OWNER', 'ADMIN', 'MEMBER'],
    },
    createdAt: text(
      '组织创建时间；ISO 8601 UTC，旧本地日期格式兼容性待验收。',
      '2026-10-19T00:00:00.000Z',
    ),
  },
  examples: [
    {
      id: orgId,
      name: '示例标注团队',
      unifiedCreditCode: null,
      description: '提供数据标注服务。',
      businessLicenseUrl: null,
      logoUrl: 'logos/example.png',
      expertiseTags: ['图像标注'],
      verifyStatus: 'APPROVED',
      status: 'ACTIVE',
      position: 'OWNER',
      createdAt: '2026-10-19T00:00:00.000Z',
    },
  ],
};
export const organizationUpdateResponse = {
  type: 'object',
  description: '组织资料更新后的实际保存值。',
  additionalProperties: false,
  required: ['id', 'description', 'logoUrl', 'updatedAt'],
  properties: {
    id: orgIdField,
    description: organizationDetailResponse.properties.description,
    logoUrl: organizationDetailResponse.properties.logoUrl,
    updatedAt: text(
      '本次更新时间；ISO 8601 UTC。即使没有提交可修改字段也更新审计时间。',
      '2026-10-19T01:00:00.000Z',
    ),
  },
  examples: [
    {
      id: orgId,
      description: '提供数据标注服务。',
      logoUrl: 'logos/example.png',
      updatedAt: '2026-10-19T01:00:00.000Z',
    },
  ],
};
export function organizationSchema(
  operationId: string,
  summary: string,
  description: string,
  response: Record<string, unknown>,
): FastifySchema {
  const failure = resultSchema({ type: 'null', description: '失败时无业务数据，固定 null。' });
  return {
    operationId,
    summary,
    tags: ['Organization'],
    description: `${description} 沿用 code/message/data 包装。组织权限只查指定 orgId 下的多组织成员关系，不由EXPERT身份或用户表兼容字段授权。Web/Electron页面使用HttpOnly Cookie，写请求须带WEB_ORIGINS或DESKTOP_ORIGINS中的精确受信Origin，声明X-Tyde-Client: web；桌面来源Cookie使用SameSite=None、Secure，跨源fetch须携带credentials: include。审批退出和成员导入的Idempotency-Key已允许CORS预检。普通无Origin、sec-fetch-*或Cookie的API客户端使用Bearer；禁止混用Cookie和Bearer。UUID/ISO日期与旧库数值ID/本地时间格式的兼容验收尚未完成。`,
    security: [{ webSession: [] }, { desktopSession: [] }],
    response: {
      200: resultSchema(response),
      ...Object.fromEntries(
        Object.entries({
          400: '请求字段、格式或长度不正确。',
          401: '未登录，或会话过期、已撤销。',
          403: '非指定组织主管/管理员、成员状态不允许或请求来源不可信。',
          404: '组织不存在或已逻辑删除；先检查关系，无权限时优先返回403。',
          409: '成员版本或组织主管已发生变化，请刷新后重试。',
          500: '内部处理失败。',
          503: '数据库暂不可用，或请求的项目成员筛选能力尚未接入。',
        }).map(([status, message]) => [
          status,
          {
            ...failure,
            description: message,
            examples: [{ code: Number(status), message, data: null }],
          },
        ]),
      ),
    },
  };
}
