import { expect, test, type Locator, type Page } from '@playwright/test';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { productionPlanResponse } from '../../apps/server/src/modules/projects/project-production-plan.schema';
import { projectCardExample } from '../../apps/server/src/modules/projects/project-list.schema';
import {
  examDetailExample,
  examManagementExample,
  examRosterExample,
} from '../../apps/server/src/modules/entrance-exams/exam-query.schema';
import { examGradingDetailExample } from '../../apps/server/src/modules/entrance-exams/exam-grading-query.schema';
import { examAdmissionExample } from '../../apps/server/src/modules/entrance-exams/exam-admission.schema';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import type {
  AuthUser,
  EntranceExamAdmissionItem,
  EntranceExamConfiguration,
  EntranceExamGradingDetail,
  EntranceExamManagement,
  EntranceExamRosterItem,
  NavigatorProjectCard,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001,
  examId = 5001,
  attemptId = 11001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
test.use({ timezoneId: 'America/Los_Angeles' });
const user: AuthUser = {
  id: uuid(1),
  uid: 'NAVEXAMS10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '领航阅卷员',
  realName: '测试阅卷员',
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
  createdAt: '2026-11-04T03:00:00.000Z',
  updatedAt: '2026-11-04T03:00:00.000Z',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectName: '领航员阅卷项目',
  requesterId: uuid(88),
  requesterName: '其他需求方',
  creatorUid: 'OTHERCREATOR',
  creatorName: '其他创建人',
  projectDescription: '仅配置阅卷人可读考试数据。',
  experienceRequirement: null,
  workSummary: null,
  specialRequirement: null,
  standardLink: null,
  currentNodeCode: 'PRODUCTION_TASK',
  attachments: [],
} as WorkbenchProjectDetail;
const card = {
  ...structuredClone(projectCardExample),
  id: projectId,
  projectName: project.projectName,
  creatorId: uuid(88),
  creatorName: '其他创建人',
  currentNodeCode: 'PRODUCTION_TASK',
  branchNodeCode: 'ENTRANCE_EXAM_GRADING',
  workbenchStatus: 'PROCESSING',
  currentAction: 'VIEW_DETAIL',
  currentActionDescription: '协助阅卷',
  needAssistGrading: true,
} as NavigatorProjectCard;
const attachment = {
  uploadedFileId: uuid(90),
  fileName: '历史答案.txt',
  objectKey: `entrance-exam-attachment/2026/11/04/${'a'.repeat(32)}.txt`,
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 19,
  fileHash: 'a'.repeat(64),
};
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** HTTP替身保留应试绑定来源；当前配置仅供显式查看，人工阅卷资格由提交接口鉴权。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.context().addCookies([
    {
      name: 'navigator_exam_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const configuration = structuredClone(examDetailExample) as EntranceExamConfiguration;
  configuration.examName = '当前准入考试';
  configuration.gradingRounds[0]!.reviewers = [
    { userId: user.id, uid: user.uid, name: user.nickname },
  ];
  configuration.papers[0]!.questions = [1, 2].map((number) => ({
    ...structuredClone(configuration.papers[0]!.questions[0]!),
    questionId: 8000 + number,
    sequenceNo: number,
    questionContent: `绑定试卷题目${number}`,
    score: 10,
    questionFiles: null,
    referenceFiles: null,
  }));
  const grading = structuredClone(examGradingDetailExample) as EntranceExamGradingDetail;
  grading.candidateName = '应试甲';
  grading.candidateUid = 'CANDIDATE1';
  grading.selectedRound = {
    ...grading.selectedRound,
    status: 'PENDING',
    score: null,
    roundResult: null,
    conclusionSummary: null,
    errorMessage: null,
  };
  grading.rounds[0] = structuredClone(grading.selectedRound);
  grading.questions = [1, 2].map((number) => ({
    ...structuredClone(grading.questions[0]!),
    questionId: 8000 + number,
    sequenceNo: number,
    questionContent: `绑定试卷题目${number}`,
    score: 10,
    referenceAnswer: `历史参考${number}`,
    answerId: 12000 + number,
    answerContent: `考生实际答案${number}`,
    questionFiles: null,
    referenceFiles: null,
    answerFiles: number === 1 ? [attachment] : [],
    correctness: null,
    gradingOpinion: null,
  }));
  const management = {
    ...structuredClone(examManagementExample),
    canCreateExam: false,
    createDisabledReason: '阅卷人仅可查看考试信息',
    exams: [
      { ...structuredClone(examManagementExample.exams[0]), examName: '当前准入考试' },
      {
        ...structuredClone(examManagementExample.exams[0]),
        examId: 5002,
        examNo: 'EX-HISTORY-5002',
        examName: '已关闭历史考试',
        currentVersionId: 16001,
        status: 'CLOSED',
        closedAt: '2026-11-03 18:00:00',
      },
    ],
  } as EntranceExamManagement;
  const roster: EntranceExamRosterItem[] = Array.from({ length: 23 }, (_, index) => ({
    ...structuredClone(examRosterExample.records[0]),
    attemptId: attemptId + index,
    candidateUserId: uuid(100 + index),
    candidateUid: `CANDIDATE${index + 1}`,
    candidateName: index === 0 ? '应试甲' : index === 1 ? '应试乙' : `候选人${index + 1}`,
    finalResult: index === 1 ? 'ADMITTED' : 'PENDING',
    roundScores: [{ roundNo: 1, gradingMode: 'MANUAL', score: null, roundResult: null }],
  }));
  const admissions: EntranceExamAdmissionItem[] = roster.map((row, index) => ({
    ...structuredClone(examAdmissionExample.records[0]),
    attemptId: row.attemptId,
    examId,
    examName: '应试绑定历史名称',
    candidateUserId: row.candidateUserId,
    candidateUid: row.candidateUid,
    candidateName: row.candidateName,
    admissionStatus: index === 1 ? 'PENDING_ENTRY' : index === 2 ? 'ADMITTED' : 'PENDING',
    employmentType: null,
  }));
  const state = {
    user: structuredClone(user),
    projects: [structuredClone(card)],
    configuration,
    grading,
    management,
    reader: true,
    managementStatus: 200,
    configurationStatus: 200,
    rosterStatus: 200,
    gradingStatus: 200,
    admissionStatus: 200,
    fileStatus: 200,
    projectsStatus: 200,
    writeStatus: 200,
    network: false,
    commitOnFailure: false,
    postReadFailure: false,
    hold: false,
    malformed: false,
    holdFile: false,
  };
  const requests: RequestLog[] = [];
  let releaseWrite: (() => void) | undefined;
  let releaseFile: (() => void) | undefined;
  function save(input: Record<string, unknown>) {
    const historicOffset = input.examId === 5002 ? 10000 : 0;
    const round = state.grading.rounds.find(
      (item) => item.gradingRecordId === Number(input.gradingRecordId) - historicOffset,
    )!;
    round.status = 'COMPLETED';
    round.score = 10;
    round.roundResult = 'ELIMINATED';
    round.conclusionSummary = String(input.conclusionSummary ?? '') || null;
    state.grading.questions = state.grading.questions.map((question) => {
      const submitted = (input.items as Record<string, unknown>[]).find(
        (item) => item.questionId === question.questionId + historicOffset,
      )!;
      return {
        ...question,
        correctness: submitted.correctness,
        gradingOpinion: submitted.gradingOpinion,
      };
    }) as EntranceExamGradingDetail['questions'];
    roster[0]!.roundScores[0] = {
      roundNo: round.roundNo,
      gradingMode: 'MANUAL',
      score: 10,
      roundResult: 'ELIMINATED',
    };
    return {
      attemptId: Number(input.attemptId),
      gradingRecordId: Number(input.gradingRecordId),
      recordStatus: 'COMPLETED',
      score: 10,
      roundResult: 'ELIMINATED',
      gradingStatus: 'IN_PROGRESS',
      finalResult: 'PENDING',
    };
  }
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    requests.push({
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers: await request.allHeaders(),
    });
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (path === '/api/v1/users/me') return reply(state.user);
    if (path === '/api/v1/auth/switch-role') {
      state.user.role = body!.role as AuthUser['role'];
      state.user.selectedRole = state.user.role;
      return reply({ selectedRole: state.user.role, roles: state.user.roles });
    }
    if (path === '/api/v1/projects/list')
      return reply(
        state.projectsStatus === 200
          ? state.projects.filter(
              (item) =>
                !url.searchParams.get('keyword') ||
                item.projectName?.includes(url.searchParams.get('keyword')!),
            )
          : null,
        state.projectsStatus,
        state.projectsStatus === 200 ? '操作成功' : '最新项目待办读取失败',
      );
    if (path === '/api/v1/projects/production-plan')
      return reply({ ...productionPlanResponse.examples[0], projectId, needWrittenExam: true });
    if (path === '/api/v1/projects/manager/list') return reply([strategistProjectCard(project)]);
    if (path === '/api/v1/projects/draft/current') return reply({ hasDraft: false, draft: null });
    if (path === `/api/v1/projects/${projectId}`) return reply(project);
    if (path === '/api/v1/expert-assignments/my-tasks') return reply([]);
    if (path === '/api/v1/entrance-exams/reviewers')
      return reply([{ userId: user.id, uid: user.uid, name: user.nickname, avatarUrl: null }]);
    if (path.startsWith('/api/v1/entrance-exams/') && !state.reader)
      return reply(null, 403, '当前账号不在项目人工阅卷池');
    if (path === '/api/v1/entrance-exams/management')
      return reply(
        state.managementStatus === 200 ? state.management : null,
        state.managementStatus,
        '考试管理读取结果',
      );
    if (path === '/api/v1/entrance-exams/detail') {
      if (url.searchParams.get('examId') === '5002')
        return reply(null, 400, '已关闭考试不允许编辑');
      return reply(
        state.configurationStatus === 200 ? state.configuration : null,
        state.configurationStatus,
        '当前配置读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/roster') {
      const current = Number(body!.current ?? 1),
        size = Number(body!.size ?? 20);
      const records = roster
        .map((row) => (body!.examId === 5002 ? { ...row, attemptId: row.attemptId + 10000 } : row))
        .filter(
          (row) =>
            (!body!.keyword || row.candidateName.includes(String(body!.keyword))) &&
            (!body!.finalResult || row.finalResult === body!.finalResult),
        );
      return reply(
        state.rosterStatus === 200
          ? {
              current,
              size,
              total: records.length,
              pages: Math.ceil(records.length / size),
              records: records.slice((current - 1) * size, current * size),
            }
          : null,
        state.rosterStatus,
        '考试名单读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/admissions') {
      const current = Number(url.searchParams.get('current') ?? 1),
        size = Number(url.searchParams.get('size') ?? 20);
      const records = admissions.filter(
        (row) =>
          (!url.searchParams.get('keyword') ||
            row.candidateName.includes(url.searchParams.get('keyword')!)) &&
          (!url.searchParams.get('admissionStatus') ||
            row.admissionStatus === url.searchParams.get('admissionStatus')),
      );
      return reply(
        state.admissionStatus === 200
          ? {
              current,
              size,
              total: records.length,
              pages: Math.ceil(records.length / size),
              records: records.slice((current - 1) * size, current * size),
            }
          : null,
        state.admissionStatus,
        '准入情况读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/grading/detail') {
      const historic = body!.examId === 5002;
      const rounds = state.grading.rounds.map((round) =>
        historic
          ? {
              ...round,
              gradingRoundId: round.gradingRoundId + 10000,
              gradingRecordId:
                round.gradingRecordId === null ? null : round.gradingRecordId + 10000,
            }
          : round,
      );
      const selectedRound = rounds.find((round) => round.roundNo === (body!.roundNo ?? 1))!;
      return reply(
        state.gradingStatus === 200
          ? {
              ...state.grading,
              rounds,
              questions: historic
                ? state.grading.questions.map((question) => ({
                    ...question,
                    questionId: question.questionId + 10000,
                    answerId: question.answerId === null ? null : question.answerId + 10000,
                  }))
                : state.grading.questions,
              examId: Number(body!.examId),
              attemptId: state.malformed ? attemptId + 999 : Number(body!.attemptId),
              selectedRound,
            }
          : null,
        state.gradingStatus,
        '历史阅卷详情读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/grading/manual') {
      if (state.hold)
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      let result: unknown;
      if (state.commitOnFailure) result = save(body!);
      if (state.network) return route.abort('failed');
      if (state.writeStatus !== 200)
        return reply(
          null,
          state.writeStatus,
          state.writeStatus === 403 ? '当前用户不是本轮配置的阅卷人' : '人工阅卷提交失败',
        );
      result ??= save(body!);
      if (state.postReadFailure) state.projectsStatus = 503;
      return reply(result);
    }
    if (path === '/api/v1/files/view') {
      if (state.holdFile)
        await new Promise<void>((resolve) => {
          releaseFile = resolve;
        });
      return state.fileStatus === 200
        ? route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: 'isolated exam file',
          })
        : reply(null, state.fileStatus, '历史附件无读取权限');
    }
    return reply(null, 404, '夹具未配置此接口');
  });
  return {
    state,
    requests,
    roster,
    admissions,
    calls: (suffix: string) =>
      requests.filter((item) => item.path === `/api/v1/entrance-exams/${suffix}`),
    release: () => {
      if (!releaseWrite) throw new Error('没有等待中的人工阅卷');
      state.hold = false;
      releaseWrite();
    },
    releaseFile: () => {
      if (!releaseFile) throw new Error('没有等待中的附件');
      state.holdFile = false;
      releaseFile();
    },
  };
}

const panel = (page: Page) => page.getByRole('region', { name: '领航员准入考试', exact: true });
async function openExams(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/`);
  await page
    .getByRole('article')
    .filter({ hasText: '领航员阅卷项目' })
    .getByRole('link', { name: '查看项目', exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}
async function rosterDialog(page: Page, name = '当前准入考试') {
  const list = panel(page)
    .getByRole('article')
    .filter({ hasText: name })
    .getByRole('region', { name: '考试花名册', exact: true });
  await expect(list.getByRole('row').filter({ hasText: '应试甲' })).toBeVisible();
  return list;
}
async function gradingDialog(page: Page, examName?: string) {
  const list = await rosterDialog(page, examName);
  await list
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  const detail = page.getByRole('region', { name: '阅卷详情', exact: true });
  await expect(detail).toBeVisible();
  return detail;
}
async function choose(page: Page, target: Locator, name: string, value: string) {
  await target.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function fillGrading(page: Page, dialog: Locator, summary = '核对原始答案后提交') {
  await choose(page, dialog, '题目1判定', '正确');
  await choose(page, dialog, '题目2判定', '错误');
  await dialog.getByRole('textbox', { name: '阅卷意见1', exact: true }).fill('依据完整');
  await dialog.getByRole('textbox', { name: '阅卷意见2', exact: true }).fill('关键条件遗漏');
  await dialog.getByRole('textbox', { name: '本轮总结', exact: true }).fill(summary);
}
async function submit(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '确认提交', exact: true }).click();
}
async function readOnly(dialog: Locator) {
  await expect(
    dialog
      .getByRole('button', { name: '提交人工阅卷', exact: true })
      .and(dialog.locator(':enabled')),
  ).toHaveCount(0);
  for (const name of ['重试模拟阅卷', '人工补偿'])
    await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
}
async function chooseRole(page: Page, name: '领航员' | '策略官') {
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(name);
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: `artifacts/navigator-exams/${name}.png`, fullPage: true });
}

for (const desktop of [false, true])
  test(`${desktop ? '桌面配置' : 'Web'}历史人工池领航员不是创建人也能从阅卷支线直达，仅读已有管理数据`, async ({
    page,
  }) => {
    const f = await backend(page, desktop);
    await openExams(page);
    await expect(panel(page).getByRole('tab', { name: '阅卷', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel(page)).toContainText('已关闭历史考试');
    expect(f.calls('management')[0]!.method).toBe('GET');
    expect(f.calls('management')[0]!.query).toEqual({ projectId: String(projectId) });
    expect(f.calls('management')[0]!.headers.cookie).toContain('navigator_exam_session=active');
    expect(f.calls('reviewers')).toHaveLength(0);
    await panel(page)
      .getByRole('article', { name: '当前准入考试', exact: true })
      .getByRole('button', { name: '查看配置', exact: true })
      .click();
    const configuration = page.getByRole('dialog', { name: '考试配置', exact: true });
    await expect(configuration).toContainText('绑定试卷题目1');
    await page.getByRole('button', { name: '关闭考试配置', exact: true }).click();
    await screenshot(page, desktop ? 'exams-desktop' : 'exams-web');
  });

test('多场考试并排保留名单，默认选择首人，收起考试不改变右侧卷面', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  const detail = page.getByRole('region', { name: '阅卷详情', exact: true });
  await expect(detail).toContainText('应试甲的阅卷详情');
  await expect
    .poll(() => [...new Set(f.calls('roster').map((request) => request.body?.examId))].sort())
    .toEqual([5001, 5002]);
  const current = panel(page).getByRole('article', { name: '当前准入考试', exact: true });
  const summary = current
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: '当前准入考试', exact: true }) });
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(current.getByRole('region', { name: '考试花名册', exact: true })).toBeHidden();
  await expect(detail).toContainText('应试甲的阅卷详情');
  await summary.click();
  await expect(current.getByRole('region', { name: '考试花名册', exact: true })).toBeVisible();
});

test('管理响应即使canCreateExam=true，NAV也不显示任何PM管理、导入或自动操作', async ({ page }) => {
  const f = await backend(page);
  f.state.management.canCreateExam = true;
  await openExams(page);
  for (const name of ['发布考试', '新增考试', '编辑考试', '关闭考试', '导入考试', '下载导入模板'])
    await expect(panel(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  const dialog = await gradingDialog(page);
  await choose(page, dialog, '判卷轮次', '第2轮 · 模拟自动阅卷');
  await readOnly(dialog);
  expect(
    f.requests.filter((request) =>
      /\/(publish|edit|close|retry|compensate|parse|template)$/.test(request.path),
    ),
  ).toEqual([]);
});

test('当前配置不可用也无需后台读配置，绑定MANUAL完整逐题判定后只提交一次', async ({ page }) => {
  const f = await backend(page);
  f.state.configurationStatus = 503;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect.poll(() => f.calls('grading/manual').length).toBe(1);
  expect(f.calls('grading/manual')[0]!.body).toEqual({
    projectId,
    examId,
    attemptId,
    gradingRecordId: 10001,
    conclusionSummary: '核对原始答案后提交',
    items: [
      { questionId: 8001, correctness: 'CORRECT', gradingOpinion: '依据完整' },
      { questionId: 8002, correctness: 'INCORRECT', gradingOpinion: '关键条件遗漏' },
    ],
  });
  await expect(dialog).toContainText('本轮得分：10分');
  await expect(dialog).toContainText('最终准入结果：待确定');
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(1);
  expect(f.calls('detail')).toHaveLength(0);
});

test('缺一题判定或UTF8载荷超过16KiB均不提交，保留原意见供修改', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  const dialog = await gradingDialog(page);
  await choose(page, dialog, '题目1判定', '正确');
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true }),
  ).toHaveCount(0);
  await fillGrading(page, dialog, '核'.repeat(5000));
  await dialog.getByRole('textbox', { name: '阅卷意见1', exact: true }).fill('验'.repeat(1000));
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toContainText('阅卷内容超过当前可提交大小');
  await expect(dialog.getByRole('textbox', { name: '阅卷意见1', exact: true })).toHaveValue(
    '验'.repeat(1000),
  );
  expect(f.calls('grading/manual')).toHaveLength(0);
  await dialog.getByRole('textbox', { name: '阅卷意见1', exact: true }).fill('缩短后可编辑');
  await dialog.getByRole('textbox', { name: '本轮总结', exact: true }).fill('缩短总结后提交');
  await submit(page, dialog);
  await expect(dialog).toContainText('本轮得分：10分');
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('名单原快照未交卷，考生后续真实交卷后只读重载可按实际记录开放当前轮次', async ({ page }) => {
  const f = await backend(page);
  f.roster[0]!.submittedAt = null;
  f.roster[0]!.finalResult = null;
  f.state.grading.gradingStatus = 'NOT_STARTED';
  f.state.grading.rounds[0]!.gradingRecordId = null;
  f.state.grading.rounds[0]!.status = null;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await readOnly(dialog);
  f.state.grading.gradingStatus = 'IN_PROGRESS';
  f.state.grading.rounds[0]!.gradingRecordId = 10001;
  f.state.grading.rounds[0]!.status = 'PENDING';
  f.roster[0]!.submittedAt = '2026-11-04 12:00:00';
  f.roster[0]!.finalResult = 'PENDING';
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '提交人工阅卷', exact: true })).toBeEnabled();
  expect(f.calls('grading/manual')).toHaveLength(0);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('本轮得分：10分');
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('确认提交前实时读取发现原记录已完成，保留原稿且不向陈旧轮次POST', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  const dialog = await gradingDialog(page);
  await fillGrading(page, dialog, '状态已变化前的原稿');
  f.state.grading.rounds[0]!.status = 'COMPLETED';
  await submit(page, dialog);
  await expect(dialog).toContainText('本轮状态或阅卷资格已变化');
  await expect(dialog.getByRole('textbox', { name: '本轮总结', exact: true })).toHaveValue(
    '状态已变化前的原稿',
  );
  expect(f.calls('grading/detail').length).toBeGreaterThan(1);
  expect(f.calls('grading/manual')).toHaveLength(0);
});

test('当前新版本同轮序但全局ID不同，人工提交使用实际绑定旧卷的轮次和题目', async ({ page }) => {
  const f = await backend(page);
  f.state.configuration.currentVersionId = 6002;
  f.state.configuration.gradingRounds[0]!.gradingRoundId = 19001;
  f.state.configuration.papers[0]!.paperId = 17001;
  for (const question of f.state.configuration.papers[0]!.questions) question.questionId += 10000;
  f.state.configuration.papers[0]!.questions[0]!.questionContent = '新版不应替代绑定试卷';
  await openExams(page);
  const dialog = await gradingDialog(page);
  await expect(dialog).toContainText('绑定试卷题目1');
  await expect(dialog.getByText('新版不应替代绑定试卷', { exact: true })).toHaveCount(0);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('本轮得分：10分');
  expect(f.calls('grading/manual')[0]!.body).toMatchObject({
    projectId,
    examId,
    attemptId,
    gradingRecordId: 10001,
    items: [
      { questionId: 8001, correctness: 'CORRECT' },
      { questionId: 8002, correctness: 'INCORRECT' },
    ],
  });
  expect(f.calls('detail')).toHaveLength(0);
});

test('CLOSED考试可读名单并提交绑定历史试卷，不以关闭状态禁止人工阅卷', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  const dialog = await gradingDialog(page, '已关闭历史考试');
  await expect(dialog).toContainText('考生实际答案1');
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('本轮得分：10分');
  expect(f.calls('grading/detail').at(-1)!.body).toMatchObject({ projectId, examId: 5002 });
  expect(f.calls('grading/manual')[0]!.body).toMatchObject({
    projectId,
    examId: 5002,
    attemptId: 21001,
    gradingRecordId: 20001,
    items: [
      { questionId: 18001, correctness: 'CORRECT' },
      { questionId: 18002, correctness: 'INCORRECT' },
    ],
  });
  expect(f.calls('detail')).toHaveLength(0);
});

test('有读取资格但前轮未完成、本轮缺record或WAITING时不生成人工入口', async ({ page }) => {
  const f = await backend(page);
  f.state.grading.rounds[0]!.status = 'WAITING';
  f.state.grading.rounds[0]!.gradingRecordId = null;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(0);
});

test('仅项目创建人而不在历史人工池时服务端403，不能借卡片阅卷标记扩大资格', async ({ page }) => {
  const f = await backend(page);
  f.state.reader = false;
  f.state.projects[0]!.creatorId = user.id;
  await openExams(page);
  await expect(panel(page)).toContainText('当前账号不在项目人工阅卷池');
  expect(f.calls('grading/detail')).toHaveLength(0);
  expect(f.calls('grading/manual')).toHaveLength(0);
});

test('考试名单真实POST分页与筛选，轮次通过不冒充最终考试通过', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  const dialog = await rosterDialog(page);
  await dialog.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(dialog).toContainText('候选人21');
  expect(f.calls('roster').at(-1)!.body).toEqual({ projectId, examId, current: 2, size: 20 });
  await dialog.getByRole('textbox', { name: '搜索考试人员', exact: true }).fill('应试乙');
  await choose(page, dialog, '考试结果', '考试通过');
  await dialog.getByRole('button', { name: '查询', exact: true }).click();
  await expect(dialog.getByRole('row').filter({ hasText: '应试乙' })).toBeVisible();
  expect(f.calls('roster').at(-1)!.body).toEqual({
    projectId,
    examId,
    current: 1,
    size: 20,
    keyword: '应试乙',
    finalResult: 'ADMITTED',
  });
});

test('项目准入真实GET区分待入项和已入项，查询不发送写命令', async ({ page }) => {
  const f = await backend(page);
  await openExams(page);
  await panel(page).getByRole('tab', { name: '准入情况', exact: true }).click();
  const admission = panel(page).getByRole('region', { name: '项目准入情况', exact: true });
  await choose(page, admission, '准入状态', '待入项');
  await admission.getByRole('textbox', { name: '搜索准入人员', exact: true }).fill('应试乙');
  await admission.getByRole('button', { name: '查询', exact: true }).click();
  await expect(admission.getByRole('row').filter({ hasText: '应试乙' })).toContainText('待入项');
  expect(f.calls('admissions').at(-1)!.query).toEqual({
    projectId: String(projectId),
    current: '1',
    size: '20',
    keyword: '应试乙',
    admissionStatus: 'PENDING_ENTRY',
  });
  expect(
    f.calls('admissions').every((request) => request.method === 'GET' && request.body === null),
  ).toBe(true);
});

test('历史题干参考答案HTML不执行外链脚本，附件仅走Cookie鉴权代理', async ({ page }) => {
  const f = await backend(page);
  f.state.grading.questions[0]!.referenceAnswer =
    '<p>安全历史参考</p><script>document.documentElement.dataset.examScript="ran"</script><img src="https://exam-unsafe.invalid/pixel" onerror="document.documentElement.dataset.examScript=\'ran\'">';
  const external: string[] = [];
  await page.route('https://exam-unsafe.invalid/**', (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  await openExams(page);
  const dialog = await gradingDialog(page);
  await expect(dialog).toContainText('安全历史参考');
  expect(await page.evaluate(() => document.documentElement.dataset.examScript)).toBeUndefined();
  expect(external).toEqual([]);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: attachment.fileName, exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(attachment.fileName);
  const file = f.requests.find((request) => request.path === '/api/v1/files/view')!;
  expect(file.query).toEqual({ objectKey: attachment.objectKey });
  expect(file.headers.cookie).toContain('navigator_exam_session=active');
  expect(file.headers.authorization).toBeUndefined();
});

test('附件403不回退公开URL，迟到成功响应在切换角色后也不能触发下载', async ({ page }) => {
  const f = await backend(page);
  f.state.fileStatus = 403;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await dialog.getByRole('button', { name: attachment.fileName, exact: true }).click();
  await expect(dialog).toContainText('历史附件无读取权限');
  expect(f.requests.filter((request) => request.path === '/api/v1/files/view')).toHaveLength(1);
  expect(f.requests.filter((request) => request.path === '/api/v1/auth/switch-role')).toHaveLength(
    0,
  );
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  f.state.fileStatus = 200;
  f.state.holdFile = true;
  await dialog.getByRole('button', { name: attachment.fileName, exact: true }).click();
  await expect
    .poll(() => f.requests.filter((request) => request.path === '/api/v1/files/view').length)
    .toBe(2);
  await panel(page).getByRole('tab', { name: '准入情况', exact: true }).click();
  await chooseRole(page, '策略官');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/files/view' && response.status() === 200,
    ),
    Promise.resolve().then(() => f.releaseFile()),
  ]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(downloads).toEqual([]);
});

test('项目可读但非本轮阅卷人仍由POST拒绝403，明确展示并保留原稿暂停写入', async ({ page }) => {
  const f = await backend(page);
  f.state.writeStatus = 403;
  f.state.configuration.gradingRounds[0]!.reviewers = [
    { userId: uuid(77), uid: user.uid, name: user.nickname },
  ];
  await openExams(page);
  const dialog = await gradingDialog(page);
  await expect(dialog.getByRole('button', { name: '提交人工阅卷', exact: true })).toBeEnabled();
  expect(f.calls('detail')).toHaveLength(0);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('当前用户不是本轮配置的阅卷人');
  await readOnly(dialog);
  await expect(dialog.getByRole('textbox', { name: '本轮总结', exact: true })).toHaveValue(
    '核对原始答案后提交',
  );
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('网络未知关闭重开后保留逐题草稿，GET显示PENDING仍不解锁或自动重发', async ({ page }) => {
  const f = await backend(page);
  f.state.network = true;
  await openExams(page);
  let dialog = await gradingDialog(page);
  await fillGrading(page, dialog, '未知结果原稿');
  await submit(page, dialog);
  await expect(dialog).toContainText('连接服务失败');
  page.on('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '返回考试名单', exact: true }).click();
  dialog = page.getByRole('region', { name: '阅卷详情', exact: true });
  await expect(dialog.getByRole('textbox', { name: '本轮总结', exact: true })).toHaveValue(
    '未知结果原稿',
  );
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('未知5xx即使服务端轮次已完成也只展示当前事实，不重发原阅卷或自动开放写', async ({ page }) => {
  const f = await backend(page);
  f.state.writeStatus = 503;
  f.state.commitOnFailure = true;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('人工阅卷提交失败');
  page.on('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('成功后完整项目待办回读失败，仅显式读取恢复而不重复人工命令', async ({ page }) => {
  const f = await backend(page);
  f.state.postReadFailure = true;
  await openExams(page);
  const dialog = await gradingDialog(page);
  await fillGrading(page, dialog);
  await submit(page, dialog);
  await expect(dialog).toContainText('操作已成功提交，最新状态读取失败');
  await readOnly(dialog);
  f.state.projectsStatus = 200;
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await expect(dialog).toContainText('本轮得分：10分');
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('NAV未知阅卷切PM不能借原草稿完成，回NAV仍保持原角色锁', async ({ page }) => {
  const f = await backend(page);
  f.state.network = true;
  await openExams(page);
  let dialog = await gradingDialog(page);
  await fillGrading(page, dialog, 'NAV原角色草稿');
  await submit(page, dialog);
  await expect(dialog).toContainText('连接服务失败');
  page.on('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '返回考试名单', exact: true }).click();
  await chooseRole(page, '策略官');
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=ENTRANCE_EXAM`);
  const pmPanel = page.getByRole('region', { name: '准入考试', exact: true });
  await expect(pmPanel).toBeVisible();
  await pmPanel.getByRole('tab', { name: '阅卷', exact: true }).click();
  await pmPanel
    .getByRole('article')
    .filter({ hasText: '当前准入考试' })
    .getByRole('region', { name: '考试花名册', exact: true })
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  dialog = page.getByRole('region', { name: '考试名单', exact: true });
  await dialog
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .first()
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  dialog = page.getByRole('region', { name: '阅卷详情', exact: true });
  await expect(
    dialog
      .getByRole('button', { name: '提交人工阅卷', exact: true })
      .and(dialog.locator(':enabled')),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: '返回考试名单', exact: true }).click();
  await chooseRole(page, '领航员');
  await openExams(page);
  dialog = await gradingDialog(page);
  await expect(dialog.getByRole('textbox', { name: '本轮总结', exact: true })).toHaveValue(
    'NAV原角色草稿',
  );
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(1);
});

test('阅卷返回错误attemptId时拒绝响应，不能按旧题目提交其他应试', async ({ page }) => {
  const f = await backend(page);
  f.state.malformed = true;
  await openExams(page);
  const list = await rosterDialog(page);
  await list
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .first()
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  const dialog = page.getByRole('region', { name: '阅卷详情', exact: true });
  await expect(dialog).toContainText('服务响应格式异常，请稍后重试');
  await readOnly(dialog);
  expect(f.calls('grading/manual')).toHaveLength(0);
});

test('375px历史阅卷题目与长意见可滚动访问，无横向溢出并保留截图', async ({ page }) => {
  await backend(page);
  await openExams(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const dialog = await gradingDialog(page);
  await fillGrading(page, dialog, '手机本轮总结');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, 'exams-375');
});
