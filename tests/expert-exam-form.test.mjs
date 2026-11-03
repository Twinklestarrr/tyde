import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidatePaperExample } from '../apps/server/src/modules/entrance-exams/exam-candidate.schema.ts';
import {
  expertExamDeadline,
  expertExamSubmission,
} from '../apps/web/src/modules/projects/expert-exam-form.ts';

const paper = {
  ...candidatePaperExample,
  questions: [
    candidatePaperExample.questions[0],
    { ...candidatePaperExample.questions[0], questionId: 2, sequenceNo: 2, requiredFlag: false },
  ],
};
const readyFile = {
  key: 'answer',
  name: '作答.pdf',
  size: 20,
  status: 'ready',
  reference: { objectKey: 'entrance-exam-attachment/answer.pdf', uploadToken: 'one-use-token' },
};

test('expert exam requires text or a ready attachment for required questions, optional questions may stay empty', () => {
  assert.match(expertExamSubmission(paper, {}, true).errors[1], /填写本题答案或上传/);
  const answers = { 1: { text: '  独立作答  ', files: [] } };
  const result = expertExamSubmission(paper, answers, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.input, {
    projectId: paper.projectId,
    attemptId: paper.attemptId,
    integritySigned: true,
    answers: [
      { questionId: 1, answerContent: '独立作答', answerFiles: [] },
      { questionId: 2, answerContent: '', answerFiles: [] },
    ],
  });
  assert.equal(answers[1].text, '  独立作答  ');
  const attachmentOnly = expertExamSubmission(
    paper,
    { 1: { text: ' ', files: [readyFile] } },
    true,
  );
  assert.deepEqual(attachmentOnly.errors, {});
  assert.deepEqual(attachmentOnly.input.answers[0].answerFiles, [readyFile.reference]);
});

test('expert exam blocks incomplete uploads, missing one-use tokens, unsigned integrity and overlong answers', () => {
  for (const file of [
    { ...readyFile, status: 'uploading' },
    { ...readyFile, status: 'failed' },
    { ...readyFile, reference: { objectKey: readyFile.reference.objectKey } },
  ]) {
    const result = expertExamSubmission(paper, { 1: { text: '答案', files: [file] } }, false);
    assert.match(result.errors[1], /完成附件上传/);
    assert.match(result.errors.integrity, /独立作答承诺/);
  }
  assert.match(
    expertExamSubmission(paper, { 1: { text: 'a'.repeat(100001), files: [] } }, true).errors[1],
    /100000/,
  );
  assert.deepEqual(
    expertExamSubmission(paper, { 1: { text: 'a'.repeat(100000), files: [] } }, true).errors,
    {},
  );
});

test('expert exam enforces the full 2 MiB UTF-8 answer body including JSON overhead', () => {
  const largePaper = {
    ...paper,
    questions: Array.from({ length: 8 }, (_, index) => ({
      ...paper.questions[0],
      questionId: index + 1,
      sequenceNo: index + 1,
    })),
  };
  const answers = Object.fromEntries(
    largePaper.questions.map((question) => [
      question.questionId,
      { text: question.questionId < 8 ? '中'.repeat(90000) : '', files: [] },
    ]),
  );
  const overhead = Buffer.byteLength(
    JSON.stringify(expertExamSubmission(largePaper, answers, true).input),
  );
  const remaining = 2 * 1024 * 1024 - overhead;
  answers[8].text = '中'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3);
  assert.ok(answers[8].text.length <= 100000);
  const exact = expertExamSubmission(largePaper, answers, true);
  assert.equal(Buffer.byteLength(JSON.stringify(exact.input)), 2 * 1024 * 1024);
  assert.deepEqual(exact.errors, {});
  answers[8].text += '中';
  assert.match(expertExamSubmission(largePaper, answers, true).errors.form, /2 MiB/);
});

test('expert exam deadlines interpret server wall-clock times in Shanghai regardless of browser timezone', () => {
  assert.equal(expertExamDeadline(null), null);
  assert.equal(expertExamDeadline('2026-11-03 08:30:00'), Date.parse('2026-11-03T00:30:00Z'));
  assert.equal(expertExamDeadline('2026-11-03 00:00:00'), Date.parse('2026-11-02T16:00:00Z'));
});
