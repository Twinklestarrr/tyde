import * as XLSX from 'xlsx';
import { AppError } from '../../common/errors.js';
import { examArchive } from './exam-import-archive.js';
import {
  rejectLegacyPictures,
  workbookImages,
  type ImportAsset,
  type ImportCell,
} from './exam-import-images.js';
import { configKey, configValue, narrativeRows, normalizeTable } from './exam-import-narrative.js';
import {
  blank,
  buildExamImport,
  cell,
  EXAM_TEXT_LIMIT,
  importBad,
  type ParsedExam,
} from './exam-import.domain.js';

function metadata(rows: ImportCell[][]) {
  if (rows[0]?.map((c) => c.text.trim()).join('\0') !== '配置项\0值')
    throw importBad('考试配置表头必须为：配置项、值');
  const values = new Map<string, string>();
  for (const row of rows.slice(1)) {
    if (row.length !== 2 || row.some((c) => c.assets.length))
      throw importBad('考试配置必须为两列纯文本');
    const key = configKey(row[0]!.text.trim());
    if (
      ![
        'formatVersion',
        'examName',
        'durationMinutes',
        'registrationDeadline',
        'fullScore',
        'passScore',
      ].includes(key)
    )
      throw importBad('存在未知考试配置项');
    if (values.has(key)) throw importBad('考试配置项重复');
    values.set(key, configValue(key, row[1]!.text.trim()));
  }
  if (values.has('formatVersion') && values.get('formatVersion') !== '1')
    throw importBad('格式版本必须为1');
  return values;
}

export function parseExamText(bytes: Buffer): ParsedExam {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw importBad('TXT必须使用UTF-8编码');
  }
  if (text.length > EXAM_TEXT_LIMIT) throw importBad('TXT内容过长');
  const lines = text.split(/\r\n|[\n\r\u0085\u2028\u2029]/);
  if (!text.includes('[考试配置]') && !text.includes('[题目]')) {
    const rows = lines.filter((l) => l.trim()).map((l) => l.split('\t').map((s) => cell(s)));
    const table = normalizeTable(rows);
    return table ? buildExamImport(new Map(), table) : narrativeRows(lines.map((l) => cell(l)));
  }
  const config: ImportCell[][] = [],
    questions: ImportCell[][] = [],
    seen = new Set<string>();
  let current: ImportCell[][] | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (['[考试配置]', '[题目]'].includes(line)) {
      if (seen.has(line)) throw importBad('重复的配置或题目段');
      seen.add(line);
      current = line === '[考试配置]' ? config : questions;
      continue;
    }
    if (!current) throw importBad('TXT必须以配置或题目段标识开始');
    current.push(
      line
        .split('\t')
        .map((s) =>
          cell(
            s.replace(/\\([nt\\])/g, (_, c: string) =>
              c === 'n' ? '\n' : c === 't' ? '\t' : '\\',
            ),
          ),
        ),
    );
    if (config.length > 20 || questions.length > 4001) throw importBad('TXT超过允许行数');
  }
  return buildExamImport(metadata(config), questions);
}

export function parseExamExcel(source: Buffer): ParsedExam {
  try {
    const archive = source.subarray(0, 2).toString() === 'PK' ? examArchive(source) : null;
    const images = archive
      ? workbookImages(archive)
      : new Map<string, Map<string, ImportAsset[]>>();
    if (!archive) {
      // SheetJS不提供旧BIFF图片锚点；有绘图记录时明确拒绝，防止静默丢题。
      const compound = XLSX.CFB.read(source, { type: 'buffer' });
      const stream = compound.FileIndex.find((f: { name: string; content?: Uint8Array }) =>
        /^(Workbook|Book)$/i.test(f.name),
      )?.content;
      if (stream) rejectLegacyPictures(Buffer.from(stream));
    }
    const workbook = XLSX.read(source, { type: 'buffer', cellFormula: true, sheetStubs: true });
    let configRows: ImportCell[][] | undefined;
    const combined: ImportCell[][] = [],
      lines: ImportCell[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name]!;
      if (sheet['!merges']?.length) throw importBad('固定模板不支持合并单元格');
      const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
      if (range.e.r >= 4001 || range.e.c >= 8) throw importBad('Excel超过4001行或8列限制');
      const pictures = images.get(name) ?? new Map<string, ImportAsset[]>();
      const last = Math.max(range.e.r, ...[...pictures.keys()].map((k) => Number(k.split(':')[0])));
      const rows: ImportCell[][] = [];
      for (let row = 0; row <= last; row++) {
        const cells: ImportCell[] = [];
        for (let col = 0; col < 8; col++) {
          const c = sheet[XLSX.utils.encode_cell({ r: row, c: col })] as
            XLSX.CellObject | undefined;
          if (c?.f !== undefined) throw importBad('模板不支持公式，请粘贴为值后导入');
          const assets = pictures.get(`${row}:${col}`) ?? [];
          cells.push(cell(c ? XLSX.utils.format_cell(c) : '', assets));
        }
        // 保留模板中显式空白单元格，同时剔除读取器补齐的尾部空列。
        while (
          cells.length &&
          blank(cells[cells.length - 1]!) &&
          !sheet[XLSX.utils.encode_cell({ r: row, c: cells.length - 1 })]
        )
          cells.pop();
        if (!cells.every(blank)) rows.push(cells);
      }
      if (name === '考试配置') {
        if (rows.length > 20) throw importBad('考试配置超过允许行数');
        configRows = rows;
      } else {
        const table = normalizeTable(rows);
        if (table) {
          if (!combined.length) combined.push(table[0]!);
          for (const row of table.slice(1)) {
            if (
              workbook.SheetNames.length - Number(workbook.SheetNames.includes('考试配置')) > 1 &&
              !row[0]!.text.trim()
            )
              row[0] = cell(name);
            combined.push(row);
          }
        } else for (const row of rows) for (const c of row) if (!blank(c)) lines.push(c);
      }
    }
    if (combined.length) {
      if (lines.length) throw importBad('Excel不支持混合题目表和自由文本');
      return buildExamImport(configRows ? metadata(configRows) : new Map(), combined);
    }
    const config = configRows
      ? [...metadata(configRows)].map(([key, value]) => cell(`${key}：${value}`))
      : [];
    return narrativeRows([...config, ...lines]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw importBad('Excel文件无效、已加密或不符合导入格式');
  }
}
