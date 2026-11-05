import type { FastifySchema } from 'fastify';
import {
  gradingSubmitExample,
  manualGradingExample,
  manualGradingSchema,
} from './exam-grading-command.schema.js';
const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
const text = (description: string, maxLength: number) => ({
  type: 'string',
  nullable: true,
  maxLength,
  description,
});
const manualBody = manualGradingSchema.body as { properties: Record<string, object> };
const items = manualBody.properties.items;
const result = structuredClone(manualGradingSchema.response) as Record<
  number,
  {
    properties: { data: { properties: Record<string, object> } };
    examples?: unknown[];
    description: string;
  }
>;
const data = result[200]!.properties.data;
Object.assign(data.properties.recordStatus!, {
  enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
  description:
    '本轮状态：PENDING待执行、PROCESSING模拟执行中、COMPLETED完成、FAILED失败待重试；WAITING不可操作。',
});
Object.assign(data.properties.score!, {
  nullable: true,
  description: '服务端累计正确题得分，0保留；待执行或失败为null，不信任Agent自报分数。',
});
Object.assign(data.properties.roundResult!, {
  enum: ['ADMITTED', 'ELIMINATED', null],
  nullable: true,
  description: '本轮票ADMITTED准入、ELIMINATED淘汰；待执行或失败为null。',
});
Object.assign(data.properties.gradingStatus!, {
  enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'],
  description:
    '整体状态：PENDING待重试执行，IN_PROGRESS轮次尚未全部完成，COMPLETED全部完成并裁决。',
});
result[200]!.description = '自动阅卷状态及必要副作用同事务提交，结果可能待执行、失败或完成。';
result[403]!.description =
  '当前会话不是PM生效主策略官；招募协作负责人和NAVIGATOR仅有读取资格，不能重试或补偿。';
result[400]!.description =
  '轮次、交卷、逐题来源或状态不符；不可逆入项/转项结论不允许反转，所有写入回滚。';
result[409]!.description = '当前执行trace失效、重复回调内容变化、下一轮状态或准入来源发生冲突。';
const locator = {
  projectId: id('项目ID，须为已发布项目。'),
  examId: id('考试ID，允许历史版本及已关闭考试。'),
  gradingRecordId: id('目标自动判卷记录ID，必须属于该考试。'),
};
const retryExample = { projectId: 3001, examId: 5001, gradingRecordId: 10001 };
export const compensateExample = {
  ...retryExample,
  summary: '模拟结果经人工校正',
  compensationReason: '复核答案',
  items: manualGradingExample.items,
};
export const callbackExample = {
  projectId: 3001,
  attemptId: 11001,
  examVersionId: 6001,
  paperId: 7001,
  roundNo: 1,
  gradingRecordId: 10001,
  toolTraceId: 'mock-execution-trace',
  status: 'SUCCEEDED',
  summary: '模拟来源：可控mock执行完成',
  items: manualGradingExample.items,
  errorCode: null,
  errorMessage: null,
};
const base = { tags: ['准入考试阅卷'], response: result };
export const autoRetrySchema: FastifySchema = {
  ...base,
  operationId: 'retryEntranceExamAutoGrading',
  summary: '重新执行自动阅卷（mock）',
  description:
    '仅当前PM生效主策略官可将FAILED自动轮恢复PENDING；清空trace、回调摘要、逐题临时判定及执行汇总，旧执行回调失效。已交卷且前轮全部完成，同事务消解失败待办并写mock待派发事实。由显式本地mock命令领取，不调用真实Agent。',
  body: {
    type: 'object',
    additionalProperties: false,
    description: '定位待重试失败自动轮，不接受应试ID或客户端身份扩权。',
    required: Object.keys(locator),
    properties: locator,
    examples: [retryExample],
  },
  response: {
    ...result,
    200: {
      ...result[200],
      examples: [
        {
          code: 200,
          message: '操作成功',
          data: {
            ...gradingSubmitExample,
            recordStatus: 'PENDING',
            score: null,
            roundResult: null,
            gradingStatus: 'PENDING',
            finalResult: 'PENDING',
          },
        },
      ],
    },
  },
};
export const autoCompensateSchema: FastifySchema = {
  ...base,
  operationId: 'compensateEntranceExamAutoGrading',
  summary: '人工补偿自动阅卷结果（mock来源）',
  description:
    '仅当前PM生效主策略官可补偿FAILED或COMPLETED自动轮。覆盖完整实际试卷判定，由服务器计分并重新按绑定版本投票；FAILED补偿才激活紧接下一轮，COMPLETED修正不重复激活。清空trace使旧回调失效；转项结论不允许反转，已进入人员入项流程的准入不得改为淘汰，可逆PENDING_CONFIRM成员同事务撤销。保存补偿原因审计，事件实际投递及跨领域卡片重算待回补。',
  body: {
    type: 'object',
    additionalProperties: false,
    description: '完整人工补偿，所有判定须来自该考生实际试卷。',
    required: [...Object.keys(locator), 'items'],
    properties: {
      ...locator,
      items,
      summary: text('本轮总结，省略/null/空白按得分生成，最多5000字。', 5000),
      compensationReason: text(
        '补偿原因，省略/null/空白记录null，其余去首尾空白，最多1000字；用于审计。',
        1000,
      ),
    },
    examples: [compensateExample],
  },
};
export const autoCallbackSchema: FastifySchema = {
  ...base,
  response: {
    ...result,
    401: {
      ...result[401],
      description: '专用HMAC无效、缺失或时间超出±300秒；用户会话不代替签名。',
    },
    403: { ...result[403], description: '请求携带不可信浏览器来源。' },
  },
  security: [],
  operationId: 'callbackEntranceExamAutoGrading',
  summary: '自动阅卷结果回调（专用HMAC，mock来源）',
  description:
    '无需用户登录，必须按原始UTF-8请求体验专用HMAC-SHA256。规范串POST\\n/api/v1/integrations/agents/entrance-exam-grading/callback\\n时间戳\\nBase64(SHA256(原始体))，签名为Base64(HMAC-SHA256(专用密钥,规范串))。时间窗口±300秒，先验签再解析。仅当前PROCESSING trace可首次提交；相同trace相同规范化内容幂等，变化内容409，重试/补偿后的旧trace拒绝。SUCCEEDED完整逐题判定由服务器计分，FAILED不开放后轮。当前仅mock执行，不连接真实Agent。',
  headers: {
    type: 'object',
    description: '服务间鉴权头，用户Cookie/Bearer不能代替。',
    required: ['x-agent-timestamp', 'x-agent-signature'],
    properties: {
      'x-agent-timestamp': {
        type: 'string',
        pattern: '^\\d{1,12}$',
        description: 'Unix秒时间戳，与服务器时间相差不超过300秒。',
      },
      'x-agent-signature': {
        type: 'string',
        description: '专用密钥HMAC-SHA256的Base64签名，覆盖方法、固定路径、时间及原始体。',
      },
    },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    description: '当前mock执行结果，定位字段均与数据库交叉验证，非真实Agent验收。',
    required: [
      'projectId',
      'attemptId',
      'examVersionId',
      'paperId',
      'roundNo',
      'gradingRecordId',
      'toolTraceId',
      'status',
    ],
    properties: {
      projectId: locator.projectId,
      attemptId: id('已交卷应试ID。'),
      examVersionId: id('考生绑定的历史版本ID，不能使用当前版本替换。'),
      paperId: id('考生实际答卷试卷ID。'),
      roundNo: id('绑定版本的自动轮序号，从1开始。'),
      gradingRecordId: locator.gradingRecordId,
      toolTraceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: '领取时生成的当前执行trace；重试后旧值失效，人工补偿后清空。',
      },
      status: {
        type: 'string',
        enum: ['SUCCEEDED', 'FAILED'],
        description: 'SUCCEEDED成功且items必填完整题目集合；FAILED失败不计分、不激活后轮。',
      },
      items: {
        ...items,
        nullable: true,
        description: '成功时条件必填：实际试卷全部逐题判定；失败时必须省略或null，不应用逐题结果。',
      },
      summary: text(
        '本轮总结，最多5000字；成功省略/null/空白按得分生成，幂等比较去首尾空白。',
        5000,
      ),
      errorCode: text('失败原因码，最多64字符，省略/null/空白无错误码；纳入幂等比较。', 64),
      errorMessage: text(
        '失败说明，最多1000字；省略/null/空白使用模拟失败提示，纳入幂等比较。',
        1000,
      ),
    },
    examples: [
      callbackExample,
      {
        ...callbackExample,
        status: 'FAILED',
        items: null,
        summary: null,
        errorCode: 'MOCK_FAILURE',
        errorMessage: '可控模拟执行失败',
      },
    ],
  },
};
