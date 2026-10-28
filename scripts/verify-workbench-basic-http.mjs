import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// 仅通过正在运行的本机HTTP服务验证108；复用08验收的专用账号和项目，不连接数据库。
const base = 'http://127.0.0.1:3000/api/v1';
const root = new URL('../', import.meta.url);
const fixtureUrl = new URL('.local/exam-candidate-http-acceptance/state.json', root);
const reportDir = new URL('.local/workbench-basic-http/', root);
const reportUrl = new URL(
  `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  reportDir,
);
const results = [];
const sessions = [];
const report = {
  startedAt: new Date().toISOString(),
  base,
  scope:
    '复用08专用数据；仅Bearer真实HTTP读取、当前新会话角色切换和退出；无业务数据写入、数据库连接或迁移。',
  results,
};
function check(name, fn) {
  try {
    fn();
    results.push({ name, kind: 'assertion', pass: true });
  } catch {
    results.push({ name, kind: 'assertion', pass: false });
    throw new Error(name);
  }
}
async function request(
  name,
  path,
  { method = 'GET', body, session, expected = 200, headers = {} } = {},
) {
  // Node fetch会自动附加sec-fetch-mode，与桌面Bearer来源契约冲突；使用原生HTTP精确发送头。
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      base + path,
      {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          'x-tyde-client': 'desktop',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
          ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            incoming.destroy(new Error('HTTP响应超过验收工具8MiB限制'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
  results.push({
    name,
    kind: 'http',
    method,
    path,
    expected,
    actual: response.status,
    pass: response.status === expected,
  });
  if (response.status !== expected)
    throw new Error(`${name}：预期${expected}，实际${response.status}`);
  const envelope = JSON.parse(response.text);
  // 先交给调用方保存登录凭证，保证后续断言失败时仍能退出新会话。
  return envelope;
}
async function login(key, role, fixture) {
  const account = fixture.users[key];
  assert(
    account?.phone && account.password && account.profile?.id,
    `缺少08专用账号${key}，未发起登录`,
  );
  const envelope = await request(`${key}/${role}新会话登录`, '/auth/login', {
    method: 'POST',
    body: { account: account.phone, password: account.password, role },
  });
  const session = { key, role, ...envelope.data };
  assert(session.accessToken, '登录未返回访问凭证');
  sessions.push(session);
  const profile = (await request(`${key}/${role}身份核对`, '/users/me', { session })).data;
  check(`${key}/${role}仅使用原专用账号及当前会话角色`, () => {
    assert.equal(profile.id, account.profile.id);
    assert.equal(profile.role, role);
  });
  return session;
}
const path = '/projects/workbench/board/project-detail';
async function basic(name, projectId, session, expected = 200, headers = {}) {
  const envelope = await request(name, path, {
    method: 'POST',
    body: { projectId },
    session,
    expected,
    headers,
  });
  check(`${name}结果封装`, () => {
    assert.equal(envelope.code, expected);
    if (expected !== 200) assert.equal(envelope.data, null);
  });
  return envelope.data;
}

try {
  const ready = await request('本机后端就绪', '/health/ready');
  check('数据库就绪状态', () => assert.equal(ready.status, 'ready'));
  const live = await request('本机后端存活', '/health/live');
  check('后端应用身份', () => assert.equal(live.application, 'tyde'));
  const spec = await request('读取运行中Swagger', '/docs/json');
  check('108真实POST路由与完整字段已注册', () => {
    assert.equal(spec.paths['/api/v1' + path].post.operationId, 'getProjectBoardBasicDetail');
  });
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const projects = Object.entries(fixture.projects).map(([key, project]) => ({
    key,
    id: project.id,
  }));
  assert.equal(projects.length, 3, '08专用项目清单不完整');
  for (const project of projects) assert(Number.isInteger(project.id) && project.id > 0);
  report.projectIds = projects.map((p) => p.id);
  await basic('匿名基础详情拒绝', projects[0].id, undefined, 401);
  const actors = {};
  for (const [key, role] of [
    ['nav', 'NAVIGATOR'],
    ['pm', 'PM'],
    ['owner', 'EXPERT'],
    ['lead', 'EXPERT'],
    ['member', 'EXPERT'],
    ['personal', 'EXPERT'],
    ['outsider', 'NAVIGATOR'],
  ])
    actors[key] = await login(key, role, fixture);
  const navExpert = await login('nav', 'EXPERT', fixture);
  const required = [
    'projectId',
    'projectNo',
    'projectName',
    'projectDescription',
    'requesterType',
    'requesterId',
    'requesterName',
    'categoryLevel1Id',
    'categoryLevel1Name',
    'categoryLevel2Id',
    'categoryLevel2Name',
    'categoryLevel3Ids',
    'categoryLevel3Names',
    'difficultyLevel',
    'projectQuantity',
    'quantityUnit',
    'deadline',
    'requiredHeadcount',
    'educationRequirement',
    'employmentType',
    'experienceRequirement',
    'workSummary',
    'specialRequirement',
    'mandatoryRequirement',
    'standardContent',
    'standardLink',
    'status',
    'currentNodeCode',
    'publishedAt',
    'closedAt',
  ];
  for (const project of projects) {
    const before = (
      await request(`${project.key}已实现项目详情基线`, `/projects/${project.id}`, {
        session: actors.nav,
      })
    ).data;
    const baseline = await basic(`${project.key}创建人视角`, project.id, actors.nav);
    check(`${project.key}基础字段及分类实时名称与既有详情一致`, () => {
      assert.deepEqual(Object.keys(baseline).sort(), [...required].sort());
      assert.equal(baseline.projectId, before.id);
      for (const key of required.filter(
        (key) => !['projectId', 'publishedAt', 'closedAt'].includes(key),
      ))
        assert.deepEqual(baseline[key], before[key]);
      for (const key of ['deadline', 'publishedAt', 'closedAt'])
        assert(
          baseline[key] === null || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(baseline[key]),
        );
    });
    for (const key of ['pm', 'owner', 'lead']) {
      const detail = await basic(`${project.key}/${key}当前关系允许`, project.id, actors[key]);
      check(`${project.key}/${key}基础响应口径一致`, () => assert.deepEqual(detail, baseline));
    }
    for (const key of ['member', 'personal', 'outsider'])
      await basic(`${project.key}/${key}缺少管理关系拒绝`, project.id, actors[key], 403);
    await basic(`${project.key}同账号其他EXPERT会话不继承创建人权限`, project.id, navExpert, 403);
    const after = (
      await request(`${project.key}项目版本和详情回读`, `/projects/${project.id}`, {
        session: actors.nav,
      })
    ).data;
    check(`${project.key}读取不改变项目详情及版本`, () => assert.deepEqual(after, before));
  }
  await request('切换本次NAV会话到EXPERT', '/auth/switch-role', {
    method: 'POST',
    session: actors.nav,
    body: { role: 'EXPERT' },
  });
  await basic('切换角色立即收回创建人视角', projects[0].id, actors.nav, 403);
  await request('恢复本次NAV会话', '/auth/switch-role', {
    method: 'POST',
    session: actors.nav,
    body: { role: 'NAVIGATOR' },
  });
  await basic('恢复角色重新获取创建人视角', projects[0].id, actors.nav);
  await basic('另一EXPERT会话保持独立', projects[0].id, navExpert, 403);
  for (const projectId of [0, -1, 1.5, 2147483648, 'abc'])
    await request(`非法ID ${projectId}`, path, {
      method: 'POST',
      session: actors.nav,
      body: { projectId },
      expected: 400,
    });
  await request('缺失项目ID', path, {
    method: 'POST',
    session: actors.nav,
    body: {},
    expected: 400,
  });
  await basic('不存在项目统一403', 2147483647, actors.nav, 403);
  await basic('不可信来源拒绝', projects[0].id, actors.nav, 403, {
    origin: 'https://untrusted.example',
  });
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  for (const session of sessions) {
    try {
      await request(`${session.key}/${session.role}退出本次新会话`, '/auth/logout', {
        method: 'POST',
        session,
        body: { refreshToken: session.refreshToken },
      });
      await request(`${session.key}/${session.role}退出后401`, '/users/me', {
        session,
        expected: 401,
      });
    } catch (error) {
      report.cleanupErrors ??= [];
      report.cleanupErrors.push({ account: session.key, role: session.role, error: error.message });
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.checks = results.length;
  report.passed = results.filter((r) => r.pass).length;
  report.httpRequests = results.filter((r) => r.kind === 'http').length;
  report.newSessions = sessions.length;
  report.closedSessions = results.filter((r) => r.name.endsWith('退出后401') && r.pass).length;
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        checks: report.checks,
        passed: report.passed,
        httpRequests: report.httpRequests,
        newSessions: report.newSessions,
        closedSessions: report.closedSessions,
        error: report.error ?? null,
        cleanupErrors: report.cleanupErrors ?? [],
        report: reportUrl.pathname,
      },
      null,
      2,
    ),
  );
}
