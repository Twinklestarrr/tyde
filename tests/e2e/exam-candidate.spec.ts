import { expect, test, type Page } from '@playwright/test';
import {
  assignmentDetailExample,
  myProjectExample,
} from '../../apps/server/src/modules/expert/expert-assignment.schema';
import { expertTaskExample } from '../../apps/server/src/modules/expert/expert-task.schema';
import { candidatePaperExample } from '../../apps/server/src/modules/entrance-exams/exam-candidate.schema';
import type { AuthUser } from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = expertTaskExample.basicInfo.projectId;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'CANDIDATE10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '考生联调员',
  realName: '测试专家',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'EXPERT',
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
const questionAttachment = {
  objectKey: `entrance-exam-attachment/2026/11/03/${'b'.repeat(32)}.txt`,
  uploadedFileId: uuid(81),
  fileName: '题目材料.txt',
  extension: 'txt',
  contentType: 'text/plain',
  fileSize: 16,
  fileHash: 'b'.repeat(64),
};
const paper = {
  ...candidatePaperExample,
  projectId,
  examName: '执行专家准入考试',
  paperName: '已绑定历史试卷',
  enteredAt: '2026-11-03 10:00:00',
  answerDeadlineAt: null as string | null,
  fullScore: 30,
  questions: [
    {
      ...candidatePaperExample.questions[0],
      questionContent: '<p>请描述质检流程。</p><script>window.examUnsafe = true</script>',
      questionFiles: [questionAttachment],
    },
    {
      questionId: 2,
      sequenceNo: 2,
      questionContent: '补充说明（选答）',
      questionFiles: null,
      requiredFlag: false,
      score: 10,
    },
  ],
};
interface RequestLog {
  path: string;
  method: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  form: Record<string, string>;
  fileName?: string;
}

/** 考试和上传均使用内存 HTTP 夹具，不访问业务数据库、OSS 或真实阅卷 Agent。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'candidate_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const state = {
    task: {
      ...structuredClone(expertTaskExample),
      acceptanceStatus: 'ACCEPTED',
      needWrittenExam: true,
      branchNodeCode: 'ENTRANCE_EXAM',
      operations: { canAccept: false, canReject: false, canReportOutput: false },
    },
    paper: structuredClone(paper),
    status: 'NOT_EXAMINED' as 'NOT_EXAMINED' | 'NOT_PASSED' | 'PENDING' | 'PASSED',
    entered: false,
    submitted: false,
    cancelled: false,
    currentStatus: 200,
    enterStatus: 200,
    writeStatus: 200,
    uploadStatus: 200,
    unknownSubmit: false,
    applyUnknownSubmit: false,
    unknownCancel: false,
    applyUnknownCancel: false,
    hideTask: false,
    holdSubmit: false,
  };
  const requests: RequestLog[] = [];
  let releaseSubmit: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const contentType = headers['content-type'] ?? '';
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body: contentType.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
      headers,
      form: {},
    };
    if (contentType.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      for (const part of (request.postDataBuffer()?.toString('utf8') ?? '').split(
        `--${boundary?.[1] ?? boundary?.[2]}`,
      )) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        const start = part.indexOf('\r\n\r\n');
        if (!name || start < 0) continue;
        log.form[name] = part.slice(start + 4).replace(/\r\n$/, '');
        log.fileName = /filename="([^"]+)"/.exec(part)?.[1] ?? log.fileName;
      }
    }
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!headers.cookie?.includes('candidate_session=active')) return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/users/me') return reply(user);
    if (log.path === '/api/v1/expert-assignments/my-projects')
      return reply([{ ...myProjectExample, admissionStatus: state.status }]);
    if (log.path === '/api/v1/users/me/applications')
      return reply({
        records: [],
        total: 0,
        current: log.body?.current ?? 1,
        size: log.body?.size ?? 10,
        pages: 0,
      });
    if (log.path === '/api/v1/expert-assignments/my-tasks')
      return reply(state.hideTask ? [] : [state.task]);
    if (log.path === '/api/v1/expert-assignments/detail')
      return reply({
        ...assignmentDetailExample,
        assignmentId: state.task.assignmentId,
        movementId: state.task.movementId,
      });
    if (log.path === '/api/v1/entrance-exams/current')
      return reply(
        state.currentStatus === 200 ? { projectId, status: state.status } : null,
        state.currentStatus,
        state.currentStatus === 403 ? '当前应试身份已失效' : '考试状态读取结果',
      );
    if (log.path === '/api/v1/entrance-exams/enter') {
      if (state.enterStatus !== 200) return reply(null, state.enterStatus, '当前应试身份已失效');
      if (state.cancelled) return reply(null, 400, '已取消并离场，不可再次操作');
      if (state.submitted) return reply(null, 409, '答卷已提交，不可重复操作');
      state.entered = true;
      state.status = 'NOT_PASSED';
      return reply(state.paper);
    }
    if (log.path === '/api/v1/entrance-exams/submit') {
      if (state.writeStatus !== 200)
        return reply(null, state.writeStatus, '答卷暂时不能提交，请保留答案');
      const apply = () => {
        state.submitted = true;
        state.status = 'PENDING';
      };
      if (state.unknownSubmit) {
        if (state.applyUnknownSubmit) apply();
        return route.abort('failed');
      }
      const finish = async () => {
        apply();
        await reply({
          attemptId: state.paper.attemptId,
          answerCount: state.paper.questions.length,
          gradingRoundCount: 2,
          gradingStatus: 'PENDING',
          submittedAt: '2026-11-03 10:20:00',
        });
      };
      if (state.holdSubmit) {
        releaseSubmit = finish;
        return;
      }
      return finish();
    }
    if (log.path === '/api/v1/entrance-exams/cancel') {
      if (state.unknownCancel) {
        if (state.applyUnknownCancel) {
          state.cancelled = true;
          state.status = 'NOT_PASSED';
        }
        return route.abort('failed');
      }
      state.cancelled = true;
      state.status = 'NOT_PASSED';
      return reply({ attemptId: state.paper.attemptId, cancelledAt: '2026-11-03 10:20:00' });
    }
    if (log.path === '/api/v1/files/upload')
      return reply(
        state.uploadStatus === 200
          ? {
              fileId: uuid(91),
              objectKey: `entrance-exam-attachment/2026/11/03/${'c'.repeat(32)}.txt`,
              uploadToken: 'u'.repeat(43),
              url: null,
              sensitive: true,
              fileName: log.fileName,
              extension: 'txt',
              size: Buffer.byteLength(log.form.file ?? ''),
              contentType: 'text/plain',
              fileHash: 'c'.repeat(64),
            }
          : null,
        state.uploadStatus,
        '附件上传结果',
      );
    if (log.path === '/api/v1/files/view')
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'isolated material',
      });
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, releaseSubmit: async () => releaseSubmit?.() };
}

async function openExam(page: Page) {
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await page.getByRole('button', { name: '参加准入考试', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '参加准入考试', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

const integrity = '我承诺独立完成作答，并确认提交后不可修改。';
const writes = (requests: RequestLog[], command: string) =>
  requests.filter((request) => request.path === `/api/v1/entrance-exams/${command}`);

for (const desktop of [false, true]) {
  test(`${desktop ? '桌面运行配置' : 'Web'}专家考试校验必答与诚信、鉴权附件并仅交卷一次`, async ({
    page,
  }) => {
    const fixture = await backend(page, desktop);
    const dialog = await openExam(page);
    expect(writes(fixture.requests, 'enter')).toHaveLength(0);
    await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
    await expect(dialog.getByLabel('第1题答案', { exact: true })).toBeVisible();
    await expect(dialog.getByText('已绑定历史试卷', { exact: true })).toBeVisible();
    await page.screenshot({
      path: `artifacts/exam-candidate/answer-${desktop ? 'desktop-config' : 'web'}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => 'examUnsafe' in window)).toBe(false);
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '题目材料.txt', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('题目材料.txt');
    expect(
      fixture.requests.find((request) => request.path === '/api/v1/files/view')?.query,
    ).toEqual({ objectKey: questionAttachment.objectKey });

    await dialog.getByRole('button', { name: '提交答卷', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认交卷', exact: true })).toHaveCount(0);
    expect(writes(fixture.requests, 'submit')).toHaveLength(0);
    await dialog.getByLabel('第1题答案', { exact: true }).fill('先核对标准，再记录质检结果。');
    await dialog.getByRole('button', { name: '提交答卷', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认交卷', exact: true })).toHaveCount(0);

    await dialog.getByLabel('上传第1题答案附件', { exact: true }).setInputFiles({
      name: '作答说明.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('isolated candidate answer'),
    });
    await expect(
      dialog.getByRole('button', { name: '下载作答说明.txt', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('checkbox', { name: integrity, exact: true }).check();
    fixture.state.holdSubmit = true;
    await dialog.getByRole('button', { name: '提交答卷', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认交卷', exact: true });
    await confirmation.getByRole('button', { name: '确认交卷', exact: true }).click();
    await expect.poll(() => writes(fixture.requests, 'submit').length).toBe(1);
    await expect(
      confirmation.getByRole('button', { name: '确认交卷', exact: true }),
    ).toBeDisabled();
    await fixture.releaseSubmit();
    await expect(dialog.getByText('答卷已提交，等待阅卷。', { exact: true })).toBeVisible();
    expect(writes(fixture.requests, 'enter')).toHaveLength(1);
    const submission = writes(fixture.requests, 'submit')[0].body;
    expect(submission).toMatchObject({
      projectId,
      attemptId: 1,
      integritySigned: true,
    });
    expect(submission?.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionId: 1,
          answerContent: '先核对标准，再记录质检结果。',
          answerFiles: [
            {
              objectKey: `entrance-exam-attachment/2026/11/03/${'c'.repeat(32)}.txt`,
              uploadToken: 'u'.repeat(43),
            },
          ],
        }),
      ]),
    );
    const uploaded = fixture.requests.filter((request) => request.path === '/api/v1/files/upload');
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].form.bizType).toBe('ENTRANCE_EXAM_ATTACHMENT');
    expect(uploaded[0].headers['x-tyde-client']).toBe('web');
    expect(uploaded[0].headers.cookie).toContain('candidate_session=active');
    await dialog.getByRole('button', { name: '关闭考试', exact: true }).click();
    expect(writes(fixture.requests, 'submit')).toHaveLength(1);
  });
}

test('专家恢复绑定历史试卷，关闭考试保留当前页面答案且不取消或重复入场', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.entered = true;
  state.status = 'NOT_PASSED';
  state.paper.examVersionId = 9;
  state.paper.paperId = 17;
  let dialog = await openExam(page);
  await dialog.getByRole('button', { name: '恢复答题', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('保留在当前页面内存的答案');
  await dialog.getByRole('button', { name: '关闭考试', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '参加准入考试', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '参加准入考试', exact: true });
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue(
    '保留在当前页面内存的答案',
  );
  await expect(dialog.getByText('已绑定历史试卷', { exact: true })).toBeVisible();
  expect(writes(requests, 'enter')).toHaveLength(1);
  expect(writes(requests, 'cancel')).toHaveLength(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
  expect(writes(requests, 'enter')[0].body).toEqual({ projectId });
});

test('转项考试使用目标项目独立入场，明确确认取消后不保存临时答案', async ({ page }) => {
  const { state, requests } = await backend(page);
  Object.assign(state.task, {
    assignmentId: null,
    movementId: 7,
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    sourceBizId: 7,
    needWrittenExam: false,
  });
  const dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('取消时不会提交此答案');
  await dialog.getByRole('button', { name: '取消考试', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认取消考试', exact: true });
  await expect(confirmation).toBeVisible();
  expect(writes(requests, 'cancel')).toHaveLength(0);
  await confirmation.getByRole('button', { name: '确认取消考试', exact: true }).click();
  await expect.poll(() => state.cancelled).toBe(true);
  expect(writes(requests, 'enter')[0].body).toEqual({ projectId });
  expect(writes(requests, 'cancel')[0].body).toEqual({ projectId, attemptId: 1 });
  expect(writes(requests, 'submit')).toHaveLength(0);
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('考试已取消，无法再次入场。', { exact: true })).toBeVisible();
  expect(
    requests.find((request) => request.path.endsWith('/expert-assignments/detail'))?.query,
  ).toEqual({ movementId: '7' });
});

test('考试资格读取403保留服务端拒绝，不入场且不提供交卷操作', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.currentStatus = 403;
  const dialog = await openExam(page);
  await expect(dialog.getByText('当前应试身份已失效', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始考试', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toHaveCount(0);
  expect(writes(requests, 'enter')).toHaveLength(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('交卷响应丢失只读取聚合状态，暂停重复写入并保留答案', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownSubmit = true;
  state.applyUnknownSubmit = true;
  const dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('响应丢失时保留该答案');
  await dialog.getByRole('checkbox', { name: integrity, exact: true }).check();
  await dialog.getByRole('button', { name: '提交答卷', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认交卷', exact: true })
    .getByRole('button', { name: '确认交卷', exact: true })
    .click();
  await expect(
    dialog.getByText('提交结果尚未确认，请先核实考试状态。', { exact: true }),
  ).toBeVisible();
  expect(writes(requests, 'submit')).toHaveLength(1);
  await dialog.getByRole('button', { name: '核实考试状态', exact: true }).click();
  await expect(
    dialog.getByText('当前准入状态：等待阅卷。已暂停交卷与取消操作。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('答卷已提交，等待阅卷。', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue('响应丢失时保留该答案');
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toHaveCount(0);
  expect(writes(requests, 'submit')).toHaveLength(1);
  expect(writes(requests, 'enter')).toHaveLength(1);
});

test('未取得通过结果不能解锁未知交卷，显式恢复同一应试后才允许重新检查提交', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownSubmit = true;
  const dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('恢复原应试时保留该答案');
  await dialog.getByRole('checkbox', { name: integrity, exact: true }).check();
  await dialog.getByRole('button', { name: '提交答卷', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认交卷', exact: true })
    .getByRole('button', { name: '确认交卷', exact: true })
    .click();
  await expect(
    dialog.getByText('提交结果尚未确认，请先核实考试状态。', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '核实考试状态', exact: true }).click();
  await expect(
    dialog.getByText('当前状态无法确认上次操作。可恢复原试卷核实，系统不会自动重发交卷或取消。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toHaveCount(0);
  expect(writes(requests, 'submit')).toHaveLength(1);
  await dialog.getByRole('button', { name: '恢复答题', exact: true }).click();
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue(
    '恢复原应试时保留该答案',
  );
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toBeEnabled();
  expect(writes(requests, 'enter')).toHaveLength(2);
  expect(writes(requests, 'submit')).toHaveLength(1);
});

test('刷新后只恢复服务端绑定试卷，不宣称临时答案已保存', async ({ page }) => {
  const { requests } = await backend(page);
  let dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('刷新后不会自动保存的答案');
  await expect(dialog.getByText(/刷新页面或离开后可能丢失/)).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await page.reload();
  dialog = await openExam(page);
  await dialog.getByRole('button', { name: '恢复答题', exact: true }).click();
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('已绑定历史试卷', { exact: true })).toBeVisible();
  expect(writes(requests, 'enter')).toHaveLength(2);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('取消响应丢失后未通过聚合状态不能冒充取消成功，也不重发取消', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknownCancel = true;
  state.applyUnknownCancel = true;
  const dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('取消结果未确认时保留该答案');
  await dialog.getByRole('button', { name: '取消考试', exact: true }).click();
  await page
    .getByRole('dialog', { name: '确认取消考试', exact: true })
    .getByRole('button', { name: '确认取消考试', exact: true })
    .click();
  await expect(
    dialog.getByText('提交结果尚未确认，请先核实考试状态。', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '核实考试状态', exact: true }).click();
  await expect(
    dialog.getByText('当前状态无法确认上次操作。可恢复原试卷核实，系统不会自动重发交卷或取消。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByText('考试已取消，无法再次入场。', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue(
    '取消结果未确认时保留该答案',
  );
  await expect(dialog.getByRole('button', { name: '取消考试', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '恢复答题', exact: true }).click();
  await expect(dialog.getByText('已取消并离场，不可再次操作', { exact: true })).toBeVisible();
  expect(writes(requests, 'cancel')).toHaveLength(1);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('重开考试读取最新聚合状态，待阅卷时保留草稿并暂停交卷取消', async ({ page }) => {
  const { state, requests } = await backend(page);
  let dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('其他页面操作后仍保留当前草稿');
  await dialog.getByRole('button', { name: '关闭考试', exact: true }).click();
  state.status = 'PENDING';
  const currentReads = writes(requests, 'current').length;
  await page.getByRole('button', { name: '参加准入考试', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '参加准入考试', exact: true });
  await expect(dialog.getByText('当前准入状态：等待阅卷', { exact: true })).toBeVisible();
  expect(writes(requests, 'current').length).toBeGreaterThan(currentReads);
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue(
    '其他页面操作后仍保留当前草稿',
  );
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '取消考试', exact: true })).toHaveCount(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('开始考试前按原来源重读完整待办，失去当前来源时不能借用同项目身份', async ({ page }) => {
  const { state, requests } = await backend(page);
  const dialog = await openExam(page);
  Object.assign(state.task, { assignmentId: 9, sourceBizId: 9 });
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await expect(
    dialog.getByText('当前来源已无可参加的考试待办，请刷新项目。', { exact: true }),
  ).toBeVisible();
  expect(writes(requests, 'enter')).toHaveLength(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('个人中心已接项目只读准入状态，待阅卷刷新为通过而不入场或读取管理阅卷', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.status = 'PENDING';
  await page.goto(`${origin}/#/profile`);
  await page.getByRole('tab', { name: '我的项目', exact: true }).click();
  await page
    .getByRole('list', { name: '我的项目列表', exact: true })
    .getByRole('button', { name: /示例项目/ })
    .click();
  const result = page.getByRole('region', { name: '本人准入考试状态', exact: true });
  await expect(result.getByText('等待阅卷', { exact: true })).toBeVisible();
  await expect(
    result.getByText('通过考试后仍需确认入项安排；考试操作从工作台当前待办进入。', { exact: true }),
  ).toBeVisible();
  state.status = 'PASSED';
  await result.getByRole('button', { name: '刷新考试状态', exact: true }).click();
  await expect(result.getByText('已通过准入考试', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '参加准入考试', exact: true })).toHaveCount(0);
  expect(writes(requests, 'enter')).toHaveLength(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
  expect(
    requests.filter((request) => request.path.includes('/entrance-exams/grading')),
  ).toHaveLength(0);
  expect(
    writes(requests, 'current').every(
      (request) => request.method === 'GET' && request.query.projectId === String(projectId),
    ),
  ).toBe(true);
});

test('有答案关闭弹框后局部返回仍确认离开，拒绝保留当前草稿而同意返回项目卡片', async ({ page }) => {
  const { requests } = await backend(page);
  let dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('局部返回取消后保留的答案');
  await dialog.getByRole('button', { name: '关闭考试', exact: true }).click();
  const prompts: string[] = [];
  page.once('dialog', async (confirmation) => {
    prompts.push(confirmation.message());
    await confirmation.dismiss();
  });
  await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('未提交的答案仅保存在当前页面');
  await expect(page.getByRole('heading', { name: '项目待办详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '参加准入考试', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '参加准入考试', exact: true });
  await expect(dialog.getByLabel('第1题答案', { exact: true })).toHaveValue(
    '局部返回取消后保留的答案',
  );
  await dialog.getByRole('button', { name: '关闭考试', exact: true }).click();
  page.once('dialog', async (confirmation) => {
    prompts.push(confirmation.message());
    await confirmation.accept();
  });
  await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  expect(prompts).toHaveLength(2);
  await expect(page.getByRole('region', { name: '执行专家待办项目', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目待办详情', exact: true })).toHaveCount(0);
  expect(writes(requests, 'cancel')).toHaveLength(0);
  expect(writes(requests, 'submit')).toHaveLength(0);
});

test('375px考生答题不溢出，个人截止时间到达后禁止交卷但允许取消', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.install({ time: new Date('2026-11-03T02:00:00.000Z') });
  const { state, requests } = await backend(page);
  state.paper.answerDeadlineAt = '2026-11-03 10:01:00';
  const dialog = await openExam(page);
  await dialog.getByRole('button', { name: '开始考试', exact: true }).click();
  await dialog.getByLabel('第1题答案', { exact: true }).fill('截止前填写的答案');
  await page.screenshot({ path: 'artifacts/exam-candidate/answer-375.png', fullPage: true });
  await dialog.getByRole('checkbox', { name: integrity, exact: true }).check();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.clock.fastForward(61_000);
  await expect(
    dialog.getByText('答题时间已结束，无法交卷；可以取消考试离场。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '提交答卷', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '取消考试', exact: true })).toBeEnabled();
  expect(writes(requests, 'submit')).toHaveLength(0);
});
