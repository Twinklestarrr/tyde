import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  candidatePaperExample,
  candidateSubmitExample,
  candidateCancelExample,
} from '../apps/server/src/modules/entrance-exams/exam-candidate.schema.ts';

const attempt = { projectId: 1, attemptId: 1 };
const submission = {
  ...attempt,
  integritySigned: true,
  answers: [{ questionId: 1, answerContent: '先核验数据，再记录质检结果。', answerFiles: [] }],
};
const answerFile = {
  objectKey: 'entrance-exam-attachment/2026/11/03/0123456789abcdef0123456789abcdef.pdf',
  uploadToken: 'u'.repeat(43),
};
const wrap = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '后端明确拒绝', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: String(url).slice(origin.length),
      data: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} candidate APIs preserve the real historical-paper and command contracts`, async (t) => {
    let current = 'NOT_EXAMINED';
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/current?')) return wrap({ projectId: 1, status: current });
      if (path.endsWith('/enter')) return wrap(candidatePaperExample);
      if (path.endsWith('/submit')) return wrap(candidateSubmitExample);
      return wrap(candidateCancelExample);
    });
    assert.deepEqual(await api.enterEntranceExam(1), candidatePaperExample);
    assert.deepEqual(await api.enterEntranceExam(1), candidatePaperExample);
    for (current of ['NOT_EXAMINED', 'NOT_PASSED', 'PENDING', 'PASSED'])
      assert.deepEqual(await api.getEntranceExamCandidateCurrent(1), {
        projectId: 1,
        status: current,
      });
    assert.deepEqual(await api.submitEntranceExam(submission), candidateSubmitExample);
    assert.deepEqual(await api.cancelEntranceExam(attempt), candidateCancelExample);
    assert.deepEqual(
      calls.map(({ method, path }) => [method, path]),
      [
        ['POST', '/api/v1/entrance-exams/enter'],
        ['POST', '/api/v1/entrance-exams/enter'],
        ...Array.from({ length: 4 }, () => ['GET', '/api/v1/entrance-exams/current?projectId=1']),
        ['POST', '/api/v1/entrance-exams/submit'],
        ['POST', '/api/v1/entrance-exams/cancel'],
      ],
    );
    assert.deepEqual(calls[0].data, { projectId: 1 });
    assert.deepEqual(calls[6].data, submission);
    assert.deepEqual(calls[7].data, attempt);
    for (const call of calls) {
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], call.method === 'GET' ? undefined : 'web');
    }
  });

  test(`${mode} candidate writes never replay conflicts, lost responses or server failures`, async (t) => {
    let status = 403;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('network response lost');
      return wrap(null, status);
    });
    for (status of [400, 403, 409, 413, 503, 0]) {
      const before = calls.length;
      await assert.rejects(
        () => api.enterEntranceExam(1),
        (error) => error.status === status,
      );
      await assert.rejects(
        () => api.submitEntranceExam(submission),
        (error) => error.status === status,
      );
      await assert.rejects(
        () => api.cancelEntranceExam(attempt),
        (error) => error.status === status,
      );
      assert.equal(calls.length - before, 3);
    }
  });

  test(`${mode} new answer attachments retain one-use tokens without accepting claimed or duplicate files`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(candidateSubmitExample));
    const input = { ...submission, answers: [{ questionId: 1, answerFiles: [answerFile] }] };
    assert.deepEqual(await api.submitEntranceExam(input), candidateSubmitExample);
    assert.deepEqual(calls[0].data, input);
    for (const answers of [
      [
        {
          questionId: 1,
          answerFiles: [{ ...answerFile, uploadedFileId: '00000000-0000-4000-8000-000000000001' }],
        },
      ],
      [{ questionId: 1, answerFiles: [{ ...answerFile, uploadToken: ' ' }] }],
      [
        {
          questionId: 1,
          answerFiles: [{ ...answerFile, objectKey: 'project-attachment/other.pdf' }],
        },
      ],
      [
        {
          questionId: 1,
          answerFiles: [{ ...answerFile, objectKey: 'entrance-exam-attachment/../secret.pdf' }],
        },
      ],
      [{ questionId: 1, answerFiles: Array.from({ length: 11 }, () => answerFile) }],
      [
        { questionId: 1, answerFiles: [answerFile] },
        { questionId: 2, answerFiles: [answerFile] },
      ],
    ])
      await assert.rejects(
        () => api.submitEntranceExam({ ...submission, answers }),
        (error) => error.status === 400,
      );
    assert.equal(calls.length, 1);
  });

  test(`${mode} candidate submit accepts exactly 2 MiB UTF-8 and rejects oversize before HTTP`, async (t) => {
    const { api, calls } = adapter(t, desktop, () =>
      wrap({ ...candidateSubmitExample, answerCount: 8 }),
    );
    const input = {
      ...submission,
      answers: Array.from({ length: 8 }, (_, index) => ({
        questionId: index + 1,
        answerContent: '中'.repeat(90000),
      })),
    };
    input.answers[7].answerContent = '';
    const remaining = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(input));
    assert.ok(remaining > 0 && remaining <= 300000);
    input.answers[7].answerContent =
      '中'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3);
    assert.ok(input.answers[7].answerContent.length <= 100000);
    assert.equal(Buffer.byteLength(JSON.stringify(input)), 2 * 1024 * 1024);
    await api.submitEntranceExam(input);
    assert.equal(calls.length, 1);
    input.answers[7].answerContent += '中';
    await assert.rejects(
      () => api.submitEntranceExam(input),
      (error) => error.status === 413,
    );
    assert.equal(calls.length, 1);
  });
}

test('candidate IDs, integrity, answer lengths and unknown fields are validated before HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  for (const request of [
    () => api.getEntranceExamCandidateCurrent(0),
    () => api.enterEntranceExam(2147483648),
    () => api.enterEntranceExam('1'),
    () => api.cancelEntranceExam({ ...attempt, attemptId: -1 }),
    () => api.cancelEntranceExam({ ...attempt, examId: 1 }),
    () => api.submitEntranceExam({ ...submission, integritySigned: false }),
    () => api.submitEntranceExam({ ...submission, answers: null }),
    () =>
      api.submitEntranceExam({ ...submission, answers: [{ questionId: 1 }, { questionId: 1 }] }),
    () =>
      api.submitEntranceExam({
        ...submission,
        answers: Array.from({ length: 501 }, (_, i) => ({ questionId: i + 1 })),
      }),
    () =>
      api.submitEntranceExam({
        ...submission,
        answers: [{ questionId: 1, answerContent: 'x'.repeat(100001) }],
      }),
    () =>
      api.submitEntranceExam({
        ...submission,
        answers: [{ questionId: 1, referenceAnswer: 'not an answer field' }],
      }),
  ])
    await assert.rejects(request, (error) => error.status === 400);
  assert.equal(calls.length, 0);
});

test('candidate decoders reject mismatched identities, invalid dates and unsafe paper structure', async (t) => {
  let data;
  const { api } = adapter(t, false, () => wrap(data));
  for (data of [
    { ...candidatePaperExample, projectId: 2 },
    { ...candidatePaperExample, attemptId: 0 },
    { ...candidatePaperExample, enteredAt: '2026-02-30 12:00:00' },
    { ...candidatePaperExample, answerDeadlineAt: '2026-11-03T00:00:00Z' },
    { ...candidatePaperExample, questions: [] },
    {
      ...candidatePaperExample,
      questions: [candidatePaperExample.questions[0], candidatePaperExample.questions[0]],
    },
    {
      ...candidatePaperExample,
      questions: [
        { ...candidatePaperExample.questions[0], referenceAnswer: 'must not reach a candidate' },
      ],
    },
  ])
    await assert.rejects(
      () => api.enterEntranceExam(1),
      (error) => error.status === 502,
    );
  data = {
    ...candidatePaperExample,
    durationMinutes: null,
    answerDeadlineAt: null,
    paperName: null,
    fullScore: 0,
    questions: [
      {
        ...candidatePaperExample.questions[0],
        score: 0,
        questionFiles: { historical: ['keep', 0, null] },
      },
    ],
  };
  assert.deepEqual(await api.enterEntranceExam(1), data);
  for (data of [
    { projectId: 2, status: 'PASSED' },
    { projectId: 1, status: 'ADMITTED' },
  ])
    await assert.rejects(
      () => api.getEntranceExamCandidateCurrent(1),
      (error) => error.status === 502,
    );
  data = { ...candidateSubmitExample, attemptId: 2 };
  await assert.rejects(
    () => api.submitEntranceExam(submission),
    (error) => error.status === 502,
  );
  data = { ...candidateCancelExample, attemptId: 2 };
  await assert.rejects(
    () => api.cancelEntranceExam(attempt),
    (error) => error.status === 502,
  );
});
