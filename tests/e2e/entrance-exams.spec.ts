import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type {
  AuthUser,
  EntranceExamAdmissionItem,
  EntranceExamCard,
  EntranceExamConfigInput,
  EntranceExamConfiguration,
  EntranceExamGradingDetail,
  EntranceExamGradingSubmitResult,
  EntranceExamManagement,
  EntranceExamRosterItem,
  ProjectProductionPlan,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001;
const examId = 5001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'EXAM10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '考试联调员',
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
  createdAt: '2026-10-28T02:00:00.000Z',
  updatedAt: '2026-10-28T02:00:00.000Z',
};
const project: WorkbenchProjectDetail = {
  id: projectId,
  projectNo: 'EXAM-PROJECT-3001',
  requesterType: 'INDIVIDUAL',
  requesterId: uuid(2),
  requesterName: '考试需求方',
  projectName: '准入考试隔离项目',
  projectDescription: '仅使用本地 HTTP 夹具的考试管理项目',
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
  educationRequirement: null,
  employmentType: null,
  experienceRequirement: null,
  workSummary: '按标准完成作业',
  specialRequirement: null,
  mandatoryRequirement: null,
  standardContent: '核对标准后作答',
  standardLink: null,
  status: 'PUBLISHED',
  currentNodeCode: 'ENTRANCE_EXAM',
  versionNo: 2,
  creatorUid: 'EXAM10002',
  creatorName: '测试创建人',
  createdAt: '2026-10-28 10:00:00',
  updatedAt: '2026-10-28 10:00:00',
  attachments: [],
};
const plan: ProjectProductionPlan = {
  hasPlan: true,
  editable: false,
  id: 801,
  projectId,
  currentNodeCode: 'ENTRANCE_EXAM',
  operatorHeadcount: 4,
  operatorCpd: 10,
  inspectorHeadcount: null,
  inspectorCpd: null,
  needWrittenExam: true,
  maxActiveExamCount: 2,
  needInterview: false,
  totalExpectedOutput: 200,
  confirmedBy: user.uid,
  confirmedAt: '2026-10-28 10:00:00',
  nextStage: 'ENTRANCE_EXAM',
  extJson: null,
  projectReference: {
    projectQuantity: project.projectQuantity,
    quantityUnit: project.quantityUnit,
    deadline: project.deadline,
    requiredHeadcount: project.requiredHeadcount,
    educationRequirement: project.educationRequirement,
    employmentType: project.employmentType,
    experienceRequirement: project.experienceRequirement,
    workSummary: project.workSummary,
    specialRequirement: null,
    mandatoryRequirement: null,
  },
  crowds: [{ id: 901, sequenceNo: 1, crowdName: '熟练成员', profileRequirement: '完成培训' }],
  stages: [
    {
      id: 1001,
      sequenceNo: 1,
      stageName: '生产期',
      startDate: '2099-01-05',
      endDate: '2099-01-09',
      naturalDayCount: 5,
      workdayCount: 5,
      workdayCountSource: 'AUTO',
      operatorHeadcount: 4,
      operatorCpd: 10,
      accuracyRate: null,
      expectedOutput: 200,
    },
  ],
};
const baselineInput: EntranceExamConfigInput = {
  projectId,
  examName: '当前生效考试',
  durationMinutes: 30,
  registrationDeadline: '2099-12-31 18:20:30',
  fullScore: 20,
  passScore: 12,
  decisionRule: 'MAJORITY',
  tieBreakRule: null,
  papers: [
    {
      paperName: '基础卷',
      questions: [
        {
          questionContent: '请说明判断依据',
          questionFiles: [],
          requiredFlag: true,
          score: 20,
          scoreSource: 'MANUAL',
          referenceAnswer: '核对标准与原始记录',
          referenceFiles: [],
        },
      ],
    },
  ],
  gradingRounds: [{ gradingMode: 'MANUAL', reviewerUserIds: [user.id] }],
};
const attachment = {
  uploadedFileId: uuid(90),
  objectKey: `entrance-exam-attachment/2026/10/28/${'a'.repeat(32)}.txt`,
  fileName: 'answer.txt',
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 20,
  fileHash: 'a'.repeat(64),
};
function configuration(
  input = baselineInput,
  id = examId,
  version = 6001,
): EntranceExamConfiguration {
  return {
    projectId,
    examId: id,
    examNo: `EXAM-${id}`,
    status: 'ACTIVE',
    currentVersionId: version,
    versionNo: version - 6000,
    examName: input.examName!,
    durationMinutes: input.durationMinutes ?? null,
    registrationDeadline: input.registrationDeadline!,
    fullScore: input.fullScore!,
    passScore: input.passScore!,
    decisionRule: input.decisionRule ?? 'MAJORITY',
    tieBreakRule: input.tieBreakRule ?? null,
    papers: input.papers.map((paper, p) => ({
      paperId: 7001 + p,
      sequenceNo: p + 1,
      paperName: paper.paperName ?? null,
      totalScore: input.fullScore!,
      questions: paper.questions.map((question, q) => ({
        questionId: 8001 + p * 100 + q,
        sequenceNo: q + 1,
        questionContent: question.questionContent ?? null,
        questionFiles: question.questionFiles?.map((file) => ({ ...attachment, ...file })) ?? [],
        requiredFlag: question.requiredFlag ?? true,
        score:
          question.scoreSource === 'MANUAL'
            ? question.score!
            : input.fullScore! / paper.questions.length,
        scoreSource: question.scoreSource ?? 'AUTO',
        referenceAnswer: question.referenceAnswer ?? null,
        referenceFiles: question.referenceFiles?.map((file) => ({ ...attachment, ...file })) ?? [],
      })),
    })),
    gradingRounds: input.gradingRounds.map((round, index) => ({
      gradingRoundId: 9001 + index,
      roundNo: index + 1,
      gradingMode: round.gradingMode,
      toolCode: round.toolCode ?? null,
      toolName: round.toolName ?? null,
      toolConfig: round.toolConfig ?? null,
      toolFiles: round.toolFiles ?? [],
      reviewers: (round.reviewerUserIds ?? []).map((id) => ({
        userId: id,
        uid: user.uid,
        name: user.realName,
      })),
    })),
  };
}
function card(id = examId): EntranceExamCard {
  return {
    examId: id,
    examNo: `EXAM-${id}`,
    examName: id === examId ? '当前生效考试' : '历史关闭考试',
    status: id === examId ? 'ACTIVE' : 'CLOSED',
    examineeCount: 21,
    admittedCount: 1,
    admissionRate: 4.76,
    currentVersionId: 6001,
    createdAt: '2026-10-28 10:00:00',
    closedAt: id === examId ? null : '2026-10-28 11:00:00',
  };
}
function grading(): EntranceExamGradingDetail {
  const round = {
    gradingRoundId: 9001,
    gradingRecordId: 10001,
    roundNo: 1,
    gradingMode: 'MANUAL' as const,
    status: 'PENDING' as const,
    score: null,
    roundResult: null,
    conclusionSummary: null,
    errorMessage: null,
  };
  return {
    examId,
    attemptId: 11001,
    candidateUid: 'CANDIDATE10001',
    candidateName: '应试甲',
    passScore: 12,
    gradingStatus: 'IN_PROGRESS',
    finalResult: 'PENDING',
    rounds: [
      round,
      {
        gradingRoundId: 9002,
        gradingRecordId: null,
        roundNo: 2,
        gradingMode: 'AUTO',
        status: 'WAITING',
        score: null,
        roundResult: null,
        conclusionSummary: null,
        errorMessage: null,
      },
    ],
    selectedRound: round,
    questions: [
      {
        questionId: 8001,
        sequenceNo: 1,
        questionContent: '历史版本题干',
        questionFiles: null,
        score: 20,
        referenceAnswer: '历史版本参考答案',
        referenceFiles: null,
        answerId: 12001,
        answerContent: '按标准逐项核对',
        answerFiles: [attachment],
        answeredFlag: true,
        correctness: null,
        gradingOpinion: null,
      },
    ],
  };
}
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  form: Record<string, string>;
  fileName?: string;
}

/** 完整内存 HTTP 替身；自动阅卷只模拟既有返回，不连接数据库、OSS 或业务 Agent。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'exam_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const management: EntranceExamManagement = {
    projectId,
    needWrittenExam: true,
    activeExamCount: 1,
    maxActiveExamCount: 2,
    canCreateExam: true,
    createDisabledReason: null,
    exams: [card(), card(5002)],
  };
  const state = {
    user: structuredClone(user),
    management,
    configuration: configuration(),
    grading: grading(),
    reviewerStatus: 200,
    managementStatus: 200,
    detailStatus: 200,
    admissionStatus: 200,
    rosterStatus: 200,
    gradingStatus: 200,
    writeStatus: 200,
    networkFailure: false,
    failReadAfterWrite: false,
    holdWrite: false,
    importStatus: 200,
  };
  const requests: RequestLog[] = [];
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = await request.allHeaders();
    const contentType = headers['content-type'] ?? '';
    const body = contentType.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    const log: RequestLog = {
      path,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
      form: {},
    };
    if (contentType.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      for (const part of (request.postDataBuffer()?.toString('utf8') ?? '').split(
        `--${boundary?.[1] ?? boundary?.[2]}`,
      )) {
        const name = /name="([^"]+)"/.exec(part)?.[1],
          start = part.indexOf('\r\n\r\n');
        if (!name || start < 0) continue;
        log.form[name] = part.slice(start + 4).replace(/\r\n$/, '');
        log.fileName = /filename="([^"]+)"/.exec(part)?.[1] ?? log.fileName;
      }
    }
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!headers.cookie?.includes('exam_session=active')) return reply(null, 401, '请先登录');
    if (path === '/api/v1/users/me' && log.method === 'GET') return reply(state.user);
    if (path === '/api/v1/auth/switch-role' && log.method === 'POST') {
      const role = body!.role as AuthUser['role'];
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (
      ['/api/v1/projects/list', '/api/v1/projects/manager/list'].includes(path) &&
      log.method === 'GET'
    )
      return reply([]);
    if (path === '/api/v1/projects/draft/current' && log.method === 'GET')
      return reply({ hasDraft: false, draft: null });
    if (path === '/api/v1/expert-assignments/my-tasks' && log.method === 'POST') return reply([]);
    if (path === `/api/v1/projects/${projectId}` && log.method === 'GET') return reply(project);
    if (path === '/api/v1/projects/production-plan' && log.method === 'GET') return reply(plan);
    if (path === '/api/v1/entrance-exams/management' && log.method === 'GET')
      return reply(
        state.managementStatus === 200 ? state.management : null,
        state.managementStatus,
        '考试管理读取结果',
      );
    if (path === '/api/v1/entrance-exams/reviewers' && log.method === 'GET')
      return reply(
        state.reviewerStatus === 200
          ? [{ userId: user.id, uid: user.uid, name: user.realName, avatarUrl: null }]
          : null,
        state.reviewerStatus,
        state.reviewerStatus === 403 ? '仅当前主策略官可管理考试' : '阅卷人读取结果',
      );
    if (path === '/api/v1/entrance-exams/detail' && log.method === 'POST') {
      const closed =
        state.management.exams.find((exam) => exam.examId === body?.examId)?.status === 'CLOSED';
      return reply(
        closed || state.detailStatus !== 200 ? null : state.configuration,
        closed ? 400 : state.detailStatus,
        '考试配置读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/admissions' && log.method === 'GET') {
      const current = Number(url.searchParams.get('current') ?? 1),
        size = Number(url.searchParams.get('size') ?? 20);
      const records: EntranceExamAdmissionItem[] = Array.from({ length: 21 }, (_, index) => ({
        attemptId: 11001 + index,
        examId: index ? 5002 : examId,
        examName: index ? '历史关闭考试' : '当前生效考试',
        candidateUserId: uuid(100 + index),
        candidateUid: `CANDIDATE${10001 + index}`,
        candidateName: index ? `应试成员${index}` : '应试甲',
        organizationId: index ? uuid(80) : null,
        organizationName: index ? '隔离测试组织' : null,
        employmentType: index ? 'FULL_TIME' : null,
        examDate: '2026-10-28 11:00:00',
        admissionStatus: index ? 'ADMITTED' : 'PENDING_ENTRY',
      }));
      const filtered = records.filter(
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
              total: filtered.length,
              pages: Math.ceil(filtered.length / size),
              records: filtered.slice((current - 1) * size, current * size),
            }
          : null,
        state.admissionStatus,
        '准入名单读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/roster' && log.method === 'POST') {
      const current = Number(body?.current ?? 1),
        size = Number(body?.size ?? 20);
      const records: EntranceExamRosterItem[] = Array.from({ length: 21 }, (_, index) => ({
        attemptId: 11001 + index,
        attemptNo: `ATTEMPT-${index + 1}`,
        candidateUserId: uuid(100 + index),
        candidateUid: `CANDIDATE${10001 + index}`,
        candidateName: index ? `应试成员${index}` : '应试甲',
        organizationId: index ? uuid(80) : null,
        organizationName: index ? '隔离测试组织' : null,
        finalResult: index ? 'PENDING' : state.grading.finalResult,
        roundScores: index
          ? []
          : state.grading.rounds
              .filter((round) => round.gradingRecordId !== null)
              .map(({ roundNo, gradingMode, score, roundResult }) => ({
                roundNo,
                gradingMode,
                score,
                roundResult,
              })),
        enteredAt: '2026-10-28 10:00:00',
        submittedAt: '2026-10-28 11:00:00',
      }));
      const filtered = records.filter(
        (row) =>
          (!body?.keyword || row.candidateName.includes(String(body.keyword))) &&
          (!body?.finalResult || row.finalResult === body.finalResult),
      );
      return reply(
        state.rosterStatus === 200
          ? {
              current,
              size,
              total: filtered.length,
              pages: Math.ceil(filtered.length / size),
              records: filtered.slice((current - 1) * size, current * size),
            }
          : null,
        state.rosterStatus,
        '考试名单读取结果',
      );
    }
    if (path === '/api/v1/entrance-exams/grading/detail' && log.method === 'POST') {
      const round = state.grading.rounds.find((item) => item.roundNo === (body?.roundNo ?? 1))!;
      return reply(
        state.gradingStatus === 200
          ? { ...state.grading, attemptId: body?.attemptId, selectedRound: round }
          : null,
        state.gradingStatus,
        '阅卷详情读取结果',
      );
    }
    if (path === '/api/v1/files/view' && log.method === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'isolated exam answer',
      });
    if (path === '/api/v1/files/upload' && log.method === 'POST')
      return reply({
        fileId: uuid(90),
        objectKey: attachment.objectKey,
        uploadToken: 'u'.repeat(43),
        url: null,
        sensitive: true,
        fileName: log.fileName,
        extension: 'txt',
        size: Buffer.byteLength(log.form.file ?? ''),
        contentType: 'text/plain',
        fileHash: 'a'.repeat(64),
      });
    if (path === '/api/v1/entrance-exams/import/template' && log.method === 'GET') {
      const type = url.searchParams.get('type');
      return route.fulfill({
        status: 200,
        contentType:
          type === 'EXCEL'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : type === 'REDOC'
              ? 'application/xml'
              : 'text/plain',
        body: 'isolated exam template',
      });
    }
    if (path === '/api/v1/entrance-exams/import/parse' && log.method === 'POST')
      return reply(
        state.importStatus === 200
          ? {
              formatVersion: '1',
              sourceType: 'TXT',
              config: { ...baselineInput, examName: '导入预览考试' },
            }
          : null,
        state.importStatus,
        '导入预览读取结果',
      );
    const writes = [
      '/publish',
      '/edit',
      '/close',
      '/grading/manual',
      '/grading/retry',
      '/grading/auto/compensate',
    ];
    if (
      writes.some((suffix) => path === `/api/v1/entrance-exams${suffix}`) &&
      log.method === (path.endsWith('/edit') ? 'PUT' : 'POST')
    ) {
      if (state.networkFailure) return route.abort('failed');
      if (state.writeStatus !== 200)
        return reply(
          null,
          state.writeStatus,
          state.writeStatus === 409 ? '考试版本已发生变化' : '考试操作暂不可用',
        );
      const save = async () => {
        let result: unknown;
        if (path.endsWith('/publish') || path.endsWith('/edit')) {
          const id = path.endsWith('/publish') ? 5003 : Number(body!.examId);
          state.configuration = configuration(
            body as unknown as EntranceExamConfigInput,
            id,
            path.endsWith('/publish') ? 6001 : 6002,
          );
          const changed: EntranceExamCard = {
            ...card(id),
            examName: String(body!.examName),
            status: 'ACTIVE',
            currentVersionId: state.configuration.currentVersionId,
            closedAt: null,
          };
          state.management.exams = path.endsWith('/publish')
            ? [changed, ...state.management.exams]
            : state.management.exams.map((item) => (item.examId === id ? changed : item));
          result = {
            projectId,
            examId: id,
            examNo: changed.examNo,
            examName: changed.examName,
            status: 'ACTIVE',
            currentVersionId: state.configuration.currentVersionId,
            versionNo: state.configuration.versionNo,
            publishedAt: '2026-10-28 12:00:00',
          };
        } else if (path.endsWith('/close')) {
          state.management.exams = state.management.exams.map((item) =>
            item.examId === body?.examId
              ? {
                  ...item,
                  status: 'CLOSED',
                  closedAt: '2026-10-28 12:00:00',
                }
              : item,
          );
          result = {
            examId: body!.examId,
            status: 'CLOSED',
            closedBy: user.uid,
            closedAt: '2026-10-28 12:00:00',
          };
        } else {
          const retry = path.endsWith('/retry');
          const round = state.grading.rounds.find(
            (item) => item.gradingRecordId === body?.gradingRecordId,
          )!;
          Object.assign(round, {
            status: retry ? 'PENDING' : 'COMPLETED',
            score: retry ? null : 20,
            roundResult: retry ? null : 'ADMITTED',
            errorMessage: null,
          });
          if (!retry)
            state.grading.questions.forEach((question) => {
              question.correctness = 'CORRECT';
            });
          const next = state.grading.rounds.find((item) => item.roundNo === round.roundNo + 1);
          if (!retry && next?.status === 'WAITING') {
            next.status = 'PENDING';
            next.gradingRecordId = 10002;
          }
          const complete = state.grading.rounds.every((item) => item.status === 'COMPLETED');
          state.grading.gradingStatus = complete ? 'COMPLETED' : 'IN_PROGRESS';
          state.grading.finalResult = complete ? 'ADMITTED' : 'PENDING';
          const submitted: EntranceExamGradingSubmitResult = {
            attemptId: state.grading.attemptId,
            gradingRecordId: Number(body!.gradingRecordId),
            recordStatus: retry ? 'PENDING' : 'COMPLETED',
            score: retry ? null : 20,
            roundResult: retry ? null : 'ADMITTED',
            gradingStatus: state.grading.gradingStatus,
            finalResult: state.grading.finalResult,
          };
          result = submitted;
        }
        state.management.activeExamCount = state.management.exams.filter(
          (item) => item.status === 'ACTIVE',
        ).length;
        state.management.canCreateExam =
          state.management.activeExamCount < state.management.maxActiveExamCount;
        if (state.failReadAfterWrite) {
          state.managementStatus = 503;
          state.detailStatus = 503;
          state.gradingStatus = 503;
          state.rosterStatus = 503;
          state.admissionStatus = 503;
        }
        await reply(result);
      };
      if (!state.holdWrite) return save();
      return new Promise<void>((resolve, reject) => {
        release = async () => {
          try {
            await save();
            resolve();
          } catch (failure) {
            reject(failure);
          }
        };
      });
    }
    return reply(null, 404, '测试未约定此接口');
  });
  const calls = (suffix: string) =>
    requests.filter((row) => row.path === `/api/v1/entrance-exams/${suffix}`);
  return {
    state,
    requests,
    calls,
    releaseWrite: async () => {
      if (!release) throw new Error('没有等待中的考试写入');
      await release();
    },
  };
}

async function openExams(page: Page, view: 'admission' | 'grading' = 'grading') {
  await page.goto(`${origin}/#/strategist/projects/${projectId}`);
  await page.getByRole('tab', { name: '准入考试', exact: true }).click();
  const panel = page.getByRole('region', { name: '准入考试', exact: true });
  await expect(panel).toBeVisible();
  if (view === 'grading') await panel.getByRole('tab', { name: '阅卷', exact: true }).click();
  return panel;
}
async function screenshot(page: Page, name: string) {
  const folder = 'artifacts/entrance-exams-audit';
  await mkdir(folder, { recursive: true });
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('dialog[open] > div').forEach((node) => {
      node.scrollTop = 0;
    });
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `${folder}/${name}.png`, animations: 'disabled' });
}

async function choose(page: Page, scope: Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function createEditor(page: Page, panel: Locator) {
  await panel.getByRole('button', { name: '组织考试', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '创建考试', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}
async function fillEditor(editor: Locator, name = '完整发布考试') {
  await editor.getByRole('textbox', { name: '考试名称', exact: true }).fill(name);
  await editor.getByRole('spinbutton', { name: '答题时限（分钟）', exact: true }).fill('30');
  await editor.getByLabel(/^截止时间（上海时间）\s*\*$/).fill('2099-12-31T18:20:30');
  await editor.getByRole('spinbutton', { name: '试卷满分', exact: true }).fill('20');
  await editor.getByRole('spinbutton', { name: '准入分数线', exact: true }).fill('12');
  await editor
    .getByRole('textbox', { name: '试卷1题目1题干', exact: true })
    .fill('请核对记录并说明判断依据');
  await editor
    .getByRole('textbox', { name: '试卷1题目1参考答案（选填）', exact: true })
    .fill('核对原始记录与标准');
  await editor
    .getByRole('group', { name: '第1轮阅卷人', exact: true })
    .getByRole('checkbox', { name: `${user.realName} · ${user.uid}`, exact: true })
    .check();
  return editor;
}
async function submitConfiguration(page: Page, editor: Locator, editing = false) {
  await editor
    .getByRole('button', { name: editing ? '保存新版本' : '发布考试', exact: true })
    .click();
  const confirmation = page.getByRole('alertdialog', {
    name: editing ? '确认保存新版本' : '确认发布考试',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole('button', { name: editing ? '确认保存' : '确认发布', exact: true })
    .click();
}
const examCard = (panel: Locator, name = '当前生效考试') =>
  panel.locator('article').filter({
    has: panel.page().getByRole('heading', { name, exact: true }),
  });
async function roster(page: Page, panel: Locator) {
  await panel.getByRole('tab', { name: '阅卷', exact: true }).click();
  await examCard(panel).getByRole('button', { name: '查看名单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '考试名单', exact: true });
  await expect(dialog.getByRole('row').filter({ hasText: '应试甲' })).toBeVisible();
  return dialog;
}
async function gradingDialog(page: Page, panel: Locator) {
  const list = await roster(page, panel);
  await list
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '阅卷详情', exact: true });
  await expect(dialog.getByText('历史版本题干', { exact: true })).toBeVisible();
  return dialog;
}

for (const [mode, desktop] of [
  ['Web', false],
  ['Electron 运行配置', true],
] as const) {
  test(`${mode} 组织考试完整配置、发布编辑与关闭均只写一次`, async ({ page }) => {
    const { state, calls, releaseWrite } = await backend(page, desktop);
    const panel = await openExams(page);
    if (!desktop) await screenshot(page, 'management');
    const editor = await createEditor(page, panel);
    await fillEditor(editor);
    await editor.getByRole('button', { name: '添加试卷', exact: true }).click();
    await editor
      .getByRole('textbox', { name: '试卷2题目1题干', exact: true })
      .fill('第二卷完整题干');
    await editor.getByRole('checkbox', { name: '试卷2题目1必答', exact: true }).uncheck();
    await editor.getByRole('button', { name: '添加判卷轮次', exact: true }).click();
    await choose(page, editor, '第2轮判卷方式', '自动阅卷');
    await editor
      .getByRole('textbox', { name: '第2轮工具编码', exact: true })
      .fill('fixture-mock-tool');
    await editor.getByRole('textbox', { name: '第2轮工具名称', exact: true }).fill('模拟阅卷工具');
    await editor
      .getByRole('textbox', { name: '第2轮工具配置（选填）', exact: true })
      .fill('{"mode":"fixture"}');
    await choose(page, editor, '平局裁决规则', '从宽（准入）');
    if (!desktop) await screenshot(page, 'create');
    state.holdWrite = true;
    await submitConfiguration(page, editor);
    await expect.poll(() => calls('publish').length).toBe(1);
    await expect(editor.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled();
    expect(calls('publish')[0]!.body).toMatchObject({
      projectId,
      examName: '完整发布考试',
      registrationDeadline: '2099-12-31 18:20:30',
      durationMinutes: 30,
      fullScore: 20,
      passScore: 12,
      decisionRule: 'MAJORITY',
      tieBreakRule: 'LENIENT',
      papers: [
        {
          questions: [
            {
              questionContent: '请核对记录并说明判断依据',
              requiredFlag: true,
              scoreSource: 'AUTO',
            },
          ],
        },
        {
          questions: [
            { questionContent: '第二卷完整题干', requiredFlag: false, scoreSource: 'AUTO' },
          ],
        },
      ],
      gradingRounds: [
        { gradingMode: 'MANUAL', reviewerUserIds: [user.id] },
        {
          gradingMode: 'AUTO',
          toolCode: 'fixture-mock-tool',
          toolName: '模拟阅卷工具',
          toolConfig: { mode: 'fixture' },
        },
      ],
    });
    expect(calls('publish')[0]!.body).not.toHaveProperty('retakeCount');
    expect(calls('publish')[0]!.headers.cookie).toContain('exam_session=active');
    expect(calls('publish')[0]!.headers.authorization).toBeUndefined();
    expect(calls('publish')[0]!.headers['idempotency-key']).toBeUndefined();
    await releaseWrite();
    state.holdWrite = false;
    await expect(editor).toHaveCount(0);
    const published = examCard(panel, '完整发布考试');
    await expect(published).toBeVisible();
    await published.getByRole('button', { name: '编辑考试', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑考试', exact: true });
    await expect(edit.getByRole('textbox', { name: '考试名称', exact: true })).toHaveValue(
      '完整发布考试',
    );
    await edit.getByRole('textbox', { name: '考试名称', exact: true }).fill('已更新考试');
    await submitConfiguration(page, edit, true);
    await expect(edit).toHaveCount(0);
    expect(calls('edit')).toHaveLength(1);
    expect(calls('edit')[0]).toMatchObject({
      method: 'PUT',
      body: {
        projectId,
        examId: 5003,
        expectedCurrentVersionId: 6001,
        examName: '已更新考试',
      },
    });
    const updated = examCard(panel, '已更新考试');
    await updated.getByRole('button', { name: '关闭考试', exact: true }).click();
    let close = page.getByRole('dialog', { name: '关闭考试', exact: true });
    await close.getByRole('button', { name: '取消', exact: true }).click();
    expect(calls('close')).toHaveLength(0);
    await updated.getByRole('button', { name: '关闭考试', exact: true }).click();
    close = page.getByRole('dialog', { name: '关闭考试', exact: true });
    await close.getByRole('button', { name: '确认关闭', exact: true }).click();
    await expect(close).toHaveCount(0);
    expect(calls('close')).toHaveLength(1);
    expect(calls('close')[0]!.body).toMatchObject({ projectId, examId: 5003 });
    await expect(updated).toContainText('已关闭');
    await expect(
      updated
        .getByRole('button', { name: '编辑考试', exact: true })
        .and(updated.locator(':enabled')),
    ).toHaveCount(0);
    expect(calls('publish')).toHaveLength(1);
    if (!desktop) await screenshot(page, 'closed');
  });
}

test('多卷题目与人工自动轮次校验阻止错误分数、时间和敏感工具配置', async ({ page }) => {
  const { calls } = await backend(page);
  const editor = await createEditor(page, await openExams(page));
  await fillEditor(editor);
  await editor.getByRole('spinbutton', { name: '准入分数线', exact: true }).fill('20.001');
  await editor.getByRole('button', { name: '发布考试', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: '准入分数线', exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await editor.getByRole('spinbutton', { name: '准入分数线', exact: true }).fill('12');
  await editor.getByLabel(/^截止时间（上海时间）\s*\*$/).fill('2020-01-01T00:00:01');
  await editor.getByRole('button', { name: '发布考试', exact: true }).click();
  await expect(editor.getByLabel(/^截止时间（上海时间）\s*\*$/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await editor.getByLabel(/^截止时间（上海时间）\s*\*$/).fill('2099-12-31T18:20:30');
  await choose(page, editor, '试卷1题目1分值来源', '手动分值');
  await editor.getByRole('spinbutton', { name: '试卷1题目1分值', exact: true }).fill('19');
  await editor.getByRole('button', { name: '发布考试', exact: true }).click();
  await expect(editor).toContainText('本卷各题分值合计必须等于试卷满分');
  await editor.getByRole('spinbutton', { name: '试卷1题目1分值', exact: true }).fill('20');
  await editor.getByRole('button', { name: '添加题目', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '试卷1题目2题干', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '删除试卷1题目2', exact: true }).click();
  await editor.getByRole('button', { name: '添加判卷轮次', exact: true }).click();
  await choose(page, editor, '第2轮判卷方式', '自动阅卷');
  await editor.getByRole('textbox', { name: '第2轮工具编码', exact: true }).fill('fixture');
  await editor.getByRole('textbox', { name: '第2轮工具名称', exact: true }).fill('模拟工具');
  await editor
    .getByRole('textbox', { name: '第2轮工具配置（选填）', exact: true })
    .fill('{"token":"fixture-value"}');
  await editor.getByRole('button', { name: '发布考试', exact: true }).click();
  await expect(
    editor.getByRole('textbox', { name: '第2轮工具配置（选填）', exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  expect(calls('publish')).toHaveLength(0);
});

test('考试活动上限仅禁止新增，主策略官仍可编辑；无需笔试不开放考试', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.management.canCreateExam = false;
  state.management.activeExamCount = 2;
  state.management.createDisabledReason = '活动考试数量已达到上限';
  const panel = await openExams(page);
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  await expect(
    examCard(panel).getByRole('button', { name: '编辑考试', exact: true }),
  ).toBeEnabled();
  await examCard(panel).getByRole('button', { name: '查看配置', exact: true }).click();
  const configurationView = page.getByRole('dialog', { name: '考试配置', exact: true });
  await expect(
    configurationView.getByRole('region', { name: '考试配置内容', exact: true }),
  ).toContainText('当前生效考试');
  await expect(
    configurationView.getByRole('button', { name: '保存新版本', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  const configurationReads = calls('detail').length;
  const closed = examCard(panel, '历史关闭考试');
  await expect(closed.getByRole('button', { name: '查看配置', exact: true })).toBeDisabled();
  await closed.getByRole('button', { name: '查看名单', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '考试名单', exact: true })).toBeVisible();
  expect(calls('detail')).toHaveLength(configurationReads);
  await page.keyboard.press('Escape');
  state.managementStatus = 503;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(panel).toContainText('考试管理读取结果');
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  await expect(
    examCard(panel)
      .getByRole('button', { name: '编辑考试', exact: true })
      .and(examCard(panel).locator(':enabled')),
  ).toHaveCount(0);
  state.managementStatus = 200;
  state.management.exams = [];
  state.management.activeExamCount = 0;
  state.management.canCreateExam = true;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(panel.getByText('暂无考试', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeEnabled();
  state.management.needWrittenExam = false;
  state.management.canCreateExam = false;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(panel).toContainText('当前不能组织新考试');
  expect(calls('publish')).toHaveLength(0);
});

test('协作身份403只读与候选503禁写，真实切换角色后不读取策略官考试', async ({ page }) => {
  const { state, calls, requests } = await backend(page);
  state.reviewerStatus = 403;
  const panel = await openExams(page);
  await expect(
    panel.getByText('当前仅可查看，考试由生效主策略官维护。', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  await expect(
    examCard(panel)
      .getByRole('button', { name: '编辑考试', exact: true })
      .and(examCard(panel).locator(':enabled')),
  ).toHaveCount(0);
  await expect(
    examCard(panel).getByRole('button', { name: '查看名单', exact: true }),
  ).toBeEnabled();
  state.reviewerStatus = 503;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  state.reviewerStatus = 200;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我负责的项目', exact: true })).toBeVisible();
  const before = calls('management').length;
  await page.goto(`${origin}/#/strategist/projects/${projectId}`);
  await expect(page).toHaveURL(/#\/$/);
  expect(calls('management')).toHaveLength(before);
  expect(
    requests.filter((row) => row.path === '/api/v1/auth/switch-role').map((row) => row.body),
  ).toEqual([{ role: 'EXPERT' }]);
  expect(calls('publish')).toHaveLength(0);
});

test('项目准入与考试名单分别使用真实GET和POST筛选分页，考试通过不冒充入项', async ({ page }) => {
  const { calls } = await backend(page);
  const panel = await openExams(page, 'admission');
  const admissions = panel.getByRole('region', { name: '项目准入情况', exact: true });
  const candidate = admissions.getByRole('row').filter({ hasText: '应试甲' });
  await expect(candidate).toContainText('待入项');
  await expect(candidate).not.toContainText('已入项');
  await admissions.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => calls('admissions').at(-1)!.query.current).toBe('2');
  await admissions.getByRole('textbox', { name: '搜索准入人员', exact: true }).fill('应试甲');
  await choose(page, admissions, '准入状态', '待入项');
  await admissions.getByRole('button', { name: '查询', exact: true }).click();
  await expect(candidate).toBeVisible();
  expect(calls('admissions').at(-1)).toMatchObject({
    method: 'GET',
    body: null,
    query: {
      projectId: String(projectId),
      keyword: '应试甲',
      admissionStatus: 'PENDING_ENTRY',
      current: '1',
      size: '20',
    },
  });
  const list = await roster(page, panel);
  await list.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => calls('roster').at(-1)!.body).toMatchObject({ current: 2 });
  await list.getByRole('textbox', { name: '搜索考试人员', exact: true }).fill('应试甲');
  await choose(page, list, '考试结果', '待阅卷');
  await list.getByRole('button', { name: '查询', exact: true }).click();
  await expect(list.getByRole('row').filter({ hasText: '应试甲' })).toBeVisible();
  expect(calls('roster').at(-1)).toMatchObject({
    method: 'POST',
    query: {},
    body: {
      projectId,
      examId,
      keyword: '应试甲',
      finalResult: 'PENDING',
      current: 1,
      size: 20,
    },
  });
  expect(calls('publish')).toHaveLength(0);
});

test('编辑409和服务异常保留草稿并锁写，显式重读使用最新版本而不盲重试', async ({ page }) => {
  const { state, calls } = await backend(page);
  const panel = await openExams(page);
  await examCard(panel).getByRole('button', { name: '编辑考试', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '编辑考试', exact: true });
  await editor.getByRole('textbox', { name: '考试名称', exact: true }).fill('冲突后保留的配置');
  state.writeStatus = 409;
  await submitConfiguration(page, editor, true);
  await expect(editor).toContainText('考试版本已发生变化');
  await expect(editor.getByRole('textbox', { name: '考试名称', exact: true })).toHaveValue(
    '冲突后保留的配置',
  );
  await expect(editor.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  expect(calls('edit')).toHaveLength(1);
  expect(calls('edit')[0]!.body).toMatchObject({ expectedCurrentVersionId: 6001 });
  state.configuration = configuration(baselineInput, examId, 6002);
  state.management.exams[0]!.currentVersionId = 6002;
  state.writeStatus = 503;
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '重新读取考试状态', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑考试', exact: true });
  await expect(editor.getByRole('textbox', { name: '考试名称', exact: true })).toHaveValue(
    '当前生效考试',
  );
  expect(calls('edit')).toHaveLength(1);
  await editor.getByRole('textbox', { name: '考试名称', exact: true }).fill('显式重读后的配置');
  await submitConfiguration(page, editor, true);
  await expect(editor.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  expect(calls('edit')).toHaveLength(2);
  expect(calls('edit')[1]!.body).toMatchObject({ expectedCurrentVersionId: 6002 });
});

test('网络未知发布结果跨弹框关闭仍锁写，显式管理回读后才能重新操作', async ({ page }) => {
  const { state, calls } = await backend(page);
  const panel = await openExams(page);
  let editor = await createEditor(page, panel);
  await fillEditor(editor);
  state.networkFailure = true;
  await submitConfiguration(page, editor);
  await expect(editor.getByRole('button', { name: '发布考试', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: '重新读取考试状态', exact: true })).toBeVisible();
  expect(calls('publish')).toHaveLength(1);
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  expect(calls('publish')).toHaveLength(1);
  state.networkFailure = false;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  editor = await createEditor(page, panel);
  await fillEditor(editor, '核对未知结果后创建');
  await submitConfiguration(page, editor);
  await expect(editor).toHaveCount(0);
  expect(calls('publish')).toHaveLength(2);
});

test('发布成功回读失败保留已成功事实，仅显式读取恢复不重复发布', async ({ page }) => {
  const { state, calls } = await backend(page);
  state.failReadAfterWrite = true;
  const panel = await openExams(page);
  const editor = await createEditor(page, panel);
  await fillEditor(editor);
  await submitConfiguration(page, editor);
  await expect(editor).toHaveCount(0);
  await expect(
    panel.getByText('考试已发布，已确认结果不会重复提交。', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('操作已成功，最新资料尚未读取完成。请重新读取，不要重复提交。', {
      exact: true,
    }),
  ).toBeVisible();
  expect(calls('publish')).toHaveLength(1);
  await expect(panel.getByRole('button', { name: '组织考试', exact: true })).toBeDisabled();
  state.managementStatus = 200;
  state.detailStatus = 200;
  state.admissionStatus = 200;
  state.rosterStatus = 200;
  state.gradingStatus = 200;
  await panel.getByRole('button', { name: '刷新考试', exact: true }).click();
  await expect(examCard(panel, '完整发布考试')).toBeVisible();
  expect(calls('publish')).toHaveLength(1);
});

test('导入只填当前表单、敏感附件一次上传与鉴权下载，375弹框安全关闭恢复焦点', async ({ page }) => {
  const { calls, requests } = await backend(page);
  const panel = await openExams(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const opener = panel.getByRole('button', { name: '组织考试', exact: true });
  const editor = await createEditor(page, panel);
  await fillEditor(editor, '导入前未保存名称');
  await editor.getByText('导入试卷与下载模板', { exact: true }).click();
  const [template] = await Promise.all([
    page.waitForEvent('download'),
    editor.getByRole('button', { name: 'TXT模板', exact: true }).click(),
  ]);
  expect(template.suggestedFilename()).toBe('entrance-exam-import-v1.txt');
  await editor.getByLabel('选择试卷文件', { exact: true }).setInputFiles({
    name: 'fixture.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('isolated source exam'),
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.getByRole('button', { name: '解析并填入表单', exact: true }).click();
  expect(calls('import/parse')).toHaveLength(0);
  await expect(editor.getByRole('textbox', { name: '考试名称', exact: true })).toHaveValue(
    '导入前未保存名称',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '解析并填入表单', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '考试名称', exact: true })).toHaveValue(
    '导入预览考试',
  );
  expect(calls('import/parse')).toHaveLength(1);
  expect(calls('import/parse')[0]).toMatchObject({
    body: null,
    fileName: 'fixture.txt',
    form: { projectId: String(projectId) },
  });
  expect(calls('publish')).toHaveLength(0);
  await expect(editor).toContainText('远程文档导入暂未开放');
  await editor.getByLabel('上传试卷1题目1题干附件', { exact: true }).setInputFiles({
    name: 'question.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('isolated question attachment'),
  });
  const attachmentGroup = editor.getByRole('group', { name: '试卷1题目1题干附件', exact: true });
  await expect(
    attachmentGroup.getByRole('button', { name: '下载question.txt', exact: true }),
  ).toBeVisible();
  const upload = requests.filter((row) => row.path === '/api/v1/files/upload');
  expect(upload).toHaveLength(1);
  expect(upload[0]!.form).toMatchObject({
    bizType: 'ENTRANCE_EXAM_ATTACHMENT',
    category: 'PROJECT_ATTACHMENT',
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    attachmentGroup.getByRole('button', { name: '下载question.txt', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('question.txt');
  expect(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.getByRole('textbox', { name: '考试名称', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, 'mobile-editor');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await createEditor(page, panel);
  await page.mouse.click(4, 4);
  await expect(page.getByRole('dialog', { name: '创建考试', exact: true })).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(calls('publish')).toHaveLength(0);
});

test('历史答卷逐题判定后一次人工提交，附件鉴权下载且历史HTML不执行', async ({ page }) => {
  const { state, calls, requests } = await backend(page);
  state.grading.questions[0]!.referenceAnswer =
    '<p>安全参考答案</p><img src="https://exam-untrusted.invalid/track" onerror="document.documentElement.dataset.examScript=\'ran\'"><script>document.documentElement.dataset.examScript="ran"</script>';
  const external: string[] = [];
  await page.route('https://exam-untrusted.invalid/**', (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  const dialog = await gradingDialog(page, await openExams(page));
  await expect(dialog).toContainText('安全参考答案');
  expect(await page.evaluate(() => document.documentElement.dataset.examScript)).toBeUndefined();
  expect(external).toEqual([]);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'answer.txt', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('answer.txt');
  const fileRead = requests.find((row) => row.path === '/api/v1/files/view')!;
  expect(fileRead.query).toEqual({ objectKey: attachment.objectKey });
  expect(fileRead.headers.cookie).toContain('exam_session=active');
  expect(fileRead.headers.authorization).toBeUndefined();
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  expect(calls('grading/manual')).toHaveLength(0);
  await expect(
    page.getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true }),
  ).toHaveCount(0);
  await choose(page, dialog, '题目1判定', '正确');
  const opinion = dialog.getByRole('textbox', { name: '阅卷意见1', exact: true });
  const summary = dialog.getByRole('textbox', { name: '本轮总结', exact: true });
  const longOpinion = '核'.repeat(1000),
    longSummary = '验'.repeat(5000);
  await opinion.fill(longOpinion);
  await summary.fill(longSummary);
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect(dialog).toContainText(
    '阅卷内容超过当前可提交大小，请缩短阅卷意见或本轮总结后重试。',
  );
  expect(calls('grading/manual')).toHaveLength(0);
  await expect(opinion).toHaveValue(longOpinion);
  await expect(summary).toHaveValue(longSummary);
  await expect(dialog.getByRole('button', { name: '提交人工阅卷', exact: true })).toBeEnabled();
  await opinion.fill('核对完整');
  await summary.fill('本轮通过');
  await dialog.getByRole('button', { name: '提交人工阅卷', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认提交人工阅卷', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect.poll(() => calls('grading/manual').length).toBe(1);
  expect(calls('grading/manual')[0]!.body).toEqual({
    projectId,
    examId,
    attemptId: 11001,
    gradingRecordId: 10001,
    conclusionSummary: '本轮通过',
    items: [{ questionId: 8001, correctness: 'CORRECT', gradingOpinion: '核对完整' }],
  });
  await expect(dialog).toContainText('本轮得分：20分');
  await expect(dialog).toContainText('最终准入结果：待确定');
  await expect(
    dialog
      .getByRole('button', { name: '提交人工阅卷', exact: true })
      .and(dialog.locator(':enabled')),
  ).toHaveCount(0);
  expect(calls('grading/manual')).toHaveLength(1);
  await screenshot(page, 'historical-grading');
  await dialog.getByRole('button', { name: '返回考试名单', exact: true }).click();
  const row = page
    .getByRole('dialog', { name: '考试名单', exact: true })
    .getByRole('row')
    .filter({ hasText: '应试甲' });
  await expect(row.getByRole('cell').nth(2)).toContainText('本轮通过');
  await expect(row.getByRole('cell').nth(2)).not.toContainText('考试通过');
  await expect(row.getByRole('cell').nth(3)).toHaveText('待阅卷');
});

test('失败自动轮重试仅进入待执行，人工补偿使用原因和完整判定不调用Agent', async ({ page }) => {
  const { state, calls, requests } = await backend(page);
  Object.assign(state.grading.rounds[0]!, {
    status: 'COMPLETED',
    score: 20,
    roundResult: 'ADMITTED',
  });
  Object.assign(state.grading.rounds[1]!, {
    gradingRecordId: 10002,
    status: 'FAILED',
    errorMessage: '模拟工具执行失败',
  });
  const dialog = await gradingDialog(page, await openExams(page));
  await choose(page, dialog, '判卷轮次', '第2轮 · 模拟自动阅卷');
  await expect(dialog).toContainText('模拟工具执行失败');
  await dialog.getByRole('button', { name: '重试模拟阅卷', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认重试模拟阅卷', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  expect(calls('grading/retry')).toHaveLength(0);
  await dialog.getByRole('button', { name: '重试模拟阅卷', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认重试模拟阅卷', exact: true })
    .getByRole('button', { name: '确认重试', exact: true })
    .click();
  await expect.poll(() => calls('grading/retry').length).toBe(1);
  expect(calls('grading/retry')[0]!.body).toEqual({ projectId, examId, gradingRecordId: 10002 });
  await expect(dialog).toContainText('第2轮 · 模拟自动阅卷 · 待阅卷');
  await expect(dialog).toContainText('最终准入结果：待确定');
  await expect(
    dialog
      .getByRole('button', { name: '重试模拟阅卷', exact: true })
      .and(dialog.locator(':enabled')),
  ).toHaveCount(0);
  state.grading.rounds[1]!.status = 'FAILED';
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await dialog.getByRole('button', { name: '人工补偿', exact: true }).click();
  await choose(page, dialog, '题目1判定', '正确');
  await dialog.getByRole('button', { name: '人工补偿', exact: true }).click();
  expect(calls('grading/auto/compensate')).toHaveLength(0);
  await dialog
    .getByRole('textbox', { name: '补偿原因', exact: true })
    .fill('核对模拟失败记录后人工修正');
  state.networkFailure = true;
  await dialog.getByRole('button', { name: '人工补偿', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认人工补偿', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect.poll(() => calls('grading/auto/compensate').length).toBe(1);
  await expect(dialog.getByRole('button', { name: '人工补偿', exact: true })).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '返回考试名单', exact: true }).click();
  await page
    .getByRole('dialog', { name: '考试名单', exact: true })
    .getByRole('row')
    .filter({ hasText: '应试甲' })
    .getByRole('button', { name: '查看阅卷', exact: true })
    .click();
  await choose(page, dialog, '判卷轮次', '第2轮 · 模拟自动阅卷');
  await expect(dialog.getByRole('button', { name: '人工补偿', exact: true })).toBeDisabled();
  expect(calls('grading/auto/compensate')).toHaveLength(1);
  state.networkFailure = false;
  await dialog.getByRole('button', { name: '重新读取阅卷状态', exact: true }).click();
  await dialog.getByRole('button', { name: '人工补偿', exact: true }).click();
  await choose(page, dialog, '题目1判定', '正确');
  await dialog.getByRole('textbox', { name: '补偿原因', exact: true }).fill('显式重读后核对并修正');
  await dialog.getByRole('button', { name: '人工补偿', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认人工补偿', exact: true })
    .getByRole('button', { name: '确认提交', exact: true })
    .click();
  await expect.poll(() => calls('grading/auto/compensate').length).toBe(2);
  expect(calls('grading/auto/compensate')[1]!.body).toMatchObject({
    projectId,
    examId,
    gradingRecordId: 10002,
    compensationReason: '显式重读后核对并修正',
    items: [{ questionId: 8001, correctness: 'CORRECT' }],
  });
  await expect(dialog).toContainText('最终准入结果：已录取');
  expect(requests.some((row) => row.path.includes('/integrations/agents'))).toBe(false);
});
