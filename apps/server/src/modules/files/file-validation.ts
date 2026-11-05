import { crc32, inflateRawSync } from 'node:zlib';
import { AppError } from '../../common/errors.js';
import { businesses, categories, type FileBizType, type FileCategory } from './file.types.js';

export interface UploadInput {
  fileName: string;
  declaredType: string;
  content: Buffer;
}
const bad = (message: string) => new AppError(400, 'BAD_REQUEST', message);
export function uploadPolicy(bizType?: string, category?: string) {
  const biz = bizType?.trim().toUpperCase() || 'COMMON';
  const cat = category?.trim().toUpperCase() || '';
  if (!Object.hasOwn(businesses, biz)) throw bad('不支持的业务类型');
  if (cat && !Object.hasOwn(categories, cat)) throw bad('不支持的文件大类');
  const business = businesses[biz as FileBizType];
  return {
    bizType: biz as FileBizType,
    category: (business.category === 'ANY' ? cat || 'ANY' : business.category) as FileCategory,
    business,
  };
}
const mime: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  zst: 'application/zstd',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};
const aliases: Record<string, string[]> = {
  md: ['text/plain'],
  zip: ['application/x-zip-compressed'],
  rar: ['application/x-rar-compressed', 'application/rar'],
  tar: ['application/x-gtar'],
  gz: ['application/x-gzip'],
  tgz: ['application/x-gzip', 'application/x-compressed-tar'],
  bz2: ['application/x-bz2'],
  xz: ['application/xz'],
  zst: ['application/x-zstd'],
  mp4: ['application/mp4'],
  mov: ['video/x-quicktime'],
  avi: ['video/avi', 'video/msvideo'],
  mkv: ['video/matroska'],
  csv: ['text/plain', 'application/vnd.ms-excel'],
  json: ['text/plain'],
};
function ascii(content: Buffer, offset: number, value: string) {
  return content.subarray(offset, offset + value.length).equals(Buffer.from(value, 'ascii'));
}
function hex(content: Buffer, value: string) {
  return content.subarray(0, value.length / 2).equals(Buffer.from(value, 'hex'));
}
function plain(prefix: Buffer) {
  if (!prefix.length || prefix.some((c) => c === 0 || c < 9 || (c > 13 && c < 32))) return false;
  return !/<!doctype html|<html|<script|<svg|<iframe|<object|<\?xml/i.test(
    prefix.toString('utf8').replaceAll('\ufeff', '').trimStart(),
  );
}
function officeZip(content: Buffer, required: string) {
  // 中央目录提供包括 data descriptor 在内的压缩长度，不扫描任意字节猜边界。
  let eocd = -1;
  for (let i = content.length - 22; i >= Math.max(0, content.length - 65557); i--) {
    if (
      content.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + content.readUInt16LE(i + 20) === content.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || content.readUInt16LE(eocd + 4) || content.readUInt16LE(eocd + 6)) return false;
  const count = content.readUInt16LE(eocd + 10),
    directorySize = content.readUInt32LE(eocd + 12);
  let offset = content.readUInt32LE(eocd + 16),
    inflated = 0,
    contentTypes = false,
    directory = false;
  if (count === 65535 || offset + directorySize !== eocd) return false;
  for (let entries = 0; entries < Math.min(count, 200); entries++) {
    if (offset + 46 > eocd || content.readUInt32LE(offset) !== 0x02014b50) return false;
    const flags = content.readUInt16LE(offset + 8),
      method = content.readUInt16LE(offset + 10);
    if (flags & 1) return false;
    const compressed = content.readUInt32LE(offset + 20),
      size = content.readUInt32LE(offset + 24);
    const nameLength = content.readUInt16LE(offset + 28),
      extraLength = content.readUInt16LE(offset + 30),
      commentLength = content.readUInt16LE(offset + 32);
    const local = content.readUInt32LE(offset + 42);
    if (
      offset + 46 + nameLength + extraLength + commentLength > eocd ||
      local + 30 > content.length ||
      content.readUInt32LE(local) !== 0x04034b50 ||
      inflated + size > 2 * 1024 * 1024
    )
      return false;
    const name = content
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    const localNameLength = content.readUInt16LE(local + 26);
    if (
      !content
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(content.subarray(offset + 46, offset + 46 + nameLength))
    )
      return false;
    const start = local + 30 + localNameLength + content.readUInt16LE(local + 28),
      end = start + compressed;
    if (end > content.readUInt32LE(eocd + 16)) return false;
    const data =
      method === 0
        ? content.subarray(start, end)
        : method === 8
          ? inflateRawSync(content.subarray(start, end), {
              maxOutputLength: Math.max(1, 2 * 1024 * 1024 - inflated),
            })
          : null;
    if (!data || data.length !== size || crc32(data) !== content.readUInt32LE(offset + 16))
      return false;
    inflated += data.length;
    contentTypes ||= name === '[Content_Types].xml';
    directory ||= name.startsWith(required);
    if (contentTypes && directory) return true;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return false;
}
function validContent(content: Buffer, extension: string): boolean {
  const prefix = content.subarray(0, 65536);
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return hex(prefix, 'ffd8ff');
    case 'png':
      return hex(prefix, '89504e470d0a1a0a');
    case 'gif':
      return ascii(prefix, 0, 'GIF87a') || ascii(prefix, 0, 'GIF89a');
    case 'bmp':
      return ascii(prefix, 0, 'BM');
    case 'webp':
      return ascii(prefix, 0, 'RIFF') && ascii(prefix, 8, 'WEBP');
    case 'pdf':
      return prefix.toString('ascii').trimStart().startsWith('%PDF-');
    case 'doc':
    case 'xls':
      return hex(prefix, 'd0cf11e0a1b11ae1');
    case 'docx':
      return officeZip(content, 'word/');
    case 'xlsx':
      return officeZip(content, 'xl/');
    case 'txt':
    case 'md':
    case 'csv':
      return plain(prefix);
    case 'json':
      if (!plain(prefix)) return false;
      JSON.parse(content.toString('utf8').replace(/^\ufeff/, ''));
      return true;
    case 'zip':
      return (
        (hex(prefix, '504b0506') && content.length >= 22) ||
        (hex(prefix, '504b0304') &&
          content.length >= 30 &&
          30 + content.readUInt16LE(26) + content.readUInt16LE(28) <= content.length)
      );
    case 'rar':
      return hex(prefix, '526172211a0700') || hex(prefix, '526172211a070100');
    case '7z':
      return hex(prefix, '377abcaf271c');
    case 'gz':
    case 'tgz':
      return hex(prefix, '1f8b08');
    case 'bz2':
      return ascii(prefix, 0, 'BZh') && (prefix[3] ?? 0) >= 49 && (prefix[3] ?? 0) <= 57;
    case 'xz':
      return hex(prefix, 'fd377a585a00');
    case 'zst':
      return hex(prefix, '28b52ffd');
    case 'tar': {
      if (prefix.length < 512 || !ascii(prefix, 257, 'ustar')) return false;
      const checksum = prefix.subarray(148, 156).toString('ascii').replaceAll('\0', '').trim();
      if (!/^[0-7]+$/.test(checksum)) return false;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : prefix[i]!;
      return parseInt(checksum, 8) === sum;
    }
    case 'mp4':
    case 'mov': {
      if (
        prefix.length < 16 ||
        !ascii(prefix, 4, 'ftyp') ||
        prefix.readUInt32BE(0) < 16 ||
        prefix.readUInt32BE(0) > prefix.length
      )
        return false;
      const brand = prefix.subarray(8, 12).toString('ascii');
      return extension === 'mov'
        ? brand === 'qt  '
        : ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', '3gp4', '3gp5', '3gp6'].includes(
            brand,
          );
    }
    case 'avi':
      return ascii(prefix, 0, 'RIFF') && ascii(prefix, 8, 'AVI ');
    case 'webm':
    case 'mkv': {
      if (!hex(prefix, '1a45dfa3')) return false;
      const docType = extension === 'webm' ? 'webm' : 'matroska';
      for (let i = 4; i + 3 + docType.length <= Math.min(prefix.length, 512); i++)
        if (
          prefix[i] === 0x42 &&
          prefix[i + 1] === 0x82 &&
          prefix[i + 2] === (0x80 | docType.length) &&
          ascii(prefix, i + 3, docType)
        )
          return true;
      return false;
    }
    default:
      return false;
  }
}
export function validateUpload(file: UploadInput, category: FileCategory, maxSize: number) {
  if (!file.content.length) throw bad('上传文件不能为空');
  const limit = Math.min(maxSize, categories[category].maxMB * 1024 * 1024);
  if (file.content.length > limit)
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `文件大小超过限制（最大 ${limit} 字节）`);
  const name = file.fileName.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'file';
  const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  if (
    !extension ||
    extension.length > 20 ||
    !categories[category].extensions.split(' ').includes(extension) ||
    !mime[extension]
  )
    throw bad('不支持的文件类型');
  const declared = file.declaredType.split(';')[0]!.trim().toLowerCase();
  const contentType = mime[extension]!;
  if (
    declared &&
    declared !== 'application/octet-stream' &&
    declared !== contentType &&
    !aliases[extension]?.includes(declared)
  )
    throw bad('Content-Type 与文件类型不匹配');
  let valid = false;
  try {
    valid = validContent(file.content, extension);
  } catch {
    /* 畸形内容、解压超限和解析失败统一拒绝。 */
  }
  if (!valid) throw bad('文件内容与扩展名不匹配或包含不安全内容');
  return { fileName: name.slice(-255), extension, contentType };
}
