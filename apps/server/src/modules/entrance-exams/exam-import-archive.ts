import { crc32, inflateRawSync } from 'node:zlib';
import { AppError } from '../../common/errors.js';
const bad = () =>
  new AppError(400, 'VALIDATION_ERROR', 'Excel压缩结构无效或超过1000条目/32MiB解压限制');
// 在SheetJS或图片读取之前，逐项限制实际解压量；不信任ZIP声明的原始大小。
export function examArchive(source: Buffer): Map<string, Buffer> {
  try {
    let end = -1;
    for (let i = source.length - 22; i >= Math.max(0, source.length - 65557); i--)
      if (
        source.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + source.readUInt16LE(i + 20) === source.length
      ) {
        end = i;
        break;
      }
    if (end < 0 || source.readUInt32LE(end + 4) !== 0) throw bad();
    const count = source.readUInt16LE(end + 10),
      size = source.readUInt32LE(end + 12);
    let at = source.readUInt32LE(end + 16),
      expanded = 0;
    if (count > 1000 || count !== source.readUInt16LE(end + 8) || at + size !== end) throw bad();
    const files = new Map<string, Buffer>();
    for (let i = 0; i < count; i++) {
      if (source.readUInt32LE(at) !== 0x02014b50) throw bad();
      const flags = source.readUInt16LE(at + 8),
        method = source.readUInt16LE(at + 10);
      const packed = source.readUInt32LE(at + 20),
        unpacked = source.readUInt32LE(at + 24);
      const nameSize = source.readUInt16LE(at + 28),
        extra = source.readUInt16LE(at + 30),
        comment = source.readUInt16LE(at + 32);
      const offset = source.readUInt32LE(at + 42),
        name = source.toString('utf8', at + 46, at + 46 + nameSize);
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        files.has(name) ||
        !name ||
        name.includes('..') ||
        name.startsWith('/') ||
        name.includes('\\') ||
        unpacked > 32 * 1024 * 1024 - expanded ||
        source.readUInt32LE(offset) !== 0x04034b50
      )
        throw bad();
      if (
        source.readUInt16LE(offset + 8) !== method ||
        source.toString('utf8', offset + 30, offset + 30 + source.readUInt16LE(offset + 26)) !==
          name
      )
        throw bad();
      const begin =
        offset + 30 + source.readUInt16LE(offset + 26) + source.readUInt16LE(offset + 28);
      if (begin + packed > source.readUInt32LE(end + 16)) throw bad();
      const compressed = source.subarray(begin, begin + packed);
      const content =
        method === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(1, 32 * 1024 * 1024 - expanded),
            });
      if (
        crc32(content) !== source.readUInt32LE(at + 16) ||
        content.length !== unpacked ||
        (expanded += content.length) > 32 * 1024 * 1024
      )
        throw bad();
      files.set(name, content);
      at += 46 + nameSize + extra + comment;
    }
    if (at !== end) throw bad();
    return files;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw bad();
  }
}
