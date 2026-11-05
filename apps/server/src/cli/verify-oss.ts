import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileConfig } from '../config/files.js';
import {
  createObjectStorage,
  OSS_OBJECT_PREFIX,
} from '../infrastructure/storage/object-storage.js';

// 独立验证对象存储，不连接数据库，只写入并删除本次生成的随机对象。
async function verify() {
  const config = readFileConfig(process.env);
  if (config.provider !== 'oss') throw new Error('请先配置 FILE_STORAGE_PROVIDER=oss');
  const storage = createObjectStorage(config);
  const key = `common/oss-verification/${randomUUID()}.txt`;
  const content = Buffer.from('tyde OSS verification\n');
  console.info('OSS 验证配置：', { bucket: config.bucket, endpoint: config.endpoint });
  console.info('本次验证对象：', `${OSS_OBJECT_PREFIX}/${key}`);
  let cleanupFailed = false;
  try {
    await storage.put(key, content, 'text/plain');
    console.info('PUT 通过');
    assert.deepEqual(await storage.head(key), { size: content.length });
    console.info('HEAD 通过');
    const opened = await storage.open(key);
    assert.equal(opened.size, content.length);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), content);
    console.info('流式 GET 通过');
    // 同时验证普通链接和旧图片最大有效期，不输出带签名的链接。
    for (const seconds of [config.urlExpireSeconds, 2147483647]) {
      const response = await fetch(storage.accessUrl(key, seconds), {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    }
    console.info('外网签名 GET（普通/图片最大有效期）通过');
  } finally {
    try {
      await storage.delete(key);
      console.info('DELETE 通过');
    } catch {
      console.error('验证对象删除失败，请按上面的对象键人工清理。');
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new Error('OSS 验证对象清理失败');
  assert.equal(await storage.head(key), null);
  await assert.rejects(storage.open(key), { status: 404 });
  await storage.delete(key);
  console.info('删除后 HEAD/GET 及重复 DELETE 通过；OSS 基础验证完成。');
}

try {
  await verify();
} catch {
  // SDK/fetch 错误可能带 Authorization、签名 URL 或密钥，不直接打印原始错误。
  console.error('OSS 验证未通过，请根据最后通过的步骤检查端点网络、密钥、bucket 权限及签名策略。');
  process.exitCode = 1;
}
