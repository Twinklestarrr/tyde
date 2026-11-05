import { expect, test, type Page } from '@playwright/test';
import {
  boardProjectsExample,
  boardBasicExample,
  boardSubtasksExample,
  boardRisksExample,
  boardStatisticsExamples,
  boardTrendsExample,
} from '../../apps/server/src/modules/projects/project-board.schema';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { materialsExample } from '../../apps/server/src/modules/projects/project-materials.schema';
import { productionPlanResponse } from '../../apps/server/src/modules/projects/project-production-plan.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import {
  assignmentDetailExample,
  myProjectExample,
} from '../../apps/server/src/modules/expert/expert-assignment.schema';
import type {
  AuthUser,
  ProjectBoardDetail,
  ProjectBoardProject,
  ProjectBoardRisks,
  ProjectBoardSubtask,
  ProjectBoardTrends,
  ProjectStandardMaterials,
  WorkbenchProject,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176',
  projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const boardPath = '/api/v1/projects/workbench/board/';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const dayOffset = (offset: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const user: AuthUser = {
  id: uuid(1),
  uid: 'DIRECTORY10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '目录联调员',
  realName: '项目创建人',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'NAVIGATOR',
  selectedRole: 'NAVIGATOR',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: '2026-11-04T04:00:00.000Z',
  updatedAt: '2026-11-04T04:00:00.000Z',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectName: '目录生产项目',
  projectNo: 'DIR-3001',
  projectQuantity: 1000,
  deadline: `${today} 00:00:00`,
  projectDescription: '独立目录项目描述',
  requesterId: uuid(80),
  requesterName: '目录需求方',
  creatorUid: user.uid,
  creatorName: user.realName,
  currentNodeCode: 'PRODUCTION_TASK',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  standardContent: '目录项目标准正文',
  standardLink: 'https://example.com/directory-standard',
  versionNo: 4,
  attachments: [],
} as WorkbenchProjectDetail;
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  role: AuthUser['role'];
  headers: Record<string, string>;
}

/** 所有目录/业务/本人来源均为真实契约的内存夹具；未接通数据库、OSS或Agent。 */
async function backend(
  page: Page,
  role: AuthUser['role'] = 'NAVIGATOR',
  desktop = false,
  manager = false,
) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'directory_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const rows: ProjectBoardProject[] = Array.from({ length: 23 }, (_, i) => ({
    ...structuredClone(boardProjectsExample.records[0]),
    projectId: projectId + i,
    projectName: i === 0 ? project.projectName! : i === 1 ? '已结项目录项目' : `目录项目${i + 1}`,
    projectNo: `DIR-${projectId + i}`,
    requesterName: i === 22 ? '末页需求方' : project.requesterName,
    deadline: project.deadline,
    currentNodeCode: i === 1 ? 'COMPLETED' : 'PRODUCTION_TASK',
    currentNodeName: i === 1 ? '结项' : '生产任务',
  }));
  const basic: ProjectBoardDetail = {
    ...structuredClone(boardBasicExample),
    ...project,
    projectId,
    status: 'PUBLISHED',
    publishedAt: '2026-10-26 10:00:00',
    closedAt: null,
  } as ProjectBoardDetail;
  // API-108没有附件、版本、创建人等字段，必须与旧业务详情分开。
  for (const key of [
    'id',
    'attachments',
    'versionNo',
    'creatorUid',
    'creatorName',
    'createdAt',
    'updatedAt',
  ])
    delete (basic as unknown as Record<string, unknown>)[key];
  const state = {
    user: {
      ...structuredClone(user),
      role,
      selectedRole: role,
      hasExpertManagementRole: manager,
      organization:
        role === 'EXPERT'
          ? {
              id: uuid(10),
              name: '目录组织',
              position: manager ? ('OWNER' as const) : ('MEMBER' as const),
              joinStatus: 'ACTIVE' as const,
              description: null,
              logoUrl: null,
              expertiseTags: [],
              verifyStatus: 'APPROVED' as const,
              status: 'ACTIVE' as const,
            }
          : null,
    } as AuthUser,
    rows,
    basic,
    project: structuredClone(project),
    subtasks: structuredClone(boardSubtasksExample) as ProjectBoardSubtask[],
    risks: structuredClone(boardRisksExample) as ProjectBoardRisks,
    participating: (manager
      ? []
      : [
          {
            ...structuredClone(myProjectExample),
            assignmentId: 101,
            movementId: null,
            projectName: project.projectName,
            admissionStatus: 'PASSED',
            currentNodeCode: 'STANDARD_TRAINING',
          },
        ]) as WorkbenchProject[],
    statuses: {} as Record<string, number>,
    network: new Set<string>(),
    denyRoles: new Set<AuthUser['role']>(),
    holdBasic: false,
    materials: {
      ...structuredClone(materialsExample),
      projectId,
      currentNodeCode: 'PRODUCTION_TASK',
      standardContent: project.standardContent,
      standardLink: project.standardLink,
      attachments: [],
      versionNo: 4,
    } as ProjectStandardMaterials,
    writeStatus: 200,
    writeNetwork: false,
    failAfterWrite: false,
    written: false,
    forceEmptyTrends: false,
    trendValues: null as (number | null)[] | null,
    trendMemberCount: 2,
    wrongSource: false,
    wrongSourceProject: false,
    actualExpertManager: manager,
    holdFile: false,
    fileStatus: 200,
  };
  Object.assign(state.subtasks[0]!, {
    plannedStartDate: dayOffset(-3),
    expectedDeliveryDate: dayOffset(1),
    expectedQuantityToDate: 20,
    progressLowRisk: true,
  });
  state.subtasks.push({
    ...state.subtasks[0]!,
    subtaskId: 5202,
    subtaskNo: 'ST-5202',
    subtaskName: '历史已交付任务',
    status: 'ACCEPTED',
    statusName: '已验收',
    plannedStartDate: dayOffset(-7),
    expectedDeliveryDate: dayOffset(-1),
    reportedQuantity: 1250.1256,
    targetQuantity: 1000,
    progressPercent: 125.01,
    progressLowRisk: false,
    overdueRisk: false,
  });
  state.risks.project.items[0]!.targetName = project.projectName;
  state.risks.subtasks.items[0]!.message = '交付进度偏低（60%），截至今天应完成 20';
  const requests: RequestLog[] = [];
  let release: (() => void) | undefined;
  let releaseFile: (() => void) | undefined;
  function managed() {
    return (
      !state.denyRoles.has(state.user.role) &&
      (state.user.role !== 'EXPERT' || state.actualExpertManager)
    );
  }
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      headers = await request.allHeaders();
    const body = headers['content-type']?.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
      role: state.user.role,
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    const read = async (key: string, data: unknown) => {
      if (state.network.has(key)) return route.abort('failed');
      const status = state.statuses[key] ?? 200;
      return reply(status === 200 ? data : null, status, `${key}读取失败`);
    };
    if (!headers.cookie?.includes('directory_session=active')) return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      state.user.role = body!.role as AuthUser['role'];
      state.user.selectedRole = state.user.role;
      return reply({ selectedRole: state.user.role, roles: state.user.roles });
    }
    if (log.path === '/api/v1/projects/workbench/statistics') {
      if (!managed()) return reply(null, 403, '当前角色无看板管理权限');
      return read('statistics', {
        ...boardStatisticsExamples[1],
        totalProjectCount: state.rows.length,
        startupProjectCount: state.rows.filter((item) =>
          [
            'RECRUIT_PROJECT_MANAGER',
            'PRODUCTION_PLAN',
            'ENTRANCE_EXAM',
            'STANDARD_TRAINING',
          ].includes(item.currentNodeCode),
        ).length,
        assemblyProjectCount: state.rows.filter(
          (item) => item.currentNodeCode === 'RECRUIT_EXECUTION_EXPERT',
        ).length,
        productionProjectCount: state.rows.filter(
          (item) => item.currentNodeCode === 'PRODUCTION_TASK',
        ).length,
      });
    }
    if (log.path.startsWith(boardPath)) {
      if (!managed()) return reply(null, 403, '当前用户无权查看该项目看板');
      const key = log.path.slice(boardPath.length);
      if (key === 'projects') {
        const keyword = String(body?.keyword ?? '').trim(),
          current = Number(body?.current ?? 1),
          size = Number(body?.size ?? 20);
        const data = state.rows
          .filter((item) => `${item.projectName}${item.requesterName}`.includes(keyword))
          .map((item) => {
            const base = { ...item };
            delete base.primaryProjectManager;
            delete base.expertRecruitmentHandler;
            return {
              ...base,
              assignmentId: state.user.role === 'EXPERT' ? 120 : null,
              ...(state.user.role === 'PM'
                ? { primaryProjectManager: true, expertRecruitmentHandler: false }
                : {}),
            };
          });
        return read(key, {
          current,
          size,
          total: data.length,
          pages: Math.ceil(data.length / size),
          records: data.slice((current - 1) * size, current * size),
        });
      }
      if (key === 'project-detail') {
        const id = Number(body?.projectId),
          row = state.rows.find((item) => item.projectId === id);
        const snapshot = {
          ...state.basic,
          projectId: id,
          projectName: row?.projectName ?? state.basic.projectName,
          projectNo: row?.projectNo ?? state.basic.projectNo,
          requesterName: row?.requesterName ?? state.basic.requesterName,
          currentNodeCode: row?.currentNodeCode ?? state.basic.currentNodeCode,
          ...(row?.currentNodeCode === 'COMPLETED' ? { closedAt: '2026-11-03 17:00:00' } : {}),
        };
        if (state.holdBasic)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return read(key, snapshot);
      }
      const completed =
        state.rows.find((item) => item.projectId === body?.projectId)?.currentNodeCode ===
        'COMPLETED';
      if (key === 'subtasks')
        return read(
          key,
          state.subtasks.map((item) =>
            completed
              ? {
                  ...item,
                  status: 'ACCEPTED',
                  statusName: '已验收',
                  overdueRisk: false,
                  progressLowRisk: false,
                }
              : item,
          ),
        );
      if (key === 'risks')
        return read(key, {
          ...state.risks,
          ...(completed
            ? {
                project: { pendingCount: 0, urgentCount: 0, items: [] },
                subtasks: { pendingCount: 0, urgentCount: 0, items: [] },
              }
            : {}),
          viewScope: state.user.role === 'EXPERT' ? 'ORGANIZATION' : 'FULL_PROJECT',
          members:
            state.user.role === 'NAVIGATOR' || completed
              ? { pendingCount: 0, urgentCount: 0, items: [] }
              : state.risks.members,
        });
      if (key === 'trends') {
        const start = Date.parse(`${body!.startDate}T00:00:00Z`),
          end = Date.parse(`${body!.endDate}T00:00:00Z`);
        const dates = Array.from({ length: Math.floor((end - start) / 86400000) + 1 }, (_, i) =>
          new Date(start + i * 86400000).toISOString().slice(0, 10),
        );
        const data: ProjectBoardTrends = {
          metric: body!.metric as ProjectBoardTrends['metric'],
          viewScope: state.user.role === 'EXPERT' ? 'ORGANIZATION' : 'FULL_PROJECT',
          dates,
          series: [],
        };
        if (state.user.role !== 'NAVIGATOR' && !state.forceEmptyTrends)
          data.series = Array.from({ length: state.trendMemberCount }, (_, index) => ({
            ...boardTrendsExample.series[0]!,
            memberId: 3801 + index,
            displayName: '同人不同成员身份',
            values: state.trendValues
              ? dates.map((_, i) => state.trendValues![i] ?? null)
              : dates.map((_, i) =>
                  body!.metric === 'ACCURACY'
                    ? i === 0
                      ? null
                      : i === 1
                        ? 0
                        : 87.5
                    : body!.metric === 'CPD'
                      ? 4.64
                      : i === 0
                        ? 0
                        : 32.5,
                ),
          }));
        return read(key, data);
      }
    }
    if (log.path === '/api/v1/expert-assignments/my-projects') {
      if (state.user.role !== 'EXPERT') return reply(null, 403, '请切换专家角色');
      const keyword = log.query.keyword?.trim() ?? '';
      return read(
        'participating',
        state.participating.filter((item) =>
          `${item.projectName}${item.requesterName}`.includes(keyword),
        ),
      );
    }
    if (log.path === '/api/v1/expert-assignments/detail') {
      const source = state.participating.find((item) =>
        item.assignmentId != null
          ? String(item.assignmentId) === log.query.assignmentId
          : String(item.movementId) === log.query.movementId,
      );
      if (!source) return reply(null, 403, '本人项目来源无效');
      return read('assignment', {
        ...structuredClone(assignmentDetailExample),
        assignmentId: state.wrongSource ? 999 : source.assignmentId,
        movementId: source.movementId,
        projectDetail: { ...state.project, id: state.wrongSourceProject ? 999 : source.projectId },
        currentNodeCode: state.project.currentNodeCode,
      });
    }
    if (log.path === `/api/v1/projects/${projectId}`)
      return read('foundation', { ...state.project, ...state.materials, id: projectId });
    if (log.path === '/api/v1/projects/standard-materials/detail')
      return read('materials', state.materials);
    if (log.path === '/api/v1/projects/standard-materials/update') {
      if (!['NAVIGATOR', 'PM'].includes(state.user.role))
        return reply(null, 403, '当前角色无材料管理权限');
      if (state.writeNetwork) return route.abort('failed');
      if (state.writeStatus !== 200) return reply(null, state.writeStatus, '材料更新失败');
      state.materials = {
        ...state.materials,
        standardContent: String(body!.standardContent),
        standardLink: body!.standardLink == null ? null : String(body!.standardLink),
        versionNo: state.materials.versionNo + 1,
        stateTransitioned: false,
      };
      state.written = true;
      if (state.failAfterWrite) state.statuses.foundation = 503;
      return reply(state.materials);
    }
    if (log.path === '/api/v1/production-tasks/list')
      return reply({
        current: Number(body?.current ?? 1),
        size: Number(body?.size ?? 20),
        total: 0,
        pages: 0,
        records: [],
      });
    if (log.path === '/api/v1/projects/production-plan')
      return reply({
        ...structuredClone(productionPlanResponse.examples[0]),
        projectId,
        currentNodeCode: state.project.currentNodeCode,
      });
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return reply({
        ...structuredClone(recruitmentDetailExample),
        projectId,
        currentNodeCode: state.project.currentNodeCode,
        canChangeHandler: true,
        currentOperatorRole: 'PRIMARY_MANAGER',
      });
    if (log.path === '/api/v1/files/view') {
      if (state.holdFile)
        await new Promise<void>((resolve) => {
          releaseFile = resolve;
        });
      return state.fileStatus === 200
        ? route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: 'isolated directory attachment',
          })
        : reply(null, state.fileStatus, '项目附件读取被拒绝');
    }
    if (log.path === '/api/v1/entrance-exams/reviewers') return reply([]);
    if (log.path === '/api/v1/projects/manager-candidates') return reply([]);
    if (log.path === '/api/v1/projects/draft/current')
      return reply({ hasDraft: false, draft: null });
    if (
      [
        '/api/v1/projects/list',
        '/api/v1/projects/manager/list',
        '/api/v1/expert-assignments/my-tasks',
      ].includes(log.path)
    )
      return reply([]);
    return reply(null, 404, '目录测试未约定此接口');
  });
  return {
    state,
    requests,
    calls: (suffix: string) => requests.filter((item) => item.path === `/api/v1/${suffix}`),
    release: () => {
      if (!release) throw new Error('没有挂起基础详情');
      state.holdBasic = false;
      release();
    },
    releaseFile: () => {
      if (!releaseFile) throw new Error('没有挂起附件');
      state.holdFile = false;
      releaseFile();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof backend>>;
const mainNav = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true });
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const statisticValue = (page: Page, label: string) =>
  section(page, '项目概览')
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('..')
    .locator('dd');
const noTodo = (f: Fixture, since = 0) =>
  expect(
    f.requests
      .slice(since)
      .filter((item) =>
        [
          '/api/v1/projects/list',
          '/api/v1/projects/manager/list',
          '/api/v1/expert-assignments/my-tasks',
        ].includes(item.path),
      ),
  ).toEqual([]);
async function list(page: Page, search = '') {
  await page.goto(`${origin}/#/project-directory${search}`);
  await expect(page.getByRole('heading', { name: '项目', exact: true, level: 1 })).toBeVisible();
}
async function detail(page: Page, id = projectId, query = 'scope=managed') {
  await page.goto(`${origin}/#/project-directory/${id}?${query}`);
  await expect(
    page.getByRole('heading', { name: '项目详情', exact: true, level: 1 }),
  ).toBeVisible();
}
async function chooseRole(page: Page, name: '领航员' | '策略官' | '执行专家') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(name);
}
async function queryTrend(
  page: Page,
  metric = '正确率趋势',
  start = '2026-11-01',
  end = '2026-11-03',
) {
  const trend = section(page, metric);
  await trend.getByLabel('趋势开始日期', { exact: true }).fill(start);
  await trend.getByLabel('趋势结束日期', { exact: true }).fill(end);
  await trend.getByRole('button', { name: '查询趋势', exact: true }).click();
  return trend;
}
async function openMaterials(page: Page, role: 'NAVIGATOR' | 'PM') {
  await page.getByRole('tab', { name: '业务操作', exact: true }).click();
  const modules = page.getByRole('tablist', {
    name: role === 'NAVIGATOR' ? '领航员项目模块' : '策略官项目模块',
    exact: true,
  });
  await modules.getByRole('tab', { name: '标准与培训', exact: true }).click();
  return section(page, '标准与培训');
}
async function editMaterials(page: Page) {
  const materials = await openMaterials(page, 'PM');
  await materials.getByRole('button', { name: '编辑标准材料', exact: true }).click();
  await expect(materials.getByRole('textbox', { name: '标准正文', exact: true })).toHaveAttribute(
    'contenteditable',
    'true',
  );
  await materials
    .getByRole('textbox', { name: '标准正文', exact: true })
    .fill('从完整目录更新后的标准');
  return materials;
}
async function saveMaterials(page: Page) {
  await section(page, '标准与培训')
    .getByRole('button', {
      name: '保存并发布标准',
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog', {
      name: '发布标准材料',
      exact: true,
    })
    .getByRole('button', { name: '确认发布', exact: true })
    .click();
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: `artifacts/project-directory-parity/${name}.png`, fullPage: true });
}

for (const [role, desktop, manager] of [
  ['NAVIGATOR', false, false],
  ['NAVIGATOR', true, false],
  ['PM', false, false],
  ['EXPERT', false, true],
] as const)
  test(`${desktop ? '桌面配置' : 'Web'}${role}管理项目从独立顶部导航进入，BOARD统计和目录不读取待办`, async ({
    page,
  }) => {
    const f = await backend(page, role, desktop, manager);
    await list(page);
    await expect(mainNav(page).getByRole('link', { name: '项目', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      mainNav(page).getByRole('link', { name: '工作台', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('article', { name: project.projectName!, exact: true }),
    ).toBeVisible();
    expect(f.calls('projects/workbench/statistics')[0]!.query).toEqual({ mode: 'BOARD' });
    await expect(section(page, '项目概览')).toContainText('全部项目 23');
    await expect(section(page, '项目概览').locator('dt')).toHaveText([
      '启动中',
      '组建中',
      '生产中',
    ]);
    await expect(statisticValue(page, '启动中')).toHaveText('0');
    await expect(statisticValue(page, '组建中')).toHaveText('0');
    await expect(statisticValue(page, '生产中')).toHaveText('22');
    expect(f.calls('projects/workbench/board/projects')[0]!.body).toMatchObject({
      current: 1,
      size: 20,
    });
    expect(f.calls('projects/workbench/board/projects')[0]!.headers.cookie).toContain(
      'directory_session=active',
    );
    await page
      .getByRole('article', { name: project.projectName!, exact: true })
      .getByRole('link', { name: '查看项目', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/project-directory\/3001\?.*scope=managed/);
    await expect(section(page, '项目看板')).toBeVisible();
    await expect(section(page, '项目基础信息')).toContainText('独立目录项目描述');
    await expect(mainNav(page).getByRole('link', { name: '项目', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(f.calls('projects/workbench/board/project-detail')[0]!.body).toEqual({ projectId });
    noTodo(f);
    if (desktop) await screenshot(page, 'directory-desktop');
    await page.getByRole('link', { name: '返回项目列表', exact: true }).click();
    await expect(page).toHaveURL(/#\/project-directory(?:\?|$)/);
  });

test('目录搜索和分页由服务端处理，关键词匹配项目或需求方；超额进度保留真实百分数', async ({
  page,
}) => {
  const f = await backend(page);
  await list(page);
  const card = page.getByRole('article', { name: project.projectName!, exact: true });
  await expect(card).toContainText('125.01%');
  await page
    .getByRole('navigation', { name: '项目列表分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await expect(page.getByRole('article', { name: '目录项目23', exact: true })).toBeVisible();
  expect(f.calls('projects/workbench/board/projects').at(-1)!.body).toMatchObject({
    current: 2,
    size: 20,
  });
  await page.getByRole('searchbox', { name: '筛选项目', exact: true }).fill('  末页需求方  ');
  await page.getByRole('button', { name: '查询项目', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(f.calls('projects/workbench/board/projects').at(-1)!.body).toMatchObject({
    keyword: '末页需求方',
    current: 1,
  });
  await page.getByRole('searchbox', { name: '筛选项目', exact: true }).fill('没有匹配目录项目');
  await page.getByRole('button', { name: '查询项目', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: '重置项目筛选', exact: true }).click();
  await expect(card).toBeVisible();
  noTodo(f);
});

test('领航员沿旧版不挂人员趋势和人员风险，禁止发趋势请求，项目及子任务风险保留', async ({
  page,
}) => {
  const f = await backend(page);
  await detail(page);
  await expect(
    section(page, '子任务交付进度').getByRole('article', {
      name: boardSubtasksExample[0]!.subtaskName,
      exact: true,
    }),
  ).toBeVisible();
  await expect(section(page, '项目风险预警')).toContainText('项目已逾期，不足一天');
  await expect(section(page, '子任务风险预警')).toContainText('交付进度偏低');
  for (const name of ['人员趋势', '人员风险预警', '作业数量趋势', '正确率趋势', 'CPD趋势'])
    await expect(section(page, name)).toHaveCount(0);
  expect(f.calls('projects/workbench/board/trends')).toHaveLength(0);
  noTodo(f);
});

test('PM三指标同时绘制多人，空抽检断线与0%不同，同用户成员不合并且日期最多31天', async ({
  page,
}) => {
  const f = await backend(page, 'PM');
  await detail(page);
  const trend = await queryTrend(page);
  const svg = trend.getByRole('img');
  await expect(svg.locator('path')).toHaveCount(2);
  await expect(svg.locator('circle')).toHaveCount(4);
  await expect(trend.locator('figcaption > span')).toHaveCount(2);
  await expect(trend.locator('figcaption')).toContainText(
    `用户ID：${boardTrendsExample.series[0]!.userId}`,
  );
  const titles = await svg.locator('circle title').allTextContents();
  expect(titles.filter((text) => text.includes('2026-11-02 · 0%'))).toHaveLength(2);
  expect(titles.filter((text) => text.includes('2026-11-03 · 87.5%'))).toHaveLength(2);
  expect(titles.some((text) => text.includes('2026-11-01'))).toBe(false);
  await expect(trend).toContainText('断点表示当天无抽检数据；0%表示存在抽检且合格量为0。');
  await expect(trend.getByRole('combobox')).toHaveCount(0);
  const quantity = await queryTrend(page, '作业数量趋势');
  expect(
    (await quantity.locator('circle title').allTextContents()).filter((text) =>
      text.includes('2026-11-01 · 0 条'),
    ),
  ).toHaveLength(2);
  const before = f.calls('projects/workbench/board/trends').length;
  for (const [start, end] of [
    ['2026-11-04', '2026-11-03'],
    ['2026-10-01', '2026-11-01'],
  ]) {
    await trend.getByLabel('趋势开始日期', { exact: true }).fill(start!);
    await trend.getByLabel('趋势结束日期', { exact: true }).fill(end!);
    await trend.getByRole('button', { name: '查询趋势', exact: true }).click();
    await expect(trend).toContainText('包含首尾最多31天');
    expect(f.calls('projects/workbench/board/trends')).toHaveLength(before);
  }
  await queryTrend(page, '正确率趋势', '2026-10-01', '2026-10-31');
  expect(f.calls('projects/workbench/board/trends').at(-1)!.body).toEqual({
    projectId,
    metric: 'ACCURACY',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
  noTodo(f);
});

test('真实空目录、空子任务和空趋势保持空态，不靠待办或虚构数值填充', async ({ page }) => {
  const f = await backend(page, 'PM');
  f.state.rows = [];
  await list(page);
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(f.calls('projects/workbench/board/projects')).toHaveLength(1);
  f.state.rows = [
    {
      ...boardProjectsExample.records[0]!,
      projectId,
      projectName: project.projectName!,
      progressQuantity: 0,
      progressPercent: 0,
    },
  ];
  f.state.subtasks = [];
  f.state.forceEmptyTrends = true;
  await detail(page);
  await expect(section(page, '子任务交付进度')).toContainText('暂无可展示的子任务。');
  for (const name of ['作业数量趋势', '正确率趋势', 'CPD趋势'])
    await expect(section(page, name)).toContainText('当前范围暂无可展示的人员趋势。');
  noTodo(f);
});

test('管理目录网络失败与403明确展示，显式读取恢复；专家失权不自动切参与项目', async ({ page }) => {
  const f = await backend(page, 'EXPERT', false, true);
  f.state.network.add('projects');
  await list(page);
  await expect(page.getByText(/连接服务失败/)).toBeVisible();
  f.state.network.delete('projects');
  f.state.denyRoles.add('EXPERT');
  await page.getByRole('button', { name: '查询项目', exact: true }).click();
  await expect(page.getByText('当前用户无权查看该项目看板', { exact: true })).toBeVisible();
  expect(f.calls('expert-assignments/my-projects')).toHaveLength(0);
  await expect(page.getByRole('article')).toHaveCount(0);
  f.state.denyRoles.delete('EXPERT');
  await page.getByRole('button', { name: '查询项目', exact: true }).click();
  await expect(
    page.getByRole('article', { name: project.projectName!, exact: true }),
  ).toBeVisible();
  noTodo(f);
});

test('看板分项503独立重试，不变为空数据或连带重读另外两项趋势', async ({ page }) => {
  const f = await backend(page, 'PM');
  for (const key of ['subtasks', 'risks', 'trends']) f.state.statuses[key] = 503;
  await detail(page);
  const board = section(page, '项目看板');
  await expect(section(page, '项目基础信息')).toContainText('独立目录项目描述');
  for (const [key, region, button] of [
    ['subtasks', '子任务交付进度', '重新读取子任务进度'],
    ['risks', '项目看板', '重新读取风险预警'],
    ['trends', '作业数量趋势', '重新读取人员趋势'],
  ]) {
    const area = section(page, region!);
    await expect(area.getByText(`${key}读取失败`, { exact: true }).first()).toBeVisible();
    const before = f.requests.length;
    f.state.statuses[key!] = 200;
    await area.getByRole('button', { name: button!, exact: true }).click();
    await expect
      .poll(
        () => f.requests.slice(before).filter((item) => item.path === `${boardPath}${key}`).length,
      )
      .toBe(1);
    expect(
      f.requests
        .slice(before)
        .filter((item) => item.path.startsWith(boardPath))
        .map((item) => item.path),
    ).toEqual([`${boardPath}${key}`]);
  }
  await expect(section(page, '正确率趋势')).toContainText('trends读取失败');
  await expect(section(page, 'CPD趋势')).toContainText('trends读取失败');
  await expect(board.getByRole('button', { name: '刷新看板', exact: true })).toHaveCount(0);
  noTodo(f);
});

test('COMPLETED项目在目录与直链仍可读取，显示结项及关闭时间且不撤卡', async ({ page }) => {
  const f = await backend(page);
  await detail(page, 3002);
  await expect(section(page, '项目基础信息')).toContainText('已结项目录项目');
  await expect(section(page, '项目基础信息')).toContainText('结项');
  await expect(section(page, '项目基础信息')).toContainText('2026-11-03 17:00:00');
  await expect(page).toHaveURL(/project-directory\/3002/);
  noTodo(f);
});

test('项目档案HTML和非HTTP标准链接只展示安全内容，不执行脚本或外链图片', async ({ page }) => {
  const f = await backend(page);
  let externalImages = 0;
  await page.route('https://evil.invalid/**', (route) => {
    externalImages++;
    return route.abort('failed');
  });
  f.state.basic.projectDescription =
    '<script>window.__directoryUnsafe=true</script><img src="https://evil.invalid/x">原始说明';
  f.state.basic.standardLink = 'javascript:alert(1)';
  await detail(page);
  const basic = section(page, '项目基础信息');
  await basic.getByText('查看项目档案', { exact: true }).click();
  await expect(basic.getByRole('link', { name: 'javascript:alert(1)', exact: true })).toHaveCount(
    0,
  );
  await expect(basic.locator('script, img')).toHaveCount(0);
  expect(externalImages).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, '__directoryUnsafe'))).toBeUndefined();
  noTodo(f);
});

test('管理专家仅看组织合并看板，max assignmentId不拼人员或生产来源，参与标签独立查询', async ({
  page,
}) => {
  const f = await backend(page, 'EXPERT', false, true);
  await detail(page);
  await expect(section(page, '子任务交付进度')).toContainText('实际可管理组织的合并范围');
  await expect(page.getByRole('tab', { name: '业务操作', exact: true })).toHaveCount(0);
  expect(f.calls('expert-assignments/detail')).toHaveLength(0);
  expect(
    f.requests.filter((item) => /\/project-personnel\/|\/production-tasks\//.test(item.path)),
  ).toHaveLength(0);
  await list(page);
  const before = f.requests.length;
  await page.getByRole('tab', { name: '参与项目', exact: true }).click();
  await expect.poll(() => f.calls('expert-assignments/my-projects').length).toBe(1);
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(f.requests.slice(before).filter((item) => item.path.startsWith(boardPath))).toHaveLength(
    0,
  );
  noTodo(f);
});

test('普通专家默认参与目录，详情使用真实分配来源和本人阶段，不请求管理看板或擅自挂业务表单', async ({
  page,
}) => {
  const f = await backend(page, 'EXPERT');
  await list(page, '?view=managed');
  await expect(page.getByRole('tablist', { name: '项目范围', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '管理项目', exact: true })).toHaveCount(0);
  await expect(section(page, '项目概览')).toHaveCount(0);
  expect(f.calls('projects/workbench/statistics')).toHaveLength(0);
  const card = page.getByRole('article', { name: project.projectName!, exact: true });
  await expect(card).toContainText('本人阶段');
  await card.getByRole('link', { name: '查看项目', exact: true }).click();
  await expect(page).toHaveURL(
    /scope=participating.*assignmentId=101|assignmentId=101.*scope=participating/,
  );
  await expect(
    page.getByRole('heading', { name: '项目详情', exact: true, level: 1 }),
  ).toBeVisible();
  expect(f.calls('expert-assignments/detail')[0]!.query).toEqual({ assignmentId: '101' });
  expect(f.requests.filter((item) => item.path.startsWith(boardPath))).toHaveLength(0);
  await expect(page.getByRole('tab', { name: '业务操作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '前往工作台', exact: true })).toBeVisible();
  noTodo(f);
});

test('个人转入目录保留movement-only来源，查看不伪造分配ID也不回退管理接口', async ({ page }) => {
  const f = await backend(page, 'EXPERT');
  f.state.user.organization = null;
  f.state.participating = [{ ...f.state.participating[0]!, assignmentId: null, movementId: 701 }];
  await detail(page, projectId, 'scope=participating&movementId=701');
  await expect(page.getByText('独立目录项目描述', { exact: true })).toBeVisible();
  expect(f.calls('expert-assignments/detail')[0]!.query).toEqual({ movementId: '701' });
  expect(f.requests.filter((item) => item.path.startsWith(boardPath))).toHaveLength(0);
  noTodo(f);
});

test('本人参与资料附件仅Cookie鉴权，403明确提示；关闭切角色后迟到响应不得下载', async ({
  page,
}) => {
  const f = await backend(page, 'EXPERT');
  const objectKey = `project-attachment/2026/11/04/${'a'.repeat(32)}.txt`;
  f.state.project.attachments = [
    {
      id: 81,
      attachmentType: 'STANDARD_REFERENCE',
      fileName: '参与项目资料.txt',
      objectKey,
      extension: 'txt',
      contentType: 'text/plain',
      fileSize: 28,
      fileHash: 'a'.repeat(64),
      sortNo: 0,
      status: 'ACTIVE',
    },
  ];
  await detail(page, projectId, 'scope=participating&assignmentId=101');
  await page.getByRole('button', { name: '查看完整项目资料', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '项目详情', exact: true });
  f.state.fileStatus = 403;
  await modal.getByRole('button', { name: '下载', exact: true }).click();
  await expect(modal).toContainText('项目附件读取被拒绝');
  expect(f.calls('files/view')[0]!.query).toEqual({ objectKey });
  expect(f.calls('files/view')[0]!.headers.cookie).toContain('directory_session=active');
  f.state.fileStatus = 200;
  f.state.holdFile = true;
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await modal.getByRole('button', { name: '下载', exact: true }).click();
  await expect.poll(() => f.calls('files/view').length).toBe(2);
  await modal.getByRole('button', { name: '关闭项目详情', exact: true }).click();
  await chooseRole(page, '策略官');
  const response = page.waitForResponse((item) => item.url().includes('/files/view'));
  f.releaseFile();
  await response;
  await expect(page.getByRole('heading', { name: '项目', exact: true, level: 1 })).toBeVisible();
  expect(downloads).toEqual([]);
});

for (const query of ['scope=participating', 'scope=participating&assignmentId=101&movementId=701'])
  test(`参与详情非法来源${query}不猜测真实分配或通过projectId扩大读取`, async ({ page }) => {
    const f = await backend(page, 'EXPERT');
    const queries =
      query === 'scope=participating'
        ? [
            query,
            'scope=participating&assignmentId=0',
            'scope=participating&movementId=2147483648',
            'scope=invalid',
            'scope=managed&assignmentId=101',
          ]
        : [query];
    for (const invalid of queries) {
      await page.goto(`${origin}/#/project-directory/${projectId}?${invalid}`);
      await expect(page.getByRole('heading', { name: '项目地址无效', exact: true })).toBeVisible();
    }
    expect(f.calls('expert-assignments/detail')).toHaveLength(0);
    expect(f.requests.filter((item) => item.path.startsWith(boardPath))).toHaveLength(0);
    noTodo(f);
  });

for (const kind of ['source', 'project'] as const)
  test(`参与详情返回错误${kind}绑定时拒绝内容，不能套用另一个项目或分配`, async ({ page }) => {
    const f = await backend(page, 'EXPERT');
    if (kind === 'source') f.state.wrongSource = true;
    else f.state.wrongSourceProject = true;
    await page.goto(
      `${origin}/#/project-directory/${projectId}?scope=participating&assignmentId=101`,
    );
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('独立目录项目描述', { exact: true })).toHaveCount(0);
    noTodo(f);
  });

test('角色切换清除旧看板；迟到NAV基础响应不能覆盖PM的真实403或触发参与回退', async ({ page }) => {
  const f = await backend(page);
  f.state.basic.projectDescription = '迟到的NAV保密描述';
  f.state.holdBasic = true;
  await page.goto(`${origin}/#/project-directory/${projectId}?scope=managed`);
  await expect
    .poll(() => f.calls('projects/workbench/board/project-detail').length)
    .toBeGreaterThan(0);
  f.state.denyRoles.add('PM');
  await chooseRole(page, '策略官');
  f.release();
  await expect(page.getByText('当前用户无权查看该项目看板', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('迟到的NAV保密描述', { exact: true })).toHaveCount(0);
  expect(f.calls('expert-assignments/my-projects')).toHaveLength(0);
  noTodo(f);
});

test('领航员目录标准仅可阅读，无编辑发布或确认已读入口，读取权限不能变成写权限', async ({
  page,
}) => {
  const f = await backend(page);
  await detail(page);
  const materials = await openMaterials(page, 'NAVIGATOR');
  await expect(materials).toContainText(project.standardContent!);
  await expect(
    materials.getByRole('link', { name: project.standardLink!, exact: true }),
  ).toHaveAttribute('href', project.standardLink!);
  for (const name of ['编辑标准材料', '标准发布', '保存标准材料', '保存并发布标准', '确认已阅读'])
    await expect(materials.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(materials.getByRole('textbox')).toHaveCount(0);
  await expect(materials.locator('[contenteditable="true"]')).toHaveCount(0);
  expect(f.calls('projects/standard-materials/detail')).toHaveLength(1);
  expect(f.calls('entrance-exams/reviewers')).toHaveLength(0);
  expect(f.calls('projects/standard-materials/update')).toHaveLength(0);
  noTodo(f);
});

test('策略官从完整目录可直接发布既有标准，待办为空仍留详情与当前业务页签', async ({ page }) => {
  const f = await backend(page, 'PM');
  await detail(page);
  const materials = await openMaterials(page, 'PM');
  await materials.getByRole('button', { name: '标准发布', exact: true }).click();
  await expect.poll(() => f.calls('projects/standard-materials/update').length).toBe(1);
  await expect(page).toHaveURL(/#\/project-directory\/3001\?scope=managed/);
  await expect(page.getByRole('tab', { name: '业务操作', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(materials).toContainText(project.standardContent!);
  expect(f.calls('projects/standard-materials/update')[0]!.body).toMatchObject({
    standardContent: project.standardContent,
    standardLink: project.standardLink,
  });
  expect(f.state.materials.currentNodeCode).toBe('PRODUCTION_TASK');
  expect(f.state.materials.versionNo).toBe(5);
  noTodo(f);
});

test('目录业务写成功但详情回读503只保留成功事实，恢复仅GET且不按待办撤离', async ({ page }) => {
  const f = await backend(page, 'PM');
  f.state.failAfterWrite = true;
  await detail(page);
  await editMaterials(page);
  await saveMaterials(page);
  const materials = section(page, '标准与培训');
  await expect(materials).toContainText('标准材料已保存');
  await expect(materials.getByRole('button', { name: '编辑标准材料', exact: true })).toHaveCount(0);
  await expect(materials.getByRole('button', { name: '保存并发布标准', exact: true })).toHaveCount(
    0,
  );
  f.state.statuses.foundation = 200;
  await materials.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(materials.getByRole('button', { name: '编辑标准材料', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/#\/project-directory\/3001/);
  expect(f.calls('projects/standard-materials/update')).toHaveLength(1);
  noTodo(f);
});

test('目录内未知材料写切到看板再恢复原稿仍锁住，不因目录可读或待办为空而重发', async ({ page }) => {
  const f = await backend(page, 'PM');
  f.state.writeNetwork = true;
  await detail(page);
  await editMaterials(page);
  await saveMaterials(page);
  const materials = section(page, '标准与培训');
  await expect(materials).toContainText('提交结果暂未确认');
  await page.getByRole('tab', { name: '项目看板', exact: true }).click();
  await expect(section(page, '项目看板')).toBeVisible();
  await page.getByRole('tab', { name: '业务操作', exact: true }).click();
  await page
    .getByRole('tablist', { name: '策略官项目模块', exact: true })
    .getByRole('tab', { name: '标准与培训', exact: true })
    .click();
  await expect(materials.getByRole('textbox', { name: '标准正文', exact: true })).toContainText(
    '从完整目录更新后的标准',
  );
  await expect(
    materials.getByRole('button', { name: '保存并发布标准', exact: true }),
  ).toBeDisabled();
  await materials.getByRole('button', { name: '重新读取标准材料', exact: true }).click();
  await expect(
    materials.getByRole('button', { name: '保存并发布标准', exact: true }),
  ).toBeDisabled();
  expect(f.calls('projects/standard-materials/update')).toHaveLength(1);
  noTodo(f);
});

test('375px项目导航与长档案看板无横溢出，可键盘进入独立目录且高亮与工作台分开', async ({
  page,
}) => {
  const f = await backend(page, 'EXPERT', false, true);
  f.state.basic.projectDescription = '长档案'.repeat(100);
  f.state.subtasks[0]!.subtaskName = '可换行的长子任务名称'.repeat(8);
  await page.setViewportSize({ width: 375, height: 812 });
  await list(page);
  const link = mainNav(page).getByRole('link', { name: '项目', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('article', { name: project.projectName!, exact: true })
    .getByRole('link', { name: '查看项目', exact: true })
    .click();
  await expect(section(page, '项目看板')).toBeVisible();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(
    mainNav(page).getByRole('link', { name: '工作台', exact: true }),
  ).not.toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const trend = await queryTrend(page);
  await expect(trend.getByRole('img')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, 'directory-375');
  noTodo(f);
});

test('整体进度沿用110原始项目值并翻页精确匹配ID，拒绝自增统计和百分比相加', async ({ page }) => {
  const f = await backend(page, 'EXPERT', false, true);
  const own = {
    ...f.state.rows[0]!,
    progressQuantity: 1234.5678,
    targetQuantity: 1000,
    progressPercent: 123.46,
  };
  // 同名搜索产生两页；第一条同名项目不是本项目，不能借用其进度。
  f.state.rows = [
    ...Array.from({ length: 100 }, (_, i) => ({
      ...own,
      projectId: 6000 + i,
      projectNo: `OTHER-${i}`,
      progressQuantity: 0,
      progressPercent: 0,
    })),
    own,
  ];
  await detail(page);
  const progress = section(page, '项目整体进度');
  await expect(progress).toContainText('累计报量 1,234.57 / 1,000');
  await expect(progress).toContainText('123.46%');
  expect(f.calls('projects/workbench/board/projects').map((call) => call.body)).toEqual([
    { keyword: project.projectName, current: 1, size: 100 },
    { keyword: project.projectName, current: 2, size: 100 },
  ]);
  await expect(section(page, '项目数据概览')).toHaveCount(0);
  for (const label of ['子任务总数', '已验收', '待验收', '风险提醒'])
    await expect(
      section(page, '项目看板')
        .locator('dt')
        .filter({ hasText: new RegExp(`^${label}$`) }),
    ).toHaveCount(0);
  await expect(
    section(page, '项目看板').getByRole('button', { name: '刷新看板', exact: true }),
  ).toHaveCount(0);
  await expect(section(page, '子任务交付进度')).toContainText('实际可管理组织的合并范围');
  await expect(section(page, '项目风险预警')).toContainText('1 条风险 · 1 条紧急');
  await expect(section(page, '子任务风险预警')).toContainText('1 条风险 · 0 条紧急');
  noTodo(f);
});

test('整体进度读取503不冒充0%，空列表与真实0区分，独立重读不生成统计总览', async ({ page }) => {
  const f = await backend(page, 'PM');
  f.state.statuses.projects = 503;
  await detail(page);
  const progress = section(page, '项目整体进度');
  await expect(progress).toContainText('projects读取失败');
  await expect(progress.getByText('0%', { exact: true })).toHaveCount(0);
  await expect(section(page, '项目数据概览')).toHaveCount(0);
  f.state.statuses.projects = 200;
  Object.assign(f.state.rows[0]!, { progressQuantity: 0, progressPercent: 0 });
  const before = f.requests.length;
  await progress.getByRole('button', { name: '重新读取项目进度', exact: true }).click();
  await expect(progress.getByText('0%', { exact: true })).toBeVisible();
  expect(f.requests.slice(before).map((call) => call.path)).toEqual([`${boardPath}projects`]);
  f.state.rows = [];
  await progress.getByRole('button', { name: '重新读取项目进度', exact: true }).click();
  await expect(progress).toContainText('当前列表中暂无项目进度。');
  await expect(progress.getByText('0%', { exact: true })).toHaveCount(0);
  noTodo(f);
});

test('三趋势卡独立七日默认与查询范围，拒绝总刷新和单选指标/成员，改单项不连带查询', async ({
  page,
}) => {
  const f = await backend(page, 'PM');
  await detail(page);
  const expectedDefault = ['ACCURACY', 'CPD', 'QUANTITY'].map((metric) => ({
    projectId,
    metric,
    startDate: dayOffset(-6),
    endDate: today,
  }));
  await expect
    .poll(() =>
      f
        .calls('projects/workbench/board/trends')
        .map((call) => call.body)
        .sort((a, b) => String(a!.metric).localeCompare(String(b!.metric))),
    )
    .toEqual(expectedDefault);
  for (const name of ['作业数量趋势', '正确率趋势', 'CPD趋势']) {
    const area = section(page, name);
    await expect(area.getByLabel('趋势开始日期', { exact: true })).toHaveValue(dayOffset(-6));
    await expect(area.getByLabel('趋势结束日期', { exact: true })).toHaveValue(today);
    await expect(area.getByRole('img')).toBeVisible();
  }
  const before = f.requests.length;
  const trend = await queryTrend(page, '正确率趋势', '2026-11-01', '2026-11-05');
  await expect(trend.getByRole('img')).toBeVisible();
  await expect
    .poll(() => f.requests.slice(before).map((call) => call.body))
    .toEqual([{ projectId, metric: 'ACCURACY', startDate: '2026-11-01', endDate: '2026-11-05' }]);
  await expect(
    section(page, '作业数量趋势').getByLabel('趋势开始日期', { exact: true }),
  ).toHaveValue(dayOffset(-6));
  await expect(section(page, 'CPD趋势').getByLabel('趋势开始日期', { exact: true })).toHaveValue(
    dayOffset(-6),
  );
  await expect(section(page, '人员趋势').getByRole('combobox')).toHaveCount(0);
  await expect(
    section(page, '项目看板').getByRole('button', { name: '刷新看板', exact: true }),
  ).toHaveCount(0);
  expect(f.calls('projects/workbench/statistics')).toHaveLength(0);
  expect(
    f.requests
      .slice(before)
      .every((item) => item.method === 'POST' && item.path === `${boardPath}trends`),
  ).toBe(true);
  noTodo(f);
});

test('375与1280多人曲线保留0和null断点，超过十人改日期矩阵，数值按旧版最多显示两位小数', async ({
  page,
}) => {
  const f = await backend(page, 'PM');
  f.state.trendValues = [0, null, 87.5, 0, 50];
  await page.setViewportSize({ width: 375, height: 812 });
  await detail(page);
  const trend = await queryTrend(page, '正确率趋势', '2026-11-01', '2026-11-05');
  const chart = trend.getByRole('region', { name: '趋势图表', exact: true });
  const svg = chart.getByRole('img');
  await expect(svg.locator('circle')).toHaveCount(8);
  await expect(svg.locator('path')).toHaveCount(2);
  for (const path of await svg
    .locator('path')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')))) {
    expect(path?.match(/M/g)).toHaveLength(2);
    expect(path?.match(/L/g)).toHaveLength(2);
  }
  const pointTitles = await svg.locator('circle title').allTextContents();
  expect(pointTitles.filter((text) => text.includes('2026-11-01 · 0%'))).toHaveLength(2);
  expect(pointTitles.some((text) => text.includes('2026-11-02'))).toBe(false);
  expect(
    pointTitles.filter((text) => text.includes(`用户ID：${boardTrendsExample.series[0]!.userId}`)),
  ).toHaveLength(8);
  for (const width of [375, 1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await svg.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        svg.evaluate((node) =>
          Math.abs(
            (node as SVGSVGElement).viewBox.baseVal.width - node.getBoundingClientRect().width,
          ),
        ),
      )
      .toBeLessThan(1);
    const layout = await chart.evaluate((node) => {
      const svg = node.querySelector('svg')!,
        box = svg.getBoundingClientRect();
      const fits = (rect: DOMRect) =>
        rect.left >= box.left - 1 &&
        rect.right <= box.right + 1 &&
        rect.top >= box.top - 1 &&
        rect.bottom <= box.bottom + 1;
      return {
        overflow: node.scrollWidth > node.clientWidth + 1,
        height: box.height,
        pointsFit: [...svg.querySelectorAll('circle')].every((point) =>
          fits(point.getBoundingClientRect()),
        ),
        axesFit: [...svg.querySelectorAll('text[font-size="12"]')].every((text) =>
          fits(text.getBoundingClientRect()),
        ),
        zeroY: [...svg.querySelectorAll('circle')]
          .filter((point) => point.querySelector('title')?.textContent?.endsWith(' · 0%'))
          .map((point) => point.cy.baseVal.value),
      };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.pointsFit).toBe(true);
    expect(layout.axesFit).toBe(true);
    expect(layout.height).toBeCloseTo(260, 0);
    expect(new Set(layout.zeroY).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 1280) await screenshot(page, 'dashboard-desktop');
  }
  await screenshot(page, 'dashboard-375');
  f.state.trendMemberCount = 10;
  f.state.trendValues = [999999.1234, 0, 1, 0, 0];
  const quantity = await queryTrend(page, '作业数量趋势', '2026-11-01', '2026-11-05');
  await expect(quantity.locator('figcaption > span')).toHaveCount(10);
  await expect(quantity.getByRole('img').locator('path')).toHaveCount(10);
  await expect(quantity.getByRole('table')).toHaveCount(0);
  await expect(quantity.locator('circle title').first()).toContainText(
    '2026-11-01 · 999,999.12 条',
  );
  f.state.trendMemberCount = 11;
  await queryTrend(page, '作业数量趋势', '2026-11-01', '2026-11-05');
  const matrix = quantity.getByRole('table', { name: '作业数量逐日人员数据', exact: true });
  await expect(matrix.getByRole('row')).toHaveCount(12);
  await expect(matrix.getByRole('columnheader')).toHaveCount(6);
  await expect(matrix.getByRole('cell', { name: '999,999.12 条', exact: true })).toHaveCount(11);
  await expect(
    matrix.getByRole('cell', {
      name: `同人不同成员身份（用户ID：${boardTrendsExample.series[0]!.userId}）`,
      exact: true,
    }),
  ).toHaveCount(11);
  await expect(quantity.getByRole('img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, 'dashboard-matrix-375');
  noTodo(f);
});
