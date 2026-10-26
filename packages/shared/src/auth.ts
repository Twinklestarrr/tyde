import { Type, type Static } from '@sinclair/typebox';
const options = { additionalProperties: false };
// 输出普通 string + enum，避免 Swagger 把枚举拆成多个 anyOf，保留字面量类型推导。
function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: 'string', enum: [...values], description });
}
const phone = Type.String({
  pattern: '^1[3-9][0-9]{9}$',
  description: '中国大陆手机号，11 位数字，不含 +86；用于接收验证码及登录。',
  examples: ['13812345678'],
});
const code = Type.String({
  minLength: 4,
  maxLength: 8,
  description:
    '手机验证码，须先按当前操作对应的 scene 获取；有效期 5 分钟，验证成功后仅消费一次。开发/测试 mock 固定为字符串 095270，须保留前导零。',
  examples: ['095270'],
});
export const passwordPattern =
  '^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9!@#$%^&*()_+\\-=\\[\\]{};\':",.<>/?]{8,64}$';
const password = Type.String({
  minLength: 8,
  maxLength: 64,
  pattern: passwordPattern,
  description:
    '登录密码，8～64 位，必须同时包含英文字母和数字，可包含 pattern 中列出的特殊字符；不支持空格或中文。',
  examples: ['Example123!'],
});
const role = stringEnum(
  ['NAVIGATOR', 'PM', 'EXPERT', 'OPS'],
  '旧接口兼容身份字段，可省略；NAVIGATOR=领航员，PM=策略官，EXPERT=执行专家，OPS=平台运营。登录时省略默认EXPERT；可提交记住的NAVIGATOR/PM/EXPERT，OPS禁止自助登录或切换。',
);
export const smsSendSchema = Type.Object(
  {
    phone,
    scene: stringEnum(
      ['login', 'register', 'reset_password'],
      '短信业务场景：login=登录，register=注册，reset_password=重置密码。不同场景的验证码独立，不能跨场景使用。',
    ),
  },
  {
    ...options,
    description:
      '发送验证码请求。发送冷却和频率限制按手机号跨场景共用；当前仅开发/测试 mock，不实际发送短信。',
    examples: [{ phone: '13812345678', scene: 'register' }],
  },
);
export const smsLoginSchema = Type.Object(
  { phone, code, role: Type.Optional(role) },
  {
    ...options,
    description:
      '短信登录请求。code 必须来自 scene=login；已注册返回登录令牌；未注册返回 status=registration_required 和一次性注册凭证，不创建账号或会话，客户端据此展示注册表单。角色省略默认EXPERT，允许提交记住的业务角色。',
    examples: [{ phone: '13812345678', code: '095270' }],
  },
);
export const loginSchema = Type.Object(
  {
    account: Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        '登录账号，支持中国大陆手机号、注册时填写的备用邮箱或平台 uid；去除首尾空格后匹配。邮箱不区分大小写。',
      examples: ['13812345678'],
    }),
    password: Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        '该账号的现有登录密码，按原值校验；仅通过旧验证码流程创建且未设置密码的账号需先重置密码。',
      examples: ['Example123!'],
    }),
    role: Type.Optional(role),
  },
  {
    ...options,
    description: '账号密码登录请求。无需选择身份，成功后签发访问令牌与刷新令牌。',
    examples: [{ account: '13812345678', password: 'Example123!' }],
  },
);
export const passwordResetSchema = Type.Object(
  {
    phone,
    code,
    newPassword: Type.String({
      ...password,
      description:
        '重置后的新登录密码，8～64 位，必须包含英文字母和数字，字符范围见 pattern；重置成功后全部客户端会话及刷新令牌失效。',
    }),
  },
  {
    ...options,
    description: '验证码重置密码请求。code 必须来自 scene=reset_password；手机号必须已注册。',
    examples: [{ phone: '13812345678', code: '095270', newPassword: 'Changed123!' }],
  },
);
export const refreshSchema = Type.Object(
  {
    refreshToken: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        '登录或上次刷新返回的刷新令牌原值，不能使用 accessToken 替代；刷新成功后原访问/刷新令牌对失效。须与原登录客户端类型一致。',
      examples: ['r'.repeat(43)],
    }),
  },
  {
    ...options,
    description: '刷新访问令牌请求。刷新令牌只能成功轮换一次，请保存本次返回的新令牌对。',
    examples: [{ refreshToken: 'r'.repeat(43) }],
  },
);
export const smsRegisterSchema = Type.Object(
  {
    accountType: Type.Optional(
      stringEnum(['INDIVIDUAL'], '兼容字段，选填且仅接受INDIVIDUAL；账号统一，不决定组织关系。'),
    ),
    roles: Type.Optional(
      Type.Array(role, {
        description: '兼容字段，忽略选择；注册自动拥有NAVIGATOR、PM、EXPERT，不授予OPS。',
      }),
    ),
    password,
    confirmPassword: Type.String({
      minLength: 1,
      maxLength: 64,
      description: '确认密码，必须与 password 完全一致。',
      examples: ['Example123!'],
    }),
    nickname: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          '昵称，选填；省略、空串或仅空白时使用 realName（真实姓名），保存前去除首尾空格；含默认姓名在内的昵称必须唯一，冲突返回409。',
        examples: ['小明'],
      }),
    ),
    realName: Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        '真实姓名，必填；去除首尾空格后须以中文或英文字母开头，后续允许中英文、连字符 - 和间隔号 ·，最多 64 字符，不支持姓名中的空格。',
      examples: ['王小明'],
    }),
    idCardNo: Type.Optional(
      Type.String({
        maxLength: 32,
        description:
          '身份证号，选填；支持 15 位数字或 18 位（末位可为数字或 X），保存时去除首尾空格并将 x 转大写；响应只返回脱敏值。',
        examples: ['11010119900101001X'],
      }),
    ),
    phone,
    code: Type.Optional(code),
    registrationToken: Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9_-]{43}$',
        description:
          '短信登录返回的一次性注册凭证，10 分钟有效，绑定已验证手机号；与 code 必须且只能提交一个。使用此凭证无需重新获取注册验证码，不能用于登录鉴权；示例不可实际使用。',
        examples: ['g'.repeat(43)],
      }),
    ),
    email: Type.Optional(
      Type.String({
        maxLength: 128,
        description:
          '备用邮箱，选填；填写非空值时必须是有效邮箱，保存前去除首尾空格并转小写，也可作为密码登录账号。',
        examples: ['expert@example.com'],
      }),
    ),
  },
  {
    ...options,
    description:
      '统一手机号注册。code与registrationToken必须且只能提交一个；不创建组织，自动拥有NAVIGATOR/PM/EXPERT；成功返回资料，不自动登录。',
    examples: [
      {
        phone: '13812345678',
        code: '095270',
        password: 'Example123!',
        confirmPassword: 'Example123!',
        realName: '王小明',
      },
    ],
  },
);
// 与旧 UserProfileUpdateRequest 一致：null 与省略均不修改，空串清空可清空字段。
const optionalText = (maxLength: number, description: string) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()], { description }));
export const nicknameCheckSchema = Type.Object(
  {
    nickname: Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        '待检查昵称，必填；去除首尾空格后不能为空，最多64字符。按新库精确匹配，不预留昵称。',
      examples: ['小明'],
    }),
  },
  {
    ...options,
    description: '匿名昵称去重查询。无请求体；建议值仅为查询时可用，注册时仍可能冲突。',
    examples: [{ nickname: '小明' }],
  },
);
export const userProfileUpdateSchema = Type.Object(
  {
    avatarUrl: optionalText(
      512,
      '头像地址或文件 objectKey，最多512字符；省略/null保持，空白清空。新上传头像请传上传响应objectKey并同时传avatarUploadToken，服务端认领后保存可展示URL；本人的已认领头像可重复保存。旧外部URL兼容保留，不远程抓取。替换或清空会释放旧头像台账。',
    ),
    avatarUploadToken: optionalText(
      128,
      '头像一次性上传凭证，关联新AVATAR文件时条件必填，使用/files/upload响应的uploadToken；必须本人登录上传。省略/null仅允许保持、清空、旧外部URL或重复保存本人已认领头像。不得单独提交凭证。',
    ),
    bio: optionalText(1000, '个人简介，最多1000字符；省略/null保持，空白清空，保存前trim。'),
    idCardNo: optionalText(
      32,
      '身份证号，15位数字或18位（末位可为X）；trim并转大写。省略/null保持，空白清空未认证号码。已认证仅允许原号码，变更或清空403；响应脱敏。',
    ),
    newPassword: Type.Optional(
      Type.Union([password, Type.Null()], {
        description:
          '新密码，8～64位且含字母与数字，字符范围见pattern；省略/null表示不改。填写时须同时提交相同confirmNewPassword，成功撤销全部客户端会话及刷新令牌。',
      }),
    ),
    confirmNewPassword: optionalText(
      64,
      '确认新密码；修改密码时条件必填且须与newPassword完全一致；未修改时省略/null。',
    ),
    roles: Type.Optional(
      Type.Union(
        [
          Type.Array(role, { minItems: 1, maxItems: 3, description: '旧兼容角色列表，1～3项。' }),
          Type.Null(),
        ],
        {
          description:
            '旧兼容角色列表；省略/null保持。已知值NAVIGATOR=领航员、PM=策略官、EXPERT=执行专家、OPS=运营均忽略，不改变注册自带的三角色，也不改变当前会话角色；OPS不会被授予。',
        },
      ),
    ),
  },
  {
    ...options,
    description:
      '仅更新当前会话本人；未传/null保持，空串可清空头像/简介/未认证证件。无昵称、姓名、邮箱或目标用户ID字段。空对象可用；密码更新撤销全部会话。',
    examples: [
      {
        avatarUrl: 'https://example.com/avatar.png',
        bio: '数据标注专家',
        idCardNo: '11010119900101001X',
        roles: ['EXPERT'],
      },
      { newPassword: 'Changed123!', confirmNewPassword: 'Changed123!' },
      { avatarUrl: 'avatar/2026/10/21/example.png', avatarUploadToken: 'a'.repeat(43) },
      { avatarUrl: '', bio: '', idCardNo: '' },
    ],
  },
);
export type UserProfileUpdateInput = Static<typeof userProfileUpdateSchema>;
export interface NicknameCheckResult {
  nickname: string;
  available: boolean;
  suggestion: string;
  message: string;
}
export type SmsSendInput = Static<typeof smsSendSchema>;
export type SmsLoginInput = Static<typeof smsLoginSchema>;
export type LoginInput = Static<typeof loginSchema>;
export type SmsRegisterInput = Static<typeof smsRegisterSchema>;
export type PasswordResetInput = Static<typeof passwordResetSchema>;
export interface RegistrationRequired {
  status: 'registration_required';
  registrationToken: string;
  expiresAt: string;
}
export type SmsLoginResponse = LoginResponse | RegistrationRequired;
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
export interface Result<T> {
  code: number;
  message: string;
  data: T;
}
export interface AuthUser {
  id: string;
  uid: string;
  accountType: 'INDIVIDUAL' | 'ORGANIZATION';
  phone: string;
  nickname: string;
  realName: string;
  idCardNo: string | null;
  idVerified: number;
  avatarUrl: string | null;
  bio: string | null;
  role: BusinessRole;
  roles: BusinessRole[];
  selectedRole: BusinessRole | null;
  hasExpertManagementRole: boolean;
  status: string;
  creditScore: number;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  organization: Record<string, unknown> | null;
  organizations?: {
    id: string;
    name: string;
    position: string;
    joinStatus: string;
    status: string;
    verifyStatus: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

export const BUSINESS_ROLES = ['NAVIGATOR', 'PM', 'EXPERT'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];
export const switchRoleSchema = Type.Object(
  {
    role: stringEnum(
      BUSINESS_ROLES,
      '目标会话角色，必填：NAVIGATOR=领航员、PM=策略官、EXPERT=执行专家；不支持OPS。',
    ),
  },
  {
    ...options,
    description: '只切换当前有效会话，不更换令牌、不影响其他会话。',
    examples: [{ role: 'EXPERT' }],
  },
);
export const organizationCreateSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 128,
      description: '组织名称，必填；去除首尾空格后不能为空，名称不能与已有组织重复。',
      examples: ['示例标注团队'],
    }),
    unifiedCreditCode: Type.Optional(
      Type.String({
        maxLength: 32,
        description: '统一社会信用代码，选填；非空值不能与已有组织重复。',
        examples: ['EXAMPLE_CREDIT_CODE'],
      }),
    ),
    businessLicense: Type.Optional(
      Type.Object(
        {
          objectKey: Type.String({
            minLength: 1,
            maxLength: 512,
            description:
              '文件上传登记的营业执照对象存储 Key，不能提交可访问 URL；须与 uploadToken 对应。先通过 POST /files/upload 且 bizType=BUSINESS_LICENSE 上传。',
            examples: ['business-license/example.jpg'],
          }),
          uploadToken: Type.String({
            minLength: 1,
            maxLength: 256,
            description:
              '文件上传接口返回的一次性认领凭证，须与 objectKey 对应；示例仅作字段说明，不能用于实际认领。',
            examples: ['example-upload-token'],
          }),
        },
        {
          ...options,
          description:
            '营业执照上传凭证，选填。仅接受 BUSINESS_LICENSE 登记对象及其一次性 uploadToken；默认 24 小时内认领（可配置），重复/过期 HTTP 409，错误凭证 HTTP 403，无登记对象 HTTP 400。认领与组织创建同事务；存储未配置或不可达时 HTTP 503。',
        },
      ),
    ),
    description: Type.Optional(
      Type.String({
        maxLength: 1024,
        description: '组织简介，选填，最多 1024 字符。',
        examples: ['提供数据标注与质量检查服务。'],
      }),
    ),
    logoUrl: Type.Optional(
      Type.String({
        maxLength: 512,
        description:
          '组织 Logo 图片地址或 ORG_LOGO objectKey，选填。新上传图片提交objectKey及logoUploadToken，服务端校验本人上传并在创建事务中认领，保存可展示URL；旧外部HTTPS地址兼容保留。该字段不用于营业执照等敏感文件。',
        examples: ['https://example.com/logo.png'],
      }),
    ),
    logoUploadToken: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          '新上传组织Logo的一次性凭证，与logoUrl=objectKey一起提交；来自登录后bizType=ORG_LOGO的图片上传。仅在内存保存，不用于图片查看；错误或他人凭证403，过期或已被其他组织认领409。',
        examples: ['example-upload-token'],
      }),
    ),
    expertiseTags: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: '单个擅长领域标签，1～128 字符。',
          examples: ['图像标注'],
        }),
        {
          description:
            '组织擅长领域标签列表，选填，可多选；省略时保存为空列表。当前实现未要求至少选择一个。',
          examples: [['图像标注', '文本审核']],
        },
      ),
    ),
  },
  {
    ...options,
    description:
      '组织创建资料。登录且当前角色为EXPERT时提交；创建即ACTIVE/APPROVED，本人固定OWNER，不限制本人已有组织数量。',
    examples: [
      {
        name: '示例标注团队',
        unifiedCreditCode: 'EXAMPLE_CREDIT_CODE',
        description: '提供数据标注服务。',
        logoUrl: 'https://example.com/logo.png',
        expertiseTags: ['图像标注'],
      },
      {
        name: '图片示例团队',
        logoUrl: 'org-logo/2026/10/23/example.png',
        logoUploadToken: 'example-upload-token',
      },
    ],
  },
);
export type OrganizationCreateInput = Static<typeof organizationCreateSchema>;
