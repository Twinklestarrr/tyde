import {
  ENTRANCE_EXAM_ANSWER_MAX_BYTES,
  type EntranceExamCandidatePaper,
  type EntranceExamCandidateSubmitInput,
} from '@tyde/shared';
import type { ExamDraftFile } from './entrance-exam-form';

export interface ExpertExamAnswer {
  text: string;
  files: ExamDraftFile[];
}

/** 临时答案只保存在当前页面内存；整卷一次提交，不冒充服务端自动保存。 */
export function expertExamSubmission(
  paper: EntranceExamCandidatePaper,
  answers: Record<number, ExpertExamAnswer>,
  integritySigned: boolean,
) {
  const errors: Record<string, string> = {};
  const input: EntranceExamCandidateSubmitInput = {
    projectId: paper.projectId,
    attemptId: paper.attemptId,
    integritySigned: true,
    answers: paper.questions.map((question) => {
      const answer = answers[question.questionId] ?? { text: '', files: [] };
      const content = answer.text.trim();
      if (answer.files.some((file) => file.status !== 'ready' || !file.reference?.uploadToken))
        errors[question.questionId] = '请完成附件上传，或移除上传失败的附件。';
      else if (content.length > 100000)
        errors[question.questionId] = '每题答案不能超过100000个字符。';
      else if (question.requiredFlag && !content && !answer.files.length)
        errors[question.questionId] = '请填写本题答案或上传答案附件。';
      return {
        questionId: question.questionId,
        answerContent: content,
        answerFiles: answer.files.flatMap((file) =>
          file.reference?.uploadToken
            ? [{ objectKey: file.reference.objectKey, uploadToken: file.reference.uploadToken }]
            : [],
        ),
      };
    }),
  };
  if (!integritySigned) errors.integrity = '请先确认独立作答承诺。';
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > ENTRANCE_EXAM_ANSWER_MAX_BYTES)
    errors.form = '整份答卷超过2 MiB，请减少文字内容后再提交。';
  return { input, errors };
}

/** 后端为上海墙钟时间，不能按浏览器所在时区解释截止时间。 */
export function expertExamDeadline(value: string | null) {
  return value === null ? null : Date.parse(`${value.replace(' ', 'T')}+08:00`);
}
