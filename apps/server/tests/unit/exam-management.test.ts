import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import {
  examConfigRows,
  examImportTemplate,
  examQuestionRows,
} from '../../src/modules/entrance-exams/exam-import-template.js';
import {
  reviewerItem,
  reviewersQuery,
  reviewersResult,
  templateQuery,
} from '../../src/modules/entrance-exams/exam-management.schema.js';
import { ExamManagementService } from '../../src/modules/entrance-exams/exam-management.service.js';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'pm-uid',
  sessionId: 'session',
  role: 'PM',
  clientType: 'desktop',
};
const requester = {
  id: '00000000-0000-4000-8000-000000000002',
  uid: 'nav-uid',
  displayName: '小明',
  realName: '王小明',
  avatarUrl: null,
};
const manager = {
  ...requester,
  id: principal.userId,
  uid: principal.uid,
  displayName: '策略官',
  realName: null,
};
function setup() {
  const tx = {
    managementGrant: { findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }) },
    project: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 3001, status: 'PUBLISHED', requesterId: requester.id }),
    },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({
        candidateUserId: principal.userId,
        expertRecruitmentHandlerUserId: requester.id,
      }),
    },
    user: { findMany: vi.fn().mockResolvedValue([manager, requester]) },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  return { tx, db, service: new ExamManagementService(db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  principal.role = 'PM';
});
test('three templates preserve v1 configuration and question layout, TXT escapes newlines and XML uses document tables', () => {
  const excel = examImportTemplate('EXCEL');
  const book = XLSX.read(excel.content, { type: 'buffer' });
  expect(book.SheetNames).toEqual(['考试配置', '题目']);
  expect(XLSX.utils.sheet_to_json(book.Sheets['考试配置']!, { header: 1 })).toEqual(examConfigRows);
  expect(XLSX.utils.sheet_to_json(book.Sheets['题目']!, { header: 1 })).toEqual(examQuestionRows);
  const txt = examImportTemplate('TXT');
  expect(txt.content.toString()).toContain('请选择正确选项。\\nA. 选项一\\nB. 选项二\tA');
  expect(
    txt.content
      .toString()
      .split('\n')
      .find((line) => line.startsWith('试卷名称'))
      ?.split('\t'),
  ).toHaveLength(8);
  const xml = examImportTemplate('REDOC');
  expect(xml.content.toString().match(/<table /g)).toHaveLength(2);
  expect(xml.content.toString()).toContain('请选择正确选项。<br />A. 选项一<br />B. 选项二');
  expect(xml.filename).toBe('entrance-exam-import-v1.xml');
});
test('template download requires the current PM session role', async () => {
  const { service } = setup();
  principal.role = 'EXPERT';
  await expect(service.template('TXT', principal)).rejects.toMatchObject({ status: 403 });
  principal.role = 'PM';
  expect((await service.template('TXT', principal)).filename).toBe('entrance-exam-import-v1.txt');
});
test('reviewers have bounded scope and stable order, no phone fields, literal case-insensitive keyword and fallback names', async () => {
  const { service, tx } = setup();
  expect(await service.reviewers(3001, undefined, principal)).toEqual([
    { userId: requester.id, uid: requester.uid, name: '小明(王小明)', avatarUrl: null },
    { userId: manager.id, uid: manager.uid, name: '策略官', avatarUrl: null },
  ]);
  expect(tx.user.findMany.mock.calls[0]![0].where).toEqual({
    id: { in: [requester.id, principal.userId] },
    status: 'ACTIVE',
  });
  expect(await service.reviewers(3001, ' NAV-UID ', principal)).toHaveLength(1);
  expect(await service.reviewers(3001, '%', principal)).toEqual([]);
  tx.user.findMany.mockResolvedValueOnce([{ ...manager, displayName: '', realName: '' }]);
  expect(await service.reviewers(3001, '  ', principal)).toEqual([
    { userId: manager.id, uid: manager.uid, name: manager.uid, avatarUrl: null },
  ]);
});
test('requester and manager duplicates collapse and inactive candidates are absent', async () => {
  const { service, tx } = setup();
  tx.project.findFirst.mockResolvedValueOnce({
    id: 3001,
    status: 'PUBLISHED',
    requesterId: principal.userId,
  });
  tx.user.findMany.mockResolvedValueOnce([manager]);
  expect(await service.reviewers(3001, undefined, principal)).toHaveLength(1);
  tx.user.findMany.mockResolvedValueOnce([]);
  expect(await service.reviewers(3001, undefined, principal)).toEqual([]);
});
test('missing grants, missing/unpublished projects, replacement and handler-only access fail before user reads', async () => {
  const { service, tx } = setup();
  principal.role = 'EXPERT';
  await expect(service.reviewers(3001, undefined, principal)).rejects.toMatchObject({
    status: 403,
  });
  principal.role = 'PM';
  tx.project.findFirst.mockResolvedValueOnce(null);
  await expect(service.reviewers(3001, undefined, principal)).rejects.toMatchObject({
    status: 404,
  });
  tx.project.findFirst.mockResolvedValueOnce({
    id: 3001,
    status: 'DRAFT',
    requesterId: requester.id,
  });
  await expect(service.reviewers(3001, undefined, principal)).rejects.toMatchObject({
    status: 400,
  });
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce(null);
  await expect(service.reviewers(3001, undefined, principal)).rejects.toMatchObject({
    status: 403,
  });
  tx.projectManagerRecruitment.findFirst.mockResolvedValueOnce({
    candidateUserId: requester.id,
    expertRecruitmentHandlerUserId: principal.userId,
  });
  await expect(service.reviewers(3001, undefined, principal)).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.user.findMany).not.toHaveBeenCalled();
});
test('HTTP exports raw files, serializes candidates and errors, rejects invalid input and untrusted/mixed transport', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const app = await createApp(config, db);
  const headers = { authorization: 'Bearer token' };
  try {
    for (const [type, extension, mime] of [
      ['TXT', 'txt', 'text/plain'],
      ['REDOC', 'xml', 'application/xml'],
      ['EXCEL', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ]) {
      const res = await app.inject({
        url: `/api/v1/entrance-exams/import/template?type=${type}`,
        headers,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toContain(mime);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="entrance-exam-import-v1.${extension}"`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      if (type === 'EXCEL') expect(XLSX.read(res.rawPayload).SheetNames).toHaveLength(2);
      else expect(res.body).not.toContain('"code":200');
    }
    const res = await app.inject({
      url: '/api/v1/entrance-exams/reviewers?projectId=3001',
      headers,
    });
    expect(res.json()).toMatchObject({
      code: 200,
      message: '操作成功',
      data: [{ userId: requester.id, avatarUrl: null }, { userId: principal.userId }],
    });
    for (const query of ['', '?type=CSV', '?type=txt', '?type=TXT&extra=1']) {
      const res = await app.inject({
        url: `/api/v1/entrance-exams/import/template${query}`,
        headers,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 400, message: '请求字段或格式不正确', data: null });
    }
    for (const id of ['0', '-1', '2147483648', '1.5', 'abc'])
      expect(
        (await app.inject({ url: `/api/v1/entrance-exams/reviewers?projectId=${id}`, headers }))
          .statusCode,
      ).toBe(400);
    for (const unsafe of [
      { origin: 'https://evil.test', cookie: 'tyde_session=token' },
      { ...headers, cookie: 'tyde_session=token' },
    ])
      expect(
        (
          await app.inject({
            url: '/api/v1/entrance-exams/import/template?type=TXT',
            headers: unsafe,
          })
        ).statusCode,
      ).toBe(403);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(
      Object.keys(
        spec.paths['/api/v1/entrance-exams/import/template'].get.responses['200'].content,
      ),
    ).toEqual([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'application/xml',
    ]);
    expect(spec.paths['/api/v1/entrance-exams/reviewers'].get.operationId).toBe(
      'getEntranceExamReviewerCandidates',
    );
    for (const schema of [templateQuery, reviewersQuery, reviewerItem, reviewersResult]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'GET',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    vi.spyOn(ExamManagementService.prototype, 'reviewers').mockRejectedValueOnce(
      new (await import('../../src/common/errors.js')).AppError(403, 'FORBIDDEN', '没有权限'),
    );
    expect(
      (
        await app.inject({ url: '/api/v1/entrance-exams/reviewers?projectId=3001', headers })
      ).json(),
    ).toEqual({ code: 403, message: '没有权限', data: null });
  } finally {
    await app.close();
  }
});
