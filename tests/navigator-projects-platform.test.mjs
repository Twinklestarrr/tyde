import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { PROJECT_ATTACHMENT_MAX_BYTES } from '../packages/shared/dist/index.js';

const userId = '00000000-0000-4000-8000-000000000001';
const wallTime = '2026-10-26 09:30:01';
const category = {
  id: 31,
  categoryCode: 'LABEL',
  categoryName: '标注',
  categoryLevel: 3,
  sortNo: -1,
};
const requester = {
  requesterType: 'INDIVIDUAL',
  requesterId: userId,
  requesterName: '测试领航员(测试用户)',
  orgId: null,
  orgVerifyStatus: null,
};
const card = {
  id: 17,
  projectNo: 'PRJ20261026093001A1B2C3D4',
  projectName: '契约测试项目',
  projectDescription: null,
  categoryLevel1Name: null,
  categoryLevel2Name: null,
  categoryLevel3Names: [],
  categoryDisplayName: '未分类项目',
  status: 'PUBLISHED',
  statusDescription: '已发布',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  branchNodeCode: null,
  workbenchStatus: 'PENDING',
  workbenchStatusDescription: '待处理',
  currentAction: 'RECRUIT_PROJECT_MANAGER',
  currentActionDescription: '招募策略官',
  needAssistGrading: false,
  requesterName: requester.requesterName,
  creatorId: null,
  creatorName: requester.requesterName,
  projectManagerId: null,
  projectManagerName: null,
  projectManagerStatusDescription: '招募中',
  projectOwners: [{ userId, name: '项目负责人', avatarUrl: null }],
  activeExpertCount: 1,
  requiredHeadcount: null,
  deadline: null,
  createdAt: wallTime,
  updatedAt: wallTime,
};
const detail = {
  id: 17,
  projectNo: card.projectNo,
  requesterType: 'INDIVIDUAL',
  requesterId: userId,
  requesterName: requester.requesterName,
  projectName: '契约测试项目',
  projectDescription: null,
  categoryLevel1Id: 11,
  categoryLevel2Id: 21,
  categoryLevel1Name: '分类一',
  categoryLevel2Name: '分类二',
  categoryLevel3Ids: [31],
  categoryLevel3Names: ['标注'],
  difficultyLevel: 'EASY',
  projectQuantity: 100.25,
  quantityUnit: '条',
  deadline: '2099-12-31 18:00:02',
  requiredHeadcount: 5,
  educationRequirement: 'BACHELOR',
  employmentType: 'UNLIMITED',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  mandatoryRequirement: '遵守规范',
  standardContent: '按要求执行',
  standardLink: null,
  status: 'PUBLISHED',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  versionNo: 2,
  creatorUid: 'TEST-NAVIGATOR-1',
  creatorName: requester.requesterName,
  createdAt: wallTime,
  updatedAt: wallTime,
  attachments: [],
};
const draft = { ...detail, status: 'DRAFT', currentNodeCode: null, creatorName: null };
const snapshot = {
  operation: 'SAVE_DRAFT',
  requesterType: 'INDIVIDUAL',
  requesterId: userId,
  projectName: '契约测试项目',
  projectDescription: null,
  categoryLevel1Id: 11,
  categoryLevel2Id: 21,
  categoryLevel3Ids: [31],
  difficultyLevel: 'EASY',
  projectQuantity: 100.25,
  quantityUnit: '条',
  deadline: '2099-12-31 18:00:02',
  requiredHeadcount: 5,
  educationRequirement: 'BACHELOR',
  employmentType: 'UNLIMITED',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  mandatoryRequirement: '遵守规范',
  standardContent: '按要求执行',
  standardLink: null,
  attachments: [
    { id: 51, sortNo: 0 },
    {
      attachmentType: 'OTHER',
      objectKey: 'project-attachment/2026/10/26/0123456789abcdef0123456789abcdef.txt',
      uploadToken: 'u'.repeat(43),
      sortNo: 1,
    },
  ],
  versionNo: 0,
};
const saved = {
  id: 17,
  projectNo: card.projectNo,
  operation: 'SAVE_DRAFT',
  status: 'DRAFT',
  currentNodeCode: null,
  versionNo: 1,
  updatedAt: wallTime,
  publishedAt: null,
};
const published = {
  ...saved,
  operation: 'CREATE_PROJECT',
  status: 'PUBLISHED',
  currentNodeCode: 'RECRUIT_PROJECT_MANAGER',
  publishedAt: wallTime,
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 3600,
};
const uploaded = (file) => ({
  fileId: '00000000-0000-4000-8000-000000000002',
  objectKey: snapshot.attachments[1].objectKey,
  uploadToken: 'u'.repeat(43),
  url: null,
  sensitive: true,
  fileName: file.name,
  extension: 'txt',
  size: file.size,
  contentType: 'text/plain',
  fileHash: 'b'.repeat(64),
});
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '服务端真实错误', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      ...options,
      path: url.slice(origin.length),
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

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron renderer' : 'Web';
  test(`${mode} navigator reads use actual pending-list, own draft and independent category contracts`, async (t) => {
    let hasDraft = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/projects/list') return result([card]);
      if (path === '/api/v1/projects/draft/current')
        return result({ hasDraft, draft: hasDraft ? draft : null });
      if (path.startsWith('/api/v1/project-categories')) return result([category]);
      if (path.endsWith('/backfill')) return result(requester);
      if (path === '/api/v1/projects/17') return result(detail);
      throw new Error('Unexpected project endpoint');
    });
    assert.deepEqual(await api.listNavigatorProjects(), [card]);
    assert.deepEqual(await api.getCurrentProjectDraft(), { hasDraft: false, draft: null });
    hasDraft = true;
    assert.deepEqual(await api.getCurrentProjectDraft(), { hasDraft: true, draft });
    assert.deepEqual(await api.getProjectCategories(), [category]);
    assert.deepEqual(await api.getProjectCategories({ categoryLevel: 3, keyword: '标注&分类' }), [
      category,
    ]);
    assert.deepEqual(await api.getCurrentProjectRequester(userId), requester);
    assert.deepEqual(await api.getProjectDetail(17), detail);
    assert.equal(calls[0].path, '/api/v1/projects/list');
    assert.equal(calls[3].path, '/api/v1/project-categories');
    assert.equal(
      calls[4].path,
      '/api/v1/project-categories?categoryLevel=3&keyword=%E6%A0%87%E6%B3%A8%26%E5%88%86%E7%B1%BB',
    );
    assert.equal(calls[5].path, `/api/v1/project-requesters/INDIVIDUAL/${userId}/backfill`);
    assert.ok(
      calls.every(
        ({ method, body, credentials, headers }) =>
          method === 'GET' &&
          body === undefined &&
          credentials === (desktop ? 'include' : 'same-origin') &&
          !headers.Authorization,
      ),
    );
  });

  test(`${mode} project draft and publication preserve full snapshots, version zero, attachment claims and wall-clock seconds`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ data }) =>
      result(data.operation === 'SAVE_DRAFT' ? saved : published),
    );
    assert.deepEqual(await api.saveProject(snapshot), saved);
    const input = { ...snapshot, operation: 'CREATE_PROJECT', attachments: [], versionNo: 1 };
    assert.deepEqual(await api.saveProject(input), published);
    assert.deepEqual(
      calls.map(({ data }) => data),
      [snapshot, input],
    );
    assert.ok(
      calls.every(
        ({ path, method, headers, credentials }) =>
          path === '/api/v1/projects/create' &&
          method === 'POST' &&
          headers['X-Tyde-Client'] === 'web' &&
          headers['Content-Type'] === 'application/json' &&
          !headers.Authorization &&
          !headers['Idempotency-Key'] &&
          credentials === (desktop ? 'include' : 'same-origin'),
      ),
    );
    assert.equal(calls[0].data.deadline, '2099-12-31 18:00:02');
    assert.equal(snapshot.versionNo, 0);
  });

  test(`${mode} project failures keep real 403/409/503 statuses and never retry an unknown publication`, async (t) => {
    let outcome = 403;
    const { api, calls } = adapter(t, desktop, () => {
      if (outcome === 'network') throw new TypeError('offline');
      if (outcome === 'malformed') return result({ ...published, operation: 'SAVE_DRAFT' });
      return result(null, outcome);
    });
    for (const status of [403, 409, 503]) {
      outcome = status;
      const count = calls.length;
      await assert.rejects(
        api.saveProject({ ...snapshot, operation: 'CREATE_PROJECT' }),
        (error) => error.status === status && error.message === '服务端真实错误',
      );
      assert.equal(calls.length, count + 1);
    }
    outcome = 'network';
    await assert.rejects(
      api.saveProject({ ...snapshot, operation: 'CREATE_PROJECT' }),
      (error) => error.status === 0 && error.code === 'NETWORK_ERROR',
    );
    assert.equal(calls.length, 4);
    outcome = 'malformed';
    await assert.rejects(
      api.saveProject({ ...snapshot, operation: 'CREATE_PROJECT' }),
      (error) => error.status === 502,
    );
    assert.equal(calls.length, 5);
  });

  test(`${mode} explicit unauthenticated rejection refreshes once and reuses the exact project snapshot`, async (t) => {
    let attempts = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/auth/login') return result(tokens);
      if (path === '/api/v1/auth/refresh')
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      if (path === '/api/v1/projects/create')
        return ++attempts === 1 ? result(null, 401) : result(saved);
      throw new Error('Unexpected endpoint');
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    assert.deepEqual(await api.saveProject(snapshot), saved);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/auth/login',
        '/api/v1/projects/create',
        '/api/v1/auth/refresh',
        '/api/v1/projects/create',
      ],
    );
    assert.deepEqual(calls[1].data, snapshot);
    assert.equal(calls[1].body, calls[3].body);
    assert.equal(attempts, 2);
  });

  test(`${mode} sensitive project attachments use fixed business upload and authenticated byte reads`, async (t) => {
    const file = new File(['project fixture'], '要求.txt', { type: 'text/plain' });
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/files/upload') return result(uploaded(file));
      return new Response('project fixture', {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    assert.deepEqual(await api.uploadProjectAttachment(file), uploaded(file));
    assert.equal(
      await (await api.readProjectAttachment(uploaded(file).objectKey)).text(),
      'project fixture',
    );
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].data.get('bizType'), 'PROJECT_ATTACHMENT');
    assert.equal(calls[0].data.get('category'), 'PROJECT_ATTACHMENT');
    assert.equal(calls[0].data.get('file'), file);
    assert.equal(calls[0].headers['Content-Type'], undefined);
    assert.equal(calls[1].method, 'GET');
    assert.equal(
      new URL(calls[1].path, 'https://example.test').searchParams.get('objectKey'),
      uploaded(file).objectKey,
    );
    assert.ok(
      calls.every(
        ({ credentials, headers }) =>
          credentials === (desktop ? 'include' : 'same-origin') && !headers.Authorization,
      ),
    );
  });
}

test('navigator response decoding rejects mismatched project, draft state, identity, category and unsafe upload result', async (t) => {
  let value;
  const { api } = adapter(t, false, () => result(value));
  value = { ...detail, id: 18 };
  await assert.rejects(api.getProjectDetail(17), (error) => error.status === 502);
  for (value of [
    { hasDraft: false, draft },
    { hasDraft: true, draft: null },
    { hasDraft: true, draft: detail },
  ])
    await assert.rejects(api.getCurrentProjectDraft(), (error) => error.status === 502);
  value = { ...requester, requesterId: '00000000-0000-4000-8000-000000000002' };
  await assert.rejects(api.getCurrentProjectRequester(userId), (error) => error.status === 502);
  value = [{ ...category, categoryLevel: '3' }];
  await assert.rejects(api.getProjectCategories(), (error) => error.status === 502);
  value = [{ ...card, projectOwners: [{ userId, name: '负责人' }] }];
  await assert.rejects(api.listNavigatorProjects(), (error) => error.status === 502);
  const file = new File(['fixture'], '要求.txt', { type: 'text/plain' });
  for (const patch of [
    { url: 'https://example.test/private' },
    { sensitive: false },
    { objectKey: 'common/fixture.txt' },
    { size: 2 },
  ]) {
    value = { ...uploaded(file), ...patch };
    await assert.rejects(api.uploadProjectAttachment(file), (error) => error.status === 502);
  }
});

test('project trust boundaries reject invalid IDs, unsupported files and path traversal before requesting', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('Should not request');
  });
  for (const id of [0, -1, 1.5, 2147483648, '17'])
    await assert.rejects(api.getProjectDetail(id), (error) => error.status === 400);
  await assert.rejects(
    api.getCurrentProjectRequester('other-user'),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.getProjectCategories({ categoryLevel: 4 }),
    (error) => error.status === 400,
  );
  await assert.rejects(api.saveProject({ operation: 'DELETE' }), (error) => error.status === 400);
  await assert.rejects(
    api.saveProject({ ...snapshot, versionNo: -1 }),
    (error) => error.status === 400,
  );
  for (const key of [
    'https://example.test/file.pdf',
    'project-attachment/../private.txt',
    'project-attachment//private.txt',
    'project-attachment/other\\file.txt',
    'common/private.txt',
  ])
    await assert.rejects(api.readProjectAttachment(key), (error) => error.status === 400);
  await assert.rejects(
    api.uploadProjectAttachment(new File([], 'empty.txt')),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.uploadProjectAttachment(new File(['fixture'], 'script.js')),
    (error) => error.status === 400,
  );
  const large = new File(['x'], 'large.txt');
  Object.defineProperty(large, 'size', { value: PROJECT_ATTACHMENT_MAX_BYTES + 1 });
  await assert.rejects(api.uploadProjectAttachment(large), (error) => error.status === 413);
  assert.equal(calls.length, 0);
});

test('attachment read errors remain API failures and are never returned as downloadable JSON', async (t) => {
  let status = 403;
  const { api, calls } = adapter(t, false, () => result(null, status));
  for (status of [403, 404, 503])
    await assert.rejects(
      api.readProjectAttachment(snapshot.attachments[1].objectKey),
      (error) => error.status === status,
    );
  status = 200;
  await assert.rejects(
    api.readProjectAttachment(snapshot.attachments[1].objectKey),
    (error) => error.status === 502,
  );
  assert.equal(calls.length, 4);
});
