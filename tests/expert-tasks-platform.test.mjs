import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import { expertTaskExample } from '../apps/server/src/modules/expert/expert-task.schema.ts';
import { requiresExpertProjectOwners } from '../packages/shared/src/expert-tasks.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';

for (const desktop of [false, true]) {
  test(`expert tasks preserve assignment/transfer sources and authenticated filters (${desktop ? 'Electron' : 'Web'})`, async () => {
    const original = globalThis.fetch;
    const cards = [
      expertTaskExample,
      {
        ...expertTaskExample,
        assignmentId: null,
        movementId: 7,
        sourceBizType: 'PROJECT_MEMBER_TRANSFER',
        sourceBizId: 7,
      },
    ];
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return Response.json({ code: 200, message: '操作成功', data: cards });
    };
    try {
      const api = createHttpAuth(
        async () => (desktop ? 'https://api.example.test' : ''),
        desktop ? 'include' : 'same-origin',
      );
      assert.deepEqual(await api.getMyExpertTasks(), cards);
      const filters = { keyword: ' 标注 & 复核 ', acceptanceStatus: 'PENDING_ACCEPTANCE' };
      assert.deepEqual(await api.getMyExpertTasks(filters), cards);
      assert.deepEqual(
        calls.map(({ options }) => JSON.parse(options.body)),
        [{}, filters],
      );
      for (const { url, options } of calls) {
        assert.equal(
          url,
          `${desktop ? 'https://api.example.test' : ''}/api/v1/expert-assignments/my-tasks`,
        );
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, desktop ? 'include' : 'same-origin');
        assert.equal(options.headers['X-Tyde-Client'], 'web');
        assert.equal(options.headers['Content-Type'], 'application/json');
      }
      for (const filters of [
        { keyword: 2 },
        { keyword: 'x'.repeat(101) },
        { status: 'OTHER' },
        { acceptanceStatus: 'ACCEPTED', status: 'REJECTED' },
      ])
        await assert.rejects(api.getMyExpertTasks(filters), { status: 400 });
      assert.equal(calls.length, 2);
      for (const invalid of [
        { ...expertTaskExample, sourceBizId: 9 },
        { ...expertTaskExample, movementId: 7 },
        { ...cards[1], assignmentId: 1 },
        { ...cards[1], movementId: 2147483648, sourceBizId: 2147483648 },
        {
          ...expertTaskExample,
          operations: { ...expertTaskExample.operations, canAccept: 'true' },
        },
      ]) {
        globalThis.fetch = async () =>
          Response.json({ code: 200, message: '操作成功', data: [invalid] });
        await assert.rejects(api.getMyExpertTasks(), { status: 502 });
      }
      globalThis.fetch = async () =>
        Response.json({ code: 'FORBIDDEN', message: '无权限', data: null }, { status: 403 });
      await assert.rejects(api.getMyExpertTasks(), { status: 403, message: '无权限' });
    } finally {
      globalThis.fetch = original;
    }
  });
}

test('only the matching active organization owner selects first-acceptance owners; an ordinary member with no remaining project owners does not', () => {
  const task = {
    ...expertTaskExample,
    basicInfo: {
      ...expertTaskExample.basicInfo,
      subjectType: 'ORGANIZATION',
      organizationId,
      projectOwners: [],
    },
  };
  const owner = { id: organizationId, position: 'OWNER', joinStatus: 'ACTIVE' };
  const user = { organization: null, organizations: [owner] };
  assert.equal(requiresExpertProjectOwners(task, user), true);
  for (const membership of [
    { ...owner, id: ownerId },
    { ...owner, position: 'MEMBER' },
    { ...owner, position: 'ADMIN' },
    { ...owner, joinStatus: 'LEFT' },
  ])
    assert.equal(
      requiresExpertProjectOwners(task, { ...user, organizations: [membership] }),
      false,
    );
  assert.equal(requiresExpertProjectOwners({ ...task, acceptanceStatus: 'ACCEPTED' }, user), false);
  assert.equal(
    requiresExpertProjectOwners({ ...task, assignmentId: null, movementId: 7 }, user),
    false,
  );
  assert.equal(requiresExpertProjectOwners(expertTaskExample, user), false);
  assert.equal(requiresExpertProjectOwners(task, { organization: owner }), true);
});

for (const desktop of [false, true]) {
  test(`expert acceptance uses real owner candidates, preserves response sources, and never retries an unknown write (${desktop ? 'Electron' : 'Web'})`, async () => {
    const original = globalThis.fetch;
    const base = desktop ? 'https://api.example.test' : '';
    const api = createHttpAuth(async () => base, desktop ? 'include' : 'same-origin');
    const candidates = [
      {
        userId: ownerId,
        uid: 'u1',
        name: '负责人',
        avatarUrl: null,
        position: 'MEMBER',
        projectOwner: false,
      },
    ];
    const calls = [];
    const accepted = {
      assignmentId: 1,
      movementId: null,
      status: 'ACCEPTED',
      memberStatus: null,
      nextAction: 'WAIT_ENTRY_CONFIRMATION',
      notifiedMemberCount: 0,
    };
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        code: 200,
        message: '操作成功',
        data: options.method === 'GET' ? candidates : accepted,
      });
    };
    try {
      assert.deepEqual(await api.getExpertProjectOwnerCandidates(1), candidates);
      assert.equal(
        calls[0].url,
        `${base}/api/v1/expert-assignments/project-owner-candidates?assignmentId=1`,
      );
      assert.equal(calls[0].options.method, 'GET');
      const individual = { assignmentId: 1, decision: 'ACCEPT' };
      assert.deepEqual(await api.respondExpertTask(individual), accepted);
      const organization = { ...individual, projectOwnerUserIds: [ownerId] };
      await api.respondExpertTask(organization);
      assert.deepEqual(JSON.parse(calls[2].options.body), organization);
      const memberRejected = {
        ...accepted,
        status: 'ACCEPTED',
        memberStatus: 'REJECTED',
        nextAction: 'VIEW_RESULT',
      };
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return Response.json({ code: 200, message: '操作成功', data: memberRejected });
      };
      assert.deepEqual(
        await api.respondExpertTask({
          assignmentId: 1,
          decision: 'REJECT',
          rejectReason: '暂不参加',
        }),
        memberRejected,
      );
      for (const legacy of [false, true]) {
        const transfer = {
          ...accepted,
          assignmentId: legacy ? 1 : null,
          movementId: 7,
          nextAction: 'TAKE_ENTRANCE_EXAM',
        };
        globalThis.fetch = async (url, options) => {
          calls.push({ url, options });
          return Response.json({ code: 200, message: '操作成功', data: transfer });
        };
        assert.deepEqual(
          await api.respondExpertTask(legacy ? individual : { movementId: 7, decision: 'ACCEPT' }),
          transfer,
        );
      }
      for (const { url, options } of calls.slice(1)) {
        assert.equal(url, `${base}/api/v1/expert-assignments/respond`);
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, desktop ? 'include' : 'same-origin');
        assert.equal(options.headers['X-Tyde-Client'], 'web');
        assert.equal(options.headers['Content-Type'], 'application/json');
      }
      const count = calls.length;
      for (const input of [
        { decision: 'ACCEPT' },
        { assignmentId: 1, movementId: 7, decision: 'ACCEPT' },
        { assignmentId: 2147483648, decision: 'ACCEPT' },
        { ...individual, decision: 'OTHER' },
        { ...individual, decision: 'REJECT', rejectReason: '  ' },
        { ...individual, decision: 'REJECT', rejectReason: 'x'.repeat(501) },
        { ...individual, projectOwnerUserIds: ['bad'] },
        { movementId: 7, decision: 'ACCEPT', projectOwnerUserIds: [ownerId] },
      ])
        await assert.rejects(api.respondExpertTask(input), { status: 400 });
      for (const id of [0, 1.2, 2147483648, '1'])
        await assert.rejects(api.getExpertProjectOwnerCandidates(id), { status: 400 });
      assert.equal(calls.length, count);
      for (const invalid of [
        { ...accepted, assignmentId: 2 },
        { ...accepted, memberStatus: 'PENDING' },
        { ...accepted, nextAction: 'OTHER' },
        { ...accepted, notifiedMemberCount: -1 },
        { ...accepted, movementId: 2147483648 },
      ]) {
        globalThis.fetch = async () =>
          Response.json({ code: 200, message: '操作成功', data: invalid });
        await assert.rejects(api.respondExpertTask(individual), { status: 502 });
      }
      for (const failure of [0, 409, 500]) {
        let writes = 0;
        globalThis.fetch = async () => {
          writes++;
          if (!failure) throw new TypeError('network lost after send');
          return Response.json(
            { code: 'CONFLICT', message: '请刷新任务状态' },
            { status: failure },
          );
        };
        await assert.rejects(api.respondExpertTask(individual), { status: failure });
        assert.equal(writes, 1);
      }
      globalThis.fetch = async () =>
        Response.json({
          code: 200,
          message: '操作成功',
          data: [{ ...candidates[0], userId: 'bad' }],
        });
      await assert.rejects(api.getExpertProjectOwnerCandidates(1), { status: 502 });
    } finally {
      globalThis.fetch = original;
    }
  });
}
