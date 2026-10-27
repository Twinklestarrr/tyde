import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type {
  AuthUser,
  ProjectProductionPlan,
  ProjectProductionPlanInput,
  StrategistProjectCard,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = 701;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'PLAN10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '生产计划联调员',
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
  createdAt: '2026-10-27T02:00:00.000Z',
  updatedAt: '2026-10-27T02:00:00.000Z',
};
const detail: WorkbenchProjectDetail = {
  id: projectId,
  projectNo: 'PLAN-PROJECT-701',
  requesterType: 'INDIVIDUAL',
  requesterId: uuid(2),
  requesterName: '计划需求方',
  projectName: '生产计划隔离项目',
  projectDescription: '真实接口结构的隔离测试夹具',
  categoryLevel1Id: 1,
  categoryLevel2Id: 2,
  categoryLevel1Name: '数据处理',
  categoryLevel2Name: '文本标注',
  categoryLevel3Ids: [3],
  categoryLevel3Names: ['内容分类'],
  difficultyLevel: 'MEDIUM',
  projectQuantity: 500,
  quantityUnit: '条',
  deadline: '2099-12-31 18:00:00',
  requiredHeadcount: 4,
  educationRequirement: 'BACHELOR',
  employmentType: 'PART_TIME',
  experienceRequirement: '具备标注经验',
  workSummary: '按标准执行生产',
  specialRequirement: null,
  mandatoryRequirement: '完成培训',
  standardContent: '逐条核对生产标准',
  standardLink: null,
  status: 'PUBLISHED',
  currentNodeCode: 'PRODUCTION_PLAN',
  versionNo: 2,
  creatorUid: 'PLAN10002',
  creatorName: '测试创建人',
  createdAt: '2026-10-27 10:00:00',
  updatedAt: '2026-10-27 10:00:00',
  attachments: [],
};
const input: ProjectProductionPlanInput = {
  operatorHeadcount: 4,
  operatorCpd: 10.25,
  inspectorHeadcount: 2,
  inspectorCpd: 20.5,
  needWrittenExam: false,
  maxActiveExamCount: 2,
  needInterview: true,
  crowds: [{ crowdName: '熟练组', profileRequirement: '完成相关培训' }],
  stages: [
    {
      stageName: '爬坡期',
      startDate: '2099-01-05',
      endDate: '2099-01-09',
      workdayCountSource: 'AUTO',
      operatorHeadcount: 2,
      operatorCpd: null,
      accuracyRate: 98.5,
    },
    {
      stageName: '稳定生产期',
      startDate: '2099-01-05',
      endDate: '2099-01-09',
      workdayCountSource: 'MANUAL',
      workdayCount: 7,
      operatorHeadcount: 3,
      operatorCpd: 20.5,
      accuracyRate: null,
    },
  ],
};
function initialPlan(): ProjectProductionPlan {
  return {
    hasPlan: false,
    editable: true,
    id: null,
    projectId,
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
    projectReference: {
      projectQuantity: detail.projectQuantity,
      quantityUnit: detail.quantityUnit,
      deadline: detail.deadline,
      requiredHeadcount: detail.requiredHeadcount,
      educationRequirement: detail.educationRequirement,
      employmentType: detail.employmentType,
      experienceRequirement: detail.experienceRequirement,
      workSummary: detail.workSummary,
      specialRequirement: detail.specialRequirement,
      mandatoryRequirement: detail.mandatoryRequirement,
    },
    crowds: [{ id: null, sequenceNo: 1, crowdName: null, profileRequirement: null }],
    stages: ['爬坡期', '稳定生产期'].map((stageName, index) => ({
      id: null,
      sequenceNo: index + 1,
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
    })),
  };
}
function confirmedPlan(): ProjectProductionPlan {
  return {
    ...initialPlan(),
    ...structuredClone(input),
    hasPlan: true,
    editable: false,
    id: 801,
    operatorHeadcount: 4,
    operatorCpd: 10.25,
    inspectorHeadcount: 2,
    inspectorCpd: 20.5,
    needWrittenExam: false,
    maxActiveExamCount: 2,
    needInterview: true,
    totalExpectedOutput: 533,
    confirmedBy: user.uid,
    confirmedAt: '2026-10-27 11:00:00',
    currentNodeCode: 'STANDARD_TRAINING',
    nextStage: 'STANDARD_TRAINING',
    extJson: null,
    crowds: [{ id: 901, sequenceNo: 1, crowdName: '熟练组', profileRequirement: '完成相关培训' }],
    stages: input.stages.map((stage, index) => ({
      id: 1001 + index,
      sequenceNo: index + 1,
      stageName: stage.stageName,
      startDate: stage.startDate,
      endDate: stage.endDate,
      workdayCountSource: stage.workdayCountSource ?? 'AUTO',
      naturalDayCount: 5,
      workdayCount: index ? 7 : 5,
      operatorHeadcount: stage.operatorHeadcount,
      operatorCpd: index ? 20.5 : 10.25,
      accuracyRate: stage.accuracyRate ?? null,
      expectedOutput: index ? 430.5 : 102.5,
    })),
  };
}
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

/** 替代HTTP接口，所有确认均只写内存夹具，不连接业务数据库。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'plan_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const state = {
    user: structuredClone(user),
    plan: initialPlan(),
    primary: true,
    listStatus: 200,
    planStatus: 200,
    confirmStatus: 200,
    networkFailure: false,
    failReadAfterConfirm: false,
    holdConfirm: false,
  };
  const requests: RequestLog[] = [];
  let releaseConfirm: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = await request.allHeaders();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
    });
    const reply = (data: unknown, status = 200, message = '成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/auth/switch-role') {
      const role = (body as { role: AuthUser['role'] }).role;
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (path === '/api/v1/projects/list') return reply([]);
    if (path === '/api/v1/projects/draft/current') return reply({ hasDraft: false, draft: null });
    if (path === '/api/v1/projects/manager/list') {
      const card: StrategistProjectCard = {
        id: projectId,
        projectNo: detail.projectNo,
        projectName: detail.projectName,
        projectDescription: detail.projectDescription,
        categoryLevel1Name: detail.categoryLevel1Name,
        categoryLevel2Name: detail.categoryLevel2Name,
        categoryLevel3Names: detail.categoryLevel3Names,
        categoryDisplayName: '内容分类',
        status: 'PUBLISHED',
        statusDescription: '已发布',
        currentNodeCode: state.plan.currentNodeCode ?? 'PRODUCTION_PLAN',
        branchNodeCode: null,
        workbenchStatus: 'PROCESSING',
        workbenchStatusDescription: '处理中',
        currentAction: 'VIEW_DETAIL',
        currentActionDescription: '查看项目详情',
        primaryProjectManager: state.primary,
        expertRecruitmentHandler: !state.primary,
        needAssistGrading: false,
        requesterName: detail.requesterName,
        creatorId: uuid(2),
        creatorName: detail.creatorName,
        projectManagerId: state.primary ? user.id : uuid(3),
        projectManagerName: state.primary ? user.realName : '当前主策略官',
        projectManagerStatusDescription: '已指定',
        projectOwners: [],
        activeExpertCount: 0,
        requiredHeadcount: detail.requiredHeadcount,
        deadline: detail.deadline,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      };
      return reply(
        state.listStatus === 200 ? [card] : null,
        state.listStatus,
        '项目列表暂时不可用',
      );
    }
    if (path === `/api/v1/projects/${projectId}`)
      return reply({ ...detail, currentNodeCode: state.plan.currentNodeCode });
    if (path === '/api/v1/projects/production-plan')
      return reply(
        state.planStatus === 200 ? state.plan : null,
        state.planStatus,
        '生产计划读取暂时不可用',
      );
    if (path === '/api/v1/projects/production-plan/confirm') {
      if (state.networkFailure) return route.abort('failed');
      if (state.confirmStatus !== 200)
        return reply(
          null,
          state.confirmStatus,
          state.confirmStatus === 409 ? '计划已被其他会话确认' : '生产计划确认暂时不可用',
        );
      const save = async () => {
        state.plan = confirmedPlan();
        if (state.failReadAfterConfirm) state.planStatus = 503;
        await reply(state.plan);
      };
      if (!state.holdConfirm) return save();
      return new Promise<void>((resolve, reject) => {
        releaseConfirm = async () => {
          try {
            await save();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    return reply(null, 404, '测试未约定此接口');
  });
  const calls = (path: string) =>
    requests.filter((request) => request.path === `/api/v1/projects/${path}`);
  return {
    state,
    requests,
    calls,
    releaseConfirm: async () => {
      if (!releaseConfirm) throw new Error('没有等待中的生产计划确认');
      await releaseConfirm();
    },
  };
}
async function openPlan(page: Page) {
  await page.goto(`${origin}/#/strategist/projects/${projectId}`);
  const panel = page.getByRole('region', { name: '生产计划', exact: true });
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeVisible();
  return panel;
}
async function fillPlan(page: Page) {
  const panel = page.getByRole('region', { name: '生产计划', exact: true });
  await panel.getByRole('spinbutton', { name: '作业人数', exact: true }).fill('4');
  await panel.getByRole('spinbutton', { name: '作业 CPD', exact: true }).fill('10.25');
  await panel.getByRole('spinbutton', { name: '质检人数（选填）', exact: true }).fill('2');
  await panel.getByRole('spinbutton', { name: '质检 CPD（选填）', exact: true }).fill('20.5');
  await panel.getByRole('checkbox', { name: '需要笔试', exact: true }).uncheck();
  await panel.getByRole('spinbutton', { name: '准入考试数量', exact: true }).fill('2');
  await panel.getByRole('checkbox', { name: '需要面试', exact: true }).check();
  await panel.getByRole('textbox', { name: '人群1名称', exact: true }).fill('熟练组');
  await panel.getByRole('textbox', { name: '人群1画像要求', exact: true }).fill('完成相关培训');
  for (let stage = 1; stage <= 2; stage++) {
    await panel.getByLabel(new RegExp(`^阶段${stage}开始日期\\s*\\*$`)).fill('2099-01-05');
    await panel.getByLabel(new RegExp(`^阶段${stage}结束日期\\s*\\*$`)).fill('2099-01-09');
    await panel
      .getByRole('spinbutton', { name: `阶段${stage}作业人数`, exact: true })
      .fill(stage === 1 ? '2' : '3');
  }
  await panel.getByRole('spinbutton', { name: '阶段1准确率（选填）', exact: true }).fill('98.5');
  await panel.getByRole('combobox', { name: '阶段2天数来源', exact: true }).click();
  await page.getByRole('option', { name: '手动填写', exact: true }).click();
  await panel.getByRole('spinbutton', { name: '阶段2有效生产天数', exact: true }).fill('7');
  await panel.getByRole('spinbutton', { name: '阶段2作业 CPD（选填）', exact: true }).fill('20.5');
  return panel;
}
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog', { name: '确认生产计划', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  return dialog;
}
async function screenshot(page: Page, name: string) {
  const directory = 'artifacts/production-plan-audit';
  await mkdir(directory, { recursive: true });
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: `${directory}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron 运行配置', true],
] as const) {
  test(`${mode} 策略官入口、完整计划与明细增删、确认单写后只读`, async ({ page }) => {
    const { state, calls, releaseConfirm } = await backend(page, desktop);
    await page.goto(`${origin}/#/`);
    await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
    await page.getByLabel('筛选当前待办', { exact: true }).fill('不存在的项目');
    await expect(page.getByText('没有匹配的待办项目', { exact: true })).toBeVisible();
    await page.getByLabel('筛选当前待办', { exact: true }).fill('PLAN-PROJECT-701');
    await page.getByRole('link', { name: '生产计划', exact: true }).click();
    const workflow = page.getByRole('region', { name: '策略官项目流程', exact: true });
    const tabs = workflow.getByRole('tablist', { name: '策略官项目模块', exact: true });
    await expect(tabs.getByRole('tab')).toHaveCount(6);
    for (const name of [
      '生产计划',
      '准入考试',
      '标准与培训',
      '招募执行专家',
      '人员管理',
      '生产任务',
    ])
      await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: /^(招募策略官|结项)$/ })).toHaveCount(0);
    const panel = await fillPlan(page);
    await panel.getByRole('button', { name: '添加人群', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '人群2名称', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '删除人群2', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '人群2名称', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '添加阶段', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '阶段3名称', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '删除阶段3', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '阶段3名称', exact: true })).toHaveCount(0);
    if (!desktop) await screenshot(page, 'editable');
    state.holdConfirm = true;
    await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
    expect(calls('production-plan/confirm')).toHaveLength(0);
    const dialog = await confirm(page);
    await expect.poll(() => calls('production-plan/confirm').length).toBe(1);
    await expect(dialog.getByRole('button', { name: '确认提交', exact: true })).toBeDisabled();
    const write = calls('production-plan/confirm')[0]!;
    expect(write.query).toEqual({ projectId: String(projectId) });
    expect(write.body).toMatchObject(input);
    expect(write.body).not.toHaveProperty('projectId');
    expect(write.headers.cookie).toContain('plan_session=active');
    expect(write.headers['idempotency-key']).toBeUndefined();
    await releaseConfirm();
    await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '确认生产计划', exact: true })).toHaveCount(0);
    await expect(panel).toContainText('533');
    await expect(workflow.getByText('当前阶段：标准与培训', { exact: true })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: '生产计划', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(calls('production-plan/confirm')).toHaveLength(1);
    if (!desktop) await screenshot(page, 'confirmed');
    await page.reload();
    await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
    await expect(panel).toContainText('533');
    expect(calls('production-plan/confirm')).toHaveLength(1);
  });
}

test('协作负责人及已确认计划只读，不以列表身份代替接口editable', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.primary = false;
  state.plan.editable = false;
  await page.goto(`${origin}/#/`);
  await expect(page.getByText('招募协作负责人', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '生产计划', exact: true }).click();
  let panel = page.getByRole('region', { name: '生产计划', exact: true });
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '确认生产计划', exact: true })).toHaveCount(0);
  state.primary = true;
  state.plan = initialPlan();
  await page.reload();
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeEnabled();
  await panel.getByRole('spinbutton', { name: '作业 CPD', exact: true }).fill('10.25');
  state.planStatus = 403;
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '重新读取生产计划', exact: true }).click();
  await expect(panel.getByText('生产计划读取暂时不可用', { exact: true })).toBeVisible();
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '确认生产计划', exact: true })).toBeDisabled();
  state.primary = false;
  state.plan = {
    ...confirmedPlan(),
    currentNodeCode: 'PRODUCTION_TASK',
    nextStage: 'STANDARD_TRAINING',
  };
  state.planStatus = 200;
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '重新读取生产计划', exact: true }).click();
  panel = page.getByRole('region', { name: '生产计划', exact: true });
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toHaveValue('4');
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await expect(page.getByText('当前阶段：生产任务', { exact: true })).toBeVisible();
  expect(calls('production-plan/confirm')).toHaveLength(0);
});

test('生产计划数字精度、质检配对与日期校验阻止无效确认', async ({ page }) => {
  const { calls } = await backend(page);
  await openPlan(page);
  const panel = await fillPlan(page);
  await panel.getByRole('spinbutton', { name: '作业 CPD', exact: true }).fill('10.12345');
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认生产计划', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('spinbutton', { name: '作业 CPD', exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await panel.getByRole('spinbutton', { name: '作业 CPD', exact: true }).fill('10.25');
  await panel.getByRole('spinbutton', { name: '质检 CPD（选填）', exact: true }).fill('');
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await expect(
    panel.getByRole('spinbutton', { name: '质检 CPD（选填）', exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('dialog', { name: '确认生产计划', exact: true })).toHaveCount(0);
  await panel.getByRole('spinbutton', { name: '质检 CPD（选填）', exact: true }).fill('20.5');
  await panel.getByLabel(/^阶段1开始日期\s*\*$/).fill('2099-01-10');
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await expect(panel.getByLabel(/^阶段1结束日期\s*\*$/)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('dialog', { name: '确认生产计划', exact: true })).toHaveCount(0);
  await panel.getByLabel(/^阶段1开始日期\s*\*$/).fill('2099-01-05');
  await panel.getByRole('spinbutton', { name: '阶段2有效生产天数', exact: true }).fill('0');
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await expect(
    panel.getByRole('spinbutton', { name: '阶段2有效生产天数', exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('dialog', { name: '确认生产计划', exact: true })).toHaveCount(0);
  expect(calls('production-plan/confirm')).toHaveLength(0);
});

test('计划409和未知网络结果锁写，仅显式重读后才可继续', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.confirmStatus = 409;
  await openPlan(page);
  let panel = await fillPlan(page);
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await confirm(page);
  await expect(panel.getByText('计划已被其他会话确认', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '确认生产计划', exact: true })).toBeDisabled();
  expect(calls('production-plan/confirm')).toHaveLength(1);
  state.confirmStatus = 200;
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '重新读取生产计划', exact: true }).click();
  panel = await fillPlan(page);
  state.networkFailure = true;
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: '确认生产计划', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '重新读取生产计划', exact: true })).toBeVisible();
  expect(calls('production-plan/confirm')).toHaveLength(2);
});

test('确认成功而回读失败保留成功状态，恢复仅GET不重发确认', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.failReadAfterConfirm = true;
  await openPlan(page);
  const panel = await fillPlan(page);
  await panel.getByRole('button', { name: '确认生产计划', exact: true }).click();
  await confirm(page);
  await expect(
    panel.getByText('生产计划已确认，但最新资料读取失败。请重新读取。', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  expect(calls('production-plan/confirm')).toHaveLength(1);
  state.planStatus = 200;
  await panel.getByRole('button', { name: '重新读取生产计划', exact: true }).click();
  await expect(
    panel.getByText('生产计划已确认，但最新资料读取失败。请重新读取。', { exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByRole('spinbutton', { name: '作业人数', exact: true })).toBeDisabled();
  await expect(panel).toContainText('533');
  expect(calls('production-plan/confirm')).toHaveLength(1);
});

test('真实角色切换隔离PM接口，375布局和项目详情弹框不丢计划输入', async ({ page }) => {
  const { state, requests, calls } = await backend(page);
  state.user.role = 'NAVIGATOR';
  state.user.selectedRole = 'NAVIGATOR';
  await page.goto(`${origin}/#/strategist/projects/${projectId}`);
  await expect(page).toHaveURL(/#\/$/);
  expect(calls('manager/list')).toHaveLength(0);
  expect(calls('production-plan')).toHaveLength(0);
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '生产计划', exact: true }).click();
  const panel = await fillPlan(page);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await screenshot(page, 'mobile-form');
  const before = requests.length;
  const details = page.getByRole('button', { name: '查看项目详情', exact: true });
  await details.click();
  const dialog = page.getByRole('dialog', { name: '项目详情', exact: true });
  await expect(dialog.getByRole('region', { name: '基础信息', exact: true })).toContainText(
    '500 条',
  );
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({
    path: 'artifacts/production-plan-audit/mobile-details.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(details).toBeFocused();
  await expect(panel.getByRole('spinbutton', { name: '作业 CPD', exact: true })).toHaveValue(
    '10.25',
  );
  expect(requests).toHaveLength(before);
  await page.setViewportSize({ width: 1280, height: 720 });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  const planReads = calls('production-plan').length,
    managerReads = calls('manager/list').length;
  await page.goto(`${origin}/#/strategist/projects/${projectId}`);
  await expect(page).toHaveURL(/#\/$/);
  expect(calls('production-plan')).toHaveLength(planReads);
  expect(calls('manager/list')).toHaveLength(managerReads);
  expect(calls('production-plan/confirm')).toHaveLength(0);
  expect(
    requests
      .filter((request) => request.path === '/api/v1/auth/switch-role')
      .map((request) => request.body),
  ).toEqual([{ role: 'PM' }, { role: 'EXPERT' }]);
});
