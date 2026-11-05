import { crc32, deflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { uploadPolicy, validateUpload } from '../../src/modules/files/file-validation.js';
const validate = (
  fileName: string,
  content: Buffer | string,
  declaredType = 'application/octet-stream',
  category: Parameters<typeof validateUpload>[1] = 'ANY',
  maxSize = 50 * 1024 * 1024,
) => validateUpload({ fileName, content: Buffer.from(content), declaredType }, category, maxSize);
test('fixed business categories cannot be widened and unknown parameters fail', () => {
  expect(uploadPolicy(' business_license ', 'any')).toMatchObject({
    category: 'IMAGE',
    bizType: 'BUSINESS_LICENSE',
  });
  expect(uploadPolicy(undefined, 'document')).toMatchObject({ category: 'DOCUMENT' });
  expect(() => uploadPolicy('typo')).toThrow();
  expect(() => uploadPolicy('AVATAR', 'typo')).toThrow();
});
test.each(['svg', 'html', 'exe', 'js', 'missing', 'png.exe'])(
  'rejects unknown or active file type %s',
  (extension) => {
    expect(() => validate(`a.${extension}`, '<script>alert(1)</script>')).toThrow();
  },
);
test('extension, MIME and actual content must agree, filename path is removed', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  expect(validate('C:\\files\\avatar.PNG', png, 'image/png')).toEqual({
    fileName: 'avatar.PNG',
    extension: 'png',
    contentType: 'image/png',
  });
  expect(() => validate('a.png', png, 'text/plain')).toThrow();
  expect(() => validate('a.png', 'not an image', 'image/png')).toThrow();
  expect(() => validate('a.txt', Buffer.from([0]))).toThrow();
});
test.each(['<!doctype html>', '<html>', '<script>', '<svg>', '<iframe>', '<object>', '<?xml'])(
  'rejects disguised active text %s',
  (content) => {
    expect(() => validate('a.txt', content, 'text/plain')).toThrow();
  },
);
test('JSON must be a single valid value and cannot hide active markup', () => {
  expect(validate('a.json', '{"value":1}')).toMatchObject({ contentType: 'application/json' });
  for (const content of ['{} {}', '{bad}', '{"value":"<script>"}'])
    expect(() => validate('a.json', content)).toThrow();
});
test('empty content and size limits are enforced at exact byte boundary', () => {
  expect(() => validate('a.txt', '')).toThrow();
  expect(validate('a.txt', 'abcd', 'text/plain', 'ANY', 4)).toBeTruthy();
  expect(() => validate('a.txt', 'abcde', 'text/plain', 'ANY', 4)).toThrow(
    expect.objectContaining({ status: 413 }),
  );
  expect(() =>
    validate('a.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 65), 'text/plain', 'JSON'),
  ).toThrow(expect.objectContaining({ status: 413 }));
});
// 生成小型标准 ZIP，覆盖 CRC、Office目录、data descriptor 和解压资源上限。
function zip(entries: Record<string, Buffer>, descriptor = false) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      packed = deflateRawSync(data),
      hash = crc32(data);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(filename.length, 26);
    if (!descriptor) {
      local.writeUInt32LE(hash, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(descriptor ? 8 : 0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(hash, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    const tail = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) {
      tail.writeUInt32LE(0x08074b50);
      tail.writeUInt32LE(hash, 4);
      tail.writeUInt32LE(packed.length, 8);
      tail.writeUInt32LE(data.length, 12);
    }
    locals.push(local, filename, packed, tail);
    centrals.push(central, filename);
    offset += local.length + filename.length + packed.length + tail.length;
  }
  const directory = Buffer.concat(centrals),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
test.each([false, true])(
  'Office ZIP uses actual directory and bounded inflation, descriptor=%s',
  (descriptor) => {
    const doc = zip(
      {
        '[Content_Types].xml': Buffer.from('<Types/>'),
        'word/document.xml': Buffer.from('<document/>'),
      },
      descriptor,
    );
    expect(validate('a.docx', doc)).toMatchObject({ extension: 'docx' });
    expect(() => validate('a.xlsx', doc)).toThrow();
    const fake = Buffer.from(doc);
    fake[0] = 0;
    expect(() => validate('a.docx', fake)).toThrow();
    const large = zip(
      {
        '[Content_Types].xml': Buffer.alloc(2 * 1024 * 1024 + 1),
        'word/document.xml': Buffer.from('<document/>'),
      },
      descriptor,
    );
    expect(() => validate('a.docx', large)).toThrow();
  },
);
test('ZIP metadata alone does not make an Office file, invalid archives fail', () => {
  expect(() => validate('a.docx', zip({ 'hello.txt': Buffer.from('hello') }))).toThrow();
  expect(() =>
    validate('a.zip', Buffer.from('504b0304', 'hex'), 'application/zip', 'DOCUMENT'),
  ).toThrow();
});
test.each([
  ['jpg', 'ffd8ff'],
  ['png', '89504e470d0a1a0a'],
  ['gif', '474946383961'],
  ['bmp', '424d'],
  ['webp', '524946460000000057454250'],
  ['pdf', '255044462d312e37'],
  ['doc', 'd0cf11e0a1b11ae1'],
  ['xls', 'd0cf11e0a1b11ae1'],
  ['rar', '526172211a0700'],
  ['7z', '377abcaf271c'],
  ['gz', '1f8b08'],
  ['tgz', '1f8b08'],
  ['bz2', '425a6831'],
  ['xz', 'fd377a585a00'],
  ['zst', '28b52ffd'],
  ['avi', '524946460000000041564920'],
  ['mp4', '000000106674797069736f6d00000000'],
  ['mov', '00000010667479707174202000000000'],
  ['webm', '1a45dfa34282847765626d'],
  ['mkv', '1a45dfa34282886d6174726f736b61'],
])('accepts known container magic for %s and rejects forged content', (extension, magic) => {
  expect(
    validate(
      `a.${extension}`,
      Buffer.from(magic, 'hex'),
      'application/octet-stream',
      'PROJECT_ATTACHMENT',
    ),
  ).toBeTruthy();
  expect(() =>
    validate(
      `a.${extension}`,
      Buffer.from('forged'),
      'application/octet-stream',
      'PROJECT_ATTACHMENT',
    ),
  ).toThrow();
});
