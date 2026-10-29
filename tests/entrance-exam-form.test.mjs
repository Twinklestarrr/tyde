import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  entranceExamConfigurationValues,
  entranceExamImportedValues,
  entranceExamInput,
  examAllFiles,
  examPaperScores,
  examScoreCents,
  examShanghaiTime,
  newEntranceExam,
  newExamPaper,
  newExamQuestion,
  newExamRound,
} from '../apps/web/src/modules/projects/entrance-exam-form.ts';

const reviewer = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const now = new Date('2026-10-27T16:00:00Z');
function valid() {
  const values = newEntranceExam('示例项目');
  values.durationMinutes = '30';
  values.registrationDeadline = '2099-01-01T18:00:00';
  values.papers[0].questions[0].questionContent = '逐条说明判断依据';
  values.gradingRounds[0].reviewerUserIds = [reviewer];
  return values;
}
const input = (values, options = {}) => entranceExamInput(7, values, { now, ...options });
function configuration() {
  return {
    projectId: 7,
    examId: 11,
    examNo: 'EX-11',
    status: 'ACTIVE',
    currentVersionId: 12,
    versionNo: 2,
    examName: '已有考试',
    durationMinutes: null,
    registrationDeadline: '2099-01-01 18:00:00',
    fullScore: 100,
    passScore: 60,
    decisionRule: 'MAJORITY',
    tieBreakRule: null,
    papers: [
      {
        paperId: 13,
        sequenceNo: 1,
        paperName: '原试卷',
        totalScore: 100,
        questions: [
          {
            questionId: 14,
            sequenceNo: 1,
            questionContent: '<p>原题干</p>',
            requiredFlag: true,
            score: 100,
            scoreSource: 'MANUAL',
            referenceAnswer: '原参考答案',
            referenceFiles: null,
            questionFiles: [
              {
                uploadedFileId: fileId,
                objectKey: 'exam/original.txt',
                fileName: '原文件.txt',
                fileSize: 123,
                extension: 'txt',
                contentType: 'text/plain',
                fileHash: null,
                extra: 'legacy',
              },
            ],
          },
        ],
      },
    ],
    gradingRounds: [
      {
        gradingRoundId: 15,
        roundNo: 1,
        gradingMode: 'MANUAL',
        toolCode: null,
        toolName: null,
        toolConfig: null,
        toolFiles: null,
        reviewers: [{ userId: reviewer, uid: 'R001', name: '原阅卷人', extra: true }],
      },
    ],
  };
}

test('exam defaults stay in memory; a valid snapshot preserves UUIDs and omits unsupported retake fields', () => {
  const values = valid(),
    result = input(values);
  assert.deepEqual(result.errors, {});
  assert.equal(result.input.projectId, 7);
  assert.equal(result.input.registrationDeadline, '2099-01-01 18:00:00');
  assert.equal(result.input.durationMinutes, 30);
  assert.deepEqual(result.input.gradingRounds, [
    { gradingMode: 'MANUAL', reviewerUserIds: [reviewer] },
  ]);
  assert.equal(result.input.papers[0].questions[0].scoreSource, 'AUTO');
  assert.equal(Object.hasOwn(result.input.papers[0].questions[0], 'score'), false);
  assert.equal(Object.hasOwn(result.input, 'allowRetake'), false);
  assert.equal(Object.hasOwn(result.input, 'maxTotalAttempts'), false);
});

test('exam AUTO score uses floor cents and a last-question remainder, including mixed manual sources', () => {
  const values = valid(),
    paper = values.papers[0];
  paper.questions = [newExamQuestion(), newExamQuestion(), newExamQuestion()];
  for (const question of paper.questions) question.questionContent = '题干';
  assert.deepEqual(examPaperScores(paper, '100'), [3333, 3333, 3334]);
  assert.deepEqual(examPaperScores(paper, '0.30'), [10, 10, 10]);
  assert.ok(input(values).input);
  paper.questions[0].scoreSource = 'MANUAL';
  paper.questions[0].score = '34';
  assert.deepEqual(examPaperScores(paper, '100'), [3400, 3333, 3334]);
  assert.match(input(values).errors['papers.0.questions'], /合计/);
  paper.questions[0].score = '33.33';
  assert.ok(input(values).input);
  values.fullScore = '0.01';
  values.passScore = '0.01';
  paper.questions = [newExamQuestion(), newExamQuestion()];
  for (const question of paper.questions) question.questionContent = '题干';
  assert.equal(input(values).input, null);
});

test('exam score bounds reject zero passing score, precision loss and decimal overflow', () => {
  for (const [value, expected] of [
    ['1', 100],
    ['.5', 50],
    ['1.23000', 123],
    ['1e-2', 1],
    ['99999999.99', 9999999999],
    ['0', null],
    ['-1', null],
    ['0.001', null],
    ['100000000', null],
    ['NaN', null],
  ])
    assert.equal(examScoreCents(value), expected, value);
  for (const [field, value] of [
    ['passScore', '0'],
    ['passScore', '100.01'],
    ['fullScore', '1.001'],
    ['fullScore', '100000000'],
  ]) {
    const values = valid();
    values[field] = value;
    assert.ok(input(values).errors[field]);
    assert.equal(input(values).input, null);
  }
});

test('Shanghai deadline must be a real future wall-clock second and is rechecked at submission', () => {
  assert.equal(examShanghaiTime(now), '2026-10-28 00:00:00');
  const values = valid();
  values.registrationDeadline = '2026-10-28T00:00:01';
  assert.ok(input(values).input);
  assert.ok(input(values, { now: new Date('2026-10-27T16:00:01Z') }).errors.registrationDeadline);
  values.registrationDeadline = '2099-01-01T18:00';
  assert.equal(input(values).input.registrationDeadline, '2099-01-01 18:00:00');
  for (const value of ['2026-02-30T12:00:00', '2026-10-27T23:59:59', '2099-01-01T24:00:00']) {
    values.registrationDeadline = value;
    assert.ok(input(values).errors.registrationDeadline, value);
  }
});

test('duration, duplicate names and per-collection limits follow current backend boundaries', () => {
  const values = valid();
  values.durationMode = 'UNLIMITED';
  values.durationMinutes = 'bad';
  assert.equal(input(values).input.durationMinutes, null);
  values.durationMode = 'LIMITED';
  for (const value of ['', '0', '1.5', '2147483648']) {
    values.durationMinutes = value;
    assert.ok(input(values).errors.durationMinutes);
  }
  values.durationMinutes = '2147483647';
  assert.ok(input(values).input);
  assert.ok(input(values, { existingExamNames: [values.examName] }).errors.examName);
  assert.ok(
    input(values, { existingExamNames: [values.examName], originalExamName: values.examName })
      .input,
  );
  values.papers = Array.from({ length: 21 }, newExamPaper);
  assert.ok(input(values).errors.papers);
  values.papers = [newExamPaper()];
  values.papers[0].questions = Array.from({ length: 201 }, newExamQuestion);
  assert.ok(input(values).errors['papers.0.questions']);
  values.gradingRounds = Array.from({ length: 21 }, newExamRound);
  assert.ok(input(values).errors.gradingRounds);
});

test('round choices keep reviewer UUIDs and reject duplicate identities, unsafe JSON and invalid decision rules', () => {
  const values = valid(),
    round = values.gradingRounds[0];
  round.reviewerUserIds = [reviewer, reviewer];
  assert.ok(input(values).errors['gradingRounds.0.reviewerUserIds']);
  round.gradingMode = 'AUTO';
  round.toolCode = 'mock';
  round.toolName = '模拟阅卷';
  round.reviewerUserIds = [];
  values.decisionRule = 'MANUAL_PRIORITY';
  assert.ok(input(values).errors.decisionRule);
  values.decisionRule = 'MAJORITY';
  for (const text of [
    '{"nested":{"api_key":"hidden"}}',
    '{"PASSWORD":"hidden"}',
    '[1e999]',
    '{bad',
  ]) {
    round.toolConfigText = text;
    assert.ok(input(values).errors['gradingRounds.0.toolConfigText']);
  }
  round.toolConfigText = '[1,true,"non-sensitive"]';
  assert.deepEqual(input(values).input.gradingRounds[0].toolConfig, [1, true, 'non-sensitive']);
  assert.equal(input(values).input.tieBreakRule, null);
  const second = newExamRound();
  second.reviewerUserIds = [reviewer];
  values.gradingRounds.push(second);
  values.tieBreakRule = 'LENIENT';
  assert.equal(input(values).input.tieBreakRule, 'LENIENT');
  values.decisionRule = 'MANUAL_PRIORITY';
  assert.equal(input(values).input.tieBreakRule, null);
});

test('uploads remain blocked until ready; one object can only be referenced once per configuration', () => {
  const values = valid(),
    question = values.papers[0].questions[0];
  const file = {
    key: 'new',
    name: '题干.txt',
    size: 3,
    status: 'uploading',
    reference: { objectKey: 'exam/file.txt', uploadToken: 'once' },
  };
  question.questionFiles = [file];
  question.questionContent = '';
  assert.ok(input(values).errors['papers.0.questions.0.questionFiles']);
  file.status = 'failed';
  assert.equal(input(values).input, null);
  file.status = 'ready';
  assert.ok(input(values).input);
  question.referenceFiles = [structuredClone(file)];
  assert.match(input(values).errors['papers.0.questions.0.referenceFiles'], /重复/);
  question.referenceFiles = [];
  file.reference.uploadedFileId = fileId;
  assert.equal(input(values).input, null);
});

test('import preserves questions and one-time references but does not invent missing configuration or persist upload metadata', () => {
  const values = entranceExamImportedValues({
    projectId: 7,
    examName: null,
    fullScore: null,
    passScore: null,
    registrationDeadline: null,
    papers: [
      {
        paperName: '导入卷',
        questions: [
          {
            questionContent: '&lt;题干&gt;<br/>第二行',
            score: 10,
            questionFiles: [
              {
                objectKey: 'exam/import.png',
                uploadToken: 'once',
                fileId: 'ignored-import-file-id',
                fileName: '图.png',
                size: 20,
              },
            ],
          },
        ],
      },
    ],
    gradingRounds: [],
  });
  assert.equal(values.examName, '');
  assert.equal(values.fullScore, '');
  assert.equal(values.registrationDeadline, '');
  assert.deepEqual(values.gradingRounds, []);
  assert.equal(values.papers[0].questions[0].questionContent, '&lt;题干&gt;<br/>第二行');
  assert.deepEqual(values.papers[0].questions[0].questionFiles[0].reference, {
    objectKey: 'exam/import.png',
    uploadToken: 'once',
  });
  assert.ok(input(values).errors.gradingRounds);
  assert.equal(input(values).input, null);
});

test('edit recovers claimed attachments and reviewers without tokens or numeric UUID conversion', () => {
  const values = entranceExamConfigurationValues(configuration()),
    result = input(values);
  assert.ok(result.input);
  assert.deepEqual(result.input.papers[0].questions[0].questionFiles, [
    { objectKey: 'exam/original.txt', uploadedFileId: fileId },
  ]);
  assert.equal(values.papers[0].questions[0].questionFiles[0].name, '原文件.txt');
  assert.equal(values.papers[0].questions[0].questionFiles[0].size, 123);
  assert.equal(values.gradingRounds[0].reviewerUserIds[0], reviewer);
  assert.equal(examAllFiles(values).length, 1);
  for (const bad of [
    { questionFiles: { broken: true } },
    { questionFiles: [{ objectKey: 'exam/missing-id' }] },
  ]) {
    const config = configuration();
    Object.assign(config.papers[0].questions[0], bad);
    assert.throws(() => entranceExamConfigurationValues(config), /快照/);
  }
  const invalidReviewers = configuration();
  invalidReviewers.gradingRounds[0].reviewers = 'broken';
  assert.throws(() => entranceExamConfigurationValues(invalidReviewers), /阅卷人快照/);
});
