import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_IMPORT_MAX_ROWS,
  emptyRow,
  isPhoneDraft,
  normalizeMemberCell,
  parseClipboard,
  serializeRows,
  validateMemberPhones,
  validateMemberRows,
} from '../apps/web/src/modules/organizations/member-import-table.ts';
import {
  parseImport,
  resolveImport,
} from '../apps/server/src/modules/organizations/member-import.parser.ts';

test('phone entry limits and submitted row errors match the backend, including gaps and duplicates', () => {
  for (const value of ['', '1', '13800009001']) assert.equal(isPhoneDraft(value), true);
  for (const value of ['138000090011', '138abc', '+8613800009001', '１３８００００９００１'])
    assert.equal(isPhoneDraft(value), false);
  const rows = [
    emptyRow(),
    ['空值', '', '全职', '', ''],
    ['短号', '138', '全职', '', ''],
    ['前缀', '82777777777', '全职', '', ''],
    ['重复甲', '13800009001', '全职', '', ''],
    emptyRow(),
    ['重复乙', '13800009001', '兼职', '', ''],
    ['合法', '13900009002', '全职', '', ''],
  ];
  const errors = validateMemberPhones(rows);
  const codes = (errors) => errors.map(({ rowNo, errorCode }) => [rowNo, errorCode]);
  assert.deepEqual(codes(errors), [
    [1, 'REQUIRED_MISSING'],
    [2, 'FORMAT_INVALID'],
    [3, 'FORMAT_INVALID'],
    [4, 'DUPLICATE_IN_BATCH'],
    [5, 'DUPLICATE_IN_BATCH'],
  ]);
  const backend = parseImport(resolveImport(undefined, serializeRows(rows)));
  assert.deepEqual(codes(errors), codes(backend.errors.filter((error) => error.field === 'phone')));
  assert.deepEqual(validateMemberPhones([emptyRow(), rows.at(-1)]), []);
});

test('cell normalization preserves empty drafts and translates only backend-supported English enums', () => {
  for (let column = 0; column < 5; column++) assert.equal(normalizeMemberCell(column, '  '), '');
  assert.equal(normalizeMemberCell(0, '  Jane Doe  '), 'Jane Doe');
  for (const [input, expected] of [
    ['Full-time', '全职'],
    ['Part-time', '兼职'],
    ['全职', '全职'],
  ])
    assert.equal(normalizeMemberCell(2, ` ${input} `), expected);
  for (const [input, expected] of [
    ['Member', '成员'],
    ['Administrator', '管理员'],
    ['管理员', '管理员'],
  ])
    assert.equal(normalizeMemberCell(3, ` ${input} `), expected);
  for (const input of ['1', '138', '82777777777'])
    assert.equal(normalizeMemberCell(1, ` ${input} `), input);
  assert.throws(() => normalizeMemberCell(1, '123456789012'), /手机号.*11/);
  assert.throws(() => normalizeMemberCell(1, '138abc'), /手机号/);
  for (const input of ['full-time', 'FULL_TIME', '其他'])
    assert.throws(() => normalizeMemberCell(2, input), /人员属性/);
  for (const input of ['member', 'OWNER', '主管'])
    assert.throws(() => normalizeMemberCell(3, input), /组织角色/);
});

test('name normalization counts Unicode code points and uses the same character set as backend', () => {
  for (const value of ['张三', 'Élodie O’Neil·A.B-C', "O'Neil", '𠮷'.repeat(64)])
    assert.equal(normalizeMemberCell(0, value), value);
  assert.throws(() => normalizeMemberCell(0, '𠮷'.repeat(65)), /64/);
  for (const value of ['1张三', '-Jane', '张三🙂', '张\t三', '张\n三', 'e\u0301'])
    assert.throws(() => normalizeMemberCell(0, value), /姓名/);
});

test('dates accept real leap days and future years without accepting automatic calendar rollover', () => {
  for (const value of ['0000-02-29', '2000-02-29', '2024-02-29', '9999-12-31'])
    assert.equal(normalizeMemberCell(4, ` ${value} `), value);
  for (const value of [
    '1900-02-29',
    '2025-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-01-00',
    '2026-13-01',
    '2026-2-03',
    '10000-01-01',
  ])
    assert.throws(() => normalizeMemberCell(4, value), /入组日期/);
});

test('all submitted member field errors match backend rules after excluding blank rows', () => {
  const rows = [
    emptyRow(),
    ['', '13800009001', '全职', '', ''],
    ['𠮷'.repeat(64), '13800009002', 'Full-time', 'Administrator', '2024-02-29'],
    ['𠮷'.repeat(65), '13800009003', 'Part-time', 'Member', '2000-02-29'],
    ['Jane Doe', '13800009004', '', '', '1900-02-29'],
    ['李四', '13800009005', 'FULL_TIME', '主管', '2025-02-29'],
    emptyRow(),
    ['前缀', '82777777777', '兼职', '成员', '2026-04-31'],
    ['日期', '13900009006', '全职', '', '9999-12-31'],
    ['重复', '13900009006', '兼职', 'Member', '0000-02-29'],
    ['1姓名', '', '全职', 'member', '2026-2-03'],
  ];
  const errors = validateMemberRows(rows);
  const codes = (list) => list.map(({ rowNo, field, errorCode }) => [rowNo, field, errorCode]);
  const backend = parseImport(resolveImport(undefined, serializeRows(rows)));
  assert.deepEqual(codes(errors), codes(backend.errors));
  assert.equal(errors[0].message, '姓名不能为空');
  assert.deepEqual(validateMemberRows([emptyRow(), rows[2]]), []);
  assert.deepEqual(
    codes(validateMemberPhones(rows)),
    codes(errors.filter((error) => error.field === 'phone')),
  );
});

test('Excel and WPS TSV preserves empty cells, CRLF rows and nonempty column widths', () => {
  const rows = parseClipboard(
    '\uFEFF姓名\t手机号\t人员属性\t组织内角色\t入组时间\r\n张三\t13812345678\t全职\t\t2026-10-23\r\n\t13912345678\t兼职\t成员\t\r\n\t\t\t\t\r\n',
  );
  assert.deepEqual(rows, [
    ['张三', '13812345678', '全职', '', '2026-10-23'],
    ['', '13912345678', '兼职', '成员', ''],
  ]);
  assert.equal(serializeRows(rows), '张三,13812345678,全职,,2026-10-23\n,13912345678,兼职,成员');
  assert.deepEqual(
    parseClipboard('姓名\t手机号\t人员属性\t组织角色\t入组日期\r张三\t13812345678'),
    [['张三', '13812345678']],
  );
});

test('simple English and Chinese CSV skips recognized headers and keeps empty fields', () => {
  assert.deepEqual(
    parseClipboard(
      ' Name , Phone number , Employment type , Organization role , Join date \nJane Doe,13812345678,Full-time,,2026-10-23',
    ),
    [['Jane Doe', '13812345678', 'Full-time', '', '2026-10-23']],
  );
  assert.deepEqual(parseClipboard('李四，13912345678，兼职，，'), [
    ['李四', '13912345678', '兼职', '', ''],
  ]);
  assert.deepEqual(parseClipboard('张三'), [['张三']]);
  assert.deepEqual(parseClipboard('  \r\n\t\t\n'), []);
});

test('quoted clipboard cells reject ambiguous fields and embedded newlines', () => {
  for (const text of ['"张,三",13812345678,全职', '"张\n三"\t13812345678\t全职', '"张三'])
    assert.throws(() => parseClipboard(text), /引号/);
});

test('overwide rows and over-500 member batches are rejected without truncation', () => {
  assert.equal(MEMBER_IMPORT_MAX_ROWS, 500);
  for (const text of [
    '张三\t13812345678\t全职\t成员\t2026-10-23\t',
    '张三,13812345678,全职,,,多余列',
  ])
    assert.throws(() => parseClipboard(text), /超过 5 列/);
  const accepted = Array.from({ length: 500 }, () => '张三\t13812345678\t全职').join('\n');
  assert.equal(parseClipboard(accepted).length, 500);
  assert.throws(() => parseClipboard(`${accepted}\n李四\t13912345678\t兼职`), /最多导入 500/);
  assert.throws(() => serializeRows(Array.from({ length: 501 }, () => ['姓名'])), /最多导入 500/);
  assert.throws(() => serializeRows([['张三', '', '', '', '', '']]), /超过 5 列/);
});

test('serialization omits empty rows and trailing empty cells and leaves business validation to server', () => {
  const first = emptyRow();
  first[0] = '第一行';
  assert.deepEqual(emptyRow(), ['', '', '', '', '']);
  assert.equal(
    serializeRows([
      emptyRow(),
      ['  张三  ', 'bad-phone', '未知属性'],
      [''],
      ['李四', '', '', '', 'invalid-date'],
    ]),
    '张三,bad-phone,未知属性\n李四,,,,invalid-date',
  );
  assert.equal(serializeRows([emptyRow()]), '');
});

test('serialization escapes delimiter characters without changing the backend column mapping', () => {
  for (const cell of ['张,三', '张，三', '张\n三', '张\r三', '张\t三', '张"三']) {
    const source = [cell, '13812345678', '全职', '', '2026-10-23'];
    const parsed = parseImport(resolveImport(undefined, serializeRows([source])));
    assert.deepEqual(parsed.rows[0].columns, source);
    assert.equal(parsed.rows[0].phone, '13812345678');
    assert.ok(parsed.errors.some((error) => error.field === 'realName'));
  }
  assert.equal(serializeRows([['张"三', '13812345678', '全职']]), '"张""三",13812345678,全职');
  assert.equal(
    serializeRows([['张三', '13812345678', '全职', '成员', '']]),
    '张三,13812345678,全职,成员',
  );
});

test('serialization rejects backend comment/header sentinels instead of silently omitting data', () => {
  for (const name of ['#说明', '*姓名：说明', '*Name: hint'])
    assert.throws(() => serializeRows([[name, '13812345678', '全职']]), /表头或说明标记/);
  assert.throws(
    () => serializeRows([['姓名', '手机号', '人员属性', '组织内角色', '入组时间']]),
    /表头或说明标记/,
  );
});
