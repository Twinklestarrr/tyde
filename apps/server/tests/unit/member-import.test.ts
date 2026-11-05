import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/application.js';
import { readConfig } from '../../src/config/index.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import {
  importBody,
  importErrorExample,
  importExample,
  importQuery,
  importResponse,
} from '../../src/modules/organizations/import.schema.js';
import {
  englishHeaders,
  headers,
  parseImport,
  resolveImport,
  template,
} from '../../src/modules/organizations/member-import.parser.js';
import { MemberImportService } from '../../src/modules/organizations/member-import.service.js';
const orgId = '00000000-0000-4000-8000-000000000002';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
afterEach(() => vi.restoreAllMocks());
const textInput = (content: string) => resolveImport(undefined, content);
test.each([false, true])(
  'template round-trip has hints, fixed second-row headers and no members (English=%s)',
  (english) => {
    const bytes = template(english),
      workbook = XLSX.read(bytes, { type: 'buffer' }),
      sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })[1]).toEqual(
      english ? englishHeaders : headers,
    );
    const parsed = parseImport(
      resolveImport({ fileName: 'template.xlsx', contentType: 'application/octet-stream', bytes }),
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toMatchObject([{ errorCode: 'REQUIRED_MISSING' }]);
  },
);
test.each(['xlsx', 'xls'] as const)(
  'Excel %s parses numeric phones, first sheet and formatted dates',
  (bookType) => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      headers,
      ['张三', 13812345678, '全职', '管理员', new Date(Date.UTC(2026, 9, 1))],
    ]);
    sheet.E2!.z = 'yyyy-mm-dd';
    XLSX.utils.book_append_sheet(workbook, sheet, 'first');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ignored']]), 'second');
    const parsed = parseImport(
      resolveImport({
        fileName: `test.${bookType}`,
        contentType: 'application/octet-stream',
        bytes: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType })),
      }),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      phone: '13812345678',
      employmentType: 'FULL_TIME',
      position: 'ADMIN',
      joinedDate: '2026-10-01',
    });
  },
);
test.each(['formula', 'error'])('Excel %s cell is rejected without evaluating content', (kind) => {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ['张三', '13812345678', '全职']]);
  sheet.A2 = kind === 'formula' ? { t: 's', v: '张三', f: '"张三"' } : { t: 'e', v: 7 };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'members');
  const result = parseImport(
    resolveImport({
      fileName: 'test.xlsx',
      contentType: '',
      bytes: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })),
    }),
  );
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ rowNo: 0, errorCode: 'FORMAT_INVALID' })]),
  );
});
test('CSV and text support BOM, hints, English labels, quotes and Chinese delimiter only for text', () => {
  const csv =
    '\uFEFF#说明\r\n' +
    englishHeaders.join(',') +
    '\r\n"O\'Neil",13812345678,Full-time,Administrator,2026-10-01';
  const parsed = parseImport(
    resolveImport({
      fileName: 'a.csv',
      contentType: 'application/vnd.ms-excel',
      bytes: Buffer.from(csv),
    }),
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows[0]).toMatchObject({ realName: "O'Neil", position: 'ADMIN' });
  expect(parseImport(textInput('张三，13812345678，兼职')).errors).toEqual([]);
  expect(
    parseImport(
      resolveImport({
        fileName: 'a.csv',
        contentType: 'text/csv',
        bytes: Buffer.from('张三，13812345678，全职'),
      }),
    ).errors.length,
  ).toBeGreaterThan(0);
  expect(parseImport(textInput('"张\n三",13812345678,全职')).rows[0]!.realName).toBe('张\n三');
  expect(parseImport(textInput('"张""三",13812345678,全职')).rows[0]!.realName).toBe('张"三');
});
test('nonempty file takes precedence, empty file falls back, invalid UTF-8 and fake Excel never downgrade to text', () => {
  const chosen = resolveImport(
    { fileName: 'x.csv', contentType: 'text/csv', bytes: Buffer.from('张三,13812345678,全职') },
    'ignored',
  );
  expect(chosen).toMatchObject({ sourceType: 'CSV', textIgnored: true });
  expect(
    resolveImport(
      { fileName: 'x.csv', contentType: 'text/csv', bytes: Buffer.alloc(0) },
      '张三,13812345678,全职',
    ).sourceType,
  ).toBe('TEXT');
  expect(() =>
    parseImport(
      resolveImport(
        { fileName: 'x.csv', contentType: 'text/csv', bytes: Buffer.from([0xff]) },
        'valid',
      ),
    ),
  ).toThrow('UTF-8');
  expect(() =>
    parseImport(
      resolveImport(
        { fileName: 'x.xlsx', contentType: '', bytes: Buffer.from('张三,13812345678,全职') },
        'valid',
      ),
    ),
  ).toThrow('Excel');
  expect(() =>
    resolveImport(
      { fileName: 'x.pdf', contentType: 'application/pdf', bytes: Buffer.from('bad') },
      'valid',
    ),
  ).toThrow();
});
test('all field errors and duplicate rows are accumulated with masked phones and logical row numbers', () => {
  const result = parseImport(
    textInput(
      '#hint\n' +
        headers.join(',') +
        '\n张三,13812345678,全职\n李四,13812345678,兼职,主管,2026-02-30\n,invalid,UNKNOWN,,,extra',
    ),
  );
  expect(result.rows.map((r) => r.rowNo)).toEqual([1, 2, 3]);
  expect(result.errors.filter((e) => e.errorCode === 'DUPLICATE_IN_BATCH')).toHaveLength(2);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rowNo: 2, field: 'position' }),
      expect.objectContaining({ rowNo: 2, field: 'joinedAt' }),
      expect.objectContaining({ rowNo: 3, field: 'realName' }),
      expect.objectContaining({ rowNo: 3, field: 'employmentType' }),
      expect.objectContaining({ rowNo: 3, field: 'row' }),
    ]),
  );
  expect(JSON.stringify(result.errors)).not.toContain('13812345678');
});
test('unclosed quotes and over-500 batches produce global errors', () => {
  expect(
    parseImport(textInput('"张三,13812345678,全职')).errors.some(
      (e) => e.rowNo === 0 && e.errorCode === 'FORMAT_INVALID',
    ),
  ).toBe(true);
  expect(
    parseImport(textInput(Array.from({ length: 501 }, () => '张三,13812345678,全职').join('\n')))
      .errors,
  ).toMatchObject([{ rowNo: 0, errorCode: 'LIMIT_EXCEEDED' }]);
});
function multipart(parts: { name: string; content: string | Buffer; filename?: string }[]) {
  const boundary = 'member-import-unit',
    chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${part.filename ? 'Content-Type: text/csv\r\n' : ''}\r\n`,
      ),
      Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: 'Bearer token',
      'idempotency-key': 'unit-import',
    },
  };
}
test('multipart HTTP accepts file before fields and query orgId, retains full row-error data, validates examples and serves binary template', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({
    userId: 'actor',
    uid: 'uid',
    role: 'EXPERT',
    sessionId: 'session',
    clientType: 'desktop',
  });
  const generate = vi
    .spyOn(MemberImportService.prototype, 'generate')
    .mockResolvedValue(importErrorExample as never);
  const app = await createApp(config, new PrismaClient());
  try {
    const uploaded = multipart([
      { name: 'csvFile', filename: 'test.csv', content: '张三,13812345678,全职' },
      { name: 'memberText', content: 'ignored' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/member-imports/generate?orgId=${orgId}`,
      ...uploaded,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      code: 400,
      message: '成员信息校验失败',
      data: importErrorExample,
    });
    expect(generate.mock.calls[0]![3]).toMatchObject({ fileName: 'test.csv' });
    generate.mockResolvedValue(importExample as never);
    const text = multipart([
      { name: 'orgId', content: orgId },
      { name: 'memberText', content: '张三,13812345678,全职' },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/member-imports/generate',
          ...text,
        })
      ).json().data,
    ).toEqual(importExample);
    const duplicate = multipart([
      { name: 'orgId', content: orgId },
      { name: 'orgId', content: orgId },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/member-imports/generate',
          ...duplicate,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations/member-imports/generate',
          headers: { authorization: 'Bearer token' },
          payload: { orgId, memberText: 'text' },
        })
      ).statusCode,
    ).toBe(400);
    const template = await app.inject({
      url: '/api/v1/organizations/member-imports/template',
      headers: { authorization: 'Bearer token', 'accept-language': 'en-US' },
    });
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-type']).toContain('spreadsheetml');
    expect(
      XLSX.utils.sheet_to_json(
        XLSX.read(template.rawPayload, { type: 'buffer' }).Sheets['Member import']!,
        { header: 1 },
      )[1],
    ).toEqual(englishHeaders);
    for (const schema of [importBody, importQuery, importResponse]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/examples',
        httpPart: 'body',
      });
      for (const example of (schema.examples as unknown[]) ?? [])
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(
      spec.paths['/api/v1/organizations/member-imports/template'].get.responses['200'].content[
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ].schema.format,
    ).toBe('binary');
    expect(
      spec.paths['/api/v1/organizations/member-imports/generate'].post.responses['400'].content[
        'application/json'
      ].schema.properties.data.anyOf,
    ).toBeDefined();
  } finally {
    await app.close();
  }
});

test('XLSX declared decompression size is checked before parsing workbook content', () => {
  const bytes = Buffer.from(template());
  const end = bytes.length - 22;
  const directory = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(101 * 1024 * 1024, directory + 24);
  expect(() =>
    parseImport(resolveImport({ fileName: 'oversize.xlsx', contentType: '', bytes })),
  ).toThrow('100MiB');
});
