import { examFileSchema } from './exam-config.schema.js';
import type { FastifySchema } from 'fastify';
import { resultSchema } from '../auth/auth.schema.js';
import { examFileSnapshots } from './exam-query.schema.js';
const id = (description: string) => ({
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description,
});
const text = (description: string, nullable = false) => ({
  type: 'string',
  description,
  ...(nullable ? { nullable: true } : {}),
});
export const candidatePaperExample = {
  projectId: 1,
  attemptId: 1,
  examId: 1,
  examVersionId: 1,
  paperId: 1,
  examName: '准入考试',
  paperName: '试卷一',
  durationMinutes: 60,
  fullScore: 20,
  enteredAt: '2026-10-23 14:00:00',
  answerDeadlineAt: '2026-10-23 15:00:00',
  questions: [
    {
      questionId: 1,
      sequenceNo: 1,
      questionContent: '请描述质检流程。',
      questionFiles: null,
      requiredFlag: true,
      score: 20,
    },
  ],
};
const question = {
  type: 'object',
  additionalProperties: false,
  description: '考生实际试卷题目，仅返回题干与分值。',
  required: [
    'questionId',
    'sequenceNo',
    'questionContent',
    'questionFiles',
    'requiredFlag',
    'score',
  ],
  properties: {
    questionId: id('题目ID，交卷必须属于本应试绑定试卷。'),
    sequenceNo: id('题目序号，从1开始。'),
    questionContent: text('题干富文本；仅附件题可为null。', true),
    questionFiles: examFileSnapshots,
    requiredFlag: { type: 'boolean', description: 'true=必答，false=选答。' },
    score: { type: 'number', minimum: 0, description: '本题分值，最多两位小数。' },
  },
};
const paper = {
  type: 'object',
  additionalProperties: false,
  description: '首次随机绑定的版本和试卷，重复入场保持不变，不包含参考答案或阅卷配置。',
  required: Object.keys(candidatePaperExample),
  properties: {
    projectId: id('项目ID。'),
    attemptId: id('本人的应试ID；取消或交卷后不可重考。'),
    examId: id('服务端随机分配的考试ID。'),
    examVersionId: id('首次进入时绑定的历史配置版本ID。'),
    paperId: id('首次进入时随机绑定的试卷ID。'),
    examName: text('绑定版本考试名称快照，不随考试编辑变化。'),
    paperName: text('试卷名称；未配置为null。', true),
    durationMinutes: {
      type: 'integer',
      minimum: 1,
      nullable: true,
      description: '答题时限，单位分钟；null=不限时。',
    },
    fullScore: { type: 'number', minimum: 0, description: '绑定版本的满分，最多两位小数。' },
    enteredAt: text('首次进入时间，上海时区yyyy-MM-dd HH:mm:ss。'),
    answerDeadlineAt: text('个人答题截止时间，上海时区yyyy-MM-dd HH:mm:ss；不限时为null。', true),
    questions: {
      type: 'array',
      minItems: 1,
      description: '按题号升序排列的固定试卷题目；参考答案及附件不返回。',
      items: question,
    },
  },
  examples: [candidatePaperExample],
};
const candidateFailures = Object.fromEntries(
  Object.entries({
    400: '请求字段、诚信承诺、答卷完整性或当前考试状态不允许此操作。',
    401: '未登录或会话已失效。',
    403: '当前角色、接单身份、文件凭证或请求来源无权限。',
    404: '项目、考试或本人应试记录不存在。',
    409: '答卷已提交，或文件已认领/凭证过期。',
    413: '请求体超过服务端大小限制。',
    500: '绑定试卷、版本或轮次异常，或内部处理失败。',
    503: '转项来源未接入或数据库/文件存储暂不可用。',
  }).map(([status, description]) => [
    status,
    {
      ...resultSchema({ type: 'null', description: '失败时没有业务数据，固定null。' }),
      description: `HTTP ${status}，业务码${status}：${description}`,
      examples: [{ code: Number(status), message: description, data: null }],
    },
  ]),
);
export function candidateSchema(enter: boolean): FastifySchema {
  return {
    tags: ['执行专家准入考试'],
    summary: enter ? '进入准入考试' : '查询当前执行专家的准入考试通过状态',
    operationId: enter ? 'entranceExamCandidateEnter' : 'entranceExamCandidateCurrent',
    description:
      '仅当前EXPERT及真实有效接单资格；有效组织身份优先，单纯主管、待响应和离组成员无应试资格。首次入场需笔试计划及未截止ACTIVE考试；已入场可在关闭或编辑后按原卷恢复，个人截止时间仍有效。转项来源由12任务接入。',
    security: [{ desktopSession: [] }, { webSession: [] }],
    ...(enter
      ? {
          body: {
            type: 'object',
            additionalProperties: false,
            description: '只传项目ID，由服务端分配考试和试卷。',
            required: ['projectId'],
            properties: { projectId: id('项目ID，32位正整数，必填。') },
            examples: [{ projectId: 1 }],
          },
        }
      : {
          querystring: {
            type: 'object',
            additionalProperties: false,
            description: '本人项目考试状态查询。',
            required: ['projectId'],
            properties: {
              projectId: {
                type: 'string',
                pattern: '^[1-9][0-9]{0,9}$',
                description: '项目ID，十进制32位正整数，必填。',
                examples: ['1'],
              },
            },
          },
        }),
    response: {
      ...candidateFailures,
      200: resultSchema(
        enter
          ? paper
          : {
              type: 'object',
              additionalProperties: false,
              description: '聚合本人在项目所有未删除考试的应试记录。免试不伪造PASSED。',
              required: ['projectId', 'status'],
              properties: {
                projectId: id('项目ID。'),
                status: {
                  type: 'string',
                  enum: ['PASSED', 'PENDING', 'NOT_PASSED', 'NOT_EXAMINED'],
                  description:
                    '按顺序聚合：PASSED=任一场已录取；PENDING=未录取但有待阅卷；NOT_PASSED=进入过但无上述结果（含答题中和取消）；NOT_EXAMINED=从未进入。',
                },
              },
              examples: [{ projectId: 1, status: 'NOT_EXAMINED' }],
            },
      ),
    },
  };
}

export const candidateSubmitExample = {
  attemptId: 1,
  answerCount: 1,
  gradingRoundCount: 2,
  gradingStatus: 'PENDING',
  submittedAt: '2026-10-23 14:30:00',
};
export const candidateCancelExample = { attemptId: 1, cancelledAt: '2026-10-23 14:30:00' };
export function candidateCommandSchema(submit: boolean): FastifySchema {
  const example = submit ? candidateSubmitExample : candidateCancelExample;
  return {
    tags: ['执行专家准入考试'],
    summary: submit ? '提交准入考试答卷' : '取消准入考试并离场',
    operationId: submit ? 'entranceExamCandidateSubmit' : 'entranceExamCandidateCancel',
    description:
      '仅当前EXPERT及有效原绑定接单身份；不允许换绑、重考或重复操作。交卷使用入场绑定历史版本，关闭或编辑不影响已入场交卷；个人答题截止后拒绝交卷但允许取消。交卷一次保存全卷，必答题须有文字或附件；所有轮次预建，首轮PENDING、后续WAITING。AUTO仅mock派发，实际投递归14，转项来源归12。取消不保存临时答案，不创建阅卷或入项成员。',
    security: [{ desktopSession: [] }, { webSession: [] }],
    body: {
      type: 'object',
      additionalProperties: false,
      description: submit
        ? '一次性完整交卷，请求体最多2MiB（UTF-8字节数）；选答题可省略，仍保存空答案。'
        : '本人应试记录取消请求。',
      required: submit
        ? ['projectId', 'attemptId', 'integritySigned', 'answers']
        : ['projectId', 'attemptId'],
      properties: {
        projectId: id('必填项目ID，32位正整数。'),
        attemptId: id('必填本人已入场的应试ID，须属于该项目。'),
        ...(submit
          ? {
              integritySigned: {
                type: 'boolean',
                description: '必填诚信承诺；仅true允许交卷，签署时间由服务端记录。',
              },
              answers: {
                type: 'array',
                maxItems: 500,
                description: '必填逐题答案，最多500题；未知或重复题目拒绝，遗漏必答题拒绝。',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  description: '本次绑定试卷的一道题答案。',
                  required: ['questionId'],
                  properties: {
                    questionId: id('必填绑定试卷题目ID。'),
                    answerContent: {
                      ...text(
                        '文字答案，最多100000字符；省略/null/空白为未填写，可仅上传附件。',
                        true,
                      ),
                      maxLength: 100000,
                    },
                    answerFiles: {
                      type: 'array',
                      nullable: true,
                      maxItems: 10,
                      description:
                        '新上传答案附件，每题最多10个；省略/null/空数组表示无附件。同卷不得重复文件，只信任服务端台账元数据。',
                      items: {
                        ...examFileSchema,
                        description:
                          '仅允许本人ENTRANCE_EXAM_ATTACHMENT新上传文件；objectKey及uploadToken必填，uploadedFileId须省略或null，禁止复用参考答案或其他考生附件。',
                        required: ['objectKey', 'uploadToken'],
                        properties: {
                          ...examFileSchema.properties,
                          uploadToken: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 128,
                            description: '本人新上传附件的一次性凭证，必填。',
                          },
                        },
                      },
                    },
                  },
                },
              },
            }
          : {}),
      },
      examples: [
        submit
          ? {
              projectId: 1,
              attemptId: 1,
              integritySigned: true,
              answers: [
                { questionId: 1, answerContent: '先核验数据，再记录质检结果。', answerFiles: [] },
              ],
            }
          : { projectId: 1, attemptId: 1 },
      ],
    },
    response: {
      ...candidateFailures,
      200: resultSchema({
        type: 'object',
        additionalProperties: false,
        description: submit
          ? '已持久化交卷及阅卷任务，不表示已完成判卷。'
          : '已取消并离场，不能再次进入。',
        required: Object.keys(example),
        properties: {
          attemptId: id('本人应试ID。'),
          ...(submit
            ? {
                answerCount: {
                  type: 'integer',
                  minimum: 1,
                  description: '保存的全卷题数，含未作答选答题。',
                },
                gradingRoundCount: {
                  type: 'integer',
                  minimum: 1,
                  description: '原绑定版本预建阅卷轮次数。',
                },
                gradingStatus: {
                  type: 'string',
                  enum: ['PENDING'],
                  description: 'PENDING=等待首轮阅卷；不代表通过或已入项。',
                },
                submittedAt: text('交卷及诚信签署时间，上海时区yyyy-MM-dd HH:mm:ss。'),
              }
            : { cancelledAt: text('取消时间，上海时区yyyy-MM-dd HH:mm:ss。') }),
        },
        examples: [example],
      }),
    },
  };
}
