import type { FastifySchema } from 'fastify';
type DocumentedSchema = Record<string, unknown>;
function text(description: string, example: string | null, nullable = false) {
  return {
    type: 'string',
    description,
    examples: [example],
    ...(nullable ? { nullable: true } : {}),
  };
}
const organizationResponse = {
  type: 'object',
  nullable: true,
  additionalProperties: true,
  description:
    '当前关联组织资料；没有组织时为 null。从可参与的多组织关系中选取：OWNER优先，其次最早入组，未记录入组时间排后；已删除组织不展示。',
  properties: {
    id: text('组织主键 ID，新项目为 UUID 字符串。', '00000000-0000-4000-8000-000000000002'),
    name: text('组织名称。', '示例标注团队'),
    unifiedCreditCode: text('统一社会信用代码，未填写时为 null。', null, true),
    description: text('组织简介，未填写时为 null。', '提供数据标注服务。', true),
    businessLicenseUrl: text(
      '已认领营业执照的 objectKey（保留旧字段名，不是公开 URL）；未填写时为 null。读取须走鉴权文件代理；已认领营业执照仅本组织主管/管理员可读取。',
      null,
      true,
    ),
    logoUrl: text('组织 Logo 地址，未填写时为 null。', null, true),
    expertiseTags: {
      type: 'array',
      description: '组织擅长领域标签列表，未填写时为空数组。',
      items: text('单个擅长领域标签。', '图像标注'),
      examples: [['图像标注']],
    },
    verifyStatus: text(
      '组织生效状态，新建固定APPROVED，表示创建即生效、不代表人工审核；PENDING/REJECTED仅为历史枚举。',
      'APPROVED',
    ),
    status: text('组织状态，读取数据库：ACTIVE=正常、FROZEN=冻结、DISSOLVED=解散。', 'ACTIVE'),
    position: {
      ...text(
        '当前用户在组织内的身份：OWNER=组织主管，ADMIN=管理员，MEMBER=成员；无身份记录时为 null。',
        'OWNER',
        true,
      ),
      enum: ['OWNER', 'ADMIN', 'MEMBER', null],
    },
    joinStatus: text(
      '当前所选组织关系状态：ACTIVE=在组、EXIT_APPROVING=退出审批中、PENDING_LEAVE=待离职；其他状态不展示。',
      'ACTIVE',
    ),
    createdAt: text('组织创建时间，ISO 8601 UTC 时间字符串。', '2026-10-16T08:00:00.000Z'),
  },
};
const userExample = {
  id: '00000000-0000-4000-8000-000000000001',
  uid: '00000000000040008000000000000001',
  accountType: 'INDIVIDUAL',
  phone: '138****5678',
  nickname: '小明',
  realName: '王小明',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: null,
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  organizations: [],
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T08:00:00.000Z',
};
export const userResponse = {
  type: 'object',
  description:
    '用户资料。注册成功和查询当前用户均返回该结构；手机号、身份证号只返回脱敏值，当前未迁移能力以字段说明中的固定值或 null 返回。',
  examples: [userExample],
  properties: {
    id: text('用户主键 ID，新项目为 UUID 字符串，与旧项目数值 ID 类型不同。', userExample.id),
    uid: text(
      '用户全局业务标识，可用作密码登录账号；新注册账号为不含连字符的 32 位 UUID 字符串。',
      userExample.uid,
    ),
    accountType: {
      ...text(
        '兼容字段，新注册统一INDIVIDUAL；组织身份由成员关系表达，不以此字段决定权限。',
        'INDIVIDUAL',
      ),
      enum: ['INDIVIDUAL', 'ORGANIZATION'],
    },
    phone: text('已脱敏的中国大陆手机号，隐藏中间 4 位，不含 +86。', '138****5678'),
    nickname: text('昵称；注册未填写时使用真实姓名。', '小明'),
    realName: text('真实姓名。', '王小明'),
    idCardNo: text('脱敏身份证号；未填写时为 null，仅保留前 3 位和后 4 位。', null, true),
    idVerified: {
      type: 'integer',
      description:
        '实名认证状态：0=未认证，1=已认证。来自数据库，注册默认0；实名核验流程尚未迁移，本接口不能更改该状态。',
      examples: [0],
    },
    avatarUrl: text(
      '头像展示URL，未填写/清空为null；新上传AVATAR经本人一次性认领后返回签名URL；历史外部URL/objectKey兼容保留，不代表敏感文件读取权限。',
      null,
      true,
    ),
    bio: text('个人简介，未填写或清空时为null。', null, true),
    role: {
      ...text(
        '当前会话角色；无会话的注册响应默认EXPERT。NAVIGATOR=领航员、PM=策略官、EXPERT=执行专家。',
        'EXPERT',
      ),
      enum: ['NAVIGATOR', 'PM', 'EXPERT'],
    },
    roles: {
      type: 'array',
      description: '账号注册自带角色列表，固定NAVIGATOR、PM、EXPERT；不含OPS。',
      items: {
        ...text('角色代码：NAVIGATOR=领航员、PM=策略官、EXPERT=执行专家。', 'EXPERT'),
        enum: ['NAVIGATOR', 'PM', 'EXPERT'],
      },
      examples: [['NAVIGATOR', 'PM', 'EXPERT']],
    },
    selectedRole: {
      ...text(
        '当前服务端会话角色，首次登录默认EXPERT；查询及资料更新返回实际角色；无登录会话的注册响应null。',
        null,
        true,
      ),
      enum: ['NAVIGATOR', 'PM', 'EXPERT', null],
    },
    hasExpertManagementRole: {
      type: 'boolean',
      description:
        '当前会话是否具备执行专家管理职责；仅EXPERT会话下，有效多组织主管或已接单组织的现任项目负责人为true。负责人须仍在对应组织，关系表存在任何历史即禁用旧单值回退；删除项目不计入。ADMIN本身不代表管理职责。注册响应false；本字段用于展示，不作为业务权限凭据。',
      examples: [false],
    },
    status: text(
      '账号状态，ACTIVE=正常；其他状态禁止登录，旧状态 FROZEN=冻结、BANNED=封禁。新注册账号为 ACTIVE。',
      'ACTIVE',
    ),
    creditScore: {
      type: 'integer',
      description: '信用分；信用体系尚未迁移，当前固定返回 100。',
      examples: [100],
    },
    lastLoginAt: text(
      '最近一次密码或短信登录成功时间，ISO 8601 UTC；尚未登录时为 null，刷新令牌不更新此字段。',
      null,
      true,
    ),
    lastLoginIp: text('最近一次密码或短信登录的客户端 IP；尚未登录时为 null。', null, true),
    organization: organizationResponse,
    organizations: {
      type: 'array',
      description:
        '本人全部有效组织关系，按组织ID排序；无组织为空数组。与当前角色无关，不作为组织管理授权凭据。',
      items: {
        type: 'object',
        description: '单个有效组织关系摘要。',
        required: ['id', 'name', 'position', 'joinStatus', 'status', 'verifyStatus'],
        properties: {
          id: organizationResponse.properties.id,
          name: organizationResponse.properties.name,
          position: organizationResponse.properties.position,
          joinStatus: organizationResponse.properties.joinStatus,
          status: organizationResponse.properties.status,
          verifyStatus: organizationResponse.properties.verifyStatus,
        },
      },
      examples: [[]],
    },
    createdAt: text('账号创建时间，ISO 8601 UTC 时间字符串。', userExample.createdAt),
    updatedAt: text('账号最近更新时间，ISO 8601 UTC 时间字符串。', userExample.updatedAt),
  },
};
export const nicknameCheckResponse = {
  type: 'object',
  description: '昵称校验结果，建议仅保证查询时可用，不预留昵称。',
  required: ['nickname', 'available', 'suggestion', 'message'],
  properties: {
    nickname: text('去除首尾空格后的原昵称。', '小明'),
    available: {
      type: 'boolean',
      description: '是否可用：true=未占用，false=已占用。',
      examples: [false],
    },
    suggestion: text(
      '可用时等于原昵称；占用时推荐从1递增的数字后缀，最长64字符，必要时截短原昵称。最多尝试1000个，无可用值返回409。',
      '小明1',
    ),
    message: text('中文校验提示。', '昵称已存在，可使用推荐昵称「小明1」'),
  },
  examples: [
    {
      nickname: '小明',
      available: false,
      suggestion: '小明1',
      message: '昵称已存在，可使用推荐昵称「小明1」',
    },
  ],
};
export const loginResponse = {
  type: 'object',
  description:
    '登录或刷新成功的令牌对。默认有效期 30 天；Web 与 Electron 页面同时设置 HttpOnly Cookie，后续由浏览器携带；仅非浏览器 API 客户端使用 accessToken 进行 Bearer 认证。',
  required: ['accessToken', 'refreshToken', 'tokenType', 'expiresIn'],
  examples: [
    {
      accessToken: 'a'.repeat(43),
      refreshToken: 'r'.repeat(43),
      tokenType: 'Bearer',
      expiresIn: 2592000,
    },
  ],
  properties: {
    accessToken: text(
      '访问令牌原值；仅非浏览器 API 客户端使用 Authorization: Bearer <accessToken>，Web/Electron 页面使用 HttpOnly Cookie。当前为随机不透明字符串，不能按 JWT 解析；示例不是真实令牌。',
      'a'.repeat(43),
    ),
    refreshToken: text(
      '刷新令牌原值，用于 POST /auth/refresh。刷新成功后原令牌对失效；请使用新返回的刷新令牌，示例不可用于认证。',
      'r'.repeat(43),
    ),
    tokenType: { ...text('令牌认证类型，固定为 Bearer。', 'Bearer'), enum: ['Bearer'] },
    expiresIn: {
      type: 'integer',
      description: '访问令牌有效时长，单位：秒；当前默认 2592000 秒（30 天），从本次签发开始计算。',
      examples: [2592000],
    },
  },
};
const registrationRequiredResponse = {
  type: 'object',
  description:
    '手机号已验证但尚未注册。客户端展示注册资料表单；不创建用户、登录会话或登录 Cookie。',
  required: ['status', 'registrationToken', 'expiresAt'],
  examples: [
    {
      status: 'registration_required',
      registrationToken: 'g'.repeat(43),
      expiresAt: '2026-10-16T12:10:00.000Z',
    },
  ],
  properties: {
    status: {
      ...text('处理状态，registration_required=需要填写资料并注册。', 'registration_required'),
      enum: ['registration_required'],
    },
    registrationToken: text(
      '一次性注册凭证，绑定本次手机号，10 分钟有效；仅用于 /auth/register，不能访问受保护接口。再次验证该手机号后旧凭证失效；示例不可实际使用。',
      'g'.repeat(43),
    ),
    expiresAt: text(
      '注册凭证到期时间，ISO 8601 UTC；到期后重新获取登录验证码。',
      '2026-10-16T12:10:00.000Z',
    ),
  },
};
export const smsLoginResponse = {
  description:
    '已注册返回登录令牌对；未注册返回注册指引。根据 status=registration_required 展示表单，未填写不产生账号。',
  anyOf: [loginResponse, registrationRequiredResponse],
  examples: [loginResponse.examples[0], registrationRequiredResponse.examples[0]],
};
export function resultSchema(data: DocumentedSchema) {
  const examples = data.examples as unknown[] | undefined;
  return {
    type: 'object',
    description: '统一业务响应包装；业务状态码、处理说明和业务数据。',
    required: ['code', 'message', 'data'],
    ...(examples ? { examples: [{ code: 200, message: '操作成功', data: examples[0] }] } : {}),
    properties: {
      code: {
        type: 'integer',
        description:
          '业务状态码：200=成功；400=参数错误，401=未认证，403=无权限，404=不存在，409=冲突，413=请求过大，4292=限流，500=内部错误，503=服务不可用。业务码与 HTTP 状态码不总相同，例如限流 HTTP 429 对应业务码 4292。',
        examples: [200],
      },
      message: text(
        '本次处理结果的中文说明；成功通常为“操作成功”，失败返回可展示的具体原因。',
        '操作成功',
      ),
      data: {
        description: '接口业务数据；结构见本接口响应，失败或没有业务数据时为 null。',
        ...data,
      },
    },
  };
}
const operationDescriptions: Record<string, string> = {
  checkNickname:
    '可匿名调用，无请求体，必填查询参数nickname；trim后检查唯一性，按数字后缀给出建议。不预留昵称，注册冲突仍返回409。新库按大小写敏感精确匹配，旧MySQL排序规则兼容性待验收。',
  updateCurrentUser:
    '仅更新当前有效会话本人，无目标用户参数；AVATAR须登录上传，新关联传avatarUrl=objectKey和avatarUploadToken=uploadToken，认领、替换/清空释放旧头像与资料同事务；重复保存本人已认领头像无需再次消费凭证。未传/null保持，头像/简介/未认证身份证空白可清空。姓名、邮箱及昵称不在旧更新字段中。已认证证件更改403、重复证件409。密码必须成对一致，更新与全部会话撤销同事务；成功清除Web/Electron Cookie并须重新登录。roles兼容字段不改三角色资格，响应返回实际会话角色及组织管理展示标志。多组织资料已按有效关系选取；在线状态/实时通知及完整项目管理能力待后续回补。',
  sendCode:
    '按 scene 发送验证码。不同场景独立验证，手机号跨场景共用 60 秒发送冷却；验证码 5 分钟有效，错误尝试最多 5 次。当前开发/测试仅 mock，不实际发短信，验证码为字符串 095270。',
  register:
    '使用 scene=register 的验证码或短信登录返回的 registrationToken 注册统一账号（两者必须且只能提交一个），自带NAVIGATOR/PM/EXPERT；成功返回用户资料，不自动登录，不创建组织。组织资料请登录后调用POST /organizations。',
  login:
    '通过手机号、备用邮箱或 uid 与密码登录，默认EXPERT，允许提交记住的NAVIGATOR/PM/EXPERT；OPS禁止。成功签发前在同一事务激活所有PENDING_ACTIVATION（待激活）组织关系并递增版本；激活失败整体回滚，不签发令牌。随后签发访问/刷新令牌并更新最近登录时间/IP；密码错误或无账号返回 401，禁用账号返回 403。',
  loginBySms:
    '使用 scene=login 的验证码验证手机号，默认EXPERT，允许提交记住的NAVIGATOR/PM/EXPERT；OPS禁止。已注册账号先在同一事务激活待激活组织关系（版本递增），激活失败回滚验证码消费且不签发令牌；随后签发登录令牌。未注册返回 HTTP 200、status=registration_required、registrationToken 和 expiresAt，客户端展示注册表单。凭证绑定手机号、10 分钟有效且一次性，再次验证同手机号后旧凭证失效；未提交注册不创建用户或会话。验证码成功使用后失效。',
  refresh:
    '提交 refreshToken 换取新令牌对；原访问令牌及刷新令牌失效，重复使用返回 401。客户端类型必须与原登录一致；刷新不会更新最近登录时间/IP。',
  resetPassword:
    '使用 scene=reset_password 的验证码修改密码。成功后撤销该账号全部客户端的访问与刷新令牌，须重新登录；成功 data 为 null。',
  getCurrentUser:
    '根据当前有效会话返回用户资料，selectedRole为实际会话角色；没有有效会话返回 401。组织资料按真实多组织关系选择；实名和项目管理能力尚待迁移，当前占位字段见响应说明。',
  switchRole:
    '只修改当前有效会话的selectedRole，不重新签发令牌，不影响其他会话；刷新令牌保留角色。',
  createOrganization:
    '须有效登录且当前角色EXPERT。组织、本人ACTIVE/OWNER关系及可选营业执照/Logo认领同事务；Logo使用本人登录上传的ORG_LOGO图片，以logoUrl=objectKey及logoUploadToken提交。创建即ACTIVE/APPROVED，无人工审核；允许多组织。名称或信用代码重复409，失败全部回滚；重复同名提交不会重复创建。',
  logout:
    '撤销当前访问令牌对应的会话及其刷新令牌，Web/Electron 页面同时清除登录 Cookie；不影响其他客户端会话。没有会话也成功，data 为 null。',
};
const errorDescriptions: Record<number, string> = {
  400: '请求字段/格式、验证码、密码确认或业务条件不正确。',
  401: '账号密码错误、手机号未注册，或会话/刷新令牌无效、过期、已撤销。',
  403: '账号已禁用、请求来源或客户端凭据组合不被允许。',
  404: '需要操作的账号不存在。',
  409: '手机号、昵称、邮箱、身份证或组织信息与已有数据冲突，或昵称推荐耗尽。',
  413: '请求体超过服务端大小限制。',
  429: '操作频率或验证码错误次数超限；业务码 4292，Retry-After 响应头表示建议等待秒数。',
  500: '内部处理失败。',
  503: '数据库或服务暂不可用。',
};
export function authSchema(
  operationId: string,
  summary: string,
  response: unknown,
  protectedRoute = false,
): FastifySchema {
  const failure = resultSchema({ type: 'null', description: '失败时无业务数据，固定为 null。' });
  return {
    operationId,
    summary,
    tags: ['Auth'],
    description: `${operationDescriptions[operationId] ?? summary}\n\n沿用旧字段与 code/message/data 包装。role/roles 可省略；即使传入其他已知角色仍默认EXPERT，允许提交记住的NAVIGATOR/PM/EXPERT；OPS禁止。Web/Electron 页面使用 HttpOnly Cookie，写请求声明 X-Tyde-Client: web，Origin 须精确匹配 WEB_ORIGINS 或 DESKTOP_ORIGINS。普通 Web 使用 SameSite=Lax；桌面来源使用 SameSite=None、Secure，跨源 fetch 须使用 credentials: include。CORS 允许 Content-Type、X-Tyde-Client、Idempotency-Key，并暴露 Retry-After、Content-Disposition。仅非浏览器 API 客户端使用 X-Tyde-Client: desktop 和 Bearer，禁止 Origin、Cookie、sec-fetch-*；无这些浏览器头、Cookie 和客户端声明的 API 调试请求自动按 Bearer 客户端处理。不要混用 Cookie 与 Authorization。`,
    security: protectedRoute ? [{ webSession: [] }, { desktopSession: [] }] : [],
    response: {
      200: response,
      ...Object.fromEntries(
        Object.entries(errorDescriptions).map(([status, description]) => [
          status,
          {
            ...failure,
            description,
            examples: [
              {
                code: Number(status) === 429 ? 4292 : Number(status),
                message: description,
                data: null,
              },
            ],
          },
        ]),
      ),
    },
  };
}
