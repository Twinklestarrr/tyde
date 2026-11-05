import { resultSchema } from '../auth/auth.schema.js';
import { orgIdField, organizationSchema } from './organization.schema.js';
type Schema = Record<string, unknown>;
const orgId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000001';
const text = (description: string, example: string | null, nullable = false): Schema => ({
  type: 'string',
  description,
  examples: [example],
  ...(nullable ? { nullable: true } : {}),
});
const integer = (description: string, value: number): Schema => ({
  type: 'integer',
  minimum: 0,
  description,
  examples: [value],
});
const object = (
  description: string,
  properties: Record<string, Schema>,
  example?: unknown,
  required = Object.keys(properties),
): Schema => ({
  type: 'object',
  description,
  additionalProperties: false,
  required,
  properties,
  ...(example ? { examples: [example] } : {}),
});
const role = {
  ...text('组织角色：ADMIN=管理员、MEMBER=成员；不能导入OWNER。', 'MEMBER'),
  enum: ['ADMIN', 'MEMBER'],
};
const member = object('导入成功成员；已有账号保留资料，响应手机号脱敏，不生成或返回密码。', {
  memberId: text('组织成员关系UUID；重新入组复用历史ID。', memberId),
  userId: text('用户UUID。', userId),
  uid: text('用户公开UID，可用作登录账号。', '00000000000040008000000000000001'),
  accountType: {
    ...text('统一账号兼容类型，固定INDIVIDUAL；组织身份由当前成员关系表达。', 'INDIVIDUAL'),
    enum: ['INDIVIDUAL'],
  },
  phoneMasked: text('脱敏大陆手机号，仅显示前三和后四位。', '138****5678', true),
  realName: text('沿旧字段名，内容为当前昵称(真实姓名)，缺失回退已有名称或UID。', '小张(张三)'),
  position: role,
  employmentType: {
    ...text('人员属性：FULL_TIME=全职、PART_TIME=兼职。', 'FULL_TIME', true),
    enum: ['FULL_TIME', 'PART_TIME', null],
  },
  joinedAt: text(
    '入组时间；输入日期或上海上传当日零点，响应ISO 8601 UTC；无记录为null。',
    '2026-10-18T16:00:00.000Z',
    true,
  ),
  joinStatus: {
    ...text(
      '新建账号关系PENDING_ACTIVATION=待激活；已有账号加入ACTIVE=已入组。',
      'PENDING_ACTIVATION',
    ),
    enum: ['PENDING_ACTIVATION', 'ACTIVE'],
  },
});
const rowError = object('行级错误；同一行可有多条，手机号始终脱敏，0表示全局错误。', {
  rowNo: integer('数据行号从1开始（去掉空行/说明/表头后的序号），全局错误为0。', 1),
  field: text(
    '出错字段名：realName、phone、employmentType、position、joinedAt、row、members、file或memberText。',
    'phone',
  ),
  value: text('错误原始值或null；手机号脱敏，不返回整行原文。', '138****5678', true),
  errorCode: {
    ...text(
      'REQUIRED_MISSING=缺必填、ACCOUNT_REGISTERED=已在本组织、FORMAT_INVALID=格式错、ALREADY_JOINED_OTHER_ORGANIZATION=历史保留码（允许跨组织任职后不再产生）、DUPLICATE_IN_BATCH=批内重复、LIMIT_EXCEEDED=数量/管理员上限。',
      'DUPLICATE_IN_BATCH',
    ),
    enum: [
      'REQUIRED_MISSING',
      'ACCOUNT_REGISTERED',
      'FORMAT_INVALID',
      'ALREADY_JOINED_OTHER_ORGANIZATION',
      'DUPLICATE_IN_BATCH',
      'LIMIT_EXCEEDED',
    ],
  },
  message: text('可展示的错误原因。', '同一批成员手机号重复'),
});
export const importExample = {
  sourceType: 'TEXT',
  textIgnored: false,
  totalCount: 1,
  validCount: 1,
  invalidCount: 0,
  createdCount: 1,
  rowErrors: [],
  members: [
    {
      memberId,
      userId,
      uid: '00000000000040008000000000000001',
      accountType: 'INDIVIDUAL',
      phoneMasked: '138****5678',
      realName: '小张(张三)',
      position: 'MEMBER',
      employmentType: 'FULL_TIME',
      joinedAt: '2026-10-18T16:00:00.000Z',
      joinStatus: 'PENDING_ACTIVATION',
    },
  ],
  createdAt: '2026-10-19T06:00:00.000Z',
};
export const importErrorExample = {
  ...importExample,
  validCount: 0,
  invalidCount: 1,
  createdCount: 0,
  members: [],
  createdAt: null,
  rowErrors: [
    {
      rowNo: 1,
      field: 'phone',
      value: '138****5678',
      errorCode: 'DUPLICATE_IN_BATCH',
      message: '同一批成员手机号重复',
    },
  ],
};
export const importResponse = object(
  '全量校验/导入结果。任一错误HTTP400且不创建账号/关系；回执可保存失败结果，修改输入须用新幂等键。成功createdCount包括新建、已有账号入组和重新入组。',
  {
    sourceType: {
      ...text('实际来源：EXCEL=XLS/XLSX、CSV=UTF-8 CSV、TEXT=文本。', 'TEXT'),
      enum: ['EXCEL', 'CSV', 'TEXT'],
    },
    textIgnored: {
      type: 'boolean',
      description: '非空文件优先时，若还提供非空文本则true；空文件允许回退文本。',
      examples: [false],
    },
    totalCount: integer('有效数据总行数，最多500；超限返回全局错误。', 1),
    validCount: integer('无行错误的行数；全局错误时0。', 1),
    invalidCount: integer('至少一个错误的不同数据行数，全局错误为totalCount。', 0),
    createdCount: integer('成功导入关系数；存在任一错误时为0。', 1),
    rowErrors: {
      type: 'array',
      description: '完整字段错误列表，无错误为空数组。',
      items: rowError,
    },
    members: { type: 'array', description: '成功导入成员列表；失败为空数组。', items: member },
    createdAt: text('成功完成时间ISO UTC；校验失败为null。', '2026-10-19T06:00:00.000Z', true),
  },
  importExample,
);
export const importBody = object(
  'multipart表单；orgId可在查询参数或此表单填写，csvFile和memberText至少一个有效；文件优先。',
  {
    orgId: orgIdField,
    csvFile: {
      type: 'string',
      format: 'binary',
      description:
        '可选Excel(.xlsx/.xls)或UTF-8 CSV，沿用旧字段名csvFile，非空时优先于文本；当前50MiB上限，不保存原文件。',
    },
    memberText: text(
      '可选成员文本，支持中英文逗号/双引号/转义双引号/字段内换行；姓名、手机号、人员属性必填，可选角色和yyyy-MM-dd入组日。中文全职/兼职、管理员/成员，亦接受Full-time/Part-time、Administrator/Member；空角色默认成员，空日期默认上海当天。',
      '张三,13812345678,全职,成员,2026-10-19',
    ),
  },
  { orgId, memberText: '张三,13812345678,全职,成员,2026-10-19' },
  [],
);
export const importQuery = object(
  '可选查询参数，与表单同名冲突时400；orgId必须在任一来源提供。',
  {
    orgId: orgIdField,
    memberText: text(
      '可选文本，规则同multipart中的memberText；不能同时提交不同文本。',
      '张三,13812345678,全职',
    ),
  },
  undefined,
  [],
);
export const importHeaders = {
  type: 'object',
  description: '导入幂等头；允许认证等其他标准HTTP头。',
  additionalProperties: true,
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': {
      ...text(
        '必填，trim后非空，最长128字符；组织+操作人隔离，完成结果保留24小时。同键不同有效来源/内容或处理中的请求409，整批回滚不保存完成回执。',
        'member-import-example-001',
      ),
      minLength: 1,
      maxLength: 128,
    },
  },
};
export function importSchema() {
  const base = organizationSchema(
    'generateMemberAccounts',
    '批量导入组织成员',
    '有效组织主管/管理员可导入。最多500人，先全量校验，任一错误不创建成员。新账号自带NAVIGATOR/PM/EXPERT、无默认密码、关系待激活；已有账号即使属于其他组织也可加入当前组织，仅拒绝当前组织有效重复关系，保留资料，历史LEFT/REMOVED关系复用并递增版本。5名有效管理员上限含待激活。手机号锁排序→组织锁，整批成员和幂等结果同数据库事务。首次成功登录先激活再发令牌。模板首行说明、次行表头；XLSX声明解压总量限100MiB/1024项，工作表物理范围最多10万行，超限不导入；Excel公式/错误单元格、非法UTF-8不接受。',
    importResponse,
  );
  return {
    ...base,
    consumes: ['multipart/form-data'],
    headers: importHeaders,
    querystring: importQuery,
    body: importBody,
    response: {
      ...(base.response as Record<string, unknown>),
      413: {
        ...resultSchema({ type: 'null', description: '请求超过大小或字段数量限制，无业务数据。' }),
        description: '文件、文本或multipart总请求超过服务端限制。',
        examples: [{ code: 413, message: '导入请求超过限制', data: null }],
      },
      400: {
        ...resultSchema({
          description: '参数错误时null；全量行校验失败时为完整导入结果。',
          anyOf: [
            importResponse,
            { type: 'null', description: '格式/必填等请求错误，无业务结果。' },
          ],
        }),
        examples: [{ code: 400, message: '成员信息校验失败', data: importErrorExample }],
      },
    },
  };
}
export const templateSchema = {
  headers: {
    type: 'object',
    description: '模板语言请求头；允许标准认证头。',
    additionalProperties: true,
    properties: {
      'accept-language': {
        type: 'string',
        description: '可选，主语言以en开头则英文模板，否则中文；省略默认中文。',
        examples: ['en-US'],
      },
    },
  },
  ...organizationSchema(
    'downloadMemberImportTemplate',
    '下载成员导入模板',
    '需有效登录，不要求管理身份或orgId；直接返回XLSX流，首行填写说明、次行为固定五列表头。Accept-Language以en开头时英文，其余中文；表头前三列必填。跨源页面可读取已由CORS暴露的Content-Disposition下载文件名。',
    {},
  ),
  response: {
    ...(organizationSchema('', '', '', {}).response as Record<string, unknown>),
    200: {
      description: 'XLSX模板二进制，非Result包装。',
      content: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
          schema: { type: 'string', format: 'binary', description: 'Excel模板文件字节。' },
        },
      },
    },
  },
};
