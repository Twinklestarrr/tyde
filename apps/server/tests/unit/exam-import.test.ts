import type { PrismaClient } from '@prisma/client';
import { crc32 } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { type AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { prepareExamConfig } from '../../src/modules/entrance-exams/exam-config.js';
import {
  examConfigExample,
  examConfigRouteSchema,
} from '../../src/modules/entrance-exams/exam-config.schema.js';
import { examArchive } from '../../src/modules/entrance-exams/exam-import-archive.js';
import { examImportTemplate } from '../../src/modules/entrance-exams/exam-import-template.js';
import {
  parseExamExcel,
  parseExamText,
} from '../../src/modules/entrance-exams/exam-import.parser.js';
import { examImportSchema } from '../../src/modules/entrance-exams/exam-import.schema.js';
import { ExamImportService } from '../../src/modules/entrance-exams/exam-import.service.js';
import { FileService } from '../../src/modules/files/file.service.js';
const principal: AuthPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  uid: 'manager-uid',
  sessionId: 'session',
  role: 'PM',
  clientType: 'desktop',
};
afterEach(() => {
  vi.restoreAllMocks();
  principal.role = 'PM';
});
const template = () => examImportTemplate('TXT').content;
const input = (text: string) => parseExamText(Buffer.from(text));
function zip(files: Map<string, Buffer>) {
  const contents: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const filename = Buffer.from(name),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    contents.push(local, filename, content);
    directory.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, ...directory, end]);
}
function setup() {
  const tx = {
    managementGrant: { findFirst: vi.fn().mockResolvedValue({ userId: principal.userId }) },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 3001, status: 'PUBLISHED' }) },
    projectManagerRecruitment: {
      findFirst: vi.fn().mockResolvedValue({ candidateUserId: principal.userId }),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn) => fn(tx)),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
  const files = {
    registry: { config: { maxSize: 50 * 1024 * 1024 }, inspectEntranceExamUpload: vi.fn() },
    upload: vi.fn(),
  } as unknown as FileService;
  return { db, tx, files, service: new ExamImportService(db, files) };
}
test('TXT and XLSX templates parse identical escaped text, explicit empty cells and nullable unfinished config', () => {
  const text = parseExamText(template());
  expect(parseExamExcel(examImportTemplate('EXCEL').content)).toEqual(text);
  expect(text.config).toMatchObject({
    examName: '示例准入考试',
    durationMinutes: 60,
    registrationDeadline: null,
    fullScore: 20,
    passScore: 12,
    gradingRounds: [],
  });
  expect(text.config.papers[0]!.questions[1]!.questionContent).toContain('<br/>A.');
});
test('plain legacy XLS workbook imports through the same configuration and question rules', () => {
  const book = XLSX.read(examImportTemplate('EXCEL').content);
  const xls = XLSX.write(book, { type: 'buffer', bookType: 'biff8' });
  expect(parseExamExcel(xls).config.papers).toEqual(parseExamText(template()).config.papers);
});
test('simplified table aliases, narrative grouping, score/required markers and Shanghai date conversion preserve question order', () => {
  expect(input('题目\t答案\t分数\n<标签>\tA\t5').config.papers[0]!.questions[0]).toMatchObject({
    questionContent: '&lt;标签&gt;',
    score: 5,
    requiredFlag: true,
  });
  const result = input(
    '考试名称：分组考试\n答题时限：1.5小时\n截止日期：2099/02/28\n及格线：5分\n试卷：A\n1. 题干一（10分，选答）\n答案：第一行\n  1. 答案步骤\n试卷：B\n第1题：题干二（10分） 参考答案：B',
  );
  expect(result.config).toMatchObject({
    durationMinutes: 90,
    registrationDeadline: '2099-02-28 23:59:59',
    passScore: 5,
    fullScore: 10,
  });
  expect(result.config.papers.map((p) => p.paperName)).toEqual(['A', 'B']);
  expect(result.config.papers[0]!.questions[0]).toMatchObject({
    requiredFlag: false,
    referenceAnswer: '第一行<br/>1. 答案步骤',
  });
});
test('parser rejects malformed UTF8, duplicate sections/headers/questions, missing answers and invalid dates/scores', () => {
  expect(() => parseExamText(Buffer.from([0xff]))).toThrow('UTF-8');
  for (const text of [
    '[考试配置]\n配置项\t值\n[考试配置]',
    '题干\t答案\t答案\na\tb\tc',
    '题号\t题干\t答案\n1\ta\tb\n1\tc\td',
    '1. 无答案',
    '截止日期：2099-02-30\n1. A\n答案：B',
    '题干\t答案\t分值\na\tb\t0.001',
  ])
    expect(() => input(text)).toThrow();
});
test('all-manual identical paper totals override source full score while mixed/auto scores keep configured full score', () => {
  const source = template().toString().replace('试卷满分\t20', '试卷满分\t100');
  expect(input(source).config.fullScore).toBe(20);
  expect(input(source.replace('\t10\t是', '\t\t是')).config.fullScore).toBe(100);
});
test('Excel rejects formulas, merged cells, compressed-entry size lies and CRC corruption', () => {
  const book = XLSX.read(examImportTemplate('EXCEL').content);
  book.Sheets['题目']!.C2!.f = '1+1';
  expect(() => parseExamExcel(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))).toThrow(
    '公式',
  );
  delete book.Sheets['题目']!.C2!.f;
  book.Sheets['题目']!['!merges'] = [{ s: { r: 1, c: 2 }, e: { r: 1, c: 3 } }];
  expect(() => parseExamExcel(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))).toThrow(
    '合并',
  );
  const archive = zip(new Map([['file', Buffer.from('content')]]));
  const corrupt = Buffer.from(archive);
  corrupt[34] = corrupt[34]! ^ 1;
  expect(() => examArchive(corrupt)).toThrow();
  const oversized = Buffer.from(archive),
    central = oversized.indexOf(Buffer.from('504b0102', 'hex'));
  oversized.writeUInt32LE(33 * 1024 * 1024, central + 24);
  expect(() => examArchive(oversized)).toThrow('解压限制');
});
function imageWorkbook(col = 2) {
  const files = examArchive(examImportTemplate('EXCEL').content);
  const sheet = files
    .get('xl/worksheets/sheet2.xml')!
    .toString()
    .replace('</worksheet>', '<drawing r:id="imageDrawing"/></worksheet>');
  files.set('xl/worksheets/sheet2.xml', Buffer.from(sheet));
  files.set(
    'xl/worksheets/_rels/sheet2.xml.rels',
    Buffer.from(
      '<Relationships><Relationship Id="imageDrawing" Target="../drawings/drawing1.xml"/></Relationships>',
    ),
  );
  files.set(
    'xl/drawings/drawing1.xml',
    Buffer.from(
      `<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:pic><a:blip r:embed="image1"/></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>`,
    ),
  );
  files.set(
    'xl/drawings/_rels/drawing1.xml.rels',
    Buffer.from(
      '<Relationships><Relationship Id="image1" Target="../media/image1.png"/></Relationships>',
    ),
  );
  files.set('xl/media/image1.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  return zip(files);
}
test('XLSX pictures bind to the anchored question only and invalid columns are explicitly rejected', () => {
  const parsed = parseExamExcel(imageWorkbook());
  expect(parsed.bindings).toHaveLength(1);
  expect(parsed.bindings[0]!.target).toBe(parsed.config.papers[0]!.questions[0]!.questionFiles);
  expect(parsed.bindings[0]!.asset.bytes?.toString('hex')).toBe('89504e470d0a1a0a');
  expect(() => parseExamExcel(imageWorkbook(0))).toThrow('锚定');
});
test('import authorization precedes parsing or upload and remote sources fail explicitly without network access', async () => {
  const { service, files } = setup();
  principal.role = 'EXPERT';
  await expect(
    service.parse(
      { projectId: '3001' },
      { fileName: 'x.xlsx', bytes: Buffer.from('invalid') },
      principal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  principal.role = 'PM';
  await expect(
    service.parse(
      { projectId: '3001', redocUrl: 'https://documents.example/doc/1' },
      undefined,
      principal,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(files.upload).not.toHaveBeenCalled();
});
test('preuploaded attachment checks are readonly, duplicate keys fail and embedded images upload only after all prechecks', async () => {
  const { service, files } = setup();
  vi.mocked(files.registry.inspectEntranceExamUpload).mockResolvedValue({
    objectKey: 'entrance-exam-attachment/test.txt',
    fileName: 'test.txt',
    extension: 'txt',
    contentType: 'text/plain',
    fileSize: 10,
    fileHash: 'hash',
  } as never);
  const source = Buffer.from('题目\t答案\t题干附件\na\tb\t说明');
  const request = {
    projectId: '3001',
    attachmentRefs: [
      { name: '说明', objectKey: 'entrance-exam-attachment/test.txt', uploadToken: 'token' },
    ],
  };
  const result = await service.parse(request, { fileName: 'x.txt', bytes: source }, principal);
  expect(result.config.papers[0]!.questions[0]!.questionFiles).toMatchObject([
    { uploadToken: 'token', size: 10, sensitive: true },
  ]);
  expect(files.upload).not.toHaveBeenCalled();
  await expect(
    service.parse(
      request,
      { fileName: 'x.txt', bytes: Buffer.from('题目\t答案\t题干附件\na\tb\t说明|说明') },
      principal,
    ),
  ).rejects.toThrow('重复引用');
  vi.mocked(files.upload).mockResolvedValue({
    objectKey: 'entrance-exam-attachment/p.png',
    uploadToken: 'image-token',
    url: null,
    sensitive: true,
    size: 8,
  } as never);
  const image = await service.parse(
    { projectId: '3001' },
    { fileName: 'image.xlsx', bytes: imageWorkbook() },
    principal,
  );
  expect(files.upload).toHaveBeenCalledTimes(1);
  expect(image.config.papers[0]!.questions[0]!.questionFiles?.[0]?.url).toContain(
    '/api/v1/files/view?',
  );
});
test('config validation preserves AUTO cent remainder, rejects manual mismatches/weak rules/secrets and permits valid mixed grading', () => {
  const base = structuredClone(examConfigExample) as never;
  const valid = prepareExamConfig(base);
  expect(valid.papers[0]!.questions[0]!.score.toString()).toBe('20');
  const auto = {
    ...structuredClone(examConfigExample),
    fullScore: 1,
    passScore: 1,
    papers: [{ questions: Array.from({ length: 3 }, () => ({ questionContent: '题干' })) }],
  };
  expect(
    prepareExamConfig(auto as never).papers[0]!.questions.map((q) => q.score.toString()),
  ).toEqual(['0.33', '0.33', '0.34']);
  const mixed = structuredClone(auto);
  mixed.papers[0]!.questions[0] = {
    questionContent: '手动分值',
    score: 0.33,
    scoreSource: 'MANUAL',
  } as never;
  expect(
    prepareExamConfig(mixed as never).papers[0]!.questions.map((q) => q.score.toString()),
  ).toEqual(['0.33', '0.33', '0.34']);
  mixed.papers[0]!.questions[0] = {
    questionContent: '不匹配分值',
    score: 0.5,
    scoreSource: 'MANUAL',
  } as never;
  expect(() => prepareExamConfig(mixed as never)).toThrow('合计');
  for (const patch of [
    { passScore: 30 },
    { registrationDeadline: '2020-01-01 00:00:00' },
    { gradingRounds: [] },
    {
      gradingRounds: [
        {
          gradingMode: 'AUTO',
          toolCode: 'agent',
          toolName: '工具',
          toolConfig: { nested: [{ Access_Token: 'secret' }] },
        },
      ],
    },
    { gradingRounds: [...examConfigExample.gradingRounds, ...examConfigExample.gradingRounds] },
  ])
    expect(() =>
      prepareExamConfig({ ...structuredClone(examConfigExample), ...patch } as never),
    ).toThrow();
});
function form(parts: { name: string; content: string | Buffer; filename?: string }[]) {
  const boundary = 'exam-import-boundary';
  return {
    payload: Buffer.concat([
      ...parts.flatMap((p) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n\r\n`,
        ),
        Buffer.from(p.content),
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
    headers: {
      authorization: 'Bearer token',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}
test('HTTP multipart file-first/query/JSON references, malformed forms, origin rules, Swagger examples and three added paths', async () => {
  const { db } = setup();
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(principal);
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    }),
    db,
  );
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/entrance-exams/import/parse?projectId=3001',
      ...form([
        { name: 'file', filename: 'exam.txt', content: template() },
        { name: 'attachmentRefs', content: '[]' },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.config.papers[0].questions).toHaveLength(2);
    for (const parts of [
      [
        { name: 'file', filename: 'exam.txt', content: template() },
        { name: 'projectId', content: '3002' },
      ],
      [{ name: 'attachmentRefs', content: '{broken' }],
      [
        { name: 'projectId', content: '3001' },
        { name: 'projectId', content: '3001' },
      ],
      [{ name: 'extra', content: 'x' }],
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/entrance-exams/import/parse?projectId=3001',
            ...form(parts),
          })
        ).statusCode,
      ).toBe(400);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/entrance-exams/publish'].post.operationId).toBe(
      'publishEntranceExam',
    );
    expect(spec.paths['/api/v1/entrance-exams/edit'].put.operationId).toBe('editEntranceExam');
    const descriptions = (schema: Record<string, unknown>) => {
      for (const value of Object.values(
        (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        expect(value.description).toMatch(/[\u3400-\u9fff]/u);
        descriptions(value);
      }
      if (schema.items) {
        expect((schema.items as Record<string, unknown>).description).toMatch(/[\u3400-\u9fff]/u);
        descriptions(schema.items as Record<string, unknown>);
      }
      for (const choice of (schema.anyOf ?? []) as Record<string, unknown>[]) descriptions(choice);
    };
    for (const route of [
      examImportSchema,
      examConfigRouteSchema(false),
      examConfigRouteSchema(true),
    ]) {
      if (route.body) descriptions(route.body as Record<string, unknown>);
      if (route.querystring) descriptions(route.querystring as Record<string, unknown>);
      for (const response of Object.values(route.response!))
        descriptions(response as Record<string, unknown>);
    }
    for (const schema of [
      examImportSchema.body,
      examConfigRouteSchema(false).body,
      examConfigRouteSchema(true).body,
    ] as { examples: unknown[] }[]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/entrance-exams/publish',
          headers: { origin: 'https://evil.test', cookie: 'tyde_session=token' },
          payload: examConfigExample,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
