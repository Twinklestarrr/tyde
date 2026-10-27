import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';

const userId = '00000000-0000-4000-8000-000000000001';
const wallTime = '2026-10-27 09:30:01';
const card = {
  id: 17,
  projectNo: 'PRJ-FIXTURE-17',
  projectName: '生产计划测试项目',
  projectDescription: null,
  categoryLevel1Name: null,
  categoryLevel2Name: null,
  categoryLevel3Names: [],
  categoryDisplayName: '未分类项目',
  status: 'PUBLISHED',
  statusDescription: '已发布',
  currentNodeCode: 'PRODUCTION_PLAN',
  branchNodeCode: null,
  workbenchStatus: 'PROCESSING',
  workbenchStatusDescription: '处理中',
  currentAction: 'VIEW_DETAIL',
  currentActionDescription: '查看项目详情',
  primaryProjectManager: true,
  expertRecruitmentHandler: false,
  needAssistGrading: false,
  requesterName: '测试领航员',
  creatorId: null,
  creatorName: '测试领航员',
  projectManagerId: userId,
  projectManagerName: '测试策略官',
  projectManagerStatusDescription: '已指定',
  projectOwners: [],
  activeExpertCount: 0,
  requiredHeadcount: null,
  deadline: null,
  createdAt: wallTime,
  updatedAt: wallTime,
};
const reference = {
  projectQuantity: 100000.25,
  quantityUnit: '条',
  deadline: '2099-12-31 23:59:59',
  requiredHeadcount: 30,
  educationRequirement: 'BACHELOR',
  employmentType: 'PART_TIME',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  mandatoryRequirement: '遵守规范',
};
const emptyStage = (stageName, sequenceNo) => ({
  id: null,
  sequenceNo,
  stageName,
  startDate: null,
  endDate: null,
  naturalDayCount: null,
  workdayCount: null,
  workdayCountSource: 'AUTO',
  operatorHeadcount: null,
  operatorCpd: null,
  accuracyRate: null,
  expectedOutput: null,
});
const initial = {
  hasPlan: false,
  editable: true,
  id: null,
  projectId: 17,
  currentNodeCode: 'PRODUCTION_PLAN',
  operatorHeadcount: null,
  operatorCpd: null,
  inspectorHeadcount: null,
  inspectorCpd: null,
  needWrittenExam: true,
  maxActiveExamCount: 1,
  needInterview: false,
  totalExpectedOutput: null,
  confirmedBy: null,
  confirmedAt: null,
  nextStage: null,
  extJson: null,
  projectReference: reference,
  crowds: [{ id: null, sequenceNo: 1, crowdName: null, profileRequirement: null }],
  stages: [emptyStage('爬坡期', 1), emptyStage('稳定生产期', 2)],
};
const input = {
  operatorHeadcount: 20,
  operatorCpd: 500.25,
  inspectorHeadcount: 5,
  inspectorCpd: 800.125,
  needWrittenExam: false,
  maxActiveExamCount: 2,
  needInterview: true,
  extJson: { note: '计划备注', values: [null, false, 0, '说明'] },
  crowds: [{ crowdName: '第一梯队', profileRequirement: '具备相关经验' }],
  stages: [
    {
      stageName: '爬坡期',
      startDate: '2099-01-05',
      endDate: '2099-01-09',
      workdayCountSource: 'MANUAL',
      workdayCount: 5,
      operatorHeadcount: 20,
      operatorCpd: null,
      accuracyRate: 98.5,
    },
  ],
};
const saved = {
  ...initial,
  ...input,
  hasPlan: true,
  editable: false,
  id: 51,
  currentNodeCode: 'PRODUCTION_TASK',
  totalExpectedOutput: 50025,
  confirmedBy: 'PM-FIXTURE-1',
  confirmedAt: wallTime,
  nextStage: 'STANDARD_TRAINING',
  crowds: [{ id: 61, sequenceNo: 1, ...input.crowds[0] }],
  stages: [
    {
      ...input.stages[0],
      id: 71,
      sequenceNo: 1,
      naturalDayCount: 5,
      operatorCpd: 500.25,
      expectedOutput: 50025,
    },
  ],
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 3600,
};
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
  test(`${mode} strategist pending list and production-plan reads use their actual unpaged Cookie contracts`, async (t) => {
    let plan = initial;
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      result(path === '/api/v1/projects/manager/list' ? [card] : plan),
    );
    assert.deepEqual(await api.listStrategistProjects(), [card]);
    assert.deepEqual(await api.getProjectProductionPlan(17), initial);
    plan = { ...initial, editable: false };
    assert.deepEqual(await api.getProjectProductionPlan(17), plan);
    plan = saved;
    assert.deepEqual(await api.getProjectProductionPlan(17), saved);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/projects/manager/list',
        ...Array(3).fill('/api/v1/projects/production-plan?projectId=17'),
      ],
    );
    assert.ok(
      calls.every(
        ({ method, body, credentials, headers }) =>
          method === 'GET' &&
          body === undefined &&
          !headers.Authorization &&
          !headers['X-Tyde-Client'] &&
          credentials === (desktop ? 'include' : 'same-origin'),
      ),
    );
    assert.equal(saved.currentNodeCode, 'PRODUCTION_TASK');
    assert.equal(saved.nextStage, 'STANDARD_TRAINING');
  });

  test(`${mode} production confirmation preserves the complete plan snapshot and query projectId without an invented idempotency key`, async (t) => {
    const { api, calls } = adapter(t, desktop, () => result(saved));
    assert.deepEqual(await api.confirmProjectProductionPlan(17, input), saved);
    const call = calls[0];
    assert.equal(call.path, '/api/v1/projects/production-plan/confirm?projectId=17');
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.data, input);
    assert.equal(call.data.projectId, undefined);
    assert.equal(call.headers['X-Tyde-Client'], 'web');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers['Idempotency-Key'], undefined);
    assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
  });

  test(`${mode} production failures preserve real statuses and never replay unknown non-idempotent confirmation`, async (t) => {
    let outcome = 400;
    const { api, calls } = adapter(t, desktop, () => {
      if (outcome === 'network') throw new TypeError('offline');
      if (outcome === 'malformed') return result(initial);
      return result(null, outcome);
    });
    for (outcome of [400, 403, 404, 409, 500, 503]) {
      const before = calls.length;
      await assert.rejects(
        api.confirmProjectProductionPlan(17, input),
        (error) => error.status === outcome && error.message === '服务端真实错误',
      );
      assert.equal(calls.length, before + 1);
    }
    outcome = 'network';
    await assert.rejects(
      api.confirmProjectProductionPlan(17, input),
      (error) => error.status === 0 && error.code === 'NETWORK_ERROR',
    );
    outcome = 'malformed';
    await assert.rejects(
      api.confirmProjectProductionPlan(17, input),
      (error) => error.status === 502,
    );
    assert.equal(calls.length, 8);
  });

  test(`${mode} explicit 401 refreshes once and retains the exact confirmation body`, async (t) => {
    let attempts = 0;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path === '/api/v1/auth/login') return result(tokens);
      if (path === '/api/v1/auth/refresh')
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      return ++attempts === 1 ? result(null, 401) : result(saved);
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    assert.deepEqual(await api.confirmProjectProductionPlan(17, input), saved);
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/api/v1/auth/login',
        '/api/v1/projects/production-plan/confirm?projectId=17',
        '/api/v1/auth/refresh',
        '/api/v1/projects/production-plan/confirm?projectId=17',
      ],
    );
    assert.equal(calls[1].body, calls[3].body);
    assert.equal(attempts, 2);
  });
}

test('production-plan decoding accepts very large JSON numeric outputs without claiming safe-integer precision or recomputing server totals', async (t) => {
  const huge = {
    ...saved,
    operatorCpd: 9007199254740992,
    totalExpectedOutput: 1e25,
    stages: [{ ...saved.stages[0], operatorCpd: 9007199254740992, expectedOutput: 1e25 }],
  };
  const { api } = adapter(t, false, () => result(huge));
  assert.deepEqual(await api.getProjectProductionPlan(17), huge);
  assert.deepEqual(
    await api.confirmProjectProductionPlan(17, { ...input, operatorCpd: 9007199254740992 }),
    huge,
  );
});

test('production input preserves AUTO/default and overlapping stages without adding unsupported chronology or manual-day ceilings', async (t) => {
  const body = {
    ...input,
    inspectorHeadcount: null,
    inspectorCpd: null,
    needWrittenExam: null,
    needInterview: null,
    maxActiveExamCount: null,
    extJson: [false, 1, null],
    stages: [
      { ...input.stages[0], workdayCountSource: 'AUTO', workdayCount: null },
      { ...input.stages[0], workdayCount: 99 },
    ],
  };
  const { api, calls } = adapter(t, false, () => result(saved));
  await api.confirmProjectProductionPlan(17, body);
  assert.deepEqual(calls[0].data, body);
});

test('production decoding requires full typed state, reference fields, sequential persisted rows and a matching project', async (t) => {
  let data;
  const { api } = adapter(t, false, () => result(data));
  for (const patch of [
    { projectId: 18 },
    { hasPlan: 'true' },
    { editable: true },
    { id: null },
    { operatorHeadcount: 0 },
    { operatorCpd: '500.25' },
    { inspectorCpd: null },
    { needWrittenExam: null },
    { maxActiveExamCount: 0 },
    { needInterview: null },
    { confirmedAt: '2026-02-30 09:30:01' },
    { confirmedBy: null },
    { nextStage: 'ENTRANCE_EXAM' },
    { totalExpectedOutput: null },
    { extJson: undefined },
    { projectReference: { ...reference, requiredHeadcount: undefined } },
    { projectReference: { ...reference, educationRequirement: 'OTHER' } },
    { crowds: [{ ...saved.crowds[0], sequenceNo: 2 }] },
    { crowds: [{ ...saved.crowds[0], crowdName: null }] },
    { stages: [{ ...saved.stages[0], id: null }] },
    { stages: [{ ...saved.stages[0], expectedOutput: null }] },
    { stages: [{ ...saved.stages[0], startDate: '2099-02-30' }] },
    { stages: [{ ...saved.stages[0], accuracyRate: 101 }] },
  ]) {
    data = { ...saved, ...patch };
    await assert.rejects(api.getProjectProductionPlan(17), (error) => error.status === 502);
  }
  data = { ...initial, operatorHeadcount: 20 };
  await assert.rejects(api.getProjectProductionPlan(17), (error) => error.status === 502);
  for (const patch of [{ primaryProjectManager: undefined }, { expertRecruitmentHandler: 1 }]) {
    data = [{ ...card, ...patch }];
    await assert.rejects(api.listStrategistProjects(), (error) => error.status === 502);
  }
});

test('production trust boundaries reject invalid IDs, fields, decimals, JSON and conditional stage values before requesting', async (t) => {
  const { api, calls } = adapter(t, false, () => {
    throw new Error('Should not request');
  });
  for (const id of [0, -1, 1.5, 2147483648, '17']) {
    await assert.rejects(api.getProjectProductionPlan(id), (error) => error.status === 400);
    await assert.rejects(
      api.confirmProjectProductionPlan(id, input),
      (error) => error.status === 400,
    );
  }
  const cycle = {};
  cycle.self = cycle;
  for (const patch of [
    { projectId: 17 },
    { operatorHeadcount: 0 },
    { operatorHeadcount: 2147483648 },
    { operatorCpd: 1e16 },
    { operatorCpd: 0.00001 },
    { operatorCpd: 1.23456 },
    { inspectorCpd: null },
    { inspectorHeadcount: 1.5 },
    { maxActiveExamCount: -1 },
    { needWrittenExam: 'false' },
    { needInterview: 1 },
    { extJson: cycle },
    { extJson: { invalid: Infinity } },
    { crowds: [] },
    { stages: [] },
    { crowds: Array(51).fill(input.crowds[0]) },
    { crowds: [{ crowdName: '  ', profileRequirement: '说明' }] },
    { stages: [{ ...input.stages[0], id: 1 }] },
    { stages: [{ ...input.stages[0], workdayCount: null }] },
    { stages: [{ ...input.stages[0], workdayCountSource: 'AUTO', workdayCount: 0 }] },
    { stages: [{ ...input.stages[0], operatorHeadcount: null }] },
    { stages: [{ ...input.stages[0], operatorCpd: 0 }] },
    { stages: [{ ...input.stages[0], accuracyRate: 100.0001 }] },
    { stages: [{ ...input.stages[0], endDate: '2099-01-04' }] },
    { stages: [{ ...input.stages[0], startDate: '0000-01-01' }] },
  ])
    await assert.rejects(
      api.confirmProjectProductionPlan(17, { ...input, ...patch }),
      (error) => error.status === 400,
    );
  assert.equal(calls.length, 0);
});
