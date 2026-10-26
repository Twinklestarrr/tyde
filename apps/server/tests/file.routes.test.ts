import { Readable } from 'node:stream';
import type { PrismaClient, UploadedFile } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import type { ObjectStorage } from '../src/modules/files/object-storage.js';
const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});
const png = Buffer.from('89504e470d0a1a0a', 'hex');
type Part = { name: string; fileName?: string; contentType?: string; content: string | Buffer };
const image = (name = 'file'): Part => ({
  name,
  fileName: 'a.png',
  contentType: 'image/png',
  content: png,
});
function form(parts: Part[]) {
  const boundary = 'unit-file-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.fileName ? `; filename="${part.fileName}"` : ''}\r\n${part.contentType ? `Content-Type: ${part.contentType}\r\n` : ''}\r\n`,
      ),
      Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
afterEach(() => vi.restoreAllMocks());
async function setup(limits = {}) {
  const records = new Map<string, UploadedFile>(),
    objects = new Map<string, Buffer>();
  const tx = {
    uploadedFile: {
      create: vi.fn(async ({ data }) => {
        const record = { id: 'file-id', status: 'UPLOADED', ...data };
        records.set(record.objectKey, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }) => records.get(where.objectKey) ?? null),
      update: vi.fn(async ({ where, data }) => {
        const record = [...records.values()].find((x) => x.id === where.id)!;
        Object.assign(record, data);
        return record;
      }),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(async (_sql, key) => (records.has(key) ? [records.get(key)] : [])),
  };
  const db = {
    ...tx,
    $disconnect: vi.fn(),
    $transaction: vi.fn((callback) => callback(tx)),
  } as unknown as PrismaClient;
  const storage: ObjectStorage = {
    put: vi.fn(async (key, data) => {
      objects.set(key, data);
    }),
    head: vi.fn(async (key) => (objects.has(key) ? { size: objects.get(key)!.length } : null)),
    open: vi.fn(async (key) => ({
      size: objects.get(key)!.length,
      contentType: records.get(key)!.contentType,
      stream: Readable.from(objects.get(key)!),
    })),
    delete: vi.fn(async (key) => {
      objects.delete(key);
    }),
    accessUrl: vi.fn((key, seconds) => `https://storage.example/${key}?seconds=${seconds}`),
  };
  vi.spyOn(AuthService.prototype, 'authenticate').mockImplementation(async (token) => {
    if (token !== 'a'.repeat(43)) throw new Error('bad token');
    return {
      uid: 'owner',
      userId: 'owner-id',
      sessionId: 'session',
      role: 'EXPERT',
      clientType: 'desktop',
    };
  });
  const app = await createApp(
    { ...config, files: { ...config.files, ...limits } },
    db,
    undefined,
    storage,
  );
  const upload = (parts: Part[], batch = false, headers = {}) => {
    const request = form(parts);
    return app.inject({
      method: 'POST',
      url: `/api/v1/files/upload${batch ? '/batch' : ''}`,
      ...request,
      headers: { ...request.headers, ...headers },
    });
  };
  return { app, upload, records, objects, storage, tx };
}
const bearer = { authorization: `Bearer ${'a'.repeat(43)}` };
test('multipart files may precede fields; sensitive metadata and response serialization preserve fields', async () => {
  const { app, upload, storage, records } = await setup();
  try {
    const response = await upload([
      image(),
      { name: 'bizType', content: ' business_license ' },
      { name: 'category', content: 'any' },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      url: null,
      sensitive: true,
      extension: 'png',
      size: 8,
      contentType: 'image/png',
    });
    expect(response.json().data.objectKey).toMatch(
      /^business-license\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.png$/,
    );
    expect(response.json().data.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(records.get(response.json().data.objectKey)?.claimTokenHash).not.toBe(
      response.json().data.uploadToken,
    );
    expect(storage.accessUrl).not.toHaveBeenCalled();
    expect(storage.put).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
test('batch files use repeated files field and remain ordered', async () => {
  const { app, upload } = await setup();
  try {
    const response = await upload([image('files'), { ...image('files'), fileName: 'b.png' }], true);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((x: { fileName: string }) => x.fileName)).toEqual([
      'a.png',
      'b.png',
    ]);
  } finally {
    await app.close();
  }
});
test('malformed, missing, duplicate and wrong fields fail before storage writes', async () => {
  const { app, upload, objects } = await setup();
  try {
    for (const parts of [
      [],
      [{ name: 'file', contentType: 'application/octet-stream', content: png }],
      [image('files')],
      [image(), image()],
      [image(), { name: 'bizType', content: '' }, { name: 'bizType', content: 'COMMON' }],
      [image(), { name: 'unknown', content: 'value' }],
    ])
      expect((await upload(parts)).statusCode).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      payload: '--broken\r\nunfinished',
    });
    expect(response.statusCode).toBe(400);
    expect(objects.size).toBe(0);
  } finally {
    await app.close();
  }
});
test('per-file, batch count and raw request size limits reject oversize requests', async () => {
  const { app, upload, objects } = await setup({
    maxSize: 16,
    maxBatchCount: 2,
    maxRequestSize: 1024,
  });
  try {
    expect(
      (
        await upload([
          { name: 'file', fileName: 'a.txt', contentType: 'text/plain', content: 'a'.repeat(17) },
        ])
      ).statusCode,
    ).toBe(413);
    expect((await upload([image('files'), image('files'), image('files')], true)).statusCode).toBe(
      413,
    );
    const request = form([image()]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/files/upload',
          headers: request.headers,
          payload: Buffer.concat([request.payload, Buffer.alloc(1025)]),
        })
      ).statusCode,
    ).toBe(413);
    const chunked = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...request.headers, 'transfer-encoding': 'chunked' },
      payload: Readable.from([
        request.payload.subarray(0, 30),
        Buffer.alloc(1025),
        request.payload.subarray(30),
      ]),
    });
    expect(chunked.statusCode).toBe(413);
    expect(objects.size).toBe(0);
  } finally {
    await app.close();
  }
});
test('anonymous attachments and foreign origins are denied', async () => {
  const { app, upload } = await setup();
  try {
    expect(
      (await upload([image(), { name: 'bizType', content: 'PROJECT_ATTACHMENT' }])).statusCode,
    ).toBe(401);
    expect((await upload([image()], false, { origin: 'https://evil.example' })).statusCode).toBe(
      403,
    );
  } finally {
    await app.close();
  }
});
test('organization logo upload requires login and records the uploader with an image preview URL', async () => {
  const { app, upload, records, storage } = await setup();
  try {
    const parts = [image(), { name: 'bizType', content: 'ORG_LOGO' }];
    expect((await upload(parts)).statusCode).toBe(401);
    expect(storage.put).not.toHaveBeenCalled();
    const response = await upload(parts, false, bearer);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data;
    expect(data.url).toContain(`https://storage.example/${data.objectKey}`);
    expect(records.get(data.objectKey)).toMatchObject({
      ownerUid: 'owner',
      bizType: 'ORG_LOGO',
      status: 'UPLOADED',
    });
  } finally {
    await app.close();
  }
});
test('authenticated owner can proxy own sensitive object, foreign owner is denied; sensitive URL never issued', async () => {
  const { app, upload, records, storage } = await setup();
  try {
    const response = await upload(
      [image(), { name: 'bizType', content: 'ID_CARD' }],
      false,
      bearer,
    );
    const key = response.json().data.objectKey;
    const viewed = await app.inject({
      url: `/api/v1/files/view?objectKey=${key}`,
      headers: bearer,
    });
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.rawPayload.equals(png)).toBe(true);
    expect(viewed.headers['cache-control']).toBe('no-store, private');
    expect(viewed.headers['x-content-type-options']).toBe('nosniff');
    records.get(key)!.ownerUid = 'other';
    expect(
      (await app.inject({ url: `/api/v1/files/view?objectKey=${key}`, headers: bearer }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/api/v1/files/access-url?objectKey=${key}`, headers: bearer }))
        .statusCode,
    ).toBe(403);
    expect(storage.accessUrl).not.toHaveBeenCalled();
    expect((await app.inject(`/api/v1/files/view?objectKey=${key}`)).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
test('non-sensitive links preserve default and explicit expiry; delete only permits owner and unclaimed', async () => {
  const { app, upload, objects, records } = await setup();
  try {
    const response = await upload([image()], false, bearer);
    const key = response.json().data.objectKey;
    expect(response.json().data.url).toContain('seconds=2147483647');
    expect(
      (
        await app.inject({
          url: `/api/v1/files/access-url?objectKey=${key}&expireSeconds=3600`,
          headers: bearer,
        })
      ).json().data,
    ).toContain('seconds=3600');
    expect(
      (
        await app.inject({
          url: `/api/v1/files/access-url?objectKey=${key}&expireSeconds=2147483648`,
          headers: bearer,
        })
      ).statusCode,
    ).toBe(400);
    const record = records.get(key)!;
    record.status = 'CLAIMED';
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/files?objectKey=${key}`,
          headers: bearer,
        })
      ).statusCode,
    ).toBe(403);
    record.status = 'UPLOADED';
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/files?objectKey=${key}`,
          headers: bearer,
        })
      ).json().data,
    ).toBe(true);
    expect(objects.has(key)).toBe(false);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/files?objectKey=${key}`,
          headers: bearer,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
test('failed registry write compensates the object upload', async () => {
  const { app, upload, tx, objects, storage } = await setup();
  tx.uploadedFile.create.mockRejectedValue(new Error('db unavailable'));
  try {
    expect((await upload([image()])).statusCode).toBe(500);
    expect(objects.size).toBe(0);
    expect(storage.delete).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
