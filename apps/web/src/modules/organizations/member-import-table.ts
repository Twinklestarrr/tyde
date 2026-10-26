import type { OrganizationImportRowError } from '@tyde/shared';

/** 与 memberText 接口保持相同顺序，不在客户端推断成员身份或默认值。 */
export type MemberImportRow = [string, string, string, string, string];
export const MEMBER_IMPORT_MAX_ROWS = 500;
export const emptyRow = (): MemberImportRow => ['', '', '', '', ''];
export const isPhoneDraft = (value: string) => /^\d{0,11}$/.test(value);
const memberNamePattern = /^[\p{L}][\p{L} .\-·'’]{0,63}$/u;
const employmentValues = new Map([
  ['全职', '全职'],
  ['兼职', '兼职'],
  ['Full-time', '全职'],
  ['Part-time', '兼职'],
]);
const positionValues = new Map([
  ['成员', '成员'],
  ['管理员', '管理员'],
  ['Member', '成员'],
  ['Administrator', '管理员'],
]);

/** 草稿允许留空；已填值按导入接口校验，英文枚举仅转为同义中文展示值。 */
export function normalizeMemberCell(column: number, value: string): string {
  const trimmed = value.trim();
  switch (column) {
    case 0:
      if (Array.from(trimmed).length > 64) throw new Error('姓名最多填写 64 个字符');
      if (trimmed && !memberNamePattern.test(trimmed))
        throw new Error(
          '姓名须以文字开头，最多 64 个字符，仅支持文字、空格、点、连字符、间隔号和撇号',
        );
      return trimmed;
    case 1:
      if (!isPhoneDraft(trimmed)) throw new Error('手机号只能填写最多 11 位数字');
      return trimmed;
    case 2: {
      if (!trimmed) return '';
      const normalized = employmentValues.get(trimmed);
      if (!normalized) throw new Error('人员属性必须填写全职或兼职');
      return normalized;
    }
    case 3: {
      if (!trimmed) return '';
      const normalized = positionValues.get(trimmed);
      if (!normalized) throw new Error('组织角色必须填写管理员或成员');
      return normalized;
    }
    case 4: {
      if (!trimmed) return '';
      const date = new Date(`${trimmed}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== trimmed
      )
        throw new Error('入组日期必须为有效的 YYYY-MM-DD 日期');
      return trimmed;
    }
    default:
      throw new Error('成员表格仅支持姓名、手机号、人员属性、组织角色和入组日期五列');
  }
}

/** 与现有导入接口一致：非空成员行必须填写大陆手机号，且同批不能重复。 */
export function validateMemberPhones(
  rows: readonly MemberImportRow[],
): OrganizationImportRowError[] {
  const populated = rows.filter((row) => row.some((cell) => cell.trim()));
  const counts = new Map<string, number>();
  for (const row of populated) {
    const phone = row[1].trim();
    counts.set(phone, (counts.get(phone) ?? 0) + 1);
  }
  return populated.flatMap((row, index) => {
    const phone = row[1].trim();
    const message = !phone
      ? '手机号不能为空'
      : !/^1[3-9]\d{9}$/.test(phone)
        ? '请输入 11 位大陆手机号码'
        : counts.get(phone)! > 1
          ? '同一批成员手机号重复'
          : '';
    return message
      ? [
          {
            rowNo: index + 1,
            field: 'phone',
            value: null,
            errorCode: !phone
              ? 'REQUIRED_MISSING'
              : counts.get(phone)! > 1 && /^1[3-9]\d{9}$/.test(phone)
                ? 'DUPLICATE_IN_BATCH'
                : 'FORMAT_INVALID',
            message,
          },
        ]
      : [];
  });
}

/** 提交时校验所有非空成员行；行号与后端一样排除空行，日期和角色不填则交后端取默认值。 */
export function validateMemberRows(rows: readonly MemberImportRow[]): OrganizationImportRowError[] {
  const phoneErrors = new Map(validateMemberPhones(rows).map((error) => [error.rowNo, error]));
  const fields = ['realName', 'phone', 'employmentType', 'position', 'joinedAt'] as const;
  return rows
    .filter((row) => row.some((cell) => cell.trim()))
    .flatMap((row, index) => {
      const errors: OrganizationImportRowError[] = [];
      fields.forEach((field, column) => {
        if (column === 1) {
          const phoneError = phoneErrors.get(index + 1);
          if (phoneError) errors.push(phoneError);
          return;
        }
        const value = row[column]!.trim();
        const required = column === 0 || column === 2;
        let message = '';
        if (required && !value)
          message = column === 0 ? '姓名不能为空' : '人员属性必须填写全职或兼职';
        else {
          try {
            normalizeMemberCell(column, value);
          } catch (error) {
            if (error instanceof Error) message = error.message;
            else throw error;
          }
        }
        if (message)
          errors.push({
            rowNo: index + 1,
            field,
            value: value || null,
            errorCode: required && !value ? 'REQUIRED_MISSING' : 'FORMAT_INVALID',
            message,
          });
      });
      return errors;
    });
}

const headerNames = [
  ['姓名', 'name'],
  ['手机号', 'phone number'],
  ['人员属性', 'employment type'],
  ['组织内角色', '组织角色', 'organization role'],
  ['入组时间', '入组日期', 'join date'],
];
const isHeader = (row: readonly string[]) =>
  row.length === 5 &&
  row.every((cell, column) => headerNames[column]!.includes(cell.trim().toLowerCase()));

function checkRows(rows: readonly (readonly string[])[]) {
  if (rows.length > MEMBER_IMPORT_MAX_ROWS)
    throw new Error('单次最多导入 500 个成员，请分批粘贴或导入。');
  rows.forEach((row, index) => {
    if (row.length > 5)
      throw new Error(
        `第 ${index + 1} 行超过 5 列，请按姓名、手机号、人员属性、组织角色、入组日期排列。`,
      );
  });
}

/** 单格粘贴由输入框原生处理；此函数只拆分表格结构，不校验业务字段。 */
export function parseClipboard(text: string): string[][] {
  const content = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!content.trim()) return [];
  if (content.includes('"'))
    throw new Error('粘贴内容含引号，请直接复制表格单元格，或移除引号后重试。');
  const separator = content.includes('\t') ? /\t/ : /[,，]/;
  const rows = content
    .split('\n')
    .map((line) => line.split(separator).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  if (rows[0] && isHeader(rows[0])) rows.shift();
  checkRows(rows);
  return rows;
}

/** 生成后端的 CSV memberText；仅处理结构转义，业务字段仍由服务端校验。 */
export function serializeRows(rows: readonly (readonly string[])[]): string {
  const populated = rows.filter((row) => row.some((cell) => cell.trim()));
  checkRows(populated);
  return populated
    .map((row, rowIndex) => {
      const cells = row.map((cell) => cell.trim());
      // 后端会忽略说明行和首行表头，避免用户输入在提交后被静默跳过。
      if (/^(#|\*姓名：|\*Name:)/.test(cells[0] ?? '') || isHeader(cells))
        throw new Error(`第 ${rowIndex + 1} 行包含表头或说明标记，请移除后再导入。`);
      while (cells.length && !cells.at(-1)) cells.pop();
      return cells
        .map((cell) => (/[,，"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(',');
    })
    .join('\n');
}
