import * as XLSX from 'xlsx';
import { AppError } from '../../common/errors.js';
import { businessDate } from './member.domain.js';
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const headers = ['姓名', '手机号', '人员属性', '组织内角色', '入组时间'];
export const englishHeaders = [
  'Name',
  'Phone number',
  'Employment type',
  'Organization role',
  'Join date',
];
const hints = [
  '*姓名：中文或英文',
  '*手机号：中国大陆11位手机号',
  '*人员属性：全职或兼职',
  '组织内角色：管理员或成员；留空默认成员',
  '入组时间：yyyy-MM-dd；留空默认当天',
];
const englishHints = [
  '*Name: Chinese or English letters',
  '*Phone number: 11-digit mainland China number',
  '*Employment type: Full-time or Part-time',
  'Organization role: Administrator or Member; blank defaults to Member',
  'Join date: yyyy-MM-dd; blank defaults to today',
];
export type SourceType = 'EXCEL' | 'CSV' | 'TEXT';
export interface ImportFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}
export interface ImportInput {
  sourceType: SourceType;
  textIgnored: boolean;
  content: string | Buffer;
}
export interface ImportRow {
  rowNo: number;
  columns: string[];
  realName: string;
  phone: string;
  employmentType: string | null;
  position: string | null;
  joinedDate: string | null;
}
export type RowErrorCode =
  | 'REQUIRED_MISSING'
  | 'ACCOUNT_REGISTERED'
  | 'FORMAT_INVALID'
  | 'ALREADY_JOINED_OTHER_ORGANIZATION'
  | 'DUPLICATE_IN_BATCH'
  | 'LIMIT_EXCEEDED';
export interface RowError {
  rowNo: number;
  field: string;
  value: string | null;
  errorCode: RowErrorCode;
  message: string;
}
export const rowError = (
  rowNo: number,
  field: string,
  value: string | null,
  errorCode: RowErrorCode,
  message: string,
): RowError => ({ rowNo, field, value, errorCode, message });
export const maskImportPhone = (phone: string) =>
  phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone ? '****' : null;
const bad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
export function template(english = false): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    english ? englishHints : hints,
    english ? englishHeaders : headers,
  ]);
  sheet['!cols'] = [{ wch: 26 }, { wch: 33 }, { wch: 29 }, { wch: 48 }, { wch: 44 }];
  sheet['!rows'] = [{ hpt: 36 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, english ? 'Member import' : '成员导入');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}
export function resolveImport(file?: ImportFile, memberText?: string): ImportInput {
  const textProvided = Boolean(memberText?.trim());
  if (file?.bytes.length) {
    if (file.bytes.length > IMPORT_MAX_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', '导入文件超过50MiB限制');
    const name = file.fileName.toLowerCase(),
      type = file.contentType.toLowerCase();
    let sourceType: SourceType;
    if (/\.xlsx?$/.test(name)) sourceType = 'EXCEL';
    else if (name.endsWith('.csv')) sourceType = 'CSV';
    else if (type.includes('spreadsheetml') || type === 'application/vnd.ms-excel')
      sourceType = 'EXCEL';
    else if (['text/csv', 'text/plain'].includes(type)) sourceType = 'CSV';
    else throw bad('成员导入文件仅支持.xlsx、.xls或.csv格式');
    return { sourceType, textIgnored: textProvided, content: file.bytes };
  }
  if (!textProvided) throw bad('请上传Excel、CSV或填写成员清单');
  if (Buffer.byteLength(memberText!) > IMPORT_MAX_BYTES)
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', '成员清单超过50MiB限制');
  return { sourceType: 'TEXT', textIgnored: false, content: memberText! };
}
function csv(content: string, chinese: boolean) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '"') {
      if (quoted && content[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || (chinese && ch === '，'))) {
      row.push(field.trim());
      field = '';
    } else if (!quoted && (ch === '\r' || ch === '\n')) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return { rows, malformed: quoted };
}
// XLSX解压前检查中心目录，限制声明解压体积与项数；不支持此小批导入无需的ZIP64/多卷包。
function checkZip(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad('Excel文件格式不正确或已损坏');
  const count = bytes.readUInt16LE(end + 10);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    count > 1024 ||
    bytes.readUInt16LE(end + 8) !== count
  )
    throw bad('Excel压缩包目录不受支持或超过限制');
  let offset = bytes.readUInt32LE(end + 16),
    total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw bad('Excel压缩包目录不正确');
    total += bytes.readUInt32LE(offset + 24);
    if (total > 100 * 1024 * 1024)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Excel解压内容超过100MiB限制');
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  if (offset > end) throw bad('Excel压缩包目录不正确');
}
function excel(bytes: Buffer) {
  // 仅真正的OLE/ZIP工作簿；不让SheetJS把改后缀的普通文本/HTML当Excel接受。
  if (!(
    bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) ||
    bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
  ))
    throw bad('Excel文件格式不正确或已损坏');
  if (bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) checkZip(bytes);
  try {
    const workbook = XLSX.read(bytes, {
      type: 'buffer',
      cellFormula: true,
      cellNF: true,
      cellDates: false,
      sheets: 0,
      sheetRows: 100_001,
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    if (!sheet?.['!ref']) return { rows: [], malformed: false };
    const range = XLSX.utils.decode_range(sheet['!ref']);
    // 限制物理扫描范围；超大稀疏工作表返回格式错误，避免伪造维度拖垮进程。
    if (range.e.r > 100_000 || range.e.c > 16_384) throw bad('Excel工作表范围超过安全限制');
    const rows: string[][] = [];
    let malformed = false;
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: string[] = [];
      for (let c = 0; c <= Math.min(range.e.c, 5); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        if ((cell && ('f' in cell || 'F' in cell)) || cell?.t === 'e') malformed = true;
        let value = '';
        if (cell && !('f' in cell) && !('F' in cell) && cell.t !== 'e') {
          if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && XLSX.SSF.is_date(cell.z)) {
            const d = XLSX.SSF.parse_date_code(cell.v, {
              date1904: Boolean(workbook.Workbook?.WBProps?.date1904),
            });
            value = d
              ? `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
              : '';
          } else value = cell.v == null ? '' : String(cell.v).trim();
        }
        row.push(value);
      }
      while (row.length && !row[row.length - 1]) row.pop();
      if (row.some(Boolean)) rows.push(row);
      if (rows.length > 502) break;
    }
    return { rows, malformed };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw bad('Excel文件格式不正确或已损坏');
  }
}
export function parseImport(input: ImportInput) {
  let parsed: { rows: string[][]; malformed: boolean };
  if (input.sourceType === 'EXCEL') parsed = excel(input.content as Buffer);
  else {
    let content: string;
    if (typeof input.content === 'string') content = input.content;
    else {
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(input.content);
      } catch {
        throw bad('CSV文件必须使用UTF-8编码');
      }
    }
    parsed = csv(content.replace(/^\uFEFF/, ''), input.sourceType === 'TEXT');
  }
  const raw = parsed.rows
    .filter((row) => row.some((v) => v.trim()))
    .filter(
      (row) =>
        !row[0]?.startsWith('#') && !row[0]?.startsWith('*姓名：') && !row[0]?.startsWith('*Name:'),
    );
  if (
    raw[0] &&
    (JSON.stringify(raw[0]) === JSON.stringify(headers) ||
      JSON.stringify(raw[0]) === JSON.stringify(englishHeaders))
  )
    raw.shift();
  const errors: RowError[] = [];
  if (parsed.malformed)
    errors.push(
      rowError(
        0,
        input.sourceType === 'TEXT' ? 'memberText' : 'file',
        null,
        'FORMAT_INVALID',
        input.sourceType === 'EXCEL'
          ? 'Excel中不能包含公式或错误单元格'
          : '成员清单引号或行格式不正确',
      ),
    );
  if (!raw.length)
    errors.push(rowError(0, 'members', null, 'REQUIRED_MISSING', '成员清单不包含数据行'));
  const rows: ImportRow[] = raw.map((columns, i) => ({
    rowNo: i + 1,
    columns,
    realName: columns[0] ?? '',
    phone: columns[1] ?? '',
    employmentType: null,
    position: null,
    joinedDate: columns[4] || null,
  }));
  if (rows.length > 500) {
    errors.push(
      rowError(0, 'members', String(rows.length), 'LIMIT_EXCEEDED', '单次最多导入500个成员'),
    );
    return { rows, errors };
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.phone, (counts.get(row.phone) ?? 0) + 1);
  for (const row of rows) {
    const add = (field: string, value: string | null, code: RowErrorCode, message: string) =>
      errors.push(rowError(row.rowNo, field, value, code, message));
    if (row.columns.length > 5) add('row', null, 'FORMAT_INVALID', '每行最多包含5列');
    if (!row.realName) add('realName', null, 'REQUIRED_MISSING', '真实姓名不能为空');
    else if (!/^[\p{L}][\p{L} .\-·'’]{0,63}$/u.test(row.realName))
      add('realName', row.realName, 'FORMAT_INVALID', '真实姓名格式不正确或超过64个字符');
    if (!row.phone) add('phone', null, 'REQUIRED_MISSING', '手机号不能为空');
    else if (!/^1[3-9]\d{9}$/.test(row.phone))
      add('phone', maskImportPhone(row.phone), 'FORMAT_INVALID', '手机号格式不正确');
    else if (counts.get(row.phone)! > 1)
      add('phone', maskImportPhone(row.phone), 'DUPLICATE_IN_BATCH', '同一批成员手机号重复');
    const employment = row.columns[2] ?? '';
    row.employmentType = ['全职', 'Full-time'].includes(employment)
      ? 'FULL_TIME'
      : ['兼职', 'Part-time'].includes(employment)
        ? 'PART_TIME'
        : null;
    if (!row.employmentType)
      add(
        'employmentType',
        employment || null,
        employment ? 'FORMAT_INVALID' : 'REQUIRED_MISSING',
        '人员属性必须填写全职或兼职',
      );
    const position = row.columns[3] ?? '';
    row.position =
      !position || ['成员', 'Member'].includes(position)
        ? 'MEMBER'
        : ['管理员', 'Administrator'].includes(position)
          ? 'ADMIN'
          : null;
    if (!row.position)
      add('position', position, 'FORMAT_INVALID', '组织内角色必须填写管理员或成员');
    if (row.joinedDate) {
      try {
        businessDate(row.joinedDate, true);
      } catch {
        add('joinedAt', row.joinedDate, 'FORMAT_INVALID', '入组日期格式必须为yyyy-MM-dd');
      }
    }
  }
  return { rows, errors };
}
