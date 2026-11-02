import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';

const attachment = {
  id: 51,
  attachmentType: 'STANDARD_REFERENCE',
  fileName: 'standard.pdf',
  objectKey: 'project-attachment/2026/11/02/standard.pdf',
  extension: 'pdf',
  contentType: 'application/pdf',
  fileSize: 123,
  fileHash: 'a'.repeat(64),
  sortNo: 0,
  status: 'ACTIVE',
};
const materials = {
  projectId: 17,
  standardContent: '按标准完成任务',
  standardLink: null,
  attachments: [attachment],
  currentNodeCode: 'STANDARD_TRAINING',
  stateTransitioned: false,
  canConfirmRead: false,
  confirmedReadAt: null,
  readConfirmationTransitioned: false,
  versionNo: 4,
};
const result = (data, status = 200) =>
  new Response(JSON.stringify({ code: status, message: '服务端结果', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function adapter(t, desktop, responder = () => result(materials)) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: url.slice(origin.length),
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
  const mode = desktop ? 'Electron renderer' : 'Web';
  test(`${mode} standard materials use the current GET query and authenticated Cookie contract`, async (t) => {
    const { api, calls } = adapter(t, desktop);
    assert.deepEqual(await api.getProjectStandardMaterials(17), materials);
    assert.equal(calls[0].path, '/api/v1/projects/standard-materials/detail?projectId=17');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].credentials, desktop ? 'include' : 'same-origin');
  });

  test(`${mode} standard material updates preserve clearing, retention and replacement semantics without an invented version`, async (t) => {
    const { api, calls } = adapter(t, desktop);
    for (const attachments of [
      undefined,
      null,
      [],
      [
        { id: 51, sortNo: 1 },
        {
          attachmentType: 'CASE',
          objectKey: 'project-attachment/2026/11/02/case.txt',
          uploadToken: 'u'.repeat(43),
          sortNo: 2,
        },
      ],
    ]) {
      const input = {
        projectId: 17,
        standardContent: null,
        standardLink: 'https://example.test/standard',
        ...(attachments !== undefined ? { attachments } : {}),
      };
      assert.deepEqual(await api.updateProjectStandardMaterials(input), materials);
      const call = calls.at(-1);
      assert.equal(call.path, '/api/v1/projects/standard-materials/update');
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.data, input);
      assert.equal(call.headers['X-Tyde-Client'], 'web');
      assert.equal(call.headers['Content-Type'], 'application/json');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['Idempotency-Key'], undefined);
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
    }
  });

  test(`${mode} standard material failures retain real statuses and never replay uncertain writes`, async (t) => {
    let status;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 'network') throw new TypeError('offline');
      return result(null, status);
    });
    const input = { projectId: 17, standardContent: '正文' };
    for (status of [400, 403, 404, 409, 413, 500, 503]) {
      await assert.rejects(
        api.updateProjectStandardMaterials(input),
        (error) => error.status === status && error.message === '服务端结果',
      );
    }
    status = 'network';
    await assert.rejects(
      api.updateProjectStandardMaterials(input),
      (error) => error.status === 0 && error.code === 'NETWORK_ERROR',
    );
    assert.equal(calls.length, 8);
  });
}

test('material decoding requires the matching project, complete state and valid attachment metadata', async (t) => {
  let data = materials;
  const { api } = adapter(t, false, () => result(data));
  for (const patch of [
    { projectId: 18 },
    { standardContent: undefined },
    { standardLink: 1 },
    { stateTransitioned: 'false' },
    { currentNodeCode: undefined },
    { canConfirmRead: undefined },
    { confirmedReadAt: '2026-02-30 09:00:00' },
    { readConfirmationTransitioned: null },
    { versionNo: -1 },
    { attachments: [{ ...attachment, status: 'DELETED' }] },
    { attachments: [{ ...attachment, fileSize: '123' }] },
    { attachments: [{ ...attachment, attachmentType: 'UNSUPPORTED' }] },
  ]) {
    data = { ...materials, ...patch };
    await assert.rejects(api.getProjectStandardMaterials(17), (error) => error.status === 502);
    await assert.rejects(
      api.updateProjectStandardMaterials({ projectId: 17, standardContent: '正文' }),
      (error) => error.status === 502,
    );
  }
  data = { ...materials, standardContent: null, attachments: [] };
  assert.deepEqual(await api.getProjectStandardMaterials(17), data);
});

test('material input rejects invalid IDs, unsupported fields and invalid text or attachment values before requesting', async (t) => {
  const { api, calls } = adapter(t, false);
  for (const id of [0, -1, 1.5, 2147483648, '17'])
    await assert.rejects(api.getProjectStandardMaterials(id), (error) => error.status === 400);
  for (const patch of [
    { projectId: 0 },
    { versionNo: 4 },
    { standardContent: ' ', standardLink: null },
    { standardContent: 1 },
    { standardLink: 'x'.repeat(2001) },
    { attachments: Array(21).fill({ id: 51 }) },
    { attachments: [{ id: 0 }] },
    { attachments: [{ id: 51, sortNo: -1 }] },
    { attachments: [{ attachmentType: 'UNSUPPORTED' }] },
    { attachments: [{ objectKey: 'x'.repeat(501) }] },
    { attachments: [{ uploadToken: 'x'.repeat(129) }] },
    { attachments: [{ id: 51, fileName: 'unsupported.pdf' }] },
  ])
    await assert.rejects(
      api.updateProjectStandardMaterials({ projectId: 17, standardContent: '正文', ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});
