import OSS from 'ali-oss';
import { PassThrough, Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { readFileConfig } from '../../src/config/files.js';
import {
  createObjectStorage,
  OssObjectStorage,
  validObjectKey,
} from '../../src/infrastructure/storage/object-storage.js';
const config = readFileConfig({
  FILE_STORAGE_PROVIDER: 'oss',
  OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
  OSS_BUCKET: 'tyde-test-bucket',
  OSS_ACCESS_KEY_ID: 'test-key',
  OSS_ACCESS_KEY_SECRET: 'test-secret',
});
test('storage is explicitly disabled by default and does not use legacy configuration', async () => {
  const disabled = createObjectStorage(readFileConfig({}));
  await expect(
    disabled.put('common/test.txt', Buffer.from('data'), 'text/plain'),
  ).rejects.toMatchObject({ status: 503 });
  expect(() => disabled.accessUrl('common/test.txt', 100)).toThrow();
});
test.each([
  '../secret',
  'common/../secret',
  'common//secret',
  'https://example.org/a',
  'common/a?x=1',
  'common/%2fsecret',
  'business-license/..',
])('invalid object key %s is rejected', (key) => {
  expect(() => validObjectKey(key)).toThrow();
});
test.each([
  { FILE_STORAGE_PROVIDER: 'local' },
  { TYDE_FILE_MAX_SIZE: '0' },
  { TYDE_FILE_MAX_BATCH: '1.5' },
  {
    ...{ FILE_STORAGE_PROVIDER: 'oss' },
    OSS_ENDPOINT: 'http://storage.example',
    OSS_BUCKET: 'test-bucket',
    OSS_ACCESS_KEY_ID: 'a',
    OSS_ACCESS_KEY_SECRET: 'b',
  },
])('invalid storage configuration is rejected', (source) => {
  expect(() => readFileConfig(source)).toThrow();
});
function mockSdk() {
  const client = {
    put: vi.fn().mockResolvedValue({}),
    head: vi.fn().mockResolvedValue({ res: { headers: { 'content-length': '3' } } }),
    getStream: vi.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from('abc')]),
      res: { headers: { 'content-length': '3', 'content-type': 'image/png' } },
    }),
    delete: vi.fn().mockResolvedValue({}),
    signatureUrl: vi.fn().mockReturnValue('https://signed.example/'),
  };
  const factory = vi.fn(() => client as unknown as OSS);
  return { client, factory, storage: new OssObjectStorage(config, factory) };
}
test('SDK uploads are private and cannot overwrite; HEAD and streaming preserve metadata/content', async () => {
  const { client, storage } = mockSdk();
  const key = 'business-license/2026/10/16/test.png';
  await storage.put(key, Buffer.from('abc'), 'image/png');
  expect(client.put).toHaveBeenCalledWith(`tyde/${key}`, Buffer.from('abc'), {
    mime: 'image/png',
    headers: { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
  });
  expect(await storage.head(key)).toEqual({ size: 3 });
  expect(client.head).toHaveBeenCalledWith(`tyde/${key}`);
  const opened = await storage.open(key);
  expect(client.getStream).toHaveBeenCalledWith(`tyde/${key}`);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('abc');
  expect(opened.contentType).toBe('image/png');
  expect(opened.size).toBe(3);
  await storage.delete(key);
  expect(client.delete).toHaveBeenCalledWith(`tyde/${key}`);
  storage.accessUrl(key, 600);
  expect(client.signatureUrl).toHaveBeenCalledWith(`tyde/${key}`, { expires: 600, method: 'GET' });
});
test('bare internal endpoints are normalized; download links use the matching public endpoint', () => {
  const internal = readFileConfig({
    FILE_STORAGE_PROVIDER: 'oss',
    OSS_ENDPOINT: 'oss-cn-shanghai-internal.aliyuncs.com',
    OSS_BUCKET: 'tyde-test-bucket',
    OSS_ACCESS_KEY_ID: 'test-key',
    OSS_ACCESS_KEY_SECRET: 'test-secret',
  });
  expect(internal.endpoint).toBe('https://oss-cn-shanghai-internal.aliyuncs.com');
  expect(internal.publicEndpoint).toBe('https://oss-cn-shanghai.aliyuncs.com');
  const { factory } = mockSdk();
  new OssObjectStorage(internal, factory);
  expect(factory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      endpoint: internal.publicEndpoint,
      secure: true,
      timeout: 30_000,
    }),
  );
  const url = new URL(new OssObjectStorage(internal).accessUrl('avatar/test.png', 2147483647));
  expect(url.host).toBe('tyde-test-bucket.oss-cn-shanghai.aliyuncs.com');
  expect(url.protocol).toBe('https:');
  expect(url.pathname).toBe('/tyde/avatar/test.png');
  expect(url.searchParams.get('OSSAccessKeyId')).toBe('test-key');
  const remaining = Number(url.searchParams.get('Expires')) - Math.floor(Date.now() / 1000);
  // SDK 的秒时间戳四舍五入，允许相对于向下取整的一秒差。
  expect(remaining).toBeGreaterThanOrEqual(2147483647);
  expect(remaining).toBeLessThanOrEqual(2147483648);
  expect(url.searchParams.get('Signature')).toBeTruthy();
  expect(url.href).not.toContain('test-secret');
});
test.each([
  { OSS_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com/path' },
  { OSS_ENDPOINT: 'https://user:secret@oss-cn-shanghai.aliyuncs.com' },
  { OSS_ENDPOINT: 'https://bucket.oss-cn-shanghai.aliyuncs.com' },
  { OSS_PUBLIC_ENDPOINT: 'https://oss-cn-hangzhou-internal.aliyuncs.com' },
  { OSS_PUBLIC_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com' },
])('invalid or mismatched download endpoint is rejected: %j', (overrides) => {
  expect(() =>
    readFileConfig({
      FILE_STORAGE_PROVIDER: 'oss',
      OSS_ENDPOINT: config.endpoint,
      OSS_BUCKET: config.bucket,
      OSS_ACCESS_KEY_ID: 'a',
      OSS_ACCESS_KEY_SECRET: 'b',
      ...overrides,
    }),
  ).toThrow();
});
test('missing objects are distinguished from bucket/permission failures and upstream secrets stay hidden', async () => {
  const { client, storage } = mockSdk();
  client.head.mockRejectedValue({ code: 'NoSuchKey', status: 404 });
  expect(await storage.head('common/missing.txt')).toBeNull();
  client.getStream.mockRejectedValue({ code: 'NoSuchKey', status: 404 });
  await expect(storage.open('common/missing.txt')).rejects.toMatchObject({ status: 404 });
  client.delete.mockRejectedValue({ code: 'NoSuchKey', status: 404 });
  await expect(storage.delete('common/missing.txt')).resolves.toBeUndefined();
  client.head.mockRejectedValue({ code: 'NoSuchBucket', status: 404 });
  await expect(storage.head('common/missing.txt')).rejects.toMatchObject({ status: 503 });
  client.put.mockRejectedValue(new Error('test-secret upstream URL'));
  await expect(storage.put('common/a.txt', Buffer.from('a'), 'text/plain')).rejects.toMatchObject({
    status: 503,
    message: '文件存储未配置或暂不可用',
  });
  client.delete.mockRejectedValue({ code: 'AccessDenied', status: 403 });
  await expect(storage.delete('common/a.txt')).rejects.toMatchObject({ status: 503 });
});
test.each([undefined, '', '-1', 'invalid', '9007199254740992'])(
  'invalid length %s destroys the upstream stream',
  async (length) => {
    const { client, storage } = mockSdk();
    const source = new PassThrough();
    client.getStream.mockResolvedValue({
      stream: source,
      res: { headers: { 'content-length': length } },
    });
    await expect(storage.open('common/a.txt')).rejects.toMatchObject({ status: 503 });
    expect(source.destroyed).toBe(true);
    client.head.mockResolvedValue({ res: { headers: { 'content-length': length } } });
    await expect(storage.head('common/a.txt')).rejects.toMatchObject({ status: 503 });
  },
);
test('errors after streaming starts are sanitized; downstream cancellation closes upstream', async () => {
  const { client, storage } = mockSdk();
  const source = new PassThrough();
  client.getStream.mockResolvedValue({
    stream: source,
    res: { headers: { 'content-length': '3' } },
  });
  const opened = await storage.open('common/a.txt');
  const read = (async () => {
    for await (const chunk of opened.stream) void chunk;
  })();
  source.destroy(new Error('test-secret signed upstream URL'));
  await expect(read).rejects.toMatchObject({ status: 503, message: '文件存储未配置或暂不可用' });
  const second = new PassThrough();
  client.getStream.mockResolvedValue({
    stream: second,
    res: { headers: { 'content-length': '3' } },
  });
  const download = await storage.open('common/b.txt');
  download.stream.destroy();
  await new Promise((resolve) => download.stream.once('close', resolve));
  expect(second.destroyed).toBe(true);
});
test.each([0, -1, 1.5, 2147483648])('invalid signed URL expiry %s is rejected', (seconds) => {
  expect(() => new OssObjectStorage(config).accessUrl('common/a.txt', seconds)).toThrow();
});
