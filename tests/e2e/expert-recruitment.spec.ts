import { expect, test, type Page } from '@playwright/test';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { productionPlanResponse } from '../../apps/server/src/modules/projects/project-production-plan.schema';
import {
  recruitmentDetailExample,
  recruitmentPageExample,
} from '../../apps/server/src/modules/projects/project-recruitment.schema';
import { handlerExample } from '../../apps/server/src/modules/projects/project-recruitment-handler.schema';
import type { AuthUser, WorkbenchProjectDetail } from '../../packages/shared/src/index';
import type { RecruitmentCandidate } from '../../apps/server/src/modules/projects/project-recruitment-candidates';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'RECRUIT10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '招募联调员',
  realName: '测试策略官',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'PM',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'PM',
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  organizations: [],
  createdAt: '2026-11-03T02:00:00.000Z',
  updatedAt: '2026-11-03T02:00:00.000Z',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectNo: 'RECRUIT-PROJECT-3001',
  projectName: '执行专家招募项目',
  currentNodeCode: 'RECRUIT_EXECUTION_EXPERT',
  versionNo: 4,
  attachments: [],
} as WorkbenchProjectDetail;
type Candidate = RecruitmentCandidate & { availableAction: string };
const candidate = (id: number, organization = false): Candidate => ({
  ...recruitmentPageExample.records[0],
  subjectId: uuid(id),
  subjectType: organization ? 'ORGANIZATION' : 'INDIVIDUAL',
  realName: null,
  nickname: organization ? null : id === 3 ? '个人候选甲' : `个人候选${id}`,
  organizationName: organization ? (id === 4 ? '协作组织甲' : `协作组织${id}`) : null,
  supervisorName: organization ? '组织主管' : null,
  supervisorNickname: null,
  description: '具备所需生产能力',
  assignment: null,
  availableAction: 'RECRUIT',
});
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** 五个招募 API 与项目待办均为隔离内存 HTTP 夹具，不连接数据库或真实人员。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'recruit_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const rejected = candidate(5, true);
  rejected.organizationName = '已拒单组织';
  rejected.assignment = {
    assignmentId: 12,
    status: 'REJECTED',
    productionRequirement: 20,
    operatorHeadcount: 2,
    inspectorHeadcount: null,
  };
  rejected.availableAction = 'RECRUIT_AGAIN';
  const accepted = candidate(6);
  accepted.nickname = '已接单成员';
  accepted.assignment = {
    assignmentId: 13,
    status: 'ACCEPTED',
    productionRequirement: 10,
    operatorHeadcount: 1,
    inspectorHeadcount: null,
  };
  accepted.availableAction = 'NONE';
  const state = {
    user: structuredClone(user),
    detail: {
      ...structuredClone(recruitmentDetailExample),
      projectName: project.projectName,
      primaryManager: {
        userId: user.id,
        uid: user.uid,
        name: '主策略官',
        avatarUrl: null as string | null,
      },
      handler: {
        userId: uuid(2),
        uid: 'HANDLER10002',
        name: '当前招募负责人',
        avatarUrl: null as string | null,
      },
      summary: {
        ...recruitmentDetailExample.summary,
        rejectedCount: 1,
        acceptedCount: 1,
        activeAssignmentCount: 1,
        assignedProductionRequirement: 10,
        remainingProductionRequirement: 90,
      },
    },
    candidates: [
      candidate(4, true),
      rejected,
      accepted,
      candidate(3),
      ...Array.from({ length: 18 }, (_, index) => candidate(index + 20, index % 2 === 0)),
    ],
    handlers: [
      { ...handlerExample, userId: uuid(2), name: '当前招募负责人', currentHandler: true },
      { ...handlerExample, userId: uuid(9), name: '候选负责人', currentHandler: false },
    ],
    detailStatus: 200,
    candidatesStatus: 200,
    handlerStatus: 200,
    submitStatus: 200,
    handlerWriteStatus: 200,
    unknownSubmit: false,
    applyUnknownSubmit: false,
    unknownHandler: false,
    applyUnknownHandler: false,
    holdSubmit: false,
    failReadAfterSubmit: false,
    failListAfterSubmit: false,
    listStatus: 200,
    submitted: false,
    remains: true,
  };
  const requests: RequestLog[] = [];
  let releaseSubmit: (() => Promise<void>) | undefined;
  let assignmentSequence = 100;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body: headers['content-type']?.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
      headers,
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!headers.cookie?.includes('recruit_session=active')) return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/projects/workbench/statistics')
      return reply({
        mode: 'TASK',
        pendingTaskCount: 1,
        completedTaskCount: 0,
        involvedProjectCount: 1,
      });
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      const role = log.body?.role as AuthUser['role'];
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (log.path === '/api/v1/expert-assignments/my-tasks' || log.path === '/api/v1/projects/list')
      return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`)
      return reply({ ...project, currentNodeCode: state.detail.currentNodeCode });
    if (log.path === '/api/v1/projects/production-plan')
      return reply(productionPlanResponse.examples[0]);
    if (log.path === '/api/v1/projects/manager/list')
      return reply(
        state.listStatus === 200
          ? state.submitted && !state.remains
            ? []
            : [
                {
                  ...strategistProjectCard({
                    ...project,
                    currentNodeCode: state.detail.currentNodeCode,
                  }),
                  primaryProjectManager: state.detail.canChangeHandler,
                  expertRecruitmentHandler: !state.detail.canChangeHandler,
                },
              ]
          : null,
        state.listStatus,
        '后续待办暂时无法读取',
      );
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return reply(
        state.detailStatus === 200 ? state.detail : null,
        state.detailStatus,
        state.detailStatus === 403 ? '当前任职没有招募权限' : '招募详情读取结果',
      );
    if (log.path === '/api/v1/projects/expert-recruitments/candidates') {
      if (state.candidatesStatus !== 200)
        return reply(null, state.candidatesStatus, '候选暂时无法读取');
      const current = Number(log.query.current ?? 1);
      const size = Number(log.query.size ?? 20);
      const keyword = log.query.keyword?.trim() ?? '';
      const records = state.candidates.filter(
        (row) =>
          (!log.query.subjectType || row.subjectType === log.query.subjectType) &&
          (!keyword ||
            `${row.nickname ?? ''}${row.realName ?? ''}${row.organizationName ?? ''}`.includes(
              keyword,
            )),
      );
      return reply({
        records: records.slice((current - 1) * size, current * size),
        total: records.length,
        current,
        size,
        pages: Math.ceil(records.length / size),
      });
    }
    if (log.path === '/api/v1/projects/expert-recruitments/handler-candidates')
      return reply(
        state.handlerStatus === 200 ? state.handlers : null,
        state.handlerStatus,
        '负责人候选读取结果',
      );
    if (log.path === '/api/v1/projects/expert-recruitment-handler/change') {
      if (state.handlerWriteStatus !== 200)
        return reply(null, state.handlerWriteStatus, '招募负责人已变化');
      const apply = () => {
        const handler = state.handlers.find((row) => row.userId === log.body?.handlerUserId)!;
        state.detail.handler = {
          userId: handler.userId,
          uid: handler.uid,
          name: handler.name,
          avatarUrl: handler.avatarUrl,
        };
        state.handlers.forEach((row) => {
          row.currentHandler = row.userId === handler.userId;
        });
      };
      if (state.unknownHandler) {
        if (state.applyUnknownHandler) apply();
        return route.abort('failed');
      }
      apply();
      return reply(null);
    }
    if (log.path === '/api/v1/projects/expert-recruitments/submit') {
      if (state.submitStatus !== 200)
        return reply(
          null,
          state.submitStatus,
          state.submitStatus === 403 ? '当前任职不能下发' : '候选分配已变化，请重新核实',
        );
      const apply = () => {
        state.submitted = true;
        state.detail.currentNodeCode = 'PERSONNEL_MANAGEMENT';
        const rows = log.body!.assignments as {
          subjectType: string;
          subjectId: string;
          productionRequirement: number;
          operatorHeadcount: number;
          inspectorHeadcount?: number | null;
          sourceRejectedAssignmentId?: number | null;
        }[];
        for (const item of rows) {
          const found = state.candidates.find(
            (row) => row.subjectType === item.subjectType && row.subjectId === item.subjectId,
          )!;
          found.assignment = {
            assignmentId: ++assignmentSequence,
            status: 'PENDING_ACCEPTANCE',
            productionRequirement: item.productionRequirement,
            operatorHeadcount: item.operatorHeadcount,
            inspectorHeadcount: item.inspectorHeadcount ?? null,
          };
          found.availableAction = 'NONE';
          if (item.sourceRejectedAssignmentId) {
            const source = state.candidates.find(
              (row) => row.assignment?.assignmentId === item.sourceRejectedAssignmentId,
            );
            if (source?.assignment) {
              source.assignment.status = 'REPLACED';
              source.availableAction = 'NONE';
            }
          }
          state.detail.summary.activeAssignmentCount++;
          state.detail.summary.pendingAcceptanceCount++;
          state.detail.summary.assignedProductionRequirement += item.productionRequirement;
        }
        state.detail.summary.remainingProductionRequirement = Math.max(
          0,
          100 - state.detail.summary.assignedProductionRequirement,
        );
        if (state.failReadAfterSubmit) state.detailStatus = 503;
        if (state.failListAfterSubmit) state.listStatus = 503;
      };
      if (state.unknownSubmit) {
        if (state.applyUnknownSubmit) apply();
        return route.abort('failed');
      }
      const finish = async () => {
        apply();
        await reply(null);
      };
      if (state.holdSubmit) {
        releaseSubmit = finish;
        return;
      }
      return finish();
    }
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, releaseSubmit: async () => releaseSubmit?.() };
}

const submissions = (requests: RequestLog[]) =>
  requests.filter((request) => request.path.endsWith('/expert-recruitments/submit'));
const handlerWrites = (requests: RequestLog[]) =>
  requests.filter((request) => request.path.endsWith('/expert-recruitment-handler/change'));

async function openRecruitment(page: Page) {
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=RECRUIT_EXECUTION_EXPERT`);
  const panel = page.getByRole('region', { name: '招募执行专家', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function addAssignment(page: Page, name: string, action = '加入下发') {
  const panel = page.getByRole('region', { name: '招募执行专家', exact: true });
  const edit = panel.getByRole('button', { name: '更换执行专家', exact: true });
  if (await edit.isVisible()) await edit.click();
  await panel
    .getByRole('article', { name, exact: true })
    .getByRole('button', { name: action === '补招' ? '加入下发' : action, exact: true })
    .click();
  const row = panel.getByRole('region', { name: `下发给${name}`, exact: true });
  await expect(row).toBeVisible();
  await row.getByLabel(`${name}招募量级`, { exact: true }).fill('10.1234');
  await row.getByLabel(`${name}作业人数`, { exact: true }).fill('2');
  return row;
}

async function confirmSubmit(page: Page) {
  await page.getByRole('button', { name: '下发招募', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认下发招募', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认下发', exact: true }).click();
  return dialog;
}

for (const desktop of [false, true]) {
  test(`${desktop ? '桌面运行配置' : 'Web'}策略官批量下发个人与组织，Cookie鉴权且仅写入一次`, async ({
    page,
  }) => {
    const fixture = await backend(page, desktop);
    const panel = await openRecruitment(page);
    await addAssignment(page, '个人候选甲');
    await expect(panel.getByRole('article', { name: '个人候选甲', exact: true })).toHaveCount(0);
    const organization = await addAssignment(page, '协作组织甲');
    await organization.getByLabel('协作组织甲质检人数', { exact: true }).fill('1');
    if (desktop)
      await page.screenshot({
        path: 'artifacts/expert-recruitment/recruitment-desktop.png',
        fullPage: true,
      });
    fixture.state.holdSubmit = true;
    const dialog = await confirmSubmit(page);
    await expect.poll(() => submissions(fixture.requests).length).toBe(1);
    await expect(dialog.getByRole('button', { name: '确认下发', exact: true })).toBeDisabled();
    await fixture.releaseSubmit();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '人员管理', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(submissions(fixture.requests)).toHaveLength(1);
    expect(submissions(fixture.requests)[0].body).toEqual({
      projectId,
      assignments: [
        {
          subjectType: 'INDIVIDUAL',
          subjectId: uuid(3),
          productionRequirement: 10.1234,
          operatorHeadcount: 2,
        },
        {
          subjectType: 'ORGANIZATION',
          subjectId: uuid(4),
          productionRequirement: 10.1234,
          operatorHeadcount: 2,
          inspectorHeadcount: 1,
        },
      ],
    });
    expect(submissions(fixture.requests)[0].headers.cookie).toContain('recruit_session=active');
    expect(submissions(fixture.requests)[0].headers['x-tyde-client']).toBe('web');
    expect(project.versionNo).toBe(4);
    expect(
      fixture.requests.some(
        (request) => request.path === '/api/v1/projects/manager/list' && request.method === 'GET',
      ),
    ).toBe(true);
  });
}

test('主策略官更换招募负责人，本地搜索不为候选API追加keyword', async ({ page }) => {
  const { state, requests } = await backend(page);
  const panel = await openRecruitment(page);
  await panel.getByRole('button', { name: '更换招募负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更换招募负责人', exact: true });
  await dialog.getByLabel('搜索招募负责人', { exact: true }).fill('候选');
  await dialog.getByRole('radio', { name: '候选负责人', exact: true }).check();
  await dialog.getByRole('button', { name: '确认更换负责人', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    panel
      .getByRole('region', { name: '招募概览', exact: true })
      .getByText(/招募负责人：\s*候选负责人/),
  ).toBeVisible();
  expect(handlerWrites(requests)).toHaveLength(1);
  expect(handlerWrites(requests)[0].body).toEqual({ projectId, handlerUserId: uuid(9) });
  expect(
    requests
      .filter((request) => request.path.endsWith('/handler-candidates'))
      .every((request) => Object.keys(request.query).join(',') === 'projectId'),
  ).toBe(true);
  expect(state.detail.currentNodeCode).toBe('RECRUIT_EXECUTION_EXPERT');
});

test('协作招募负责人可以下发，不能读取或更换招募负责人', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.detail.canChangeHandler = false;
  state.detail.currentOperatorRole = 'EXPERT_RECRUITMENT_HANDLER';
  state.detail.primaryManager.userId = uuid(9);
  state.detail.handler.userId = user.id;
  await openRecruitment(page);
  await expect(page.getByRole('button', { name: '更换招募负责人', exact: true })).toHaveCount(0);
  await addAssignment(page, '个人候选甲');
  await confirmSubmit(page);
  await expect(page.getByRole('tab', { name: '人员管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(submissions(requests)).toHaveLength(1);
  expect(handlerWrites(requests)).toHaveLength(0);
  expect(requests.filter((request) => request.path.endsWith('/handler-candidates'))).toHaveLength(
    0,
  );
});

test('候选分页与关键词由服务端处理，主体分类只筛选已加载候选', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  await expect(
    panel
      .getByRole('article', { name: '已接单成员', exact: true })
      .getByRole('button', { name: '加入下发', exact: true }),
  ).toBeDisabled();
  const pagination = panel.getByRole('navigation', { name: '执行专家候选分页', exact: true });
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(pagination.getByText(/第 2 \//)).toBeVisible();
  await panel.getByRole('combobox', { name: '主体类型', exact: true }).click();
  await page.getByRole('option', { name: '组织', exact: true }).click();
  await panel.getByRole('searchbox', { name: '筛选执行专家', exact: true }).fill('协作组织甲');
  await panel.getByRole('button', { name: '查询候选', exact: true }).click();
  await expect(panel.getByRole('article', { name: '协作组织甲', exact: true })).toBeVisible();
  const queried = requests.filter((request) =>
    request.path.endsWith('/expert-recruitments/candidates'),
  );
  expect(queried.some((request) => request.query.current === '2')).toBe(true);
  expect(queried.at(-1)?.query).toMatchObject({
    projectId: String(projectId),
    keyword: '协作组织甲',
    current: '1',
  });
  expect(queried.every((request) => request.query.subjectType === undefined)).toBe(true);
});

test('已招募默认只读，进入更换后同主体拒单补招保留来源且不跨主体换人', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  await expect(panel.getByRole('button', { name: '更换执行专家', exact: true })).toBeVisible();
  const row = await addAssignment(page, '已拒单组织', '补招');
  await expect(row.getByRole('button', { name: '更换补招对象', exact: true })).toHaveCount(0);
  await confirmSubmit(page);
  await expect.poll(() => submissions(requests).length).toBe(1);
  expect(submissions(requests)[0].body).toMatchObject({
    projectId,
    assignments: [{ subjectType: 'ORGANIZATION', sourceRejectedAssignmentId: 12 }],
  });
});

test('拒单候选再次加入自动保留原拒单来源，批量数值非法时不下发', async ({ page }) => {
  const { requests } = await backend(page);
  await openRecruitment(page);
  const row = await addAssignment(page, '已拒单组织');
  await row.getByLabel('已拒单组织招募量级', { exact: true }).fill('0.00001');
  await page.getByRole('button', { name: '下发招募', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认下发招募', exact: true })).toHaveCount(0);
  expect(submissions(requests)).toHaveLength(0);
  await row.getByLabel('已拒单组织招募量级', { exact: true }).fill('1000');
  await row.getByLabel('已拒单组织作业人数', { exact: true }).fill('0');
  await page.getByRole('button', { name: '下发招募', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认下发招募', exact: true })).toHaveCount(0);
  expect(submissions(requests)).toHaveLength(0);
  await row.getByLabel('已拒单组织作业人数', { exact: true }).fill('1');
  await confirmSubmit(page);
  await expect.poll(() => submissions(requests).length).toBe(1);
  expect(submissions(requests)[0].body).toMatchObject({
    assignments: [{ productionRequirement: 1000 }],
  });
  const assignment = (submissions(requests)[0].body?.assignments as Record<string, unknown>[])[0];
  expect(assignment.sourceRejectedAssignmentId).toBe(12);
});

test('招募详情403不会开放候选下发或负责人写入口', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.detailStatus = 403;
  const panel = await openRecruitment(page);
  await expect(panel.getByText('当前任职没有招募权限', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '下发招募', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '更换招募负责人', exact: true })).toHaveCount(0);
  expect(submissions(requests)).toHaveLength(0);
  expect(handlerWrites(requests)).toHaveLength(0);
});

for (const applied of [false, true])
  test(`未知下发${applied ? '已生效' : '未生效'}跨Tab保留锁，GET核实不重发或宣称本批成功`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    state.unknownSubmit = true;
    state.applyUnknownSubmit = applied;
    await openRecruitment(page);
    await addAssignment(page, '个人候选甲');
    await confirmSubmit(page);
    await expect(page.getByRole('button', { name: '核实下发结果', exact: true })).toBeVisible();
    page.once('dialog', (confirmation) => confirmation.accept());
    await page.getByRole('tab', { name: '人员管理', exact: true }).click();
    await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
    await expect(page.getByRole('button', { name: '核实下发结果', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '核实下发结果', exact: true }).click();
    expect(submissions(requests)).toHaveLength(1);
    await expect(page.getByRole('button', { name: '下发招募', exact: true })).toBeDisabled();
  });

test('下发403锁住旧清单，切换Tab不会恢复无权操作或自动重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.submitStatus = 403;
  await openRecruitment(page);
  await addAssignment(page, '个人候选甲');
  await confirmSubmit(page);
  await expect(page.getByText('当前任职不能下发', { exact: true })).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await page.getByRole('tab', { name: '人员管理', exact: true }).click();
  await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
  await expect(page.getByRole('button', { name: '下发招募', exact: true })).toBeDisabled();
  expect(submissions(requests)).toHaveLength(1);
});

test('未知下发确认离开并切换角色后返回PM，同账号项目仍持锁且保留原清单', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownSubmit = true;
  await openRecruitment(page);
  await addAssignment(page, '个人候选甲');
  await confirmSubmit(page);
  await expect(page.getByRole('button', { name: '核实下发结果', exact: true })).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await page.getByRole('link', { name: '返回我的项目', exact: true }).click();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '策略官',
  );
  await page.getByRole('link', { name: '招募执行专家', exact: true }).click();
  await expect(page.getByRole('button', { name: '核实下发结果', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '下发给个人候选甲', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下发招募', exact: true })).toBeDisabled();
  expect(submissions(requests)).toHaveLength(1);
});

test('明确409保留拒单来源，显式重读才允许重新编辑而不自动补发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.submitStatus = 409;
  await openRecruitment(page);
  await addAssignment(page, '已拒单组织', '补招');
  await confirmSubmit(page);
  await expect(page.getByText('候选分配已变化，请重新核实', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核实下发结果', exact: true }).click();
  expect(submissions(requests)).toHaveLength(1);
  state.submitStatus = 200;
  const row = page.getByRole('region', { name: '下发给已拒单组织', exact: true });
  await row.getByLabel('已拒单组织招募量级', { exact: true }).fill('30');
  await confirmSubmit(page);
  await expect.poll(() => submissions(requests).length).toBe(2);
  expect(submissions(requests)[1].body).toMatchObject({
    assignments: [{ sourceRejectedAssignmentId: 12, productionRequirement: 30 }],
  });
});

test('负责人更换响应丢失只核实现任配置，不自动重发更换', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownHandler = true;
  state.applyUnknownHandler = true;
  const panel = await openRecruitment(page);
  await panel.getByRole('button', { name: '更换招募负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更换招募负责人', exact: true });
  await dialog.getByRole('radio', { name: '候选负责人', exact: true }).check();
  await dialog.getByRole('button', { name: '确认更换负责人', exact: true }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByRole('button', { name: '核实负责人', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '核实负责人', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    panel
      .getByRole('region', { name: '招募概览', exact: true })
      .getByText(/招募负责人：\s*候选负责人/),
  ).toBeVisible();
  expect(handlerWrites(requests)).toHaveLength(1);
});

test('下发明确成功后回读失败仅重新读取，不恢复旧清单再次提交', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failListAfterSubmit = true;
  const panel = await openRecruitment(page);
  await addAssignment(page, '个人候选甲');
  await confirmSubmit(page);
  await expect(panel.getByRole('button', { name: '重新读取招募信息', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '重新读取招募信息', exact: true }).click();
  expect(submissions(requests)).toHaveLength(1);
  state.listStatus = 200;
  await panel.getByRole('button', { name: '重新读取招募信息', exact: true }).click();
  await expect(page.getByRole('tab', { name: '人员管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(submissions(requests)).toHaveLength(1);
});

test('下发成功续接人员管理后仍可回招募Tab编辑新批次，已知成功锁不遗留', async ({ page }) => {
  const { requests } = await backend(page);
  await openRecruitment(page);
  await addAssignment(page, '个人候选甲');
  await confirmSubmit(page);
  await expect(page.getByRole('tab', { name: '人员管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '招募执行专家', exact: true }).click();
  const row = await addAssignment(page, '协作组织甲');
  await expect(row.getByLabel('协作组织甲招募量级', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '下发招募', exact: true })).toBeEnabled();
  expect(submissions(requests)).toHaveLength(1);
});

test('375px候选和下发清单无需横向滚动，移除项后不产生写入', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  const row = await addAssignment(page, '协作组织甲');
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({
    path: 'artifacts/expert-recruitment/recruitment-375.png',
    fullPage: true,
  });
  await row.getByRole('button', { name: '移除下发项', exact: true }).click();
  await expect(panel.getByRole('region', { name: '下发给协作组织甲', exact: true })).toHaveCount(0);
  expect(submissions(requests)).toHaveLength(0);
});

for (const branch of [null, 'EXPERT_RECRUITMENT_RETRY']) {
  test(`${branch ? '补招支线' : '招募主线'}项目卡直接进入招募模块，刷新保持当前Tab`, async ({
    page,
  }) => {
    const { requests } = await backend(page);
    // 完整列表沿真实卡片节点派发入口，不手动选Tab弥补路由遗漏。
    await page.route('**/api/v1/projects/manager/list', (route) =>
      route.fulfill({
        status: 200,
        json: {
          code: 200,
          message: '操作成功',
          data: [{ ...strategistProjectCard(project), branchNodeCode: branch }],
        },
      }),
    );
    await page.goto(`${origin}/#/strategist/projects`);
    await page.getByRole('link', { name: '招募执行专家', exact: true }).click();
    await expect(page.getByRole('region', { name: '招募执行专家', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '招募执行专家', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.reload();
    await expect(page.getByRole('region', { name: '招募执行专家', exact: true })).toBeVisible();
    expect(submissions(requests)).toHaveLength(0);
  });
}

test('招募工作区保留本地范围和手动草稿，不编造推荐或历史请求', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  await addAssignment(page, '个人候选甲');
  const before = requests.length;
  await panel.getByRole('tab', { name: '智能推荐', exact: true }).click();
  await expect(panel.getByLabel('招募人数统计')).toContainText('需求人数');
  await expect(panel.getByLabel('招募人数统计').getByText('待同步', { exact: true })).toHaveCount(
    4,
  );
  await expect(panel.getByRole('button', { name: '生成推荐', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '人员推荐', exact: true }).click();
  const scope = page.getByRole('dialog', { name: '候选范围设置', exact: true });
  await expect(scope.getByRole('checkbox', { name: '未招募', exact: true })).toBeChecked();
  await expect(scope.getByRole('checkbox', { name: '空闲中', exact: true })).toBeChecked();
  await expect(scope.getByRole('checkbox', { name: '学历证明', exact: true })).toBeChecked();
  await scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true }).fill('0');
  await scope.getByRole('button', { name: '暂存条件', exact: true }).click();
  await expect(scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true })).toBeFocused();
  await scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true }).fill('25');
  await scope.getByRole('button', { name: '暂存条件', exact: true }).click();
  await panel.getByRole('tab', { name: '招募记录', exact: true }).click();
  await expect(panel.getByRole('table', { name: '个人招募记录', exact: true })).toContainText(
    '招募记录待同步',
  );
  await panel.getByRole('tab', { name: '人员招募', exact: true }).click();
  await panel.getByRole('button', { name: '人员推荐', exact: true }).click();
  await expect(scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true })).toHaveValue(
    '25',
  );
  await scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true }).fill('99');
  await scope.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: '人员推荐', exact: true }).click();
  await expect(scope.getByRole('spinbutton', { name: '推荐人员数量', exact: true })).toHaveValue(
    '25',
  );
  await scope.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('tab', { name: '手动搜索', exact: true }).click();
  await expect(panel.getByLabel('个人候选甲招募量级', { exact: true })).toHaveValue('10.1234');
  expect(requests.slice(before)).toHaveLength(0);
});

test('个人候选共用只读档案，不把主体UUID当用户ID且不查询本人材料', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  const openDossier = panel
    .getByRole('article', { name: '个人候选甲', exact: true })
    .getByRole('button', { name: '查看档案', exact: true });
  await expect(openDossier).toBeVisible();
  const before = requests.length;
  await openDossier.click();
  const dossier = page.getByRole('dialog', { name: '个人候选甲的档案', exact: true });
  await expect(dossier).toContainText('详细档案暂未同步');
  await expect(dossier.getByRole('tab')).toHaveCount(4);
  await expect(dossier.getByText('用户 ID', { exact: true }).locator('+ dd')).toHaveText('—');
  await expect(dossier).not.toContainText(uuid(3));
  expect(requests.slice(before)).toHaveLength(0);
});

test('无效下发切到已选并聚焦错误字段，分类不丢手动选择', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openRecruitment(page);
  const row = await addAssignment(page, '个人候选甲');
  await row.getByLabel('个人候选甲作业人数', { exact: true }).fill('0');
  await panel.getByRole('button', { name: '下发招募', exact: true }).click();
  await expect(row.getByLabel('个人候选甲作业人数', { exact: true })).toBeFocused();
  await expect(panel.getByRole('combobox', { name: '主体类型', exact: true })).toContainText(
    '已选',
  );
  expect(submissions(requests)).toHaveLength(0);
});
