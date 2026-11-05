import { posix } from 'node:path';
import { AppError } from '../../common/errors.js';
export interface ImportAsset {
  name: string;
  bytes?: Buffer;
}
export interface ImportCell {
  text: string;
  assets: ImportAsset[];
}
const bad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
function xml(files: Map<string, Buffer>, name: string) {
  const value = files.get(name)?.toString('utf8');
  if (!value || /<!DOCTYPE|<!ENTITY/i.test(value)) throw bad('Excel图片来源XML无效');
  return value;
}
function decode(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, key: string) => {
    if (key.startsWith('#')) {
      const point =
        key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      if (!Number.isInteger(point) || point < 1 || point > 0x10ffff) throw bad('Excel XML字符无效');
      return String.fromCodePoint(point);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[key]!;
  });
}
function attrs(tag: string) {
  const fields: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    fields[match[1]!] = decode(match[2] ?? match[3]!);
  return fields;
}
function relationships(files: Map<string, Buffer>, part: string) {
  const key = `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
  const value = files.has(key) ? xml(files, key) : '';
  return new Map(
    [...value.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => {
      const a = attrs(m[0]);
      if (!a.Id || !a.Target) throw bad('Excel图片关联关系缺失');
      return [a.Id, a];
    }),
  );
}
function resolve(part: string, relation: Record<string, string> | undefined) {
  if (
    !relation ||
    relation.TargetMode === 'External' ||
    !relation.Target ||
    relation.Target.includes('\\') ||
    /^[a-z]+:/i.test(relation.Target)
  )
    throw bad('Excel不支持外部图片引用');
  const path = posix.normalize(
    relation.Target.startsWith('/')
      ? relation.Target.slice(1)
      : posix.join(posix.dirname(part), relation.Target),
  );
  if (!path.startsWith('xl/')) throw bad('Excel图片关联路径无效');
  return path;
}
export function workbookImages(
  files: Map<string, Buffer>,
): Map<string, Map<string, ImportAsset[]>> {
  const result = new Map<string, Map<string, ImportAsset[]>>();
  const book = 'xl/workbook.xml';
  const relations = relationships(files, book);
  let count = 0;
  for (const match of xml(files, book).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const a = attrs(match[0]);
    if (!a.name || !a['r:id']) throw bad('Excel工作表关联缺失');
    const sheet = resolve(book, relations.get(a['r:id']));
    const value = xml(files, sheet),
      sheetRelations = relationships(files, sheet);
    const pictures = new Map<string, ImportAsset[]>();
    if (/<(?:\w+:)?(?:legacyDrawing|oleObjects|picture)\b/.test(value))
      throw bad('Excel旧式图片或嵌入对象暂不支持，请改用单元格锚定图片或预上传附件');
    for (const drawing of value.matchAll(/<(?:\w+:)?drawing\b[^>]*>/g)) {
      const part = resolve(sheet, sheetRelations.get(attrs(drawing[0])['r:id']!));
      const drawingXml = xml(files, part),
        targets = relationships(files, part);
      for (const anchor of drawingXml.matchAll(
        /<(?:\w+:)?(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g,
      )) {
        const body = anchor[2]!;
        if (!/<(?:\w+:)?pic\b/.test(body)) continue;
        const from = /<(?:\w+:)?from\b[^>]*>([\s\S]*?)<\/(?:\w+:)?from>/.exec(body)?.[1];
        const rowText = from && /<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/.exec(from)?.[1];
        const colText = from && /<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>/.exec(from)?.[1];
        if (
          !rowText ||
          !colText ||
          Number(rowText) >= 4001 ||
          ![2, 3, 6, 7].includes(Number(colText))
        )
          throw bad('Excel图片必须锚定在题干、答案或对应附件单元格内');
        const blips = [...body.matchAll(/<(?:\w+:)?blip\b[^>]*>/g)];
        if (blips.length !== 1) throw bad('Excel图片结构暂不支持');
        const image = resolve(part, targets.get(attrs(blips[0]![0])['r:embed']!));
        const bytes = files.get(image);
        if (!bytes?.length || bytes.length > 10 * 1024 * 1024 || ++count > 100)
          throw bad('Excel图片为空或超过10MiB/100个限制');
        const key = `${rowText}:${colText}`,
          list = pictures.get(key) ?? [];
        list.push({
          name: `excel-${Number(rowText) + 1}-${Number(colText) + 1}-${count}${posix.extname(image)}`,
          bytes,
        });
        pictures.set(key, list);
      }
    }
    result.set(a.name, pictures);
  }
  return result;
}

// BIFF即使没有图片也可能含空绘图容器；检查OfficeArt图片记录，而非仅凭MSODRAWING记录号拒绝。
export function rejectLegacyPictures(data: Buffer) {
  const drawings: Buffer[] = [];
  let continuingDrawing = false;
  for (let at = 0; at + 4 <= data.length;) {
    const type = data.readUInt16LE(at),
      size = data.readUInt16LE(at + 2);
    if (at + 4 + size > data.length) throw bad('XLS记录结构无效');
    if (type === 0x007f) throw bad('XLS内嵌图片暂不支持，请另存为XLSX后导入');
    const drawing = type === 0x00eb || type === 0x00ec;
    if (drawing || (type === 0x003c && continuingDrawing))
      drawings.push(data.subarray(at + 4, at + 4 + size));
    continuingDrawing = drawing || (type === 0x003c && continuingDrawing);
    at += 4 + size;
  }
  const inspect = (bytes: Buffer, depth: number) => {
    if (depth > 64) throw bad('XLS绘图结构过深');
    for (let at = 0; at < bytes.length;) {
      if (at + 8 > bytes.length) throw bad('XLS绘图结构无效');
      const header = bytes.readUInt16LE(at),
        type = bytes.readUInt16LE(at + 2),
        size = bytes.readUInt32LE(at + 4);
      if (at + 8 + size > bytes.length) throw bad('XLS绘图结构无效');
      if (
        (type === 0xf001 && size > 0) ||
        type === 0xf007 ||
        (type >= 0xf018 && type <= 0xf117) ||
        (type === 0xf00a && header >> 4 === 75)
      )
        throw bad('XLS内嵌图片暂不支持，请另存为XLSX后导入');
      if ((header & 15) === 15) inspect(bytes.subarray(at + 8, at + 8 + size), depth + 1);
      at += 8 + size;
    }
  };
  if (drawings.length) inspect(Buffer.concat(drawings), 0);
}
