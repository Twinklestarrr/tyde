import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  entranceExamGradingActions,
  entranceExamGradingInput,
  entranceExamGradingPreview,
  entranceExamGradingValues,
} from '../apps/web/src/modules/projects/entrance-exam-grading.ts';
import { examGradingDetailExample } from '../apps/server/src/modules/entrance-exams/exam-grading-query.schema.ts';

function detail() {
  const result = structuredClone(examGradingDetailExample);
  result.selectedRound.gradingMode = 'MANUAL';
  result.selectedRound.status = 'PENDING';
  result.questions = [
    {
      ...result.questions[0],
      questionId: 701,
      sequenceNo: 1,
      score: 0.1,
      correctness: null,
      gradingOpinion: null,
    },
    {
      ...result.questions[0],
      questionId: 702,
      sequenceNo: 2,
      score: 0.2,
      correctness: 'PENDING',
      gradingOpinion: null,
    },
  ];
  return result;
}

test('grading permits manager manual writes only for an existing active record after earlier rounds complete', () => {
  const data = detail();
  assert.equal(entranceExamGradingActions(data, true).manual, true);
  assert.equal(entranceExamGradingActions(data, false).manual, false);
  data.selectedRound.gradingRecordId = null;
  assert.equal(entranceExamGradingActions(data, true).manual, false);
  data.selectedRound.gradingRecordId = 123;
  data.selectedRound.roundNo = 2;
  data.rounds = [{ ...data.selectedRound, roundNo: 1, status: 'PROCESSING' }, data.selectedRound];
  assert.equal(entranceExamGradingActions(data, true).previousComplete, false);
  assert.equal(entranceExamGradingActions(data, true).manual, false);
  data.rounds[0].status = 'COMPLETED';
  assert.equal(entranceExamGradingActions(data, true).manual, true);
  for (const state of [null, 'WAITING', 'COMPLETED', 'FAILED']) {
    data.selectedRound.status = state;
    assert.equal(entranceExamGradingActions(data, true).manual, false);
  }
  data.selectedRound.status = 'PROCESSING';
  assert.equal(entranceExamGradingActions(data, true).manual, true);
});

test('only failed automatic records can retry; compensation accepts failed or completed, collaborators stay read only', () => {
  const data = detail();
  data.selectedRound.gradingMode = 'AUTO';
  for (const state of [null, 'WAITING', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']) {
    data.selectedRound.status = state;
    const actions = entranceExamGradingActions(data, true);
    assert.equal(actions.retry, state === 'FAILED');
    assert.equal(actions.compensate, state === 'FAILED' || state === 'COMPLETED');
    assert.equal(actions.manual, false);
    assert.equal(entranceExamGradingActions(data, false).retry, false);
    assert.equal(entranceExamGradingActions(data, false).compensate, false);
  }
});

test('all questions require correctness, submitted items bind actual IDs and cannot send partial numeric scores', () => {
  const data = detail();
  const values = entranceExamGradingValues(data);
  assert.equal(entranceExamGradingInput(data, values, false).input, null);
  values.items[0].correctness = 'CORRECT';
  values.items[1].correctness = 'INCORRECT';
  values.items[0].gradingOpinion = ' 已核对参考答案 ';
  values.summary = ' 本轮已核对 ';
  assert.deepEqual(entranceExamGradingInput(data, values, false), {
    errors: {},
    input: {
      items: [
        { questionId: 701, correctness: 'CORRECT', gradingOpinion: '已核对参考答案' },
        { questionId: 702, correctness: 'INCORRECT', gradingOpinion: null },
      ],
      summary: '本轮已核对',
      compensationReason: null,
    },
  });
  values.items[1].questionId = 701;
  assert.equal(entranceExamGradingInput(data, values, false).input, null);
});

test('zero preview survives and decimal points are added in cents independently of final admission', () => {
  const data = detail();
  const values = entranceExamGradingValues(data);
  assert.equal(entranceExamGradingPreview(data, values), null);
  values.items.forEach((item) => {
    item.correctness = 'INCORRECT';
  });
  assert.equal(entranceExamGradingPreview(data, values), 0);
  values.items.forEach((item) => {
    item.correctness = 'CORRECT';
  });
  assert.equal(entranceExamGradingPreview(data, values), 0.3);
  data.selectedRound.score = 0;
  data.selectedRound.conclusionSummary = '';
  data.questions[0].correctness = 'INCORRECT';
  assert.equal(entranceExamGradingValues(data).items[0].correctness, 'INCORRECT');
  assert.equal(entranceExamGradingValues(data).summary, '');
});

test('manual comments and summary cap at 5000; compensation requires a nonblank reason up to 1000', () => {
  const data = detail();
  const values = entranceExamGradingValues(data);
  values.items.forEach((item) => {
    item.correctness = 'CORRECT';
  });
  values.items[0].gradingOpinion = 'a'.repeat(5000);
  values.summary = 'a'.repeat(5000);
  assert.ok(entranceExamGradingInput(data, values, false).input);
  values.items[0].gradingOpinion += 'a';
  values.summary += 'a';
  const invalid = entranceExamGradingInput(data, values, true);
  assert.ok(invalid.errors['opinion:701']);
  assert.ok(invalid.errors.summary);
  assert.ok(invalid.errors.compensationReason);
  values.items[0].gradingOpinion = '';
  values.summary = '';
  values.compensationReason = ' ';
  assert.equal(entranceExamGradingInput(data, values, true).input, null);
  values.compensationReason = 'a'.repeat(1000);
  assert.ok(entranceExamGradingInput(data, values, true).input);
  values.compensationReason += 'a';
  assert.equal(entranceExamGradingInput(data, values, true).input, null);
});
