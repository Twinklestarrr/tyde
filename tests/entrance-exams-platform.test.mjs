import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  examConfigExample,
  examMutationExample,
} from '../apps/server/src/modules/entrance-exams/exam-config.schema.ts';
import {
  examManagementExample,
  examDetailExample,
  examRosterExample,
  examCloseExample,
} from '../apps/server/src/modules/entrance-exams/exam-query.schema.ts';
import { examAdmissionExample } from '../apps/server/src/modules/entrance-exams/exam-admission.schema.ts';
import { examGradingDetailExample } from '../apps/server/src/modules/entrance-exams/exam-grading-query.schema.ts';
import {
  manualGradingExample,
  gradingSubmitExample,
} from '../apps/server/src/modules/entrance-exams/exam-grading-command.schema.ts';
import { compensateExample } from '../apps/server/src/modules/entrance-exams/exam-auto.schema.ts';

const locator = { projectId: 3001, examId: 5001 };
const detailInput = { ...locator, attemptId: 11001, roundNo: 1 };
const retry = { ...locator, gradingRecordId: 10001 };
const reviewer = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'reviewer-uid',
  name: '测试阅卷人',
  avatarUrl: null,
};
const wrap = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '后端明确失败', data }),
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
      data:
        options.body instanceof FormData
          ? options.body
          : options.body
            ? JSON.parse(options.body)
            : undefined,
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}
function writes(api) {
  return [
    () => api.publishEntranceExam(examConfigExample),
    () =>
      api.editEntranceExam({ ...examConfigExample, examId: 5001, expectedCurrentVersionId: 6001 }),
    () => api.closeEntranceExam({ ...locator, closeReason: '停止报名' }),
    () => api.submitEntranceExamManualGrading(manualGradingExample),
    () => api.retryEntranceExamAutoGrading(retry),
    () => api.compensateEntranceExamAutoGrading(compensateExample),
  ];
}

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron Cookie' : 'Web Cookie';
  test(`${mode} reads preserve actual management, UUID reviewers, full version, history grading and server paging contracts`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/management')) return wrap(examManagementExample);
      if (path.includes('/reviewers')) return wrap([reviewer]);
      if (path.endsWith('/grading/detail')) return wrap(examGradingDetailExample);
      if (path.endsWith('/detail')) return wrap(examDetailExample);
      if (path.endsWith('/roster')) return wrap({ ...examRosterExample, current: 2, records: [] });
      return wrap({ ...examAdmissionExample, current: 2, records: [] });
    });
    assert.deepEqual(await api.getEntranceExamManagement(3001), examManagementExample);
    assert.deepEqual(await api.listEntranceExamReviewers(3001, '测试 阅卷'), [reviewer]);
    assert.deepEqual(await api.getEntranceExamConfiguration(locator), examDetailExample);
    assert.deepEqual(
      await api.getEntranceExamRoster({
        ...locator,
        current: 2,
        size: 20,
        finalResult: 'ADMITTED',
      }),
      { ...examRosterExample, current: 2, records: [] },
    );
    assert.deepEqual(
      await api.getEntranceExamAdmissions({
        projectId: 3001,
        keyword: '用户 甲',
        admissionStatus: 'PENDING_ENTRY',
        current: 2,
        size: 20,
      }),
      { ...examAdmissionExample, current: 2, records: [] },
    );
    assert.deepEqual(await api.getEntranceExamGradingDetail(detailInput), examGradingDetailExample);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET', 'GET', 'POST', 'POST', 'GET', 'POST'],
    );
    assert.equal(
      calls[4].path,
      '/api/v1/entrance-exams/admissions?projectId=3001&keyword=%E7%94%A8%E6%88%B7+%E7%94%B2&admissionStatus=PENDING_ENTRY&current=2&size=20',
    );
    assert.deepEqual(calls[2].data, locator);
    for (const call of calls) {
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Client'], call.method === 'GET' ? undefined : 'web');
    }
  });
  test(`${mode} complete writes use exact methods and payloads without fake authorization or automatic execution`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      wrap(
        path.endsWith('/close')
          ? examCloseExample
          : path.includes('/grading/')
            ? gradingSubmitExample
            : examMutationExample,
      ),
    );
    for (const write of writes(api)) await write();
    assert.deepEqual(
      calls.map((call) => [call.path, call.method]),
      [
        ['/api/v1/entrance-exams/publish', 'POST'],
        ['/api/v1/entrance-exams/edit', 'PUT'],
        ['/api/v1/entrance-exams/close', 'POST'],
        ['/api/v1/entrance-exams/grading/manual', 'POST'],
        ['/api/v1/entrance-exams/grading/retry', 'POST'],
        ['/api/v1/entrance-exams/grading/auto/compensate', 'POST'],
      ],
    );
    assert.deepEqual(calls[0].data, examConfigExample);
    assert.equal(calls[1].data.expectedCurrentVersionId, 6001);
    assert.deepEqual(calls[3].data.items, manualGradingExample.items);
    assert.equal(calls[5].data.compensationReason, compensateExample.compensationReason);
  });
  test(`${mode} manual grading accepts exactly 16 KiB UTF-8 and rejects larger valid fields before any HTTP`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => wrap(gradingSubmitExample));
    const input = {
      ...manualGradingExample,
      conclusionSummary: '测'.repeat(4000),
      items: [{ ...manualGradingExample.items[0], gradingOpinion: '' }],
    };
    const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const padding = 16 * 1024 - size(input);
    assert.ok(padding > 0 && padding < 5000);
    input.items[0].gradingOpinion = 'a'.repeat(padding);
    assert.equal(size(input), 16384);
    assert.ok(input.conclusionSummary.length <= 5000);
    assert.ok(input.items[0].gradingOpinion.length <= 5000);
    assert.deepEqual(await api.submitEntranceExamManualGrading(input), gradingSubmitExample);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/v1/entrance-exams/grading/manual');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].data, input);
    for (const extra of ['a', '中']) {
      const oversized = {
        ...input,
        items: [{ ...input.items[0], gradingOpinion: input.items[0].gradingOpinion + extra }],
      };
      assert.equal(size(oversized), extra === 'a' ? 16385 : 16387);
      assert.ok(oversized.conclusionSummary.length <= 5000);
      assert.ok(oversized.items[0].gradingOpinion.length <= 5000);
      await assert.rejects(
        () => api.submitEntranceExamManualGrading(oversized),
        (error) =>
          error.name === 'ApiError' &&
          error.status === 413 &&
          error.code === 'PAYLOAD_TOO_LARGE' &&
          error.message === '阅卷内容超过当前可提交大小，请缩短阅卷意见或本轮总结后重试。',
      );
      assert.equal(calls.length, 1);
    }
  });
  test(`${mode} conflicts, unavailable service and network-unknown writes never replay`, async (t) => {
    let status = 409;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new TypeError('fixture network failure');
      return wrap(null, status);
    });
    for (status of [403, 409, 503, 0]) {
      const before = calls.length;
      for (const write of writes(api))
        await assert.rejects(write, (error) => error.status === status);
      assert.equal(calls.length - before, 6);
    }
  });
  test(`${mode} template downloads handle all actual binary formats and reject JSON masquerading as a file`, async (t) => {
    let invalid = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (invalid) return wrap({ unexpected: true });
      const type = path.split('=').at(-1);
      return new Response('fixture bytes', {
        headers: {
          'Content-Type': {
            EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            TXT: 'text/plain;charset=UTF-8',
            REDOC: 'application/xml;charset=UTF-8',
          }[type],
        },
      });
    });
    for (const [type, extension] of [
      ['EXCEL', 'xlsx'],
      ['TXT', 'txt'],
      ['REDOC', 'xml'],
    ]) {
      const result = await api.downloadEntranceExamTemplate(type);
      assert.equal(result.fileName, `entrance-exam-import-v1.${extension}`);
      assert.equal(await result.blob.text(), 'fixture bytes');
    }
    invalid = true;
    await assert.rejects(
      () => api.downloadEntranceExamTemplate('TXT'),
      (error) => error.status === 502,
    );
    const before = calls.length;
    await assert.rejects(
      () => api.downloadEntranceExamTemplate('WORD'),
      (error) => error.status === 400,
    );
    assert.equal(calls.length, before);
  });
  test(`${mode} parsing uses multipart sources and preserves incomplete previews without publishing`, async (t) => {
    const preview = {
      ...examConfigExample,
      registrationDeadline: null,
      decisionRule: null,
      tieBreakRule: null,
      gradingRounds: [],
    };
    const parsed = { formatVersion: '1', sourceType: 'TXT', config: preview };
    const { api, calls } = adapter(t, desktop, ({ data }) =>
      data.get('redocUrl') ? wrap(null, 503) : wrap(parsed),
    );
    assert.deepEqual(
      await api.parseEntranceExamImport({
        projectId: 3001,
        file: new File(['题目'], 'exam.txt'),
        attachmentRefs: [],
      }),
      parsed,
    );
    assert.equal(calls[0].data.get('projectId'), '3001');
    assert.equal(calls[0].data.get('file').name, 'exam.txt');
    assert.equal(calls[0].data.get('attachmentRefs'), '[]');
    assert.equal(calls[0].headers['Content-Type'], undefined);
    await assert.rejects(
      () =>
        api.parseEntranceExamImport({
          projectId: 3001,
          redocUrl: 'https://documents.example/doc/example',
        }),
      (error) => error.status === 503,
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.path === '/api/v1/entrance-exams/import/parse'));
  });
  test(`${mode} exam attachments stay in their own sensitive scope and read through the authenticated byte proxy`, async (t) => {
    const file = new File(['%PDF'], 'exam.pdf', { type: 'application/pdf' });
    const key = 'entrance-exam-attachment/2026/10/28/0123456789abcdef0123456789abcdef.pdf';
    const receipt = {
      fileId: reviewer.userId,
      objectKey: key,
      uploadToken: 'u'.repeat(43),
      url: null,
      sensitive: true,
      fileName: file.name,
      extension: 'pdf',
      size: file.size,
      contentType: file.type,
      fileHash: 'a'.repeat(64),
    };
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      path.includes('/view?')
        ? new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } })
        : wrap(receipt),
    );
    assert.deepEqual(await api.uploadEntranceExamAttachment(file), receipt);
    assert.equal(calls[0].data.get('bizType'), 'ENTRANCE_EXAM_ATTACHMENT');
    assert.equal(calls[0].data.get('category'), 'PROJECT_ATTACHMENT');
    assert.equal(await (await api.readEntranceExamAttachment(key)).text(), '%PDF');
    const before = calls.length;
    for (const bad of [
      'project-attachment/a.pdf',
      'entrance-exam-attachment/../secret',
      'https://files.example/a.pdf',
    ])
      await assert.rejects(
        () => api.readEntranceExamAttachment(bad),
        (error) => error.status === 400,
      );
    assert.equal(calls.length, before);
  });
}

test('invalid IDs, unsafe pagination, unsupported import sources and sensitive config keys fail before any HTTP', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('must not request');
  });
  const invalid = [
    () => api.getEntranceExamManagement(0),
    () => api.getEntranceExamConfiguration({ projectId: 3001, examId: 1e20 }),
    () =>
      api.getEntranceExamAdmissions({
        projectId: 3001,
        current: Number.MAX_SAFE_INTEGER,
        size: 100,
      }),
    () => api.getEntranceExamAdmissions({ projectId: 3001, size: 101 }),
    () =>
      api.submitEntranceExamManualGrading({
        ...manualGradingExample,
        items: [{ questionId: 1, correctness: 'PENDING' }],
      }),
    () =>
      api.publishEntranceExam({
        ...examConfigExample,
        gradingRounds: [
          {
            gradingMode: 'AUTO',
            toolCode: 'mock',
            toolName: '模拟工具',
            toolConfig: { nested: { api_key: 'not-permitted' } },
          },
        ],
      }),
    () => api.parseEntranceExamImport({ projectId: 3001, file: new File(['x'], 'exam.docx') }),
    () =>
      api.parseEntranceExamImport({
        projectId: 3001,
        file: new File(['x'], 'exam.txt'),
        redocUrl: 'https://documents.example/doc/example',
      }),
  ];
  for (const request of invalid) await assert.rejects(request, (error) => error.status === 400);
  assert.equal(calls.length, 0);
});
test('response decoders reject mismatched identities and preserve zero marks and unknown historical JSON', async (t) => {
  let data = { ...examDetailExample, questionFiles: undefined };
  const { api } = adapter(t, false, () => wrap(data));
  data = { ...examDetailExample, examId: 9999 };
  await assert.rejects(
    () => api.getEntranceExamConfiguration(locator),
    (error) => error.status === 502,
  );
  data = structuredClone(examDetailExample);
  data.papers[0].questions[0].questionFiles = { malformedHistorical: ['keep', null, 0] };
  data.gradingRounds[0].reviewers = 'historical text';
  assert.deepEqual(await api.getEntranceExamConfiguration(locator), data);
  data = structuredClone(examGradingDetailExample);
  assert.equal((await api.getEntranceExamGradingDetail(detailInput)).selectedRound.score, 0);
  data.attemptId = 999;
  await assert.rejects(
    () => api.getEntranceExamGradingDetail(detailInput),
    (error) => error.status === 502,
  );
});
test('an explicitly unauthenticated confirmation refreshes once and retries only the same complete body', async (t) => {
  const tokens = {
    accessToken: 'a'.repeat(43),
    refreshToken: 'r'.repeat(43),
    tokenType: 'Bearer',
    expiresIn: 1800,
  };
  let publishCount = 0;
  const { api, calls } = adapter(t, false, ({ path }) => {
    if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return wrap(tokens);
    if (++publishCount === 1) return wrap(null, 401);
    return wrap(examMutationExample);
  });
  await api.login({ account: '13800000000', password: 'FixturePass123!', role: 'PM' });
  await api.publishEntranceExam(examConfigExample);
  assert.equal(publishCount, 2);
  const publishes = calls.filter((call) => call.path.endsWith('/publish'));
  assert.deepEqual(publishes[0].data, publishes[1].data);
  assert.equal(calls.filter((call) => call.path.endsWith('/refresh')).length, 1);
});
