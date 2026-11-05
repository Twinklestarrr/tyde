import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { examConfigExample, examConfigSchema } from './exam-config.schema.js';
export const attachmentRefSchema = {
  type: 'object',
  description: '通过模板附件名称匹配的本人预上传文件；不会在解析阶段认领。',
  additionalProperties: false,
  required: ['name', 'objectKey', 'uploadToken'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: '模板引用名，去首尾空白后唯一，区分大小写；不是OSS对象Key。',
    },
    objectKey: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: '已通过ENTRANCE_EXAM_ATTACHMENT业务上传的对象Key。',
    },
    uploadToken: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: '本人未认领且未过期文件的一次性上传凭证；本次仅检查，不消费。',
    },
  },
};
const preview = {
  ...examConfigExample,
  registrationDeadline: null,
  decisionRule: null,
  tieBreakRule: null,
  gradingRounds: [],
};
export const examImportSchema: FastifySchema = {
  operationId: 'parseEntranceExamImport',
  tags: ['EntranceExam'],
  summary: '解析试卷文件或远程文档',
  description:
    '须有效会话、当前PM角色及已发布项目当前生效策略官。multipart/form-data，projectId可用表单或query，同名值冲突拒绝；file与非空redocUrl必须且仅有一个。file仅XLS/XLSX/TXT，最多10MiB；TXT须UTF-8、最多100万字符，支持固定模板/简化表头/逐题文本。XLSX先限制ZIP实际解压32MiB/1000条目，公式/合并单元格拒绝；支持单元格锚定图片，XLS旧式图片/嵌入对象明确拒绝，可另存XLSX或预上传。最多20卷、每卷200题、100个附件，每题每类20个，总附件50MiB。先校验所有引用/图片再预上传图片，仅回显配置，不创建考试或认领附件；后续上传失败时此前成功预上传保留至过期清理。REDoc远程来源未接入，返回503，不访问用户URL。Web使用Cookie并校验来源，桌面/普通API客户端用Bearer，不混用。',
  security: [{ webSession: [] }, { desktopSession: [] }],
  consumes: ['multipart/form-data'],
  querystring: {
    type: 'object',
    description: '可选项目ID/远程来源查询参数；同名表单值须一致。',
    additionalProperties: false,
    properties: {
      projectId: {
        type: 'string',
        pattern: '^[1-9][0-9]{0,9}$',
        description: '项目32位正整数ID；query或表单至少提供一次。',
      },
      redocUrl: {
        type: 'string',
        maxLength: 500,
        description:
          '可选远程文档URL，最多500字符，空白视为未提供；当前远程来源未接入，提供有效来源选择后返回503。',
      },
    },
  },
  body: {
    type: 'object',
    description: '导入表单，attachmentRefs为application/json数组part；文件顺序不限。',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      projectId: {
        type: 'string',
        pattern: '^[1-9][0-9]{0,9}$',
        description: '必填项目ID字符串（可由query合并），32位正整数。',
      },
      file: {
        type: 'string',
        format: 'binary',
        description: '可选XLS/XLSX/TXT文件part，字段名file；与非空redocUrl互斥且二选一。',
      },
      redocUrl: {
        type: 'string',
        maxLength: 500,
        description: '可选远程文档URL，与file二选一；当前未接入，返回503。',
      },
      attachmentRefs: {
        type: 'array',
        maxItems: 100,
        description: '可选application/json数组part，通过名称匹配预上传凭证；最多100项，省略为空。',
        items: attachmentRefSchema,
      },
    },
    examples: [
      { projectId: '3001', file: 'exam.txt', attachmentRefs: [] },
      { projectId: '3001', redocUrl: 'https://documents.example/doc/example', attachmentRefs: [] },
    ],
  },
  response: {
    200: resultSchema({
      type: 'object',
      description: '仅解析回显，需补截止时间/裁决和判卷轮次等后调用保存入口。',
      additionalProperties: false,
      required: ['formatVersion', 'sourceType', 'config'],
      properties: {
        formatVersion: { type: 'string', enum: ['1'], description: '解析输出格式版本，固定1。' },
        sourceType: {
          type: 'string',
          enum: ['EXCEL', 'TXT'],
          description: 'EXCEL=XLS/XLSX文件；TXT=UTF-8文本。远程文档未接入，不会伪造REDOC成功。',
        },
        config: examConfigSchema,
      },
      examples: [{ formatVersion: '1', sourceType: 'TXT', config: preview }],
    }),
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 500, 503].map((code) => [
        code,
        {
          ...resultSchema({ type: 'null', description: '失败时数据固定null。' }),
          description: `${code}：格式/凭证/项目关系不合法、未登录、文件已认领/过期、超出大小限制或服务未接入/不可用。`,
          examples: [{ code, message: '解析失败', data: null }],
        },
      ]),
    ),
  },
} satisfies FastifySchema;
